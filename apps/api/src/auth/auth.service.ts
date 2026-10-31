import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  type LoginInput,
  type RegisterInput,
  type UserDto,
} from '@voxstudio/contracts';
import type { AppConfig } from '@voxstudio/core';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AuditService } from '../common/audit';
import { CONFIG, PrismaService } from '../common/infra';
import type { SessionUser } from '../common/http';
import { assertPasswordAcceptable } from './password-policy';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: object,
) => Promise<Buffer>;
// OWASP: scrypt N=2^16, r=8, p=1 (about 64 MB). Parameters are stored in the hash, so they can be raised later.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_SESSIONS_PER_USER = 10;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True when a stored hash uses weaker parameters than the current ones (it is upgraded after a successful sign-in). */
export const needsRehash = (stored: string): boolean => {
  const [alg, n, r, p] = stored.split('$');
  return alg !== 'scrypt' || Number(n) < SCRYPT.N || Number(r) < SCRYPT.r || Number(p) < SCRYPT.p;
};

// Constant work for unknown emails, so response time doesn't reveal account existence.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

/** Lockout policy: after this many consecutive failures an account (or client address) is locked, with doubling waits. */
export const LOCKOUT = {
  accountThreshold: 5,
  ipThreshold: 30,
  baseMs: 15 * 60_000,
  maxMs: 24 * 3600_000,
  decayMs: 3600_000,
};

export interface ClientContext {
  ip: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Cookie name: `__Host-` prefixed when cookies are Secure (the browser then refuses any that were set insecurely). */
  get cookieName(): string {
    return this.config.cookieSecure ? '__Host-vs_session' : 'vs_session';
  }

  // ---- lockout -----------------------------------------------------------------------------------------------
  private keys(email: string, ctx: ClientContext) {
    return { acct: `acct:${sha256(email)}`, ip: `ip:${ctx.ip}` };
  }

  private async assertNotLocked(keys: string[]): Promise<void> {
    const rows = await this.prisma.authThrottle.findMany({
      where: { key: { in: keys }, lockedUntil: { gt: new Date() } },
    });
    if (rows.length) {
      const until = Math.max(...rows.map((r) => r.lockedUntil!.getTime()));
      throw new VoxError(ErrorCodes.RATE_LIMITED, 'Too many sign-in attempts. Try again later.', {
        retryAfterSeconds: Math.ceil((until - Date.now()) / 1000),
      });
    }
  }

  private async recordFailure(
    key: string,
    threshold: number,
  ): Promise<{ locked: boolean; failures: number }> {
    const now = new Date();
    const row = await this.prisma.authThrottle.findUnique({ where: { key } });
    const stale = !row || now.getTime() - row.lastFailureAt.getTime() > LOCKOUT.decayMs;
    const failures = (stale ? 0 : row.failures) + 1;
    const over = failures - threshold;
    const lockedUntil =
      over >= 0
        ? new Date(now.getTime() + Math.min(LOCKOUT.maxMs, LOCKOUT.baseMs * 2 ** Math.min(over, 10)))
        : null;
    await this.prisma.authThrottle.upsert({
      where: { key },
      create: { key, failures, lastFailureAt: now, lockedUntil },
      update: { failures, lastFailureAt: now, lockedUntil },
    });
    return { locked: over === 0, failures };
  }

