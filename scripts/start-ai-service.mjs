#!/usr/bin/env node
// Starts the local AI voice service (services/vieneu) with the token from .env. Run before `pnpm start`.
// Python: VIENEU_PYTHON, else the venv next to the repo (../vox-datagen/.venv), else `python`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!env.VIENEU_SERVICE_TOKEN) {
  console.error('VIENEU_SERVICE_TOKEN is missing in .env');
  process.exit(1);
}
const venv = join(root, '..', 'vox-datagen', '.venv', 'Scripts', 'python.exe');
const python = process.env.VIENEU_PYTHON ?? (existsSync(venv) ? venv : 'python');
const child = spawn(python, [join(root, 'services', 'vieneu', 'server.py')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VIENEU_TOKEN: env.VIENEU_SERVICE_TOKEN,
    VIENEU_VOICES: 'Ngọc Huyền,Hải Đăng,Quang Sơn,Ngọc Trân,Thùy Dung,Adam',
  },
});
child.on('exit', (code) => process.exit(code ?? 1));
