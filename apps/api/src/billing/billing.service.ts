import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  type AdminOrderDto,
  type AdminPaymentEventDto,
  type BillingInfoDto,
  type OrderDto,
  type OrderStatus,
} from '@voxstudio/contracts';
import {
  ORDER_MONTHS,
  PAID_PLANS,
  PAYMENT_PROVIDERS,
  addMonths,
  effectivePlan,
  extractPaymentCode,
  generatePaymentCode,
  type AppConfig,
  type PaidPlan,
} from '@voxstudio/core';
import { Prisma, type Order } from '@voxstudio/db';
import { ZodError } from 'zod';
import { AccessService } from '../common/access';
import { AuditService } from '../common/audit';
import type { SessionUser } from '../common/http';
import { CONFIG, PrismaService } from '../common/infra';

const ORDER_TTL_MS = 48 * 3600_000;
const MAX_OPEN_ORDERS = 3;
const MAX_ORDERS_SHOWN = 100;

const toDto = (o: Order, now = new Date()): OrderDto => ({
  id: o.id,
  plan: o.plan as OrderDto['plan'],
  months: o.months,
  amountVnd: o.amountVnd,
  paymentCode: o.paymentCode,
  // A pending order past its time is shown as expired; a payment that still arrives is accepted.
  status: (o.status === 'pending' && o.expiresAt <= now ? 'expired' : o.status) as OrderStatus,
  paidAmountVnd: o.paidAmountVnd,
  paidAt: o.paidAt?.toISOString() ?? null,
  paidVia: o.paidVia,
  createdAt: o.createdAt.toISOString(),
  expiresAt: o.expiresAt.toISOString(),
  note: o.note,
});

export type SettleResult = { result: 'applied' | 'review' | 'already_paid'; order: Order };

