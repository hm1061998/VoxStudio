#!/usr/bin/env node
// Backup / restore for single-node deployments (database + audio storage, backed up separately).
//   node scripts/backup.mjs backup [outDir]                 → backups/<timestamp>/{db.dump,storage/,manifest.json}
//   node scripts/backup.mjs verify <backupDir>              → restores into a scratch DB + temp storage and checks it
//   node scripts/backup.mjs restore <backupDir> --yes       → restores over the configured DATABASE_URL + storage root
// Requires pg_dump/pg_restore/psql (PG_BIN or PATH) and `pnpm build`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import core from '../packages/core/dist/index.js';

const root = path.resolve(import.meta.dirname, '..');
const config = core.loadConfig();
const pgBin =
  process.env.PG_BIN ??
  (process.platform === 'win32' && existsSync('C:\\Program Files\\PostgreSQL\\18\\bin')
    ? 'C:\\Program Files\\PostgreSQL\\18\\bin'
    : '');
const exe = (n) => (pgBin ? path.join(pgBin, process.platform === 'win32' ? `${n}.exe` : n) : n);

function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    db: u.pathname.slice(1),
  };
}
function pg(cmd, args, db, opts = {}) {
  const r = spawnSync(exe(cmd), ['-h', db.host, '-p', db.port, '-U', db.user, ...args], {
    env: { ...process.env, PGPASSWORD: db.password },
    encoding: 'utf8',
    ...opts,
  });
  if (r.status !== 0)
    throw new Error(`${cmd} failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory()
      ? listFiles(p, base)
      : e.name.endsWith('.part') || e.name === '.health'
        ? []
        : [path.relative(base, p).split(path.sep).join('/')];
  });
}
const TABLES = [
  'users',
  'projects',
  'project_segments',
  'render_jobs',
  'audio_assets',
  'pronunciation_entries',
  'voice_presets',
  'project_versions',
];
function counts(db) {
  const out = {};
  for (const t of TABLES)
    out[t] = Number(pg('psql', ['-d', db.db, '-tAc', `SELECT count(*) FROM ${t}`], db).trim());
  return out;
}

const [cmd, arg, flag] = process.argv.slice(2);
const db = parseDbUrl(config.databaseUrl);

if (cmd === 'backup') {
  const out = path.resolve(arg ?? path.join(root, 'backups', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });
  pg('pg_dump', ['-d', db.db, '-Fc', '--no-owner', '-f', path.join(out, 'db.dump')], db);
  cpSync(config.storageRoot, path.join(out, 'storage'), {
    recursive: true,
    filter: (s) => !s.endsWith('.part'),
  });
  const files = listFiles(path.join(out, 'storage'));
  const manifest = {
    createdAt: new Date().toISOString(),
    counts: counts(db),
    storageFiles: files.length,
    storageBytes: files.reduce((n, f) => n + statSync(path.join(out, 'storage', f)).size, 0),
    dbDumpSha256: sha256(path.join(out, 'db.dump')),
  };
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Backup written to ${out}\n${JSON.stringify(manifest, null, 2)}`);
} else if (cmd === 'verify' || cmd === 'restore') {
  if (!arg) throw new Error('backup directory required');
  const dir = path.resolve(arg);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (sha256(path.join(dir, 'db.dump')) !== manifest.dbDumpSha256)
    throw new Error('db.dump checksum mismatch');
  let target = db;
  let storageTarget = config.storageRoot;
  if (cmd === 'verify') {
    target = { ...db, db: 'voxstudio_restore_check' };
    pg('psql', ['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${target.db}`], db);
    pg('psql', ['-d', 'postgres', '-c', `CREATE DATABASE ${target.db}`], db);
    storageTarget = mkdtempSync(path.join(tmpdir(), 'vs-restore-'));
  } else if (flag !== '--yes') {
    console.error('Refusing to overwrite the live database without --yes. Stop the API and worker first.');
    process.exit(2);
  }
  pg(
    'pg_restore',
    ['-d', target.db, '--clean', '--if-exists', '--no-owner', path.join(dir, 'db.dump')],
    target,
  );
  cpSync(path.join(dir, 'storage'), storageTarget, { recursive: true });
  const restored = counts(target);
  const mismatched = TABLES.filter((t) => restored[t] !== manifest.counts[t]);
  // Every asset row must have its file with the recorded checksum.
  const assets = pg(
    'psql',
    ['-d', target.db, '-tA', '-F', '|', '-c', 'SELECT storage_key, checksum_sha256 FROM audio_assets'],
    target,
  )
    .trim()
    // psql on Windows emits CRLF; a stray \r would corrupt every checksum but the last.
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('|'));
  const missing = assets.filter(([key, sum]) => {
    const f = path.join(storageTarget, key);
    return !existsSync(f) || sha256(f) !== sum;
  });
  console.log(
    JSON.stringify(
      {
        restoredInto: target.db,
        counts: restored,
        mismatchedTables: mismatched,
        assetsChecked: assets.length,
        assetsMissingOrCorrupt: missing.length,
      },
      null,
      2,
    ),
  );
  if (cmd === 'verify') {
    pg('psql', ['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${target.db}`], db);
    rmSync(storageTarget, { recursive: true, force: true });
  }
  if (mismatched.length || missing.length) {
    console.error('Restore verification FAILED');
    process.exit(1);
  }
  console.log(`Restore ${cmd === 'verify' ? 'verification' : ''} OK`);
} else {
  console.error('usage: backup.mjs backup [dir] | verify <dir> | restore <dir> --yes');
  process.exit(2);
}
