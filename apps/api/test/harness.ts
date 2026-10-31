import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { findRepoRoot, loadConfig, loadDotEnv, type AppConfig } from '@voxstudio/core';
import { createPrisma, type PrismaClient } from '@voxstudio/db';
import request from 'supertest';
// Compiled output: Nest DI needs emitDecoratorMetadata, which Vitest's esbuild transform lacks.
import { createApp } from '../dist/bootstrap';
import { RenderWorker } from '../../worker/dist/worker';

const root = findRepoRoot(__dirname);
loadDotEnv(path.join(root, '.env'));

export interface Harness {
  app: NestExpressApplication;
  prisma: PrismaClient;
  worker: RenderWorker;
  config: AppConfig;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

let migrated = false;
export function migrateTestDb(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (run `pnpm db:start`).');
  if (!migrated) {
    const prismaBin = path.join(
      root,
      'packages',
      'db',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
    );
    execFileSync(prismaBin, ['migrate', 'deploy'], {
      cwd: path.join(root, 'packages', 'db'),
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    migrated = true;
  }
  return url;
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const url = migrateTestDb();
  const tmp = mkdtempSync(path.join(tmpdir(), 'vs-api-test-'));
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    STORAGE_LOCAL_ROOT: path.join(tmp, 'storage'),
    TEMP_DIR: path.join(tmp, 'tmp'),
    ADMIN_EMAILS: 'admin@example.test',
    CORS_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
  const prisma = createPrisma(url);
  // Clean slate in the dedicated test database (never the dev/prod database).
  if (!/_test(\?|$)/.test(new URL(url).pathname + (new URL(url).search ? '?' : '')))
    throw new Error('Refusing to truncate a non-test database');
  await prisma.$executeRawUnsafe(
    'TRUNCATE users, sessions, password_reset_tokens, workspaces, workspace_members, projects, project_segments, voice_presets, pronunciation_entries, render_jobs, audio_assets, project_versions, audit_events, worker_heartbeats, tts_voices, tts_engines CASCADE',
  );
  const app = await createApp(config);
  const worker = new RenderWorker({ config, prisma, pollMs: 200, logger: () => undefined });
  await worker.start();
  return {
    app,
    prisma,
    worker,
    config,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await worker.stop({ abortRunning: true });
      await app.close();
      await prisma.$disconnect();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  csrf: string;
  cookie: string;
  workspaceId: string;
  userId: string;
}

export async function register(h: Harness, email: string): Promise<TestUser> {
  const r = await h
    .http()
    .post('/api/v1/auth/register')
    .send({ email, password: 'correct-horse-battery', displayName: email.split('@')[0] });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  const cookie = (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return {
    csrf: r.body.data.csrfToken,
    cookie,
    workspaceId: r.body.data.user.workspaces[0].id,
    userId: r.body.data.user.id,
  };
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export function as(h: Harness, u: TestUser) {
  const call = (m: Method, url: string, body?: unknown) => {
    const req = h.http()[m](`/api/v1${url}`).set('Cookie', u.cookie).set('x-csrf-token', u.csrf);
    return body === undefined ? req : req.send(body as object);
  };
  return {
    get: (url: string) => call('get', url),
    post: (url: string, body: unknown = {}) => call('post', url, body),
    put: (url: string, body: unknown) => call('put', url, body),
    patch: (url: string, body: unknown) => call('patch', url, body),
    del: (url: string) => call('delete', url),
  };
}

export async function waitForJob(
  h: Harness,
  u: TestUser,
  jobId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; [k: string]: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await as(h, u).get(`/render-jobs/${jobId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(r.body.data.status)) return r.body.data;
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('job did not finish in time');
}
