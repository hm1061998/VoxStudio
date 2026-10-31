import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createHarness, register, waitForJob, type Harness, type TestUser } from './harness';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let defaults: Record<string, unknown>;

beforeAll(async () => {
  h = await createHarness();
  alice = await register(h, `alice-${randomUUID().slice(0, 6)}@example.test`);
  bob = await register(h, `bob-${randomUUID().slice(0, 6)}@example.test`);
});
afterAll(async () => h?.close());

async function newProject(u: TestUser, texts: string[] = ['Hello world.', 'Second segment.']) {
  const p = await as(h, u).post(`/workspaces/${u.workspaceId}/projects`, {
    name: 'Test project',
    defaultLocale: 'en-US',
    defaultVoiceId: 'espeak:en-us',
  });
  expect(p.status).toBe(201);
  const d = await as(h, u).get(`/projects/${p.body.data.id}/segment-defaults`);
  defaults = d.body.data.settings;
  const segments = texts.map((t) => ({
    id: randomUUID(),
    sourceText: t,
    locale: 'en-US',
    voiceId: 'espeak:en-us',
    settings: { ...defaults },
  }));
  const s = await as(h, u).put(`/projects/${p.body.data.id}/segments`, { projectRevision: 0, segments });
  expect(s.status).toBe(200);
  return s.body.data as {
    id: string;
    revision: number;
    segments: { id: string; audioState: string; settings: Record<string, unknown> }[];
  };
}

