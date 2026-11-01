#!/usr/bin/env node
// Captures screenshots of the main screens (light and dark, desktop and phone) from a RUNNING test server,
// for a human to look at. Usage: node scripts/ui-shots.mjs [--base http://localhost:4010] [--out dir]
// Registers a throwaway account on that server, so point it at a test database only.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const base = arg('--base', 'http://localhost:4010').replace(/\/$/, '');
const out = arg('--out', 'qa-output/ui-shots');
mkdirSync(out, { recursive: true });

const email = `shots-${randomUUID().slice(0, 8)}@example.test`;
const password = `shots-${randomUUID()}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
const reg = await ctx.request.post('/api/v1/auth/register', {
  data: { email, password, displayName: 'Minh' },
  headers: {
    'x-forwarded-for': `10.88.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  },
});
if (reg.status() !== 201) throw new Error(`register failed: ${reg.status()}`);
const shots = [
  ['/', 'home'],
  ['/voices', 'voices'],
  ['/settings/profile', 'account-profile'],
  ['/settings/plan', 'account-plan'],
  ['/settings/password', 'account-password'],
];
for (const scheme of ['light', 'dark']) {
  for (const [w, h, tag] of [
    [1440, 900, 'desktop'],
    [390, 844, 'phone'],
  ]) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path, name] of shots) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `${out}/${name}-${tag}-${scheme}.png`, fullPage: false });
    }
    await page.close();
  }
}
await browser.close();
console.log(`saved to ${out}`);
