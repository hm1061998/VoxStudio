import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4000',
    trace: 'retain-on-failure',
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  // Uses the built app (pnpm build). Reuses a server already running on :4000.
  webServer: {
    command: 'node scripts/start-all.mjs',
    url: 'http://localhost:4000/api/v1/health/ready',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
