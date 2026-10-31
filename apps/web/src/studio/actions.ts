import type { ProjectDto, RenderJobDto, SynthesisSettings } from '@voxstudio/contracts';
import { api, describeError } from '../api/client';
import { translate } from '../i18n';
import { waitForJob } from '../api/hooks';
import { saveNow } from './persistence';
import { fingerprint, useStudio, type DraftSegment } from './store';

const PREVIEW_MAX = 1000;

export async function refreshServer(): Promise<void> {
  const { projectId, applyServer } = useStudio.getState();
  if (!projectId) return;
  applyServer(await api<ProjectDto>(`/projects/${projectId}`));
}

/** Preview one segment with its current draft values (unsaved slider changes included). */
export async function previewSegment(id: string): Promise<void> {
  let st = useStudio.getState();
  const seg = st.segments.find((s) => s.id === id);
  if (!seg) return;
  st.setPreviewing(id);
  st.setPlayer({ status: 'loading', error: null });
  try {
    if (!st.server[id]) {
      await saveNow();
      st = useStudio.getState();
      if (!st.server[id]) throw new Error(translate('studio.saveFirst'));
    }
    const long = [...seg.sourceText].length > PREVIEW_MAX;
    if (long) await saveNow();
    const job = await api<RenderJobDto>(`/segments/${id}/${long ? 'render' : 'preview'}`, {
      method: 'POST',
      body: long
        ? {}
        : { sourceText: seg.sourceText, voiceId: seg.voiceId, locale: seg.locale, settings: seg.settings },
    });
    const done = await waitForJob(job);
    if (done.status === 'succeeded' && done.resultAsset) {
      useStudio.getState().addTake({
        id: crypto.randomUUID(),
        segmentId: id,
        assetId: done.resultAsset.id,
        voiceId: seg.voiceId,
        locale: seg.locale,
        text: seg.sourceText,
        settings: { ...seg.settings },
        engines: done.resultAsset.engines ?? [],
        durationMs: done.resultAsset.durationMs,
        createdAt: done.resultAsset.createdAt,
      });
      useStudio.getState().setPlayer({
        status: 'ready',
        source: {
          kind: 'segment',
          assetId: done.resultAsset.id,
          segmentId: id,
          fingerprint: fingerprint(seg),
        },
        error: done.warnings.filter((w) => !w.startsWith('Served from')).join('\n') || null,
      });
    } else {
      useStudio
        .getState()
        .setPlayer({ status: 'failed', error: done.errorMessage ?? translate('player.previewFailed') });
    }
  } catch (e) {
    useStudio.getState().setPlayer({ status: 'failed', error: describeError(e) });
  } finally {
    useStudio.getState().setPreviewing(null);
    void refreshServer().catch(() => undefined);
  }
}

/**
 * Copy a voice and its settings onto other paragraphs (text is never touched). Paragraphs in another
 * language are skipped because the voice cannot speak them; the caller reports the counts.
 */
export function applyVoiceSettings(
  from: Pick<DraftSegment, 'voiceId' | 'locale' | 'settings'>,
  targetIds: string[],
): { applied: number; skipped: number } {
  const st = useStudio.getState();
  const lang = (l: string) => l.split('-')[0]!.toLowerCase();
  let applied = 0;
  let skipped = 0;
  const next = st.segments.map((s) => {
    if (!targetIds.includes(s.id)) return s;
    if (lang(s.locale) !== lang(from.locale)) {
      skipped++;
      return s;
    }
    applied++;
    return { ...s, voiceId: from.voiceId, locale: from.locale, settings: { ...from.settings } };
  });
  if (applied) st.commit(next);
  return { applied, skipped };
}

export function newSegment(
  base: Pick<DraftSegment, 'locale' | 'voiceId' | 'settings'>,
  sourceText = '',
): DraftSegment {
  return {
    id: crypto.randomUUID(),
    sourceText,
    locale: base.locale,
    voiceId: base.voiceId,
    settings: { ...base.settings } as SynthesisSettings,
  };
}

export function updateSegment(id: string, patch: Partial<DraftSegment>, coalesceKey?: string): void {
  const st = useStudio.getState();
  st.commit(
    st.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    coalesceKey,
  );
}

export function splitAt(id: string, offset: number): void {
  const st = useStudio.getState();
  const i = st.segments.findIndex((s) => s.id === id);
  const seg = st.segments[i];
  if (!seg) return;
  const a = seg.sourceText.slice(0, offset).trim();
  const b = seg.sourceText.slice(offset).trim();
  if (!a || !b) return;
  const next = [...st.segments];
  const second = newSegment(seg, b);
  next.splice(i, 1, { ...seg, sourceText: a }, second);
  st.commit(next);
  st.select(second.id);
}

export function mergeWithNext(id: string): void {
  const st = useStudio.getState();
  const i = st.segments.findIndex((s) => s.id === id);
  const a = st.segments[i];
  const b = st.segments[i + 1];
  if (!a || !b) return;
  const next = [...st.segments];
  next.splice(i, 2, { ...a, sourceText: `${a.sourceText.trim()} ${b.sourceText.trim()}`.trim() });
  st.commit(next);
}

export function move(id: string, delta: -1 | 1): void {
  const st = useStudio.getState();
  const i = st.segments.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= st.segments.length) return;
  const next = [...st.segments];
  [next[i], next[j]] = [next[j]!, next[i]!];
  st.commit(next);
}

export function remove(ids: string[]): void {
  const st = useStudio.getState();
  st.commit(st.segments.filter((s) => !ids.includes(s.id)));
  st.setChecked(st.checked.filter((x) => !ids.includes(x)));
}
