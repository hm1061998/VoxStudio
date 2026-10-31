import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';

// Throwaway test account generated per run (local dev server only).
const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
const password = `e2e-${randomUUID()}`;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => r.status() >= 500 && errors.push(`${r.status()} ${r.url()}`));
  return errors;
}

async function playerDuration(page: Page): Promise<number> {
  const text =
    (await page
      .getByRole('region', { name: /Audio player|Trình phát âm thanh/ })
      .locator('span.font-mono')
      .first()
      .textContent()) ?? '';
  const total = text.split('/')[1]!.trim();
  const [m, s] = total.split(':');
  return Number(m) * 60 + Number(s);
}

test('full journey: register → project → segments → preview → settings → render → export → download → reopen', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.goto('/register');
  await page.getByLabel('Your name').fill('E2E Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // Create project with an approved voice.
  await page.getByRole('button', { name: '+ New project' }).click();
  await page.getByLabel('Project name').fill('E2E narration');
  await expect(page.locator('input[name="voice"][value="espeak:en-us"]')).toBeChecked();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('E2E narration');

  // Segment 1 with Unicode + a pause marker.
  await page.getByRole('button', { name: '+ Add' }).click();
  const editor = page.getByLabel('Paragraph text');
  await editor.fill('Hello from the end-to-end test. Café, naïve — “quotes”.');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  // Normalization preview shows what the engine reads.
  await page.getByLabel('Show how it will be read').check();
  await expect(page.getByText('Text as it will be read')).toBeVisible();

  // Preview real audio.
  await page.getByRole('button', { name: '▶ Listen', exact: true }).click();
  await expect(page.getByText('Paragraph 1', { exact: true })).toBeVisible();
  await expect.poll(() => playerDuration(page)).toBeGreaterThan(1);
  const normal = await playerDuration(page);

  // Change engine-native rate in the inspector and preview again: duration must shrink.
  await page.locator('header').getByRole('radio', { name: 'Advanced' }).click();
  const rate = page.getByRole('spinbutton', { name: 'Speaking speed value' });
  await page.getByRole('tab', { name: 'Timing' }).click();
  await rate.fill('1.6');
  await rate.blur();
  await page.getByRole('button', { name: '▶ Listen', exact: true }).click();
  await expect.poll(async () => playerDuration(page), { timeout: 30_000 }).toBeLessThan(normal * 0.8);

  // DSP controls are labelled as DSP.
  await page.getByRole('tab', { name: 'Audio processing' }).click();
  await expect(page.getByLabel('Time stretch', { exact: true })).toBeVisible();

  // Second segment.
  await page.getByRole('button', { name: '+ Add' }).click();
  await page.getByLabel('Paragraph text').fill('Second segment. [pause 500ms] Rendered in order.');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paragraphs (2)' })).toBeVisible();

  // Render the project.
  await page.getByRole('button', { name: '⏵ Create full audio' }).click();
  const queue = page.getByRole('region', { name: 'Exports' });
  await expect(queue.getByText('✓ Done').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Full audio · WAV/)).toBeVisible();

  // Export MP3 and download it.
  await page.getByRole('button', { name: 'Export audio…' }).click();
  await page.getByRole('radio', { name: 'MP3' }).check();
  await page.getByRole('button', { name: 'Create & export' }).click();
  await expect(queue.getByText('MP3 44.1k mono')).toBeVisible();
  const mp3Job = queue.locator('div.rounded-md', { hasText: 'MP3 44.1k mono' });
  const dl = mp3Job.getByRole('link', { name: /Download/ });
  await expect(dl).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  expect(download.suggestedFilename()).toMatch(/^E2E.narration\.mp3$/);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.length).toBeGreaterThan(5000);
  expect(
    bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0),
  ).toBe(true);

  // Reopen: settings and audio state persist.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Paragraphs (2)' })).toBeVisible();
  await page.getByRole('button', { name: /^Paragraph 1:/ }).click();
  await page.getByRole('tab', { name: 'Timing' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Speaking speed value' })).toHaveValue('1.6');
  await expect(page.getByText('● Audio ready')).toHaveCount(2);

  // Undo/redo via keyboard outside text fields.
  await page.getByRole('button', { name: /^Paragraph 2:/ }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByRole('button', { name: /^Paragraph 1:.*Second segment/ })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /^Paragraph 1:.*Hello/ })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('voice library sample, unauthenticated redirect, keyboard focus', async ({ page, context, request }) => {
  const errors = trackErrors(page);
  // Independent account (workers restart after failures, so don't rely on the first test's user).
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = `e2e-${randomUUID()}`;
  expect(
    (
      await request.post('/api/v1/auth/register', { data: { email, password, displayName: 'E2E Two' } })
    ).status(),
  ).toBe(201);
  await context.clearCookies();
  await page.goto('/voices');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Voices' }).click();
  await page.getByRole('button', { name: /German/ }).click();
  await expect(page.getByText('What you can adjust')).toBeVisible();
  await page.getByRole('button', { name: '▶ Listen to sample' }).click();
  await expect(page.getByLabel('Voice sample')).toBeVisible({ timeout: 30_000 });
  // Japanese failed automated QA and must not be offered.
  await expect(page.getByRole('button', { name: /Japanese/ })).toHaveCount(0);
  // Keyboard: skip link is first in tab order on a fresh page load.
  await page.goto('/voices');
  await expect(page.getByRole('heading', { name: 'Voices', exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Vietnamese interface and Vietnamese speech (simple mode)', async ({ page, request, context }) => {
  const errors = trackErrors(page);
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = `e2e-${randomUUID()}`;
  expect(
    (
      await request.post('/api/v1/auth/register', { data: { email, password, displayName: 'Người dùng' } })
    ).status(),
  ).toBe(201);
  await context.clearCookies();
  await page.addInitScript(() => localStorage.setItem('vs-lang', 'vi'));
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('heading', { name: 'Tạo tệp âm thanh đầu tiên trong 3 bước' })).toBeVisible();

  // Create a project with pasted Vietnamese text; paragraphs become separate parts.
  await page.getByRole('button', { name: 'Tạo dự án đầu tiên' }).click();
  await expect(page.locator('input[name="voice"][value="espeak:vi"]')).toBeChecked();
  await page
    .getByLabel('Văn bản của bạn (không bắt buộc)')
    .fill('Xin chào các bạn. Hôm nay là 31/10/2026, giá 150.000đ.\n\nĐoạn thứ hai lúc 14h30.');
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Các đoạn (2)' })).toBeVisible();

  // Simple mode shows only the essentials.
  await expect(page.getByLabel('Tốc độ đọc')).toBeVisible();
  await expect(page.getByLabel('Dịch cao độ')).toHaveCount(0);

  // The engine will read dates, money and times in Vietnamese.
  await page.getByLabel('Xem máy sẽ đọc như thế nào').check();
  await expect(page.getByText('ngày 31 tháng 10 năm 2026').first()).toBeVisible();
  await expect(page.getByText('150.000 đồng').first()).toBeVisible();

  // Listen to real Vietnamese audio.
  await page.getByRole('button', { name: '▶ Nghe thử', exact: true }).click();
  await expect(page.getByText('Đoạn 1', { exact: true })).toBeVisible();
  await expect.poll(() => playerDuration(page)).toBeGreaterThan(2);

  // Switch language back to English without reloading.
  await page.getByLabel('Ngôn ngữ giao diện').first().selectOption('en');
  await expect(page.getByRole('heading', { name: 'Paragraphs (2)' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('voice workflow: accent, engine info, previews to compare, diagnostics, pronunciation, render engine', async ({
  page,
  request,
  context,
}) => {
  const errors = trackErrors(page);
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = `e2e-${randomUUID()}`;
  expect(
    (await request.post('/api/v1/auth/register', { data: { email, password, displayName: 'QA' } })).status(),
  ).toBe(201);
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // Vietnamese project with the Northern voice.
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Voice workflow');
  await page.getByLabel('Language of the text').selectOption('vi-VN');
  await page.locator('input[name="voice"][value="espeak:vi"]').check();
  await page.getByLabel('Your text (optional)').fill('Má mà mả marketing.');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paragraphs (1)' })).toBeVisible();
  await page.locator('#main').getByRole('radio', { name: 'Advanced' }).click();

  // Voice information: language, accent, engine, recordings status.
  const inspector = page.getByRole('region', { name: 'Voice settings' });
  await expect(inspector.getByLabel('Regional accent')).toHaveValue('northern');
  await expect(inspector.getByLabel('Regional accent').locator('option')).toHaveText([
    'Central',
    'Northern',
    'Southern',
  ]);
  await expect(inspector.getByText('Rule-based voice: there are no recordings.')).toBeVisible();
  await expect(inspector.locator('dl').first()).toContainText('Vietnamese · Northern');
  await expect(inspector.locator('dl').first()).toContainText('eSpeak NG');
  // Engine capabilities are explained, and unsupported controls are never shown as working.
  await inspector.getByText(/handled by the engine · \d+ by audio processing/).click();
  await expect(inspector.getByText(/Audio processing: applied to the finished audio/)).toBeVisible();

  // Sample of the voice itself: real audio from the server.
  await inspector.getByRole('button', { name: '▶ Listen to this voice' }).click();
  await expect(inspector.getByLabel('Voice sample')).toBeVisible();
  await expect
    .poll(() => inspector.getByLabel('Voice sample').evaluate((a: HTMLAudioElement) => a.duration))
    .toBeGreaterThan(0.5);

  // Preview 1 (Northern), then a second preview with another accent and a faster rate.
  await page.getByRole('button', { name: '▶ Listen', exact: true }).click();
  const takes = page.getByRole('region', { name: 'Previews to compare' });
  await expect(takes.getByText('Preview 1')).toBeVisible();
  await expect(takes.getByText('Made by eSpeak NG 1.52.0')).toBeVisible();
  await inspector.getByLabel('Regional accent').selectOption('southern');
  await expect(inspector.getByLabel('Voice', { exact: true })).toHaveValue('espeak:vi-vn-x-south');
  await inspector.getByRole('tab', { name: 'Timing' }).click();
  await inspector.getByLabel('Speaking speed value').fill('1.5');
  await page.getByRole('button', { name: '▶ Listen', exact: true }).click();
  await expect(takes.getByText('Preview 2')).toBeVisible();

  // Compare: the differences are listed from the real settings of both previews.
  await takes.getByLabel('Compare preview 1').check();
  await takes.getByLabel('Compare preview 2').check();
  const cmp = takes.getByRole('region', { name: 'compare' });
  await expect(cmp).toContainText('Comparing preview 1 with preview 2');
  await expect(cmp).toContainText(/Voice: Vietnamese — Northern.* → Vietnamese — Southern/);
  await expect(cmp).toContainText('1.5');
  // Both previews are real, different WAV files served by the API.
  const bodies: Buffer[] = [];
  for (const n of [1, 2]) {
    const src = await takes.getByLabel('Audio of preview ' + n).getAttribute('src');
    const res = await page.request.get(src!);
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.subarray(0, 4).toString()).toBe('RIFF');
    expect(body.length).toBeGreaterThan(5000);
    bodies.push(body);
  }
  expect(bodies[0]!.equals(bodies[1]!)).toBe(false);

  // Apply preview 1's voice and settings back to all paragraphs.
  await takes.getByRole('button', { name: 'Use for all paragraphs' }).last().click();
  await expect(page.getByText('Applied to 1 paragraph(s).').first()).toBeVisible();
  await expect(inspector.getByLabel('Voice', { exact: true })).toHaveValue('espeak:vi');

  // Spelling analysis: tones and an unreadable word.
  await page.getByLabel('Show how it will be read').check();
  await expect(page.getByText('Tones and syllables (spelling analysis)')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'rising (sắc)' })).toBeVisible();
  await expect(page.getByText(/Cannot be read as Vietnamese: marketing/)).toBeVisible();

  // Pronunciation override from the editor.
  await page.getByRole('button', { name: 'Add pronunciation…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Written as').fill('marketing');
  await dlg.getByLabel('Pronounced like').fill('mác két ting');
  await dlg.getByRole('button', { name: 'Save to dictionary' }).click();
  await expect(dlg.getByText('Saved. Press Listen to hear it.')).toBeVisible();
  await expect(dlg.getByRole('link', { name: 'Open pronunciation dictionary' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText(/Cannot be read as Vietnamese: marketing/)).toHaveCount(0);

  // Render and see the engine that made it.
  await page.getByRole('button', { name: 'Create full audio' }).click();
  await expect(page.getByTestId('render-engine').first()).toHaveText('Made with eSpeak NG 1.52.0', {
    timeout: 30_000,
  });
  expect(errors, errors.join('\n')).toEqual([]);
});

// Needs the optional AI model service (services/vieneu) and VIENEU_* variables in the server's environment.
test('AI voice: labelled AI, simple controls, real playback, engine shown, plan and usage', async ({
  page,
  request,
  context,
}) => {
  test.skip(!process.env.E2E_AI, 'set E2E_AI=1 with the AI model service running');
  const errors = trackErrors(page);
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = `e2e-${randomUUID()}`;
  expect(
    (
      await request.post('/api/v1/auth/register', { data: { email, password, displayName: 'AI QA' } })
    ).status(),
  ).toBe(201);
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // Voice library: the AI voice carries an AI badge, the rule-based ones do not.
  await page.goto('/voices');
  await expect(page.getByRole('button', { name: /Ngọc Huyền · AI/ })).toBeVisible();
  // Rule-based voices (when that engine is enabled) never carry the AI label; the product default has none.
  const ruleBased = page.getByRole('button', { name: /Vietnamese — Northern · eSpeak NG/ });
  if (await ruleBased.count()) await expect(ruleBased).not.toContainText('AI');

  await page.getByLabel('Gender').selectOption('female');
  await expect(page.getByRole('button', { name: /Quang Sơn/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Ngọc Huyền/ })).toBeVisible();

  // Project with the AI voice.
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('AI voice');
  await page.getByLabel('Language of the text').selectOption('vi-VN');
  // Choose by region and gender instead of picking a voice by name.
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Regional accent').selectOption('central');
  await dlg.getByLabel('Voice gender').selectOption('male');
  await expect(dlg.locator('input[name="voice"]:checked')).toHaveValue('vieneu:quang-son');
  await dlg.getByLabel('Voice gender').selectOption('female');
  await expect(dlg.locator('input[name="voice"]:checked')).toHaveValue('vieneu:ngoc-tran');
  await dlg.getByLabel('Regional accent').selectOption('northern');
  await expect(dlg.locator('input[name="voice"]:checked')).toHaveValue('vieneu:ngoc-huyen');
  await page.getByLabel('Your text (optional)').fill('Xin chào các bạn, chúc một ngày tốt lành.');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paragraphs (1)' })).toBeVisible();

  // Simple mode: speed and pitch are offered as audio-processing controls because the AI voice has no native ones.
  const inspector = page.getByRole('region', { name: 'Voice settings' });
  await expect(inspector.getByText(/an AI model on this server generates the speech/)).toBeVisible();
  await expect(inspector.getByLabel('Speaking speed').first()).toBeVisible();
  await expect(inspector.getByText('Time stretch')).toHaveCount(0); // simple mode uses friendly names

  // Region and gender can be changed while working: every combination reaches the right preset voice.
  const voiceSelect = inspector.getByLabel('Voice', { exact: true });
  await expect(inspector.getByLabel('Voice gender')).toHaveValue('female');
  await inspector.getByLabel('Voice gender').selectOption('male');
  await expect(voiceSelect).toHaveValue('vieneu:hai-dang');
  await inspector.getByLabel('Regional accent').selectOption('southern');
  await expect(voiceSelect).toHaveValue('vieneu:adam');
  await inspector.getByLabel('Voice gender').selectOption('female');
  await expect(voiceSelect).toHaveValue('vieneu:thuy-dung');
  await inspector.getByLabel('Regional accent').selectOption('central');
  await expect(voiceSelect).toHaveValue('vieneu:ngoc-tran');
  await inspector.getByLabel('Voice gender').selectOption('male');
  await expect(voiceSelect).toHaveValue('vieneu:quang-son');

  // Real audio from the model: the player reports a duration and the preview records the engine.
  await page.getByRole('button', { name: '▶ Listen', exact: true }).click();
  const takes = page.getByRole('region', { name: 'Previews to compare' });
  await expect(takes.getByText(/Made by VieNeu-TTS \d/)).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => playerDuration(page), { timeout: 30_000 }).toBeGreaterThan(1);
  const src = await takes.getByLabel('Audio of preview 1').getAttribute('src');
  const wav = await (await page.request.get(src!)).body();
  expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  expect(wav.length).toBeGreaterThan(20_000);

  // Plan and usage are visible to the user.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Your plan: Free/ })).toBeVisible();
  await expect(page.getByText(/AI voices this month: [1-9]\d* of 20,000 characters/)).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

// ---- administration, permissions and accessibility -----------------------------------------------------------

let ipSeq = 0;
/** Register through the API from a distinct client address (the loopback proxy is trusted), avoiding the per-address limit. */
async function apiRegister(request: import('@playwright/test').APIRequestContext, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `e2e-${randomUUID()}`;
  const displayName = `${name} ${randomUUID().slice(0, 4)}`;
  const n = ++ipSeq + Math.floor(Math.random() * 200);
  const r = await request.post('/api/v1/auth/register', {
    data: { email, password, displayName },
    headers: { 'x-forwarded-for': `10.77.${n % 250}.${(Date.now() % 250) + 1}` },
  });
  expect(r.status(), await r.text()).toBe(201);
  return { email, password, displayName, id: (await r.json()).data.user.id as string };
}
const operator = (cmd: string, email: string) =>
  execFileSync('node', ['scripts/user-admin.mjs', cmd, email], { cwd: process.cwd(), stdio: 'pipe' });

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test('administrator dashboard: users, suspension, plans, audit; ordinary users are kept out', async ({
  page,
  request,
  context,
}) => {
  const errors = trackErrors(page);
  const admin = await apiRegister(request, 'Admin QA');
  const ann = await apiRegister(request, 'Ann Ordinary');
  const bob = await apiRegister(request, 'Bob Target');
  operator('promote', admin.email);
  await context.clearCookies();

  // An ordinary user sees no admin entry, the page refuses, and the API answers 403.
  await signIn(page, ann.email, ann.password);
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('alert')).toContainText('You do not have access to this page.');
  expect((await page.request.get('/api/v1/admin/overview')).status()).toBe(403);
  expect((await page.request.get('/api/v1/admin/users')).status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The administrator sees the dashboard.
  await signIn(page, admin.email, admin.password);
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expect(page.getByText('All accounts')).toBeVisible();
  await expect(page.getByText('Failed sign-ins (24 h)')).toBeVisible();

  // Users: search, suspend (with confirmation), the account is locked out, then reactivate.
  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByLabel('Search by name or email').fill(bob.email);
  const row = page.getByRole('row').filter({ hasText: bob.email });
  await expect(row).toBeVisible();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: new RegExp('Suspend: ' + bob.email) }).click();
  await expect(page.getByRole('dialog')).toContainText(bob.email);
  await page.getByRole('dialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(row.getByText('Suspended', { exact: true })).toBeVisible();
  const denied = await request.post('/api/v1/auth/login', {
    data: { email: bob.email, password: bob.password },
    headers: { 'x-forwarded-for': '10.88.1.1' },
  });
  expect(denied.status()).toBe(401);
  await row.getByRole('button', { name: new RegExp('Reactivate: ' + bob.email) }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reactivate' }).click();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  const again = await request.post('/api/v1/auth/login', {
    data: { email: bob.email, password: bob.password },
    headers: { 'x-forwarded-for': '10.88.1.2' },
  });
  expect(again.status()).toBe(200);
  // The administrator's own row cannot be changed from here.
  await page.getByLabel('Search by name or email').fill(admin.email);
  const own = page.getByRole('row').filter({ hasText: admin.email });
  await expect(own.getByRole('button', { name: new RegExp('Suspend: ' + admin.email) })).toBeDisabled();

  // Plans.
  await page.getByRole('tab', { name: 'Plans and usage' }).click();
  const plan = page.getByLabel(new RegExp(`Plan of ${bob.displayName}`));
  await plan.selectOption('pro');
  await expect(plan).toHaveValue('pro');
  await page.reload();
  await page.getByRole('tab', { name: 'Plans and usage' }).click();
  await expect(page.getByLabel(new RegExp(`Plan of ${bob.displayName}`))).toHaveValue('pro');

  // Audit trail records what happened.
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.getByRole('cell', { name: 'admin.user_updated' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'workspace.plan_changed' }).first()).toBeVisible();
  await page.getByLabel('Show').selectOption('auth.');
  await expect(page.getByRole('cell', { name: 'auth.login' }).first()).toBeVisible();
  expect(
    errors.filter((e) => !/40[13]/.test(e)),
    errors.join('\n'),
  ).toEqual([]);
});

test('sign-in is locked after repeated failures and the page says so', async ({ page, request, context }) => {
  const u = await apiRegister(request, 'Lock Me');
  await context.clearCookies();
  const ip = `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  for (let i = 0; i < 5; i++) {
    const r = await request.post('/api/v1/auth/login', {
      data: { email: u.email, password: 'wrong-' + randomUUID() },
      headers: { 'x-forwarded-for': ip },
    });
    expect(r.status()).toBe(401);
  }
  const locked = await request.post('/api/v1/auth/login', {
    data: { email: u.email, password: u.password },
    headers: { 'x-forwarded-for': ip },
  });
  expect(locked.status()).toBe(429);
  await page.goto('/login');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/Too many requests/)).toBeVisible();
  operator('activate', u.email); // does not clear the lock; only a password reset or the lock timing out does
});

test('accessibility: no serious or critical violations on the main screens', async ({
  page,
  request,
  context,
}) => {
  const check = async (name: string) => {
    const res = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect
      .soft(
        bad.map(
          (v) =>
            `${v.id} (${v.impact}): ${v.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join(' | ')}`,
        ),
        name,
      )
      .toEqual([]);
  };
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await check('login');
  await page.goto('/register');
  await check('register');
  const admin = await apiRegister(request, 'Axe Admin');
  operator('promote', admin.email);
  await context.clearCookies();
  await signIn(page, admin.email, admin.password);
  await check('home');
  await page.getByRole('button', { name: 'Create your first project' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await check('new project dialog');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Paragraphs/ })).toBeVisible();
  await page.getByRole('button', { name: '+ Add' }).click();
  await page.getByLabel('Paragraph text').fill('Xin chào các bạn.');
  await check('studio simple');
  await page.locator('#main').getByRole('radio', { name: 'Advanced' }).click();
  await check('studio advanced');
  for (const [path, name] of [
    ['/voices', 'voices'],
    ['/presets', 'presets'],
    ['/pronunciation', 'pronunciation'],
    ['/renders', 'exports'],
    ['/settings', 'settings'],
    ['/admin', 'admin'],
  ] as const) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await check(name);
  }
  for (const tab of ['Users', 'Plans and usage', 'Voices and engines', 'Audit log']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForLoadState('networkidle');
    await check('admin ' + tab);
  }
});
