import type { DiskThresholds } from './disk';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolvePlanLimits, type PlanId, type PlanLimits } from './plans';
import { resolveToolPaths, type ToolPaths } from './tools';

export const KNOWN_ENGINES = ['espeak', 'vnunit', 'vieneu'] as const;

/** Parse ENABLED_ENGINES; unknown names are an error so a typo cannot silently drop an engine. */
export function parseEnabledEngines(value: string): string[] {
  const list = [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const unknown = list.filter((n) => !(KNOWN_ENGINES as readonly string[]).includes(n));
  if (unknown.length) throw new Error(`ENABLED_ENGINES: unknown engine(s) ${unknown.join(', ')}.`);
  if (!list.length) throw new Error('ENABLED_ENGINES must list at least one engine.');
  return list;
}

/** Find the repository root (directory containing pnpm-workspace.yaml) for default relative paths. */
export function findRepoRoot(start = __dirname): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/** Minimal .env loader (KEY=VALUE lines); real environment variables take precedence. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const intFromEnv = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PUBLIC_BASE_URL: z.url().default('http://localhost:4000'),
  API_PORT: intFromEnv(4000, 1, 65535),
  CORS_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string(),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  ADMIN_EMAILS: z.string().default(''),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  TEMP_DIR: z.string().default('./tmp'),
  WORKER_CONCURRENCY: intFromEnv(2, 1, 16),
  PREVIEW_MAX_CHARS: intFromEnv(1000, 1, 5000),
  SEGMENT_MAX_CHARS: intFromEnv(5000, 1, 5000),
  RENDER_MAX_CHARS: intFromEnv(100_000, 1, 1_000_000),
  RENDER_TIMEOUT_SECONDS: intFromEnv(600, 10, 7200),
  ENGINE_TIMEOUT_SECONDS: intFromEnv(60, 5, 600),
  QUEUE_MAX_PENDING_PER_WORKSPACE: intFromEnv(20, 1, 1000),
  ESPEAK_PATH: z.string().default(''),
  ESPEAK_APPROVED_VERSION: z.string().default('1.52.0'),
  FFMPEG_PATH: z.string().default(''),
  FFPROBE_PATH: z.string().default(''),
  /**
   * Engines offered to users (comma separated: espeak, vnunit, vieneu). Default: the AI voice engine only. The
   * rule-based eSpeak engine is not offered unless listed (development, tests, languages other than Vietnamese).
   */
  ENABLED_ENGINES: z.string().default('vieneu'),
  /** Directory of Vietnamese unit databases; the unit-selection engine is registered only when set. */
  VN_UNIT_DB_DIR: z.string().default(''),
  /** Comma-separated base URLs of the VieNeu model service (ADR 0008). Empty = the AI engine is not registered. */
  /** When false, nobody can self-register: accounts are created by an administrator or the operator. */
  ALLOW_REGISTRATION: z.enum(['true', 'false']).default('true'),
  /** A session unused for this many hours is signed out even if it has not expired. */
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /**
   * Which proxies may set X-Forwarded-For (Express "trust proxy" value: loopback, a CIDR list, or a hop count).
   * Wrong values let clients spoof their address and dodge rate limits, or put every client behind the proxy address.
   */
  TRUST_PROXY: z.string().default('loopback'),
  /** Seconds of waiting that add one priority point to a queued job (anti-starvation). */
  /** Disk protection (docs/superpowers/specs/2026-11-01-disk-protection-design.md). */
  DISK_WARN_FREE_PERCENT: z.coerce.number().min(1).max(90).default(20),
  DISK_BLOCK_FREE_PERCENT: z.coerce.number().min(0.5).max(80).default(8),
  DISK_MIN_FREE_MB: z.coerce.number().int().min(0).default(1024),
  /** Finished render jobs and audit events older than this are deleted daily. */
  JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
  QUEUE_AGING_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  /** Optional JSON overriding plan limits, e.g. {"pro":{"aiMonthlyChars":1000000}}. */
  PLAN_LIMITS_JSON: z.string().default(''),
  VIENEU_SERVICE_URLS: z.string().default(''),
  VIENEU_SERVICE_TOKEN: z.string().default(''),
  /** The operator's admission decision for the AI engine (docs/decisions/0008). Without it the engine stays "unverified". */
  VIENEU_APPROVED: z.enum(['true', 'false']).default('false'),
  VIENEU_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(180),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  publicBaseUrl: string;
  apiPort: number;
  corsOrigins: string[];
  databaseUrl: string;
  authSecret: string;
  cookieSecure: boolean;
  adminEmails: string[];
  storageRoot: string;
  tempDir: string;
  workerConcurrency: number;
  previewMaxChars: number;
  segmentMaxChars: number;
  renderMaxChars: number;
  renderTimeoutMs: number;
  engineTimeoutMs: number;
  queueMaxPendingPerWorkspace: number;
  espeakApprovedVersion: string;
  allowRegistration: boolean;
  sessionIdleMs: number;
  trustProxy: string;
  enabledEngines: string[];
  vnUnitDbDir: string | null;
  queueAgingSeconds: number;
  disk: DiskThresholds;
  jobRetentionDays: number;
  auditRetentionDays: number;
  planLimits: Record<PlanId, PlanLimits>;
  vieneuServiceUrls: string[];
  vieneuServiceToken: string;
  vieneuApproved: boolean;
  vieneuTimeoutMs: number;
  tools: ToolPaths;
  repoRoot: string;
}

