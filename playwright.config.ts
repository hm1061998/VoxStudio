import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E_PORT runs the suite beside an application that already uses :4000 (for example your own `pnpm start`).
 * That mode also uses the test database (TEST_DATABASE_URL), so the other application's worker cannot pick up
 * the test jobs and the tests never touch your real projects.
 */
const PORT = process.env.E2E_PORT ?? '4000';
if (process.env.E2E_PORT) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    try {
      url = /^TEST_DATABASE_URL=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim();
    } catch {
      /* no .env */
    }
  }
  if (!url) throw new Error('E2E_PORT needs TEST_DATABASE_URL (run `pnpm db:start`).');
  process.env.DATABASE_URL = url;
}

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  // Uses the built app (pnpm build). Reuses a server already running on the port.
  webServer: {
    command: 'node scripts/start-all.mjs',
    url: `http://localhost:${PORT}/api/v1/health/ready`,
    reuseExistingServer: true,
    // Rule-based voices are not offered by default; the suites that exercise them enable the engine explicitly.
    env: {
      API_PORT: PORT,
      CORS_ORIGINS: `http://localhost:${PORT}`,
      PLAN_PRICES_VND_JSON: '{"pro":100000,"business":300000}',
      PAYMENT_WEBHOOK_SECRET: 'e2e-webhook-secret-123456',
      PAYMENT_BANK_NAME: 'Test Bank',
      PAYMENT_BANK_ACCOUNT: '0123456789',
      PAYMENT_BANK_HOLDER: 'VOXSTUDIO',
      ENABLED_ENGINES: process.env.E2E_AI ? 'espeak,vieneu' : 'espeak',
    },
    timeout: 120_000,
  },
});
