import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { orderCreateSchema, type BillingInfoDto, type OrderDto } from '@voxstudio/contracts';
import type { z } from 'zod';
import { Public } from '../auth/guards';
import {
  CurrentUser,
  RawResponse,
  UuidPipe,
  ZodPipe,
  type SessionUser,
  type VoxRequest,
} from '../common/http';
import { BillingService } from './billing.service';

/** What a signed-in user sees: prices, their own orders, and how to pay. */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('info')
  info(): BillingInfoDto {
    return this.billing.info();
  }

  @Get('orders')
  orders(@CurrentUser() user: SessionUser): Promise<OrderDto[]> {
    return this.billing.listOrders(user);
  }

  @Post('orders')
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(orderCreateSchema)) body: z.infer<typeof orderCreateSchema>,
  ): Promise<OrderDto> {
    return this.billing.createOrder(user, body);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: SessionUser, @Param('id', UuidPipe) id: string): Promise<OrderDto> {
    return this.billing.cancelOrder(user, id);
  }
}

/**
 * Entry point for payment providers. No session and no CSRF token: the caller proves itself with the shared
 * secret (see PaymentProvider.authenticate). Answers `{ "success": true }` as providers expect.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @RawResponse()
  @Post('webhook/:provider')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async webhook(@Param('provider') provider: string, @Req() req: VoxRequest, @Body() body: unknown) {
    return this.billing.handleWebhook(provider, req.headers, body);
  }
}
