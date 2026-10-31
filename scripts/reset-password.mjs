#!/usr/bin/env node
// Operator tool: issue a one-time password reset code for a user (no email service is assumed).
// Usage: pnpm user:reset-password user@example.com   → give the printed code to the user, who enters
// it on the "Reset password" page within one hour.
import core from '../packages/core/dist/index.js';
import db from '../packages/db/dist/index.js';
import { issueResetToken } from './lib/reset-token.mjs';

const email = process.argv[2];
if (!email) {
  console.error('usage: pnpm user:reset-password <email>');
  process.exit(2);
}
const config = core.loadConfig();
const prisma = db.createPrisma(config.databaseUrl);
try {
  const token = await issueResetToken(prisma, email);
  console.log(`Reset code for ${email} (valid 1 hour):\n\n  ${token}\n`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
