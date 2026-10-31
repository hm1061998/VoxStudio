import { createHash, randomBytes } from 'node:crypto';

/** Issue a one-time password reset code (valid 1 hour). Only the SHA-256 hash is stored. */
export async function issueResetToken(prisma, email) {
  const user = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
  if (!user) throw new Error('No user with that email.');
  const token = randomBytes(24).toString('base64url');
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return token;
}
