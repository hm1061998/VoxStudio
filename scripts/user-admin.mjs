#!/usr/bin/env node
// Operator tool for accounts, run on the server with database access (nobody can reach it through the web).
//   node scripts/user-admin.mjs list
//   node scripts/user-admin.mjs promote|demote|suspend|activate|revoke <email>
// Needed for the first administrator when ADMIN_EMAILS was not used, and when registration is closed.
// Every change is written to the audit log and ends the account's sessions where that is the safe thing to do.
import path from 'node:path';
import core from '../packages/core/dist/index.js';
import { createPrisma } from '../packages/db/dist/index.js';

core.loadDotEnv(path.resolve(import.meta.dirname, '..', '.env'));
const [cmd, emailArg] = process.argv.slice(2);
const prisma = createPrisma(process.env.DATABASE_URL);

async function main() {
  if (cmd === 'list') {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    for (const u of users)
      console.log(`${u.role.padEnd(6)} ${u.status.padEnd(9)} ${u.email}  (${u.displayName})`);
    return;
  }
  if (!['promote', 'demote', 'suspend', 'activate', 'revoke'].includes(cmd ?? '') || !emailArg) {
    console.error('usage: node scripts/user-admin.mjs list | promote|demote|suspend|activate|revoke <email>');
    process.exit(2);
  }
  const user = await prisma.user.findUnique({ where: { email: emailArg.trim().toLowerCase() } });
  if (!user) {
    console.error('No such account.');
    process.exit(1);
  }
  const next = {
    promote: { role: 'admin' },
    demote: { role: 'user' },
    suspend: { status: 'suspended' },
    activate: { status: 'active' },
    revoke: {},
  }[cmd];
  if ((cmd === 'demote' || cmd === 'suspend') && user.role === 'admin' && user.status === 'active') {
    const others = await prisma.user.count({
      where: { role: 'admin', status: 'active', id: { not: user.id } },
    });
    if (others === 0) {
      console.error('Refused: this is the last active administrator.');
      process.exit(1);
    }
  }
  if (Object.keys(next).length) await prisma.user.update({ where: { id: user.id }, data: next });
  const revoked =
    cmd === 'promote' || cmd === 'activate'
      ? { count: 0 }
      : await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.auditEvent.create({
    data: {
      eventType: `cli.user_${cmd}`,
      resourceType: 'user',
      resourceId: user.id,
      metadataJson: { by: 'operator-cli', revokedSessions: revoked.count },
    },
  });
  console.log(`${cmd}: ${user.email} (${revoked.count} session(s) ended)`);
}
try {
  await main();
} finally {
  await prisma.$disconnect();
}
