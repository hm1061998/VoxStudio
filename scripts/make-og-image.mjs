#!/usr/bin/env node
// Renders the 1200x630 social preview card (apps/web/public/og-image.png) with headless Chromium.
// The card states only what the product does; no screenshots of data and no claims about voice quality.
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:BVP;src:local('Be Vietnam Pro'),local('Segoe UI')}
html,body{margin:0}
body{width:1200px;height:630px;background:#0e1a1f;color:#e6f0f2;font-family:'Be Vietnam Pro','Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;gap:28px;padding:0 90px;box-sizing:border-box;position:relative;overflow:hidden}
.brand{display:flex;align-items:center;gap:20px;font-size:44px;font-weight:700}
.mark{width:72px;height:72px;border-radius:20px;background:#4fc3cc;display:grid;place-items:center}
h1{margin:0;font-size:72px;line-height:1.12;font-weight:700;max-width:740px}
p{margin:0;font-size:32px;color:#a9bfc6;max-width:740px;line-height:1.4}
.wave{position:absolute;right:70px;top:80px;display:flex;align-items:center;gap:12px;height:470px}
.wave i{width:14px;border-radius:7px;background:#4fc3cc;opacity:.55}
</style>
<div class="brand"><span class="mark"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#06242a" stroke-width="2.6" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg></span>VoxStudio</div>
<h1>Giọng đọc tiếng Việt chạy trên máy chủ của bạn</h1>
<p>Chọn vùng miền và giới tính, nghe thử, xuất MP3 hoặc WAV.</p>
<div class="wave">${[120, 220, 330, 200, 420, 300, 150, 360, 250, 100].map((h) => `<i style="height:${h}px"></i>`).join('')}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
const png = await page.screenshot({ type: 'png' });
writeFileSync(new URL('../apps/web/public/og-image.png', import.meta.url), png);
await browser.close();
console.log(`og-image.png ${png.length} bytes`);
