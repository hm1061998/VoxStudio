import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
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
import { Prisma, type Order, type PaymentEvent } from '@voxstudio/db';
import { ZodError } from 'zod';
import { AccessService } from '../common/access';
import { AuditService } from '../common/audit';
import type { SessionUser } from '../common/http';
import { CONFIG, PrismaService } from '../common/infra';

const ORDER_TTL_MS = 48 * 3600_000;
const MAX_OPEN_ORDERS = 3;
const MAX_ORDERS_SHOWN = 100;
/** Result of a notification that is stored but not yet applied. */
const RECEIVED = 'received';
const STUCK_AFTER_MS = 60_000;
const SWEEP_EVERY_MS = 60_000;

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

/** `event_done`: the payment notification being settled had already been handled by someone else. */
export type SettleResult = { result: 'applied' | 'review' | 'already_paid' | 'event_done'; order: Order };

/** The payment notification a settlement belongs to; its result changes in the same transaction as the order. */
export interface SettleEvent {
  id: string;
  /** Results the event may still have; anything else means it was already handled. */
  from: string[];
}

/**
 * Optional billing (ADR 0010): orders for paid plans, confirmed by an administrator or by a payment provider's
 * webhook. Both paths go through settle(), which is idempotent and never downgrades a plan silently.
 */