/** Load and validate configuration. Fails fast on missing or weak secrets. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = findRepoRoot();
  if (env === process.env) loadDotEnv(path.join(root, '.env'));
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.DISK_BLOCK_FREE_PERCENT >= e.DISK_WARN_FREE_PERCENT)
    throw new Error(
      'Invalid configuration: DISK_BLOCK_FREE_PERCENT must be lower than DISK_WARN_FREE_PERCENT',
    );
  if (e.AUTH_SECRET.length < 32 || /change-me/i.test(e.AUTH_SECRET))
    throw new Error('Invalid configuration: AUTH_SECRET must be at least 32 random characters.');
  if (e.NODE_ENV === 'production' && e.COOKIE_SECURE !== 'true')
    throw new Error('Invalid configuration: COOKIE_SECURE must be true in production (serve behind TLS).');
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    apiPort: e.API_PORT,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl: e.DATABASE_URL,
    authSecret: e.AUTH_SECRET,
    cookieSecure: e.COOKIE_SECURE === 'true',
    adminEmails: e.ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    storageRoot: abs(e.STORAGE_LOCAL_ROOT),
    tempDir: abs(e.TEMP_DIR),
    workerConcurrency: e.WORKER_CONCURRENCY,
    previewMaxChars: e.PREVIEW_MAX_CHARS,
    segmentMaxChars: e.SEGMENT_MAX_CHARS,
    renderMaxChars: e.RENDER_MAX_CHARS,
    renderTimeoutMs: e.RENDER_TIMEOUT_SECONDS * 1000,
    engineTimeoutMs: e.ENGINE_TIMEOUT_SECONDS * 1000,
    queueMaxPendingPerWorkspace: e.QUEUE_MAX_PENDING_PER_WORKSPACE,
    espeakApprovedVersion: e.ESPEAK_APPROVED_VERSION,
    allowRegistration: e.ALLOW_REGISTRATION === 'true',
    sessionIdleMs: e.SESSION_IDLE_HOURS * 3600_000,
    trustProxy: e.TRUST_PROXY,
    enabledEngines: parseEnabledEngines(e.ENABLED_ENGINES),
    vnUnitDbDir: e.VN_UNIT_DB_DIR ? abs(e.VN_UNIT_DB_DIR) : null,
    queueAgingSeconds: e.QUEUE_AGING_SECONDS,
    disk: {
      warnFreePercent: e.DISK_WARN_FREE_PERCENT,
      blockFreePercent: e.DISK_BLOCK_FREE_PERCENT,
      minFreeBytes: e.DISK_MIN_FREE_MB * 1024 * 1024,
    },
    jobRetentionDays: e.JOB_RETENTION_DAYS,
    auditRetentionDays: e.AUDIT_RETENTION_DAYS,
    planLimits: resolvePlanLimits(e.PLAN_LIMITS_JSON),
    vieneuServiceUrls: e.VIENEU_SERVICE_URLS.split(',')
      .map((u) => u.trim().replace(/\/$/, ''))
      .filter(Boolean),
    vieneuServiceToken: e.VIENEU_SERVICE_TOKEN,
    vieneuApproved: e.VIENEU_APPROVED === 'true',
    vieneuTimeoutMs: e.VIENEU_TIMEOUT_SECONDS * 1000,
    tools: resolveToolPaths(env),
    repoRoot: root,
  };
}

/** Create a private per-job temp directory and always remove it afterwards. */
export async function withTempDir<T>(
  root: string,
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `${prefix.replace(/[^a-z0-9-]/gi, '')}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
