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
import { CONFIG, PrismaService } from '../common/infra';
import type { SessionUser } from '../common/http';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: object,
) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'vs_session';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
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
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Constant work for unknown emails, so response time doesn't reveal account existence.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private roleFor(email: string, current: string): 'user' | 'admin' {
    return this.config.adminEmails.includes(email) ? 'admin' : current === 'admin' ? 'admin' : 'user';
  }

  async register(input: RegisterInput): Promise<{ token: string; userId: string }> {
    const email = input.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new VoxError(ErrorCodes.EMAIL_TAKEN, 'An account with this email already exists.');
    const passwordHash = await hashPassword(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { email, passwordHash, displayName: input.displayName, role: this.roleFor(email, 'user') },
      });
      const ws = await tx.workspace.create({
        data: { name: `${input.displayName}'s workspace`, ownerUserId: u.id },
      });
      await tx.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: 'owner' } });
      return u;
    });
    return { token: await this.createSession(user.id), userId: user.id };
  }

  async login(input: LoginInput): Promise<{ token: string; userId: string }> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user
      ? await verifyPassword(input.password, user.passwordHash)
      : (await verifyPassword(input.password, await DUMMY_HASH), false);
    if (!user || !ok || user.status !== 'active')
      throw new VoxError(ErrorCodes.INVALID_CREDENTIALS, 'Email or password is incorrect.');
    const role = this.roleFor(email, user.role);
    if (role !== user.role) await this.prisma.user.update({ where: { id: user.id }, data: { role } });
    return { token: await this.createSession(user.id), userId: user.id };
  }

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
    return token;
  }

  async resolveSession(token: string | undefined): Promise<SessionUser | null> {
    if (!token || token.length > 200) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { memberships: true } } },
    });
    if (!session || session.expiresAt < new Date() || session.user.status !== 'active') return null;
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
      },
    });
    return token;
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
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

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(current, u.passwordHash)))
      throw new VoxError(ErrorCodes.INVALID_CREDENTIALS, 'Current password is incorrect.');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next) },
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
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: rec.userId },
        data: { passwordHash: await hashPassword(newPassword) },
      }),
      // Invalidate all existing sessions after a reset.
      this.prisma.session.deleteMany({ where: { userId: rec.userId } }),
    ]);
  }
}
