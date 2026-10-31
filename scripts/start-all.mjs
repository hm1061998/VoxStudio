#!/usr/bin/env node
// Runs migrations, then the API (which also serves the built web client) and the render worker.
// Usage: pnpm build && pnpm start     (single-node, non-Docker deployment)
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const migrate = spawnSync('pnpm', ['--filter', '@voxstudio/db', 'migrate:deploy'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (migrate.status !== 0) {
  console.error('[start] database migration failed');
  process.exit(migrate.status ?? 1);
}

const procs = [
  ['api', path.join(root, 'apps', 'api', 'dist', 'main.js')],
  ['worker', path.join(root, 'apps', 'worker', 'dist', 'main.js')],
].map(([name, entry]) => {
  const p = spawn(process.execPath, ['--enable-source-maps', entry], { cwd: root, stdio: 'inherit' });
  p.on('exit', (code) => {
    console.error(`[start] ${name} exited with code ${code}; stopping`);
    shutdown(code ?? 1);
  });
  return p;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
