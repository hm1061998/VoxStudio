import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { NormalizationPreviewDto, ToneDiagnosticsDto } from '@voxstudio/contracts';
import { api, describeError } from '../api/client';
import { useUiMode } from '../app/uiMode';
import { Dialog, ErrorNote, Spinner, fmtMs } from '../components/ui';
import { hasKey, translate, translateWarning, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { mergeWithNext, newSegment, previewSegment, splitAt, updateSegment } from './actions';
import { TakesPanel } from './TakesPanel';
import { useStudio } from './store';

const SEGMENT_MAX = 5000;
const PAUSE_CHOICES = [300, 500, 1000, 1500, 2000, 3000];
const PAUSE_RE = /\[pause\s+(\d+(?:\.\d+)?)\s*(ms|s)\]/gi;

function stats(text: string, rate: number) {
  const clean = text.replace(PAUSE_RE, ' ');
  const words = clean.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  let pause = 0;
  for (const m of text.matchAll(PAUSE_RE)) pause += Number(m[1]) * (m[2]!.toLowerCase() === 's' ? 1000 : 1);
  return { chars: [...text].length, words, estMs: Math.round((words / (175 * rate)) * 60000) + pause };
}

export function SegmentEditor() {
  const { t, lang } = useI18n();
  const advanced = useUiMode((s) => s.mode) === 'advanced';
  const selectedId = useStudio((s) => s.selectedId);
  const segments = useStudio((s) => s.segments);
  const previewing = useStudio((s) => s.previewing);
  const seg = segments.find((s) => s.id === selectedId);
  const index = segments.findIndex((s) => s.id === selectedId);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [pauseMs, setPauseMs] = useState(500);
  const [showNorm, setShowNorm] = useState(false);
  const [pron, setPron] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!seg)
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
        {t('editor.noSelection')}
      </div>
    );

  const st = stats(seg.sourceText, seg.settings.rate * seg.settings.tempo);
  const insertPause = () => {
    const pos = ta.current?.selectionStart ?? seg.sourceText.length;
    const marker = ` [pause ${pauseMs}ms] `;
    updateSegment(seg.id, {
      sourceText: (seg.sourceText.slice(0, pos) + marker + seg.sourceText.slice(pos)).replace(/ {2,}/g, ' '),
    });
  };

  const autoSplit = async () => {
    setBusy('split');
    setError(null);
    try {
      const r = await api<{ segments: string[] }>('/text/split', {
        method: 'POST',
        body: { text: seg.sourceText, mode: 'sentence', locale: seg.locale },
      });
      if (r.segments.length <= 1) return setError(t('editor.noBoundaries'));
      const s = useStudio.getState();
      const next = [...s.segments];
      next.splice(
        index,
        1,
        { ...seg, sourceText: r.segments[0]! },
        ...r.segments.slice(1).map((x) => newSegment(seg, x)),
      );
      s.commit(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const importTxt = async (file: File) => {
    setError(null);
    if (file.size > 200_000) return setError(t('editor.fileTooBig'));
    if (!/\.txt$/i.test(file.name) && file.type && file.type !== 'text/plain')
      return setError(t('editor.notTxt'));
    const text = (await file.text()).replace(/^\uFEFF/, '');
    if (text.includes('\0')) return setError(t('editor.notUtf8'));
    setBusy('import');
    try {
      const r = await api<{ segments: string[] }>('/text/split', {
        method: 'POST',
        body: { text, mode: 'paragraph', locale: seg.locale },
      });
      const pieces = r.segments.flatMap((p) =>
        p.length > SEGMENT_MAX ? (p.match(new RegExp(`[\\s\\S]{1,${SEGMENT_MAX}}`, 'g')) ?? []) : [p],
      );
      const s = useStudio.getState();
      const next = [...s.segments];
      next.splice(index + 1, 0, ...pieces.map((x) => newSegment(seg, x)));
      s.commit(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={t('editor.title', { n: index + 1 })} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <h2 className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {t('editor.title', { n: index + 1 })}
        </h2>
        <button
          className="btn btn-sm"
          onClick={() => splitAt(seg.id, ta.current?.selectionStart ?? 0)}
          title={t('editor.splitCursorTitle')}
        >
          {t('editor.splitCursor')}
        </button>
        <button
          className="btn btn-sm"
          disabled={index === segments.length - 1}
          onClick={() => mergeWithNext(seg.id)}
        >
          {t('editor.merge')}
        </button>
        <button className="btn btn-sm" disabled={busy === 'split'} onClick={() => void autoSplit()}>
          {t('editor.splitSentences')}
        </button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <label className="sr-only" htmlFor="pause-ms">
          {t('editor.pauseLength')}
        </label>
        {advanced ? (
          <input
            id="pause-ms"
            type="number"
            min={50}
            max={10000}
            step={50}
            className="input w-20 py-1 text-xs"
            value={pauseMs}
            onChange={(e) => setPauseMs(Math.max(50, Math.min(10000, Number(e.target.value) || 0)))}
          />
        ) : (
          <select
            id="pause-ms"
            className="input w-auto py-1 text-xs"
            value={pauseMs}
            onChange={(e) => setPauseMs(Number(e.target.value))}
          >
            {PAUSE_CHOICES.map((ms) => (
              <option key={ms} value={ms}>
                {t('insp.seconds', { n: (ms / 1000).toLocaleString(lang) })}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm" onClick={insertPause} title={t('editor.addPauseTitle')}>
          {t('editor.addPause')}
        </button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <button
          className="btn btn-sm"
          onClick={() => {
            const a = ta.current;
            const sel = a ? a.value.slice(a.selectionStart, a.selectionEnd).trim() : '';
            setPron(sel.slice(0, 100));
          }}
        >
          {t('pron.addQuick')}
        </button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <button
          className="btn btn-sm"
          onClick={() => fileInput.current?.click()}
          disabled={busy === 'import'}
        >
          {t('editor.import')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          aria-label={t('editor.importLabel')}
          onChange={(e) =>
            e.target.files?.[0] && void importTxt(e.target.files[0]).finally(() => (e.target.value = ''))
          }
        />
        <button
          className="btn btn-primary ml-auto"
          disabled={!seg.sourceText.trim() || !!previewing}
          onClick={() => void previewSegment(seg.id)}
        >
          {previewing === seg.id ? t('editor.synthesizing') : t('editor.listen')}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 scroll-thin">
        <label className="sr-only" htmlFor="segment-text">
          {t('editor.text')}
        </label>
        <textarea
          id="segment-text"
          ref={ta}
          className="input min-h-40 flex-1 resize-none leading-relaxed"
          style={{ fontSize: 16 }}
          spellCheck
          lang={seg.locale}
          maxLength={SEGMENT_MAX}
          placeholder={t('editor.placeholder')}
          value={seg.sourceText}
          onChange={(e) => updateSegment(seg.id, { sourceText: e.target.value }, `text:${seg.id}`)}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-live="polite">
          <span>{t('editor.words', { n: st.words })}</span>
          <span>{t('editor.chars', { n: st.chars, max: SEGMENT_MAX })}</span>
          <span title={t('editor.estimateTitle')}>{t('editor.estimate', { time: fmtMs(st.estMs) })}</span>
          <label className="ml-auto flex items-center gap-1.5">
            <input type="checkbox" checked={showNorm} onChange={(e) => setShowNorm(e.target.checked)} />{' '}
            {t('editor.showNorm')}
          </label>
        </div>
        {error && <ErrorNote error={error} />}
        <TakesPanel segmentId={seg.id} />
        {showNorm && (
          <NormalizationPanel
            text={seg.sourceText}
            locale={seg.locale}
            voiceId={seg.voiceId}
            showPhonemes={advanced}
          />
        )}
      </div>
      {pron !== null && (
        <PronunciationDialog initial={pron} locale={seg.locale} onClose={() => setPron(null)} />
      )}
    </section>
  );
}

/** Quick access to the pronunciation dictionary from the editor: add an override for the selected word. */
function PronunciationDialog({
  initial,
  locale,
  onClose,
}: {
  initial: string;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [match, setMatch] = useState(initial);
  const [say, setSay] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/pronunciation-entries', {
        method: 'POST',
        body: { locale, matchText: match.trim(), replacementText: say.trim() },
      });
      await qc.invalidateQueries({ queryKey: ['pronunciation'] });
      useStudio.getState().bumpDictionary();
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('pron.quickTitle')} onClose={onClose}>
      <p className="mb-3 text-xs text-muted">{t('pron.quickHelp')}</p>
      <label className="label" htmlFor="pq-match">
        {t('pron.quickWord')}
      </label>
      <input
        id="pq-match"
        className="input mb-3"
        lang={locale}
        maxLength={100}
        value={match}
        onChange={(e) => setMatch(e.target.value)}
      />
      <label className="label" htmlFor="pq-say">
        {t('pron.quickSay')}
      </label>
      <input
        id="pq-say"
        className="input mb-3"
        lang={locale}
        maxLength={200}
        value={say}
        onChange={(e) => setSay(e.target.value)}
      />
      {error && <ErrorNote error={error} />}
      {saved && (
        <p role="status" className="mb-2 text-sm text-accent">
          {t('pron.quickSaved')}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <Link to="/pronunciation" className="text-xs text-accent underline">
          {t('pron.open')}
        </Link>
        <div className="flex gap-2">
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !match.trim() || !say.trim() || saved}
            onClick={() => void save()}
          >
            {t('pron.quickSave')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ToneTable({ d }: { d: ToneDiagnosticsDto }) {
  const { t } = useI18n();
  return (
    <div>
      <p className="label">{t('norm.tones')}</p>
      <p className="mb-1 text-[11px] text-dim">{t('norm.tonesNote')}</p>
      {d.syllables.length > 0 && (
        <div className="max-h-40 overflow-auto scroll-thin">
          <table className="w-full text-xs">
            <thead className="text-left text-dim">
              <tr>
                <th className="py-0.5 pr-2 font-medium">{t('norm.col.syllable')}</th>
                <th className="py-0.5 pr-2 font-medium">{t('norm.col.onset')}</th>
                <th className="py-0.5 pr-2 font-medium">{t('norm.col.vowel')}</th>
                <th className="py-0.5 pr-2 font-medium">{t('norm.col.final')}</th>
                <th className="py-0.5 font-medium">{t('norm.col.tone')}</th>
              </tr>
            </thead>
            <tbody>
              {d.syllables.map((s, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-0.5 pr-2 font-medium">{s.syllable}</td>
                  <td className="py-0.5 pr-2 font-mono text-muted">{s.onset || '∅'}</td>
                  <td className="py-0.5 pr-2 font-mono text-muted">
                    {s.glide}
                    {s.nucleus}
                  </td>
                  <td className="py-0.5 pr-2 font-mono text-muted">{s.coda || '∅'}</td>
                  <td className="py-0.5 text-muted">{t(('tone.' + s.tone) as MessageKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.truncated && <p className="text-[11px] text-dim">{t('norm.truncated')}</p>}
      {d.unreadable.length > 0 && (
        <p className="mt-1 text-xs text-warn">⚠ {t('norm.unreadable', { list: d.unreadable.join(', ') })}</p>
      )}
    </div>
  );
}

function NormalizationPanel({
  text,
  locale,
  voiceId,
  showPhonemes,
}: {
  text: string;
  locale: string;
  voiceId: string;
  showPhonemes: boolean;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<NormalizationPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dictionaryVersion = useStudio((s) => s.dictionaryVersion);
  useEffect(() => {
    if (!text.trim()) return setData(null);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api<NormalizationPreviewDto>('/text/normalize-preview', {
        method: 'POST',
        body: { text, locale, voiceId },
        signal: ac.signal,
      })
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => (e as Error).name !== 'AbortError' && setError(describeError(e)))
        .finally(() => setLoading(false));
    }, 400);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [text, locale, voiceId, dictionaryVersion]);
  return (
    <div className="card max-h-56 shrink-0 overflow-auto p-3 text-sm scroll-thin">
      {loading && !data && <Spinner label={t('norm.loading')} />}
      {error && <ErrorNote error={error} />}
      {data && (
        <div className="space-y-2">
          <div>
            <p className="label">{t('norm.normalized')}</p>
            <p className="whitespace-pre-wrap">{data.normalized}</p>
          </div>
          {data.steps.length > 0 && (
            <div>
              <p className="label">{t('norm.rules')}</p>
              <ul className="space-y-0.5 text-xs text-muted">
                {data.steps.map((s, i) => (
                  <li key={i}>
                    <span className="text-dim">
                      {hasKey(`norm.rule.${s.rule}`) ? translate(`norm.rule.${s.rule}`) : s.rule}
                    </span>
                    : “{s.from}” → “{s.to}”
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.pronunciationApplied.length > 0 && (
            <p className="text-xs text-muted">
              {t('norm.pron', {
                list: data.pronunciationApplied.map((p) => `${p.matchText} ×${p.count}`).join(', '),
              })}
            </p>
          )}
          {showPhonemes && (
            <div>
              <p className="label">{t('norm.phonemes')}</p>
              <p className="font-mono text-xs text-muted">{data.phonemes || '—'}</p>
            </div>
          )}
          {data.diagnostics && <ToneTable d={data.diagnostics} />}
          {data.warnings.map((w) => (
            <p key={w} className="text-xs text-warn">
              ⚠ {translateWarning(w)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
