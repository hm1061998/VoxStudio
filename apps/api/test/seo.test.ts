import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ PUBLIC_BASE_URL: 'https://voice.example.test/' });
});
afterAll(async () => h?.close());

describe('search engine files and hints', () => {
  it('serves robots.txt that hides the signed-in app and names the sitemap', async () => {
    const r = await h.http().get('/robots.txt');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.text).toContain('Disallow: /api/');
    expect(r.text).toContain('Disallow: /admin');
    expect(r.text).toContain('Disallow: /settings');
    expect(r.text).toContain('Allow: /login');
    expect(r.text).toContain('Sitemap: https://voice.example.test/sitemap.xml');
  });

  it('lists only the public pages in the sitemap, with absolute addresses', async () => {
    const r = await h.http().get('/sitemap.xml');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/xml/);
    const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(['https://voice.example.test/login', 'https://voice.example.test/register']);
  });

  it('puts the configured public address into the page head', async () => {
    const r = await h.http().get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<link rel="canonical" href="https://voice.example.test/" />');
    expect(r.text).toContain('og:image" content="https://voice.example.test/og-image.png"');
    expect(r.text).not.toContain('__PUBLIC_BASE_URL__');
    expect(r.text).toContain('name="description"');
    // The same page answers every client-side route.
    const deep = await h.http().get('/settings/plan');
    expect(deep.text).not.toContain('__PUBLIC_BASE_URL__');
  });

  it('asks search engines not to index any API answer', async () => {
    const r = await h.http().get('/api/v1/health/live');
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
