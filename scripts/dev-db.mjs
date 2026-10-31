#!/usr/bin/env node
// Manages a project-local PostgreSQL cluster for development (does not touch any system cluster).
// Usage: node scripts/dev-db.mjs start|stop|status
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dataRoot = path.join(root, '.data');
const pgData = path.join(dataRoot, 'pg');
const port = process.env.DEV_PG_PORT ?? '5433';
const user = 'voxstudio';

function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  if (process.platform === 'win32') {
    for (const v of ['18', '17', '16']) {
      const p = `C:\\Program Files\\PostgreSQL\\${v}\\bin`;
      if (existsSync(path.join(p, 'pg_ctl.exe'))) return p;
    }
  }
  return '';
}
const bin = findPgBin();
const exe = (name) => (bin ? path.join(bin, process.platform === 'win32' ? `${name}.exe` : name) : name);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`[dev-db] ${path.basename(cmd)} failed with exit code ${r.status}`);
    process.exit(r.status ?? 1);
  }
  return r;
}

function ensureEnv(password) {
  const envPath = path.join(root, '.env');
  const examplePath = path.join(root, '.env.example');
  let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');
  const set = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
  };
  set('DATABASE_URL', `postgresql://${user}:${password}@127.0.0.1:${port}/voxstudio`);
  set('TEST_DATABASE_URL', `postgresql://${user}:${password}@127.0.0.1:${port}/voxstudio_test`);
  if (/^AUTH_SECRET=(change-me.*)?$/m.test(env)) set('AUTH_SECRET', randomBytes(32).toString('hex'));
  writeFileSync(envPath, env);
}

const cmd = process.argv[2] ?? 'start';
const pwFile = path.join(dataRoot, 'pg-password');

if (cmd === 'start') {
  mkdirSync(dataRoot, { recursive: true });
  if (!existsSync(path.join(pgData, 'PG_VERSION'))) {
    const password = randomBytes(18).toString('hex');
    writeFileSync(pwFile, password, { mode: 0o600 });
    run(exe('initdb'), [
      '-D',
      pgData,
      '-U',
      user,
      '--auth=scram-sha-256',
      `--pwfile=${pwFile}`,
      '-E',
      'UTF8',
      '--no-locale',
    ]);
  }
  const password = readFileSync(pwFile, 'utf8').trim();
  const status = run(exe('pg_ctl'), ['-D', pgData, 'status'], { allowFail: true, stdio: 'ignore' });
  if (status.status !== 0) {
    // Detached with its own console: the server must outlive this script and must not inherit our
    // stdio (otherwise this script never exits, and on Windows backends crash when the parent console closes).
    const child = spawn(
      exe('pg_ctl'),
      [
        '-D',
        pgData,
        '-o',
        `-p ${port} -c listen_addresses=127.0.0.1`,
        '-l',
        path.join(dataRoot, 'pg.log'),
        'start',
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = spawnSync(exe('pg_isready'), ['-h', '127.0.0.1', '-p', port], { stdio: 'ignore' }).status === 0;
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      console.error('[dev-db] PostgreSQL did not become ready; see .data/pg.log');
      process.exit(1);
    }
  }
  const env = { ...process.env, PGPASSWORD: password };
  for (const db of ['voxstudio', 'voxstudio_test']) {
    const exists = spawnSync(
      exe('psql'),
      [
        '-h',
        '127.0.0.1',
        '-p',
        port,
        '-U',
        user,
        '-d',
        'postgres',
        '-tAc',
        `SELECT 1 FROM pg_database WHERE datname='${db}'`,
      ],
      { env, encoding: 'utf8' },
    );
    if (!exists.stdout?.includes('1'))
      run(exe('createdb'), ['-h', '127.0.0.1', '-p', port, '-U', user, db], { env });
  }
  ensureEnv(password);
  console.log(
    `[dev-db] PostgreSQL running on 127.0.0.1:${port} (data: .data/pg). DATABASE_URL written to .env`,
  );
} else if (cmd === 'stop') {
  run(exe('pg_ctl'), ['-D', pgData, '-m', 'fast', 'stop'], { allowFail: true });
} else if (cmd === 'status') {
  run(exe('pg_ctl'), ['-D', pgData, 'status'], { allowFail: true });
} else if (cmd === 'destroy') {
  run(exe('pg_ctl'), ['-D', pgData, '-m', 'fast', 'stop'], { allowFail: true });
  rmSync(pgData, { recursive: true, force: true });
  rmSync(pwFile, { force: true });
} else {
  console.error('usage: dev-db.mjs start|stop|status|destroy');
  process.exit(2);
}