@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Billing');
  private sweeper: NodeJS.Timeout | null = null;

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
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // A double click, a retry after a lost response or two tabs must not make two orders: under a lock per
        // workspace, an unpaid order for the same plan and period is returned instead of a new one.
        const { order, created } = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${workspaceId}`}))`;
          const same = await tx.order.findFirst({
            where: {
              workspaceId,
              status: 'pending',
              plan: input.plan,
              months: input.months,
              expiresAt: { gt: now },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (same) return { order: same, created: false };
          const open = await tx.order.count({
            where: { workspaceId, status: 'pending', expiresAt: { gt: now } },
          });
          if (open >= MAX_OPEN_ORDERS)
            throw new VoxError(
              ErrorCodes.ORDER_STATE,
              'You already have several unpaid orders. Pay or cancel one before creating another.',
            );
          const fresh = await tx.order.create({
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
          return { order: fresh, created: true };
        });
        if (created)
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
    p: {
      amountVnd: number;
      via: string;
      actorUserId?: string;
      force?: boolean;
      now?: Date;
      event?: SettleEvent;
    },
  ): Promise<SettleResult> {
    const now = p.now ?? new Date();
    const outcome = await this.prisma.$transaction(async (tx): Promise<SettleResult> => {
      // Serialize concurrent settlements of the same order (order row first, then the event row).
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new VoxError(ErrorCodes.NOT_FOUND, 'Order not found.');
      // The order and the notification change together: a crash can never leave the plan applied while the
      // notification still looks unprocessed, or the other way round.
      const closeEvent = async (result: string) => {
        if (p.event)
          await tx.paymentEvent.update({ where: { id: p.event.id }, data: { result, orderId: order.id } });
      };
      if (p.event) {
        const rows = await tx.$queryRaw<
          { result: string }[]
        >`SELECT result FROM payment_events WHERE id = ${p.event.id}::uuid FOR UPDATE`;
        if (!rows[0] || !p.event.from.includes(rows[0].result)) return { result: 'event_done', order };
      }
      if (order.status === 'paid') {
        await closeEvent('review');
        return { result: 'already_paid', order };
      }
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
        await closeEvent('review');
        return { result: 'review', order: reviewed };
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
      await closeEvent('applied');
      return { result: 'applied', order: paid };
    });
    if (outcome.result === 'applied' || outcome.result === 'review')
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
    // The notification is stored first as 'received' and only leaves that state in the same transaction that
    // applies it. A delivery that finds it still 'received' (the first attempt crashed) therefore finishes the job
    // instead of being dropped as a duplicate; processing is safe to run twice at once.
    let row: PaymentEvent;
    try {
      row = await this.prisma.paymentEvent.create({
        data: {
          provider: provider.id,
          eventId: ev.eventId,
          direction: ev.direction,
          amountVnd: ev.amountVnd,
          note,
          result: RECEIVED,
        },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const existing = await this.prisma.paymentEvent.findUnique({
        where: { provider_eventId: { provider: provider.id, eventId: ev.eventId } },
      });
      if (!existing || existing.result !== RECEIVED) return { success: true, result: 'duplicate' };
      row = existing;
    }
    return { success: true, result: await this.processEvent(row) };
  }

  /** Decide what a stored notification means and apply it. Any failure propagates so the provider retries. */
  private async processEvent(ev: PaymentEvent): Promise<string> {
    const close = async (result: string, orderId: string | null) => {
      const r = await this.prisma.paymentEvent.updateMany({
        where: { id: ev.id, result: RECEIVED },
        data: { result, orderId },
      });
      return r.count === 1 ? result : 'duplicate';
    };
    if (ev.direction !== 'in') return close('ignored', null);
    const code = extractPaymentCode(ev.note);
    const order = code ? await this.prisma.order.findUnique({ where: { paymentCode: code } }) : null;
    if (!order) {
      const r = await close('unmatched', null);
      if (r === 'unmatched')
        await this.audit.record({
          eventType: 'payment.unmatched',
          resourceType: 'payment_event',
          resourceId: ev.id,
          metadata: { provider: ev.provider, amountVnd: ev.amountVnd },
        });
      return r;
    }
    // Money for an order that is already paid (or sits in review) is a second payment: an administrator decides.
    if (order.status === 'paid' || order.status === 'review') return close('review', order.id);
    const r = await this.settle(order.id, {
      amountVnd: ev.amountVnd,
      via: ev.provider,
      event: { id: ev.id, from: [RECEIVED] },
    });
    return r.result === 'applied' ? 'applied' : r.result === 'event_done' ? 'duplicate' : 'review';
  }

  /** Finish notifications whose first attempt died half way. Called on a timer and by tests. */
  async reprocessStuckEvents(olderThanMs = STUCK_AFTER_MS): Promise<number> {
    const stuck = await this.prisma.paymentEvent.findMany({
      where: { result: RECEIVED, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    let done = 0;
    for (const ev of stuck) {
      try {
        await this.processEvent(ev);
        done += 1;
      } catch (e) {
        this.log.warn(`payment event ${ev.id} could not be processed yet: ${(e as Error).message}`);
      }
    }
    return done;
  }

  onModuleInit(): void {
    if (!this.config.paymentWebhookSecret) return;
    this.sweeper = setInterval(
      () => void this.reprocessStuckEvents().catch((e) => this.log.warn(`event sweep failed: ${e.message}`)),
      SWEEP_EVERY_MS,
    );
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /**
   * An administrator settles a transfer that did not resolve itself.
   * attach: apply it to a chosen unpaid order. extend: it was a second payment for a paid order, so add the same
   * period again. dismiss: nothing to apply (for example the money was returned).
   */
  async resolveEvent(
    adminId: string,
    eventId: string,
    body: { action: 'attach' | 'extend' | 'dismiss'; orderId?: string; note?: string },
  ): Promise<{ result: string }> {
    const ev = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!ev) throw new VoxError(ErrorCodes.NOT_FOUND, 'Payment notification not found.');
    const OPEN = ['unmatched', 'review'];
    if (!OPEN.includes(ev.result))
      throw new VoxError(ErrorCodes.ORDER_STATE, 'This payment notification was already handled.');
    if (body.action === 'dismiss') {
      const r = await this.prisma.paymentEvent.updateMany({
        where: { id: ev.id, result: { in: OPEN } },
        data: { result: 'dismissed' },
      });
      if (r.count !== 1)
        throw new VoxError(ErrorCodes.ORDER_STATE, 'This payment notification was already handled.');
      await this.audit.record({
        eventType: 'payment.dismissed',
        resourceType: 'payment_event',
        resourceId: ev.id,
        actorUserId: adminId,
        metadata: { amountVnd: ev.amountVnd, note: body.note ?? null },
      });
      return { result: 'dismissed' };
    }
    let target: Order | null;
    if (body.action === 'attach') {
      target = body.orderId ? await this.prisma.order.findUnique({ where: { id: body.orderId } }) : null;
      if (!target) throw new VoxError(ErrorCodes.VALIDATION_FAILED, 'Choose the order to apply it to.');
      if (target.status === 'paid')
        throw new VoxError(ErrorCodes.ORDER_STATE, 'That order is already paid. Use "add time" instead.');
    } else {
      const paid = ev.orderId ? await this.prisma.order.findUnique({ where: { id: ev.orderId } }) : null;
      if (!paid || paid.status !== 'paid')
        throw new VoxError(ErrorCodes.ORDER_STATE, 'Only a second payment for a paid order can add time.');
      // The same period again, as an order of its own so the history shows it.
      target = await this.prisma.order.create({
        data: {
          workspaceId: paid.workspaceId,
          userId: paid.userId,
          plan: paid.plan,
          months: paid.months,
          amountVnd: paid.amountVnd,
          paymentCode: generatePaymentCode(),
          expiresAt: new Date(Date.now() + ORDER_TTL_MS),
          note: 'Second payment applied by an administrator.',
        },
      });
    }
    const r = await this.settle(target.id, {
      amountVnd: ev.amountVnd,
      via: ev.provider,
      actorUserId: adminId,
      force: true,
      event: { id: ev.id, from: OPEN },
    });
    if (r.result === 'event_done' || r.result === 'already_paid') {
      if (body.action === 'extend')
        await this.prisma.order.delete({ where: { id: target.id } }).catch(() => undefined);
      throw new VoxError(ErrorCodes.ORDER_STATE, 'This payment notification was already handled.');
    }
    return { result: r.result };
  }
}
