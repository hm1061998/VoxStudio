import { describe, expect, it } from 'vitest';
import { assertPasswordAcceptable } from '../src/auth/password-policy';
import { LOCKOUT, hashPassword, needsRehash, verifyPassword } from '../src/auth/auth.service';

const ctx = { email: 'nguyen.an@example.com', displayName: 'Nguyễn Văn An' };

describe('password policy', () => {
  it('accepts a long, unpredictable password', () => {
    expect(() => assertPasswordAcceptable('violet-lantern-orbit-7391', ctx)).not.toThrow();
    expect(() => assertPasswordAcceptable('Mùa thu hà nội 2026!', ctx)).not.toThrow();
  });

  it.each([
    ['password1234', /too common/],
    ['Password1234', /too common/],
    ['pass-word-1234', /too common/],
    ['xxxxxxxxxxxx', /repeats/],
    ['abababababab', /few different/],
    ['abcdefghijklmn', /sequence/],
    ['9876543210', /sequence/],
    ['my-nguyen.an-pass', /email name/],
    ['nguyenvanan-2026', /display name/],
    ['NGUYỄNVĂNAN!!x1', /display name/],
  ])('rejects %s', (pw, why) => {
    expect(() => assertPasswordAcceptable(pw, ctx)).toThrow(why);
  });
});

describe('password hashing', () => {
  it('verifies, rejects wrong passwords, and flags weaker stored parameters for upgrade', async () => {
    const h = await hashPassword('violet-lantern-orbit-7391');
    expect(h.startsWith('scrypt$65536$8$1$')).toBe(true);
    expect(await verifyPassword('violet-lantern-orbit-7391', h)).toBe(true);
    expect(await verifyPassword('violet-lantern-orbit-7392', h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash(h.replace('$65536$', '$16384$'))).toBe(true);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('keeps the lockout policy sane: waits double and are capped', () => {
    expect(LOCKOUT.accountThreshold).toBeLessThanOrEqual(10);
    expect(LOCKOUT.baseMs * 2 ** 10).toBeGreaterThan(LOCKOUT.maxMs);
    expect(LOCKOUT.maxMs).toBeLessThanOrEqual(24 * 3600_000);
  });
});
