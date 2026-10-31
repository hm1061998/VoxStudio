import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  await expect(page.getByLabel('Voice', { exact: true })).toHaveValue('espeak:en-us');
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
  await expect(page.getByRole('button', { name: /^Paragraph 1: Second segment/ })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /^Paragraph 1: Hello/ })).toBeVisible();

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
  await expect(page.getByLabel('Giọng đọc', { exact: true })).toHaveValue('espeak:vi');
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
  await page.getByLabel('Voice', { exact: true }).selectOption('espeak:vi');
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
  await expect(page.getByRole('button', { name: /Vietnamese — Northern · eSpeak NG/ })).not.toContainText(
    'AI',
  );

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
  await expect(dlg.getByLabel('Voice', { exact: true })).toHaveValue('vieneu:quang-son');
  await dlg.getByLabel('Voice gender').selectOption('female');
  await expect(dlg.getByLabel('Voice', { exact: true })).toHaveValue('vieneu:ngoc-tran');
  await dlg.getByLabel('Regional accent').selectOption('northern');
  await expect(dlg.getByLabel('Voice', { exact: true })).toHaveValue('vieneu:ngoc-huyen');
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