describe('health', () => {
  it('reports live and ready with all checks', async () => {
    expect((await h.http().get('/api/v1/health/live')).status).toBe(200);
    const r = await h.http().get('/api/v1/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.checks.engine.ok).toBe(true);
    expect(r.body.checks.ffmpeg.ok).toBe(true);
    expect(r.body.checks.worker.ok).toBe(true);
  });
});

describe('auth', () => {
  it('rejects duplicate emails and weak passwords', async () => {
    const email = `dup-${randomUUID().slice(0, 6)}@example.test`;
    await register(h, email);
    const dup = await h
      .http()
      .post('/api/v1/auth/register')
      .send({ email: email.toUpperCase(), password: 'another-long-password', displayName: 'D' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const weak = await h
      .http()
      .post('/api/v1/auth/register')
      .send({ email: 'w@example.test', password: 'short', displayName: 'W' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');
  });
  it('logs in, sets a secure session cookie, and logs out', async () => {
    const email = `login-${randomUUID().slice(0, 6)}@example.test`;
    await register(h, email);
    const bad = await h.http().post('/api/v1/auth/login').send({ email, password: 'wrong-password-x' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await h.http().post('/api/v1/auth/login').send({ email, password: 'correct-horse-battery' });
    expect(ok.status).toBe(200);
    const setCookie = (ok.headers['set-cookie'] as unknown as string[])[0]!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const u = { cookie: setCookie.split(';')[0]!, csrf: ok.body.data.csrfToken, workspaceId: '', userId: '' };
    expect((await as(h, u).get('/auth/me')).status).toBe(200);
    expect((await as(h, u).post('/auth/logout')).status).toBe(200);
    expect((await as(h, u).get('/auth/me')).status).toBe(401);
  });
  it('rotates the session on refresh', async () => {
    const u = await register(h, `refresh-${randomUUID().slice(0, 6)}@example.test`);
    const r = await as(h, u).post('/auth/refresh');
    expect(r.status).toBe(200);
    expect((await as(h, u).get('/auth/me')).status).toBe(401);
    const cookie = (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect((await as(h, { ...u, cookie, csrf: r.body.data.csrfToken }).get('/auth/me')).status).toBe(200);
  });
  it('requires a session and a CSRF token for mutations', async () => {
    expect((await h.http().get('/api/v1/workspaces')).status).toBe(401);
    const noCsrf = await h
      .http()
      .post(`/api/v1/workspaces/${alice.workspaceId}/projects`)
      .set('Cookie', alice.cookie)
      .send({ name: 'x', defaultLocale: 'en-US' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_INVALID');
  });
  it('supports operator-issued password reset codes', async () => {
    const email = `reset-${randomUUID().slice(0, 6)}@example.test`;
    await register(h, email);
    // Same operation as `pnpm user:reset-password <email>` (operator CLI).
    const { issueResetToken } = await import('../../../scripts/lib/reset-token.mjs');
    const token = await issueResetToken(h.prisma, email);
    const r = await h
      .http()
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'brand-new-password' });
    expect(r.status).toBe(200);
    expect(
      (
        await h
          .http()
          .post('/api/v1/auth/password-reset/confirm')
          .send({ token, newPassword: 'brand-new-password' })
      ).status,
    ).toBe(401);
    expect(
      (await h.http().post('/api/v1/auth/login').send({ email, password: 'brand-new-password' })).status,
    ).toBe(200);
  });
  it('grants admin role only to configured emails', async () => {
    const admin = await register(h, 'admin@example.test');
    expect((await as(h, admin).get('/admin/overview')).status).toBe(200);
    expect((await as(h, alice).get('/admin/overview')).status).toBe(403);
  });
});

describe('catalog', () => {
  it('lists only selectable voices with tiers and capabilities', async () => {
    const r = await as(h, alice).get('/voices');
    const ids = r.body.data.map((v: { id: string }) => v.id);
    expect(ids).toContain('espeak:en-us');
    expect(ids).not.toContain('espeak:ja');
    expect(r.body.data.every((v: { supportTier: string }) => v.supportTier !== 'unavailable')).toBe(true);
    const c = await as(h, alice).get('/voices/espeak:en-us/capabilities');
    expect(c.body.data.rate.support).toBe('native');
    expect(c.body.data.tempo.support).toBe('dsp');
    const e = await as(h, alice).get('/engines');
    expect(e.body.data[0]).toMatchObject({
      id: 'espeak',
      complianceStatus: 'approved',
      license: 'GPL-3.0-or-later',
    });
  });
  it('filters voices by locale', async () => {
    const r = await as(h, alice).get('/voices?locale=de');
    expect(r.body.data.map((v: { id: string }) => v.id)).toEqual(['espeak:de']);
  });
  it('previews normalization, pronunciation and phonemes', async () => {
    const r = await as(h, alice).post('/text/normalize-preview', {
      text: 'Dr. Who paid $3 [pause 200ms] ok',
      locale: 'en-US',
      voiceId: 'espeak:en-us',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.normalized).toContain('Doctor Who paid 3 dollars');
    expect(r.body.data.engineChunks[1]).toEqual({ kind: 'pause', pauseMs: 200 });
    expect(r.body.data.phonemes.length).toBeGreaterThan(5);
  });
  it('adds deterministic Vietnamese tone diagnostics, and none for other languages', async () => {
    const r = await as(h, alice).post('/text/normalize-preview', {
      text: 'Má mà mả marketing',
      locale: 'vi-VN',
      voiceId: 'espeak:vi',
    });
    expect(r.status).toBe(200);
    const d = r.body.data.diagnostics;
    expect(d.kind).toBe('vi-orthography');
    expect(d.syllables.map((x: { syllable: string; tone: string }) => [x.syllable, x.tone])).toEqual([
      ['má', 'sac'],
      ['mà', 'huyen'],
      ['mả', 'hoi'],
    ]);
    expect(d.syllables[0]).toMatchObject({ onset: 'm', nucleus: 'a', coda: '' });
    expect(d.unreadable).toEqual(['marketing']);
    expect(r.body.data.phonemes.length).toBeGreaterThan(3);
    const en = await as(h, alice).post('/text/normalize-preview', {
      text: 'Hello.',
      locale: 'en-US',
      voiceId: 'espeak:en-us',
    });
    expect(en.body.data.diagnostics).toBeNull();
  });
  it('splits text by sentence', async () => {
    const r = await as(h, alice).post('/text/split', {
      text: 'One. Two? Three!',
      mode: 'sentence',
      locale: 'en-US',
    });
    expect(r.body.data.segments).toEqual(['One.', 'Two?', 'Three!']);
  });
});

describe('projects and segments', () => {
  it('CRUD, rename, duplicate, archive, search, delete', async () => {
    const p = await newProject(alice);
    const renamed = await as(h, alice).patch(`/projects/${p.id}`, { revision: p.revision, name: 'Renamed' });
    expect(renamed.body.data.name).toBe('Renamed');
    const dup = await as(h, alice).post(`/projects/${p.id}/duplicate`);
    expect(dup.body.data.segments).toHaveLength(2);
    expect(dup.body.data.segments[0].id).not.toBe(p.segments[0]!.id);
    const search = await as(h, alice).get(`/workspaces/${alice.workspaceId}/projects?q=renamed`);
    expect(search.body.data.map((x: { id: string }) => x.id)).toContain(p.id);
    const arch = await as(h, alice).patch(`/projects/${p.id}`, {
      revision: renamed.body.data.revision,
      archived: true,
    });
    expect(arch.body.data.status).toBe('archived');
    const archived = await as(h, alice).get(`/workspaces/${alice.workspaceId}/projects?archived=true`);
    expect(archived.body.data.map((x: { id: string }) => x.id)).toContain(p.id);
    expect((await as(h, alice).del(`/projects/${p.id}`)).status).toBe(200);
    expect((await as(h, alice).get(`/projects/${p.id}`)).status).toBe(404);
  });
  it('enforces optimistic concurrency with 409', async () => {
    const p = await newProject(alice);
    const ok = await as(h, alice).patch(`/projects/${p.id}`, { revision: p.revision, name: 'A' });
    expect(ok.status).toBe(200);
    const stale = await as(h, alice).patch(`/projects/${p.id}`, { revision: p.revision, name: 'B' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    expect(stale.body.error.details.currentRevision).toBe(p.revision + 1);
  });
  it('creates, updates, reorders and deletes segments with persisted settings', async () => {
    const p = await newProject(alice, ['A.', 'B.', 'C.']);
    const ids = p.segments.map((s) => s.id);
    const re = await as(h, alice).post(`/projects/${p.id}/segments/reorder`, {
      projectRevision: p.revision,
      segmentIds: [ids[2], ids[0], ids[1]],
    });
    expect(re.body.data.segments.map((s: { sourceText: string }) => s.sourceText)).toEqual([
      'C.',
      'A.',
      'B.',
    ]);
    const up = await as(h, alice).patch(`/segments/${ids[0]}`, {
      projectRevision: re.body.data.revision,
      settings: { ...defaults, rate: 1.4, pitch: 30 },
    });
    expect(up.status).toBe(200);
    const reload = await as(h, alice).get(`/projects/${p.id}`);
    const seg = reload.body.data.segments.find((s: { id: string }) => s.id === ids[0]);
    expect(seg.settings.rate).toBe(1.4);
    expect(seg.settings.pitch).toBe(30);
    const created = await as(h, alice).post(`/projects/${p.id}/segments`, {
      projectRevision: reload.body.data.revision,
      position: 0,
      sourceText: 'Zero.',
      locale: 'en-US',
      voiceId: 'espeak:en-us',
      settings: defaults,
    });
    expect(created.body.data.segments.map((s: { sourceText: string }) => s.sourceText)).toEqual([
      'Zero.',
      'C.',
      'A.',
      'B.',
    ]);
    const del = await as(h, alice).del(`/segments/${ids[1]}?projectRevision=${created.body.data.revision}`);
    // ids[1] is "B." (ids were captured before the reorder).
    expect(del.body.data.segments.map((s: { sourceText: string }) => s.sourceText)).toEqual([
      'Zero.',
      'C.',
      'A.',
    ]);
  });
  it('accepts Unicode text', async () => {
    const p = await newProject(alice, ['Café — naïve “quote” ✓ 😀 日本']);
    const r = await as(h, alice).get(`/projects/${p.id}`);
    expect(r.body.data.segments[0].sourceText).toBe('Café — naïve “quote” ✓ 😀 日本');
  });
  it('rejects unsupported voice, locale mismatch, unknown and out-of-range settings', async () => {
    const p = await newProject(alice, ['x']);
    const base = {
      id: p.segments[0]!.id,
      sourceText: 'x',
      locale: 'en-US',
      voiceId: 'espeak:en-us',
      settings: defaults,
    };
    const cases: [object, string][] = [
      [{ ...base, voiceId: 'espeak:ja' }, 'VOICE_NOT_AVAILABLE'],
      [{ ...base, voiceId: 'espeak:nope' }, 'VOICE_NOT_AVAILABLE'],
      [{ ...base, locale: 'de-DE' }, 'VOICE_LOCALE_UNSUPPORTED'],
      [{ ...base, settings: { ...defaults, emotion: 'happy' } }, 'VALIDATION_FAILED'],
      [{ ...base, settings: { ...defaults, rate: 9 } }, 'PARAMETER_OUT_OF_RANGE'],
      [{ ...base, settings: { ...defaults, variant: 'bogus' } }, 'PARAMETER_UNSUPPORTED'],
    ];
    for (const [seg, code] of cases) {
      const r = await as(h, alice).put(`/projects/${p.id}/segments`, {
        projectRevision: p.revision,
        segments: [seg],
      });
      expect(r.body.error?.code, JSON.stringify(seg)).toBe(code);
    }
  });
  it('saves and restores versions', async () => {
    const p = await newProject(alice, ['Version one.']);
    const v = await as(h, alice).post(`/projects/${p.id}/versions`, { label: 'v1' });
    expect(v.status).toBe(201);
    const changed = await as(h, alice).put(`/projects/${p.id}/segments`, {
      projectRevision: p.revision,
      segments: [
        {
          id: p.segments[0]!.id,
          sourceText: 'Changed.',
          locale: 'en-US',
          voiceId: 'espeak:en-us',
          settings: defaults,
        },
      ],
    });
    const restored = await as(h, alice).post(`/projects/${p.id}/versions/${v.body.data.id}/restore`, {
      projectRevision: changed.body.data.revision,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.data.segments[0].sourceText).toBe('Version one.');
    const list = await as(h, alice).get(`/projects/${p.id}/versions`);
    expect(list.body.data.length).toBe(2);
  });
});

describe('authorization (cross-user isolation)', () => {
  it('denies access to another user’s projects, segments, jobs and assets', async () => {
    const p = await newProject(alice, ['Private text.']);
    const job = await as(h, alice).post(`/segments/${p.segments[0]!.id}/preview`);
    const done = await waitForJob(h, alice, job.body.data.id);
    const assetId = (done.resultAsset as { id: string }).id;
    const b = as(h, bob);
    expect((await b.get(`/projects/${p.id}`)).status).toBe(404);
    expect((await b.patch(`/projects/${p.id}`, { revision: 1, name: 'pwn' })).status).toBe(404);
    expect((await b.del(`/projects/${p.id}`)).status).toBe(404);
    expect((await b.get(`/workspaces/${alice.workspaceId}/projects`)).status).toBe(404);
    expect(
      (await b.post(`/workspaces/${alice.workspaceId}/projects`, { name: 'x', defaultLocale: 'en-US' }))
        .status,
    ).toBe(404);
    expect(
      (await b.patch(`/segments/${p.segments[0]!.id}`, { projectRevision: 1, sourceText: 'x' })).status,
    ).toBe(404);
    expect((await b.post(`/segments/${p.segments[0]!.id}/preview`)).status).toBe(404);
    expect((await b.get(`/render-jobs/${job.body.data.id}`)).status).toBe(404);
    expect((await b.post(`/render-jobs/${job.body.data.id}/cancel`)).status).toBe(404);
    expect((await b.get(`/assets/${assetId}`)).status).toBe(404);
    expect((await b.get(`/assets/${assetId}/download`)).status).toBe(404);
    expect((await b.post(`/projects/${p.id}/render`, { revision: 1 })).status).toBe(404);
    // Segment ids from another project cannot be hijacked through sync.
    const bp = await newProject(bob, ['b']);
    const hijack = await b.put(`/projects/${bp.id}/segments`, {
      projectRevision: bp.revision,
      segments: [
        {
          id: p.segments[0]!.id,
          sourceText: 'x',
          locale: 'en-US',
          voiceId: 'espeak:en-us',
          settings: defaults,
        },
      ],
    });
    expect(hijack.status).toBe(400);
  });
  it('treats malformed ids as not found', async () => {
    expect((await as(h, alice).get('/projects/../../etc/passwd')).status).toBe(404);
    expect((await as(h, alice).get('/assets/not-a-uuid/download')).status).toBe(404);
  });
});

describe('preview, render, export', () => {
  it('previews a segment with real audio and links it when it matches saved state', async () => {
    const p = await newProject(alice, ['Preview this segment please.']);
    const job = await as(h, alice).post(`/segments/${p.segments[0]!.id}/preview`);
    expect(job.status).toBe(201);
    const done = await waitForJob(h, alice, job.body.data.id);
    expect(done.status).toBe('succeeded');
    const asset = done.resultAsset as { id: string; durationMs: number; sampleRate: number };
    expect(asset.sampleRate).toBe(22050);
    expect(asset.durationMs).toBeGreaterThan(1000);
    const audio = await as(h, alice).get(`/assets/${asset.id}/stream`).buffer(true);
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(Buffer.from(audio.body).subarray(0, 4).toString()).toBe('RIFF');
    const range = await as(h, alice).get(`/assets/${asset.id}/stream`).set('Range', 'bytes=0-99');
    expect(range.status).toBe(206);
    expect(range.headers['content-range']).toMatch(/^bytes 0-99\//);
    const reload = await as(h, alice).get(`/projects/${p.id}`);
    expect(reload.body.data.segments[0].audioState).toBe('ready');
  });

  it('previews draft settings without persisting them, and caches identical previews', async () => {
    const p = await newProject(alice, ['Draft preview.']);
    const sid = p.segments[0]!.id;
    const a = await waitForJob(
      h,
      alice,
      (await as(h, alice).post(`/segments/${sid}/preview`, { settings: { ...defaults, rate: 1.5 } })).body
        .data.id,
    );
    const b = await waitForJob(
      h,
      alice,
      (await as(h, alice).post(`/segments/${sid}/preview`, { settings: { ...defaults, rate: 1.0 } })).body
        .data.id,
    );
    expect((a.resultAsset as { durationMs: number }).durationMs).toBeLessThan(
      (b.resultAsset as { durationMs: number }).durationMs,
    );
    const again = await as(h, alice).post(`/segments/${sid}/preview`, {
      settings: { ...defaults, rate: 1.5 },
    });
    expect(again.body.data.status).toBe('succeeded');
    expect(again.body.data.resultAsset.id).toBe((a.resultAsset as { id: string }).id);
    expect(again.body.data.warnings.join(' ')).toMatch(/render cache/);
    const reload = await as(h, alice).get(`/projects/${p.id}`);
    expect(reload.body.data.segments[0].settings.rate).toBe(1);
  });

  it('marks audio stale after an edit and ready again after undo (cache)', async () => {
    const p = await newProject(alice, ['Stale check.']);
    const sid = p.segments[0]!.id;
    await waitForJob(h, alice, (await as(h, alice).post(`/segments/${sid}/preview`)).body.data.id);
    const edited = await as(h, alice).put(`/projects/${p.id}/segments`, {
      projectRevision: p.revision,
      segments: [
        {
          id: sid,
          sourceText: 'Stale check edited.',
          locale: 'en-US',
          voiceId: 'espeak:en-us',
          settings: defaults,
        },
      ],
    });
    expect(edited.body.data.segments[0].audioState).toBe('stale');
    const undone = await as(h, alice).put(`/projects/${p.id}/segments`, {
      projectRevision: edited.body.data.revision,
      segments: [
        { id: sid, sourceText: 'Stale check.', locale: 'en-US', voiceId: 'espeak:en-us', settings: defaults },
      ],
    });
    expect(undone.body.data.segments[0].audioState).toBe('ready');
  });

  it('pronunciation entries change the engine input and invalidate cached audio', async () => {
    const p = await newProject(alice, ['I like SQL databases.']);
    const sid = p.segments[0]!.id;
    await waitForJob(h, alice, (await as(h, alice).post(`/segments/${sid}/preview`)).body.data.id);
    const e = await as(h, alice).post('/pronunciation-entries', {
      locale: 'en',
      matchText: 'SQL',
      replacementText: 'sequel',
      caseSensitive: true,
    });
    expect(e.status).toBe(201);
    const reload = await as(h, alice).get(`/projects/${p.id}`);
    expect(reload.body.data.segments[0].audioState).toBe('stale');
    const pv = await as(h, alice).post('/text/normalize-preview', {
      text: 'I like SQL databases.',
      locale: 'en-US',
      voiceId: 'espeak:en-us',
    });
    expect(pv.body.data.engineChunks[0].text).toBe('I like sequel databases.');
    const bad = await as(h, alice).post('/pronunciation-entries', {
      locale: 'en',
      matchText: 'x',
      replacementText: ']] -w /etc/x',
      phonemeFormat: 'espeak',
    });
    expect(bad.body.error.code).toBe('PRONUNCIATION_INVALID');
    const exp = await as(h, alice).get('/pronunciation-entries/export');
    expect(exp.body.data.entries.map((x: { matchText: string }) => x.matchText)).toContain('SQL');
    const conflict = await as(h, alice).post('/pronunciation-entries', {
      locale: 'en',
      matchText: 'SQL',
      replacementText: 'S Q L',
      caseSensitive: true,
      priority: 5,
    });
    expect(conflict.status).toBe(201);
    const c = await as(h, alice).get('/pronunciation-entries/conflicts');
    expect(c.body.data[0].winnerId).toBe(conflict.body.data.id);
    await as(h, alice).del(`/pronunciation-entries/${e.body.data.id}`);
    await as(h, alice).del(`/pronunciation-entries/${conflict.body.data.id}`);
  });

  it('renders a project with progress units, timeline order, and reuses cached segments', async () => {
    const p = await newProject(alice, ['First.', 'Second.', 'Third.']);
    const r = await as(h, alice).post(`/projects/${p.id}/render`, {
      revision: p.revision,
      outputProfile: { format: 'wav', sampleRate: 22050, channels: 1, bitDepth: 16 },
    });
    expect(r.status).toBe(201);
    expect(r.body.data.totalUnits).toBe(5);
    const done = await waitForJob(h, alice, r.body.data.id);
    expect(done.status).toBe('succeeded');
    expect(done.progressUnits).toBe(5);
    const tl = done.timeline as { segmentId: string; startMs: number; endMs: number }[];
    expect(tl.map((t) => t.segmentId)).toEqual(p.segments.map((s) => s.id));
    for (let i = 1; i < tl.length; i++) expect(tl[i]!.startMs).toBe(tl[i - 1]!.endMs);
    const dl = await as(h, alice)
      .get(`/assets/${(done.resultAsset as { id: string }).id}/download`)
      .buffer(true);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="Test-project\.wav"/);
    const project = await as(h, alice).get(`/projects/${p.id}`);
    expect(project.body.data.status).toBe('rendered');
    expect(project.body.data.segments.every((s: { audioState: string }) => s.audioState === 'ready')).toBe(
      true,
    );
    // Editing one segment then re-rendering only synthesizes that one.
    const before = await h.prisma.audioAsset.count({ where: { projectId: p.id, kind: 'segment' } });
    const segs = project.body.data.segments.map(
      (s: { id: string; sourceText: string; locale: string; voiceId: string; settings: unknown }) => ({
        id: s.id,
        sourceText: s.sourceText,
        locale: s.locale,
        voiceId: s.voiceId,
        settings: s.settings,
      }),
    );
    segs[1].sourceText = 'Second, edited.';
    const edited = await as(h, alice).put(`/projects/${p.id}/segments`, {
      projectRevision: project.body.data.revision,
      segments: segs,
    });
    expect(edited.body.data.segments.map((s: { audioState: string }) => s.audioState)).toEqual([
      'ready',
      'stale',
      'ready',
    ]);
    const r2 = await waitForJob(
      h,
      alice,
      (await as(h, alice).post(`/projects/${p.id}/render`, { revision: edited.body.data.revision })).body.data
        .id,
    );
    expect(r2.status).toBe('succeeded');
    expect(await h.prisma.audioAsset.count({ where: { projectId: p.id, kind: 'segment' } })).toBe(before + 1);
    // Identical re-render is served from cache.
    const r3 = await as(h, alice).post(`/projects/${p.id}/render`, { revision: edited.body.data.revision });
    expect(r3.body.data.status).toBe('succeeded');
    expect(r3.body.data.resultAsset.id).toBe((r2.resultAsset as { id: string }).id);
  });

  it('exports MP3 and OGG with matching metadata', async () => {
    const p = await newProject(alice, ['Export test one.', 'Export test two.']);
    for (const outputProfile of [
      { format: 'mp3', sampleRate: 44100, channels: 2, bitrateKbps: 192 },
      { format: 'ogg', sampleRate: 48000, channels: 1, bitrateKbps: 96 },
    ]) {
      const fresh = await as(h, alice).get(`/projects/${p.id}`);
      const done = await waitForJob(
        h,
        alice,
        (
          await as(h, alice).post(`/projects/${p.id}/export`, {
            revision: fresh.body.data.revision,
            outputProfile,
          })
        ).body.data.id,
      );
      expect(done.status).toBe('succeeded');
      expect(done.resultAsset).toMatchObject({
        format: outputProfile.format,
        sampleRate: outputProfile.sampleRate,
        channels: outputProfile.channels,
        bitrateKbps: outputProfile.bitrateKbps,
      });
    }
  });

  it('rejects stale-revision renders, empty projects and oversized previews', async () => {
    const p = await newProject(alice, ['x']);
    expect(
      (await as(h, alice).post(`/projects/${p.id}/render`, { revision: p.revision - 1 })).body.error.code,
    ).toBe('REVISION_CONFLICT');
    const empty = await as(h, alice).post(`/workspaces/${alice.workspaceId}/projects`, {
      name: 'Empty',
      defaultLocale: 'en-US',
    });
    expect(
      (await as(h, alice).post(`/projects/${empty.body.data.id}/render`, { revision: 0 })).body.error.code,
    ).toBe('NOTHING_TO_RENDER');
    const big = await as(h, alice).post(`/segments/${p.segments[0]!.id}/preview`, {
      sourceText: 'a'.repeat(1500),
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('TEXT_TOO_LONG');
    const huge = await as(h, alice).put(`/projects/${p.id}/segments`, {
      projectRevision: p.revision,
      segments: Array.from({ length: 600 }, () => ({
        id: randomUUID(),
        sourceText: 'x'.repeat(4000),
        locale: 'en-US',
        voiceId: 'espeak:en-us',
        settings: defaults,
      })),
    });
    expect(huge.status).toBe(413);
  });

  it('standalone previews for the voice library work and are private', async () => {
    const r = await as(h, alice).post('/previews', {
      text: 'Bonjour à tous.',
      voiceId: 'espeak:fr-fr',
      locale: 'fr-FR',
    });
    const done = await waitForJob(h, alice, r.body.data.id);
    expect(done.status).toBe('succeeded');
    expect((await as(h, bob).get(`/assets/${(done.resultAsset as { id: string }).id}`)).status).toBe(404);
  });
});

describe('voice selection, persistence and switching', () => {
  const put = async (u: TestUser, id: string, revision: number, seg: Record<string, unknown>) =>
    as(h, u).put(`/projects/${id}/segments`, { projectRevision: revision, segments: [seg] });

  it('persists the selected voice and its settings, and keeps them when the voice is switched', async () => {
    const p = await newProject(alice, ['Xin chào các bạn.']);
    const seg = p.segments[0]!;
    const base = {
      id: seg.id,
      sourceText: 'Xin chào các bạn.',
      locale: 'vi-VN',
      voiceId: 'espeak:vi-vn-x-south',
      settings: { ...defaults, rate: 1.25, pitch: 60, pauseAfterMs: 300 },
    };
    const saved = await put(alice, p.id, p.revision, base);
    expect(saved.status).toBe(200);
    const reload = async () =>
      (await as(h, alice).get(`/projects/${p.id}`)).body.data as {
        revision: number;
        segments: { voiceId: string; locale: string; settings: Record<string, unknown> }[];
      };
    let cur = await reload();
    expect(cur.segments[0]).toMatchObject({
      voiceId: 'espeak:vi-vn-x-south',
      locale: 'vi-VN',
      settings: { rate: 1.25, pitch: 60, pauseAfterMs: 300 },
    });
    // Switch to another voice of the same language: settings survive, the project stays renderable.
    const sw = await put(alice, p.id, cur.revision, { ...base, voiceId: 'espeak:vi' });
    expect(sw.status).toBe(200);
    cur = await reload();
    expect(cur.segments[0]).toMatchObject({
      voiceId: 'espeak:vi',
      settings: { rate: 1.25, pitch: 60, pauseAfterMs: 300 },
    });
    const job = (await as(h, alice).post(`/projects/${p.id}/render`, { revision: cur.revision })).body.data;
    expect((await waitForJob(h, alice, job.id)).status).toBe('succeeded');
  });

  it('validates locale compatibility and per-voice settings on save', async () => {
    const p = await newProject(alice, ['Hello.']);
    const seg = p.segments[0]!;
    const body = {
      id: seg.id,
      sourceText: 'Hello.',
      locale: 'en-US',
      voiceId: 'espeak:vi',
      settings: defaults,
    };
    const mismatch = await put(alice, p.id, p.revision, body);
    expect(mismatch.status).toBeGreaterThanOrEqual(400);
    expect(mismatch.body.error.code).toBe('VOICE_LOCALE_UNSUPPORTED');
    const badVariant = await put(alice, p.id, p.revision, {
      ...body,
      locale: 'vi-VN',
      settings: { ...defaults, variant: 'no-such-variant' },
    });
    expect(badVariant.status).toBe(400);
    expect(badVariant.body.error.code).toBe('PARAMETER_UNSUPPORTED');
    const outOfRange = await put(alice, p.id, p.revision, {
      ...body,
      locale: 'vi-VN',
      settings: { ...defaults, rate: 99 },
    });
    expect(outOfRange.body.error.code).toBe('PARAMETER_OUT_OF_RANGE');
  });

  it('previews with the selected voice, not a default', async () => {
    const speak = async (voiceId: string) => {
      const r = await as(h, alice).post('/previews', {
        text: 'Xin chào.',
        voiceId,
        locale: 'vi-VN',
      });
      const done = await waitForJob(h, alice, r.body.data.id);
      expect(done.status).toBe('succeeded');
      const meta = (await as(h, alice).get(`/assets/${(done.resultAsset as { id: string }).id}`)).body.data;
      return meta.engine as { nativeVoiceId?: string; voiceId?: string };
    };
    const a = await speak('espeak:vi');
    const b = await speak('espeak:vi-vn-x-south');
    expect(JSON.stringify(b)).toContain('vi-vn-x-south');
    expect(JSON.stringify(a)).not.toContain('vi-vn-x-south');
  });
});

describe('render provenance', () => {
  it('reports the actual engine and voices on previews, segment audio and exports', async () => {
    const p = await newProject(alice, ['One.', 'Two.']);
    const job = (await as(h, alice).post(`/projects/${p.id}/render`, { revision: p.revision })).body.data;
    const done = await waitForJob(h, alice, job.id);
    expect(done.status).toBe('succeeded');
    expect(done.resultAsset.engines).toEqual([expect.stringMatching(/^espeak@1.52.0$/)]);
    expect(done.resultAsset.voices).toEqual(['espeak:en-us']);
    const pv = await as(h, alice).post('/previews', {
      text: 'Xin chào.',
      voiceId: 'espeak:vi',
      locale: 'vi-VN',
    });
    const pd = await waitForJob(h, alice, pv.body.data.id);
    expect(pd.resultAsset.engines).toEqual(['espeak@1.52.0']);
    expect(pd.resultAsset.voices).toEqual(['espeak:vi']);
  });
});

describe('jobs: cancel, retry, failure, recovery', () => {
  it('cancels a queued job and retries it to success without duplicate assets', async () => {
    const p = await newProject(alice, ['Cancel me please. '.repeat(5)]);
    await h.worker.stop();
    const job = (await as(h, alice).post(`/projects/${p.id}/render`, { revision: p.revision })).body.data;
    expect(job.status).toBe('queued');
    const c = await as(h, alice).post(`/render-jobs/${job.id}/cancel`);
    expect(c.body.data.status).toBe('cancelled');
    expect((await as(h, alice).post(`/render-jobs/${job.id}/cancel`)).body.error.code).toBe(
      'JOB_NOT_CANCELLABLE',
    );
    const { RenderWorker } = await import('../../worker/dist/worker');
    h.worker = new RenderWorker({ config: h.config, prisma: h.prisma, pollMs: 200, logger: () => undefined });
    await h.worker.start();
    const retried = await as(h, alice).post(`/render-jobs/${job.id}/retry`);
    expect(retried.body.data.status).toBe('queued');
    const done = await waitForJob(h, alice, job.id);
    expect(done.status).toBe('succeeded');
    expect(await h.prisma.audioAsset.count({ where: { renderJobId: job.id, kind: 'export' } })).toBe(1);
    expect((await as(h, alice).post(`/render-jobs/${job.id}/retry`)).body.error.code).toBe(
      'JOB_NOT_RETRYABLE',
    );
  });

  it('cancels a running job', async () => {
    const p = await newProject(
      alice,
      Array.from(
        { length: 12 },
        (_, i) => `Long running segment number ${i} with some more words to synthesize.`,
      ),
    );
    const job = (await as(h, alice).post(`/projects/${p.id}/render`, { revision: p.revision })).body.data;
    for (let i = 0; i < 100; i++) {
      const s = (await as(h, alice).get(`/render-jobs/${job.id}`)).body.data;
      if (s.status === 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await as(h, alice).post(`/render-jobs/${job.id}/cancel`);
    const done = await waitForJob(h, alice, job.id);
    expect(['cancelled', 'succeeded']).toContain(done.status);
    if (done.status === 'cancelled') expect(done.errorCode).toBe('JOB_CANCELLED');
  });

  it('a failed render keeps the previous export and exposes a safe error', async () => {
    const p = await newProject(alice, ['Good render.']);
    const ok = await waitForJob(
      h,
      alice,
      (await as(h, alice).post(`/projects/${p.id}/render`, { revision: p.revision })).body.data.id,
    );
    const prev = (ok.resultAsset as { id: string }).id;
    const fresh = await as(h, alice).get(`/projects/${p.id}`);
    // Admin disables the engine between planning and execution → job fails safely.
    await h.worker.stop();
    const job = (
      await as(h, alice).post(`/projects/${p.id}/export`, {
        revision: fresh.body.data.revision,
        outputProfile: { format: 'mp3', sampleRate: 22050, channels: 1 },
      })
    ).body.data;
    await h.prisma.ttsEngine.update({ where: { id: 'espeak' }, data: { enabled: false } });
    const { RenderWorker } = await import('../../worker/dist/worker');
    h.worker = new RenderWorker({ config: h.config, prisma: h.prisma, pollMs: 200, logger: () => undefined });
    await h.worker.start();
    const failed = await waitForJob(h, alice, job.id);
    await h.prisma.ttsEngine.update({ where: { id: 'espeak' }, data: { enabled: true } });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('ENGINE_DISABLED');
    expect(String(failed.errorMessage)).not.toMatch(/[\\/]/);
    const after = await as(h, alice).get(`/projects/${p.id}`);
    expect(after.body.data.latestExport.id).toBe(prev);
    expect(after.body.data.status).toBe('rendered');
  });

  it('re-queues jobs whose worker died (lease expiry) and completes them', async () => {
    const p = await newProject(alice, ['Crash recovery.']);
    await h.worker.stop();
    const job = (await as(h, alice).post(`/projects/${p.id}/render`, { revision: p.revision })).body.data;
    // Simulate a worker that claimed the job and crashed.
    await h.prisma.renderJob.update({
      where: { id: job.id },
      data: {
        status: 'running',
        lockedBy: 'dead-worker',
        lockedUntil: new Date(Date.now() - 1000),
        attempts: 1,
      },
    });
    const { RenderWorker } = await import('../../worker/dist/worker');
    h.worker = new RenderWorker({ config: h.config, prisma: h.prisma, pollMs: 200, logger: () => undefined });
    await h.worker.start();
    const done = await waitForJob(h, alice, job.id);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
    const project = await as(h, alice).get(`/projects/${p.id}`);
    expect(project.body.data.segments[0].audioState).toBe('ready');
  });
});

describe('presets and admin', () => {
  it('lists built-ins, applies with a change report, and protects built-ins', async () => {
    const list = await as(h, alice).get('/presets');
    const learner = list.body.data.find((p: { name: string }) => p.name === 'Learner pace');
    expect(learner.isBuiltin).toBe(true);
    const p = await newProject(alice, ['Preset target.']);
    const dry = await as(h, alice).post(`/presets/${learner.id}/apply`, {
      projectRevision: p.revision,
      segmentIds: [p.segments[0]!.id],
      dryRun: true,
    });
    expect(dry.body.data.changes[0].changes.map((c: { key: string }) => c.key).sort()).toEqual([
      'pauseAfterMs',
      'rate',
      'wordGapMs',
    ]);
    const applied = await as(h, alice).post(`/presets/${learner.id}/apply`, {
      projectRevision: p.revision,
      segmentIds: [p.segments[0]!.id],
    });
    expect(applied.body.data.project.segments[0].settings.rate).toBe(0.75);
    expect((await as(h, alice).patch(`/presets/${learner.id}`, { name: 'x' })).status).toBe(403);
    const mine = await as(h, alice).post('/presets', { name: 'Mine', parameters: { rate: 1.1 } });
    expect(mine.status).toBe(201);
    expect((await as(h, bob).patch(`/presets/${mine.body.data.id}`, { name: 'x' })).status).toBe(404);
    expect(
      (await as(h, alice).post('/presets', { name: 'Bad', parameters: { breathiness: 3 } })).status,
    ).toBe(400);
  });
  it('admin can disable a voice; disabled voices are not selectable', async () => {
    const admin = await register(h, `admin2-${randomUUID().slice(0, 4)}@example.test`).catch(() => null);
    expect(admin).not.toBeNull();
    const a = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.test', password: 'correct-horse-battery' });
    const adm = {
      cookie: (a.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
      csrf: a.body.data.csrfToken,
      workspaceId: '',
      userId: '',
    };
    const off = await as(h, adm).patch('/admin/voices/espeak:de', { enabled: false });
    expect(off.status).toBe(200);
    expect((await as(h, alice).get('/voices?locale=de')).body.data).toEqual([]);
    expect((await as(h, adm).patch('/admin/voices/espeak:ja', { enabled: true })).status).toBe(403);
    await as(h, adm).patch('/admin/voices/espeak:de', { enabled: true });
    const ov = await as(h, adm).get('/admin/overview');
    expect(ov.body.data.worker.espeakVersion).toBe('1.52.0');
    expect(ov.body.data.storage.assetCount).toBeGreaterThan(0);
  });
});

describe('security payloads', () => {
  it('handles command-injection and path-like text safely', async () => {
    const p = await newProject(alice, [
      '$(rm -rf /) `id` ; ls ../../ [[x]] -w /tmp/evil <script>alert(1)</script>',
    ]);
    const done = await waitForJob(
      h,
      alice,
      (await as(h, alice).post(`/segments/${p.segments[0]!.id}/preview`)).body.data.id,
    );
    expect(done.status).toBe('succeeded');
  });
  it('rejects oversized JSON with 413 and malformed JSON with 400', async () => {
    const big = await h
      .http()
      .post('/api/v1/text/split')
      .set('Cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ text: 'a'.repeat(3_000_000), mode: 'sentence', locale: 'en-US' }));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const bad = await h
      .http()
      .post('/api/v1/text/split')
      .set('Cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .set('content-type', 'application/json')
      .send('{"text":');
    expect(bad.status).toBe(400);
  });
  it('does not leak stack traces or paths in errors', async () => {
    const r = await as(h, alice).get(`/projects/${randomUUID()}`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/at \w+ \(|[A-Z]:\\|node_modules/);
  });
  it('restricts CORS to configured origins', async () => {
    const ok = await h.http().get('/api/v1/health/live').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const evil = await h.http().get('/api/v1/health/live').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
