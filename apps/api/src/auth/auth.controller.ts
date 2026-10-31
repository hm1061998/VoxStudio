import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
  type SessionDto,
} from '@voxstudio/contracts';
import type { AppConfig } from '@voxstudio/core';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, ZodPipe, type SessionUser, type VoxRequest } from '../common/http';
import { CONFIG } from '../common/infra';
import { AuthService, SESSION_TTL_MS } from './auth.service';
import { Public } from './guards';

const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});
const resetConfirmSchema = z.strictObject({
  token: z.string().min(10).max(200),
  newPassword: z.string().min(10).max(200),
});
const profileSchema = z.strictObject({ displayName: z.string().trim().min(1).max(80) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private setCookie(res: Response, token: string): void {
    res.cookie(this.auth.cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.cookieSecure,
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
  }

  private async sessionFor(userId: string, token: string): Promise<SessionDto> {
    const user = await this.auth.resolveSession(token);
    return { user: await this.auth.me(userId), csrfToken: user!.csrfToken };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Req() req: VoxRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const { token, userId } = await this.auth.register(body, { ip: req.ip ?? 'unknown' });
    this.setCookie(res, token);
    return this.sessionFor(userId, token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: VoxRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const { token, userId } = await this.auth.login(body, { ip: req.ip ?? 'unknown' });
    this.setCookie(res, token);
    return this.sessionFor(userId, token);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.auth.logout(user.sessionId);
    res.clearCookie(this.auth.cookieName, {
      path: '/',
      secure: this.config.cookieSecure,
      httpOnly: true,
      sameSite: 'strict',
    });
    return { ok: true };
  }

  /** Sign out every other device; the current session stays. */
  @Post('logout-others')
  @HttpCode(200)
  async logoutOthers(@CurrentUser() user: SessionUser): Promise<{ revoked: number }> {
    return { revoked: await this.auth.revokeSessions(user.id, user.sessionId) };
  }

  /** What the sign-in pages need to know before anyone is signed in. */
  @Public()
  @Get('config')
  authConfig(): { registrationOpen: boolean } {
    return { registrationOpen: this.config.allowRegistration };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const token = await this.auth.refresh(user.sessionId);
    this.setCookie(res, token);
    return this.sessionFor(user.id, token);
  }

  /** Session probe for the web client: `null` (not 401) when signed out, so page loads log no errors. */
  @Public()
  @Get('session')
  async session(@Req() req: VoxRequest): Promise<SessionDto | null> {
    return req.user ? { user: await this.auth.me(req.user.id), csrfToken: req.user.csrfToken } : null;
  }

  @Get('me')
  async me(@CurrentUser() user: SessionUser): Promise<SessionDto> {
    return { user: await this.auth.me(user.id), csrfToken: user.csrfToken };
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    await this.auth.updateProfile(user.id, body.displayName);
    return this.auth.me(user.id);
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    await this.auth.changePassword(user.id, user.sessionId, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password-reset/confirm')
  @HttpCode(200)
  async confirmReset(
    @Body(new ZodPipe(resetConfirmSchema)) body: z.infer<typeof resetConfirmSchema>,
    @Req() _req: VoxRequest,
  ) {
    await this.auth.confirmReset(body.token, body.newPassword);
    return { ok: true };
  }
}
