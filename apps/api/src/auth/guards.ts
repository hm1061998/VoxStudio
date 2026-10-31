import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { timingSafeEqual } from 'node:crypto';
import type { VoxRequest } from '../common/http';
import { AuthService, SESSION_COOKIE } from './auth.service';

export const PUBLIC = 'vox:public';
/** Route needs no session (register/login/health). */
export const Public = () => SetMetadata(PUBLIC, true);
export const ADMIN = 'vox:admin';
export const AdminOnly = () => SetMetadata(ADMIN, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: resolves the session cookie, enforces authentication, CSRF (synchronizer token
 * sent as `x-csrf-token` on state-changing requests) and the admin role.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<VoxRequest>();
    const cookies = (req as { cookies?: Record<string, string> }).cookies ?? {};
    const user = await this.auth.resolveSession(cookies[SESSION_COOKIE]);
    if (user) req.user = user;
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    if (!user) throw new VoxError(ErrorCodes.UNAUTHENTICATED, 'Sign in required.');
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.header('x-csrf-token') ?? '';
      const a = Buffer.from(header);
      const b = Buffer.from(user.csrfToken);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        throw new VoxError(ErrorCodes.CSRF_INVALID, 'Security token missing or expired. Reload the page.');
    }
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN, [ctx.getHandler(), ctx.getClass()]);
    if (adminOnly && user.role !== 'admin')
      throw new VoxError(ErrorCodes.FORBIDDEN, 'Administrator access required.');
    return true;
  }
}