  // ---- registration and sign-in ------------------------------------------------------------------------------
  async register(input: RegisterInput, ctx: ClientContext): Promise<{ token: string; userId: string }> {
    if (!this.config.allowRegistration)
      throw new VoxError(
        ErrorCodes.FORBIDDEN,
        'Registration is closed. Ask an administrator for an account.',
      );
    const email = input.email.trim().toLowerCase();
    assertPasswordAcceptable(input.password, { email, displayName: input.displayName });
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new VoxError(ErrorCodes.EMAIL_TAKEN, 'An account with this email already exists.');
    const passwordHash = await hashPassword(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      // ADMIN_EMAILS only bootstraps the FIRST administrator: once any admin exists nobody can obtain the role by
      // registering with a listed address. Later admins are promoted by an administrator or by scripts/user-admin.mjs.
      const adminExists = (await tx.user.count({ where: { role: 'admin' } })) > 0;
      const role = !adminExists && this.config.adminEmails.includes(email) ? 'admin' : 'user';
      const u = await tx.user.create({
        data: { email, passwordHash, displayName: input.displayName, role, passwordChangedAt: new Date() },
      });
      const ws = await tx.workspace.create({
        data: { name: `${input.displayName}'s workspace`, ownerUserId: u.id },
      });
      await tx.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: 'owner' } });
      return u;
    });
    await this.audit.record({
      eventType: user.role === 'admin' ? 'auth.registered_admin' : 'auth.registered',
      resourceType: 'user',
      resourceId: user.id,
      actorUserId: user.id,
      metadata: { ip: ctx.ip },
    });
    return { token: await this.createSession(user.id), userId: user.id };
  }

  async login(input: LoginInput, ctx: ClientContext): Promise<{ token: string; userId: string }> {
    const email = input.email.trim().toLowerCase();
    const k = this.keys(email, ctx);
    await this.assertNotLocked([k.acct, k.ip]);
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user
      ? await verifyPassword(input.password, user.passwordHash)
      : (await verifyPassword(input.password, await DUMMY_HASH), false);
    if (!user || !ok || user.status !== 'active') {
      const a = await this.recordFailure(k.acct, LOCKOUT.accountThreshold);
      const i = await this.recordFailure(k.ip, LOCKOUT.ipThreshold);
      if (a.locked || i.locked)
        await this.audit.record({
          eventType: 'auth.locked',
          resourceType: 'account',
          // Hash only: the typed address may not belong to anyone.
          resourceId: sha256(email).slice(0, 16),
          actorUserId: user?.id ?? null,
          metadata: { ip: ctx.ip, scope: a.locked ? 'account' : 'address', existing: !!user },
        });
      throw new VoxError(ErrorCodes.INVALID_CREDENTIALS, 'Email or password is incorrect.');
    }
    await this.prisma.authThrottle.deleteMany({ where: { key: k.acct } });
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    });
    await this.audit.record({
      eventType: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      actorUserId: user.id,
      metadata: { ip: ctx.ip },
    });
    return { token: await this.createSession(user.id), userId: user.id };
  }

  // ---- sessions ---------------------------------------------------------------------------------------------
  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        csrfToken: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    // Bound the number of live sessions per account: the oldest ones are removed.
    const extra = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: MAX_SESSIONS_PER_USER,
      select: { id: true },
    });
    if (extra.length) await this.prisma.session.deleteMany({ where: { id: { in: extra.map((s) => s.id) } } });
    return token;
  }

  async resolveSession(token: string | undefined): Promise<SessionUser | null> {
    if (!token || token.length > 200) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { memberships: true } } },
    });
    if (!session || session.expiresAt < new Date() || session.user.status !== 'active') return null;
    // Idle timeout: a session unused for this long is dead even if it has not expired yet.
    if (Date.now() - session.lastSeenAt.getTime() > this.config.sessionIdleMs) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000)
      await this.prisma.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    return {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      role: session.user.role === 'admin' ? 'admin' : 'user',
      sessionId: session.id,
      csrfToken: session.csrfToken,
      workspaceIds: session.user.memberships.map((m) => m.workspaceId),
    };
  }

  /** Rotate the session token (and CSRF token) and extend expiry. */
  async refresh(sessionId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        tokenHash: sha256(token),
        csrfToken: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        lastSeenAt: new Date(),
      },
    });
    return token;
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  /** Sign a user out everywhere (suspension, role change, password change). `keep` leaves one session alive. */
  async revokeSessions(userId: string, keep?: string): Promise<number> {
    const r = await this.prisma.session.deleteMany({
      where: { userId, ...(keep ? { id: { not: keep } } : {}) },
    });
    return r.count;
  }

  async me(userId: string): Promise<UserDto> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { workspace: true } } },
    });
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role === 'admin' ? 'admin' : 'user',
      workspaces: u.memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name })),
    };
  }

  async changePassword(userId: string, sessionId: string, current: string, next: string): Promise<void> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(current, u.passwordHash)))
      throw new VoxError(ErrorCodes.INVALID_CREDENTIALS, 'Current password is incorrect.');
    if (next === current)
      throw new VoxError(ErrorCodes.PASSWORD_REJECTED, 'The new password must differ from the current one.', {
        field: 'newPassword',
        reason: 'same',
      });
    assertPasswordAcceptable(next, { email: u.email, displayName: u.displayName });
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() },
    });
    // A changed password signs every other device out.
    const revoked = await this.revokeSessions(userId, sessionId);
    await this.audit.record({
      eventType: 'auth.password_changed',
      resourceType: 'user',
      resourceId: userId,
      actorUserId: userId,
      metadata: { revokedSessions: revoked },
    });
  }

  async updateProfile(userId: string, displayName: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { displayName } });
  }

  /** Confirm an operator-issued reset code (see `scripts/reset-password.mjs`). */
  async confirmReset(token: string, newPassword: string): Promise<void> {
    const rec = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date())
      throw new VoxError(ErrorCodes.INVALID_CREDENTIALS, 'This reset code is invalid or has expired.');
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: rec.userId } });
    assertPasswordAcceptable(newPassword, { email: u.email, displayName: u.displayName });
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: rec.userId },
        data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
      }),
      // Invalidate all existing sessions after a reset, and clear any lockout of the account.
      this.prisma.session.deleteMany({ where: { userId: rec.userId } }),
      this.prisma.authThrottle.deleteMany({ where: { key: `acct:${sha256(u.email)}` } }),
    ]);
    await this.audit.record({
      eventType: 'auth.password_reset',
      resourceType: 'user',
      resourceId: rec.userId,
      actorUserId: rec.userId,
    });
  }
}