/**
 * Optional billing (ADR 0010): orders for paid plans, confirmed by an administrator or by a payment provider's
 * webhook. Both paths go through settle(), which is idempotent and never downgrades a plan silently.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  get enabled(): boolean {
    return PAID_PLANS.some((p) => this.config.planPrices[p] !== undefined);
  }

  info(): BillingInfoDto {
    return {
      enabled: this.enabled,
      prices: this.config.planPrices,
      months: [...ORDER_MONTHS],
      bank: this.config.bank,
      autoConfirm: this.config.paymentWebhookSecret.length > 0,
    };
  }

  async createOrder(user: SessionUser, input: { plan: PaidPlan; months: number }): Promise<OrderDto> {
    const price = this.config.planPrices[input.plan];
    if (!this.enabled || price === undefined)
      throw new VoxError(
        ErrorCodes.BILLING_DISABLED,
        'This plan cannot be bought online. Ask an administrator.',
      );
    const workspaceId = this.access.defaultWorkspace(user);
    const now = new Date();
    const open = await this.prisma.order.count({
      where: { workspaceId, status: 'pending', expiresAt: { gt: now } },
    });
    if (open >= MAX_OPEN_ORDERS)
      throw new VoxError(
        ErrorCodes.ORDER_STATE,
        'You already have several unpaid orders. Pay or cancel one before creating another.',
      );
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const order = await this.prisma.order.create({
          data: {
            workspaceId,
            userId: user.id,
            plan: input.plan,
            months: input.months,
            amountVnd: price * input.months,
            paymentCode: generatePaymentCode(),
            expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
          },
        });
        await this.audit.record({
          eventType: 'order.created',
          resourceType: 'order',
          resourceId: order.id,
          actorUserId: user.id,
          workspaceId,
          metadata: { plan: order.plan, months: order.months, amountVnd: order.amountVnd },
        });
        return toDto(order, now);
      } catch (e) {
        // A payment code collision (about 1 in 10^12) just draws another code.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    throw new VoxError(ErrorCodes.INTERNAL_ERROR, 'Could not create the order. Try again.');
  }

  async listOrders(user: SessionUser): Promise<OrderDto[]> {
    const workspaceId = this.access.defaultWorkspace(user);
    const rows = await this.prisma.order.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: MAX_ORDERS_SHOWN,
    });
    const now = new Date();
    return rows.map((o) => toDto(o, now));
  }

  async cancelOrder(user: SessionUser, id: string): Promise<OrderDto> {
    const workspaceId = this.access.defaultWorkspace(user);
    const o = await this.prisma.order.findFirst({ where: { id, workspaceId } });
    if (!o) throw new VoxError(ErrorCodes.NOT_FOUND, 'Order not found.');
    if (o.status !== 'pending')
      throw new VoxError(ErrorCodes.ORDER_STATE, 'Only an unpaid order can be cancelled.');
    const updated = await this.prisma.order.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.record({
      eventType: 'order.cancelled',
      resourceType: 'order',
      resourceId: id,
      actorUserId: user.id,
      workspaceId,
    });
    return toDto(updated);
  }

  // ---- settlement -------------------------------------------------------------------------------------------

  /**
   * Record a payment for an order and, if it is complete and safe, apply the plan.
   * `force` is for an administrator who has seen the money: it skips the amount and plan-conflict checks.
   */
  async settle(
    orderId: string,
    p: { amountVnd: number; via: string; actorUserId?: string; force?: boolean; now?: Date },
  ): Promise<SettleResult> {
    const now = p.now ?? new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent settlements of the same order.
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new VoxError(ErrorCodes.NOT_FOUND, 'Order not found.');
      if (order.status === 'paid') return { result: 'already_paid' as const, order };
      const w = await tx.workspace.findUniqueOrThrow({ where: { id: order.workspaceId } });
      const active = effectivePlan(w.plan, w.planExpiresAt, now);
      let reason: string | null = null;
      if (!p.force) {
        if (order.status === 'cancelled') reason = 'The order had been cancelled.';
        else if (p.amountVnd < order.amountVnd)
          reason = `Paid ${p.amountVnd} VND, the order is ${order.amountVnd} VND.`;
        else if (active !== 'free' && active !== order.plan)
          reason = `The workspace already has an active ${active} plan.`;
      }
      if (reason) {
        const reviewed = await tx.order.update({
          where: { id: order.id },
          data: { status: 'review', paidAmountVnd: p.amountVnd, paidVia: p.via, note: reason },
        });
        return { result: 'review' as const, order: reviewed };
      }
      // Same plan still running: the new period starts when it ends. A plan without an expiry stays without one.
      const sameActive = active === order.plan;
      const permanent = sameActive && w.planExpiresAt === null;
      const base = sameActive && w.planExpiresAt && w.planExpiresAt > now ? w.planExpiresAt : now;
      await tx.workspace.update({
        where: { id: w.id },
        data: { plan: order.plan, planExpiresAt: permanent ? null : addMonths(base, order.months) },
      });
      const paid = await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'paid',
          paidAmountVnd: p.amountVnd,
          paidAt: now,
          paidVia: p.via,
          confirmedByUserId: p.actorUserId ?? null,
          note: permanent ? 'The plan has no expiry date, so it was not extended.' : null,
        },
      });
      return { result: 'applied' as const, order: paid };
    });
    if (outcome.result !== 'already_paid')
      await this.audit.record({
        eventType: outcome.result === 'applied' ? 'order.paid' : 'order.review',
        resourceType: 'order',
        resourceId: orderId,
        actorUserId: p.actorUserId ?? null,
        workspaceId: outcome.order.workspaceId,
        metadata: {
          via: p.via,
          amountVnd: p.amountVnd,
          plan: outcome.order.plan,
          months: outcome.order.months,
        },
      });
    return outcome;
  }

  // ---- administrator -----------------------------------------------------------------------------------------

  async adminOrders(status?: string): Promise<AdminOrderDto[]> {
    const rows = await this.prisma.order.findMany({
      where: status ? { status } : {},
      include: { workspace: { select: { name: true, owner: { select: { email: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const now = new Date();
    return rows.map((o) => ({
      ...toDto(o, now),
      workspaceId: o.workspaceId,
      workspaceName: o.workspace.name,
      ownerEmail: o.workspace.owner.email,
    }));
  }

  /** The administrator has seen the money (bank statement): apply the plan whatever the checks said. */
  async adminConfirm(adminId: string, orderId: string, note?: string): Promise<AdminOrderDto> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new VoxError(ErrorCodes.NOT_FOUND, 'Order not found.');
    if (order.status === 'paid') throw new VoxError(ErrorCodes.ORDER_STATE, 'The order is already paid.');
    await this.settle(orderId, {
      amountVnd: order.paidAmountVnd ?? order.amountVnd,
      via: 'manual',
      actorUserId: adminId,
      force: true,
    });
    if (note) await this.prisma.order.update({ where: { id: orderId }, data: { note } });
    return (await this.adminOrders()).find((o) => o.id === orderId)!;
  }

  async adminReject(adminId: string, orderId: string, note?: string): Promise<AdminOrderDto> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new VoxError(ErrorCodes.NOT_FOUND, 'Order not found.');
    if (order.status === 'paid')
      throw new VoxError(ErrorCodes.ORDER_STATE, 'A paid order cannot be rejected.');
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'cancelled', note: note ?? null },
    });
    await this.audit.record({
      eventType: 'order.rejected',
      resourceType: 'order',
      resourceId: orderId,
      actorUserId: adminId,
      workspaceId: order.workspaceId,
      metadata: { note: note ?? null },
    });
    return (await this.adminOrders()).find((o) => o.id === orderId)!;
  }

  async adminPaymentEvents(): Promise<AdminPaymentEventDto[]> {
    const rows = await this.prisma.paymentEvent.findMany({
      where: { result: { in: ['unmatched', 'review'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((e) => ({
      id: e.id,
      provider: e.provider,
      amountVnd: e.amountVnd,
      note: e.note,
      result: e.result,
      orderId: e.orderId,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // ---- provider webhook --------------------------------------------------------------------------------------

  /**
   * Handle one notification from a payment provider. Returns normally for anything the provider should not retry
   * (duplicates, unmatched transfers, outgoing money); throws only for bad credentials or a malformed body.
   */
  async handleWebhook(
    providerId: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<{ success: true; result: string }> {
    const provider = PAYMENT_PROVIDERS[providerId];
    const secret = this.config.paymentWebhookSecret;
    if (!provider || !secret) throw new VoxError(ErrorCodes.NOT_FOUND, 'Not found.');
    if (!provider.authenticate(headers, secret))
      throw new VoxError(ErrorCodes.UNAUTHENTICATED, 'Invalid credentials.');
    let ev;
    try {
      ev = provider.parse(body);
    } catch (e) {
      if (e instanceof ZodError)
        throw new VoxError(ErrorCodes.VALIDATION_FAILED, 'Invalid payment notification.');
      throw e;
    }
    const note = ev.note.slice(0, 300);
    let eventRow;
    try {
      eventRow = await this.prisma.paymentEvent.create({
        data: {
          provider: provider.id,
          eventId: ev.eventId,
          direction: ev.direction,
          amountVnd: ev.amountVnd,
          note,
          result: 'ignored',
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        return { success: true, result: 'duplicate' };
      throw e;
    }
    const finish = async (result: string, orderId: string | null) => {
      await this.prisma.paymentEvent.update({ where: { id: eventRow.id }, data: { result, orderId } });
      return { success: true as const, result };
    };
    if (ev.direction !== 'in') return finish('ignored', null);
    const code = extractPaymentCode(ev.note);
    const order = code ? await this.prisma.order.findUnique({ where: { paymentCode: code } }) : null;
    if (!order) {
      await this.audit.record({
        eventType: 'payment.unmatched',
        resourceType: 'payment_event',
        resourceId: eventRow.id,
        metadata: { provider: provider.id, amountVnd: ev.amountVnd },
      });
      return finish('unmatched', null);
    }
    // Money for an order that is already paid (or sits in review) is a second payment: an administrator decides.
    if (order.status === 'paid' || order.status === 'review') return finish('review', order.id);
    const r = await this.settle(order.id, { amountVnd: ev.amountVnd, via: provider.id });
    return finish(r.result === 'applied' ? 'applied' : 'review', order.id);
  }
}
