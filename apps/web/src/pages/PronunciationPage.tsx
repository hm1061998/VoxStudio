import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NormalizationPreviewDto,
  PronunciationConflictDto,
  PronunciationEntryDto,
  RenderJobDto,
} from '@voxstudio/contracts';
import { api, assetUrl, describeError } from '../api/client';
import { usePronunciation, useVoices, waitForJob } from '../api/hooks';
import { Confirm, Dialog, Empty, ErrorNote, Spinner } from '../components/ui';
import { useUiMode } from '../app/uiMode';
import { useI18n } from '../i18n';
import { VoiceOptions } from '../studio/Inspector';

type Draft = Omit<PronunciationEntryDto, 'id' | 'createdAt' | 'updatedAt'>;
const EMPTY: Draft = {
  locale: 'vi',
  matchText: '',
  replacementText: '',
  phonemeFormat: null,
  engineScope: null,
  caseSensitive: false,
  wholeWord: true,
  priority: 0,
  enabled: true,
};

export function PronunciationPage() {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const entries = usePronunciation(q);
  const conflicts = useQuery({
    queryKey: ['pron-conflicts'],
    queryFn: () => api<PronunciationConflictDto[]>('/pronunciation-entries/conflicts'),
  });
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PronunciationEntryDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PronunciationEntryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['pronunciation'] });
    await qc.invalidateQueries({ queryKey: ['pron-conflicts'] });
  };
  const exportJson = async () => {
    const data = await api<unknown>('/pronunciation-entries/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voxstudio-pronunciation.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = async (f: File) => {
    setError(null);
    setNotice(null);
    try {
      if (f.size > 2_000_000) throw new Error(t('pron.fileTooBig'));
      const parsed = JSON.parse(await f.text()) as { version?: number; entries?: unknown[] };
      const r = await api<{ imported: number }>('/pronunciation-entries/import', {
        method: 'POST',
        body: { version: parsed.version ?? 1, entries: parsed.entries ?? [], mode: 'merge' },
      });
      setNotice(t('pron.imported', { n: r.imported }));
      await refresh();
    } catch (e) {
      setError(describeError(e));
    }
  };
  const winner = new Map(
    (conflicts.data ?? []).flatMap((c) =>
      c.entryIds.map((id) => [id, c.winnerId === id ? 'wins' : 'overridden'] as const),
    ),
  );
  return (
    <div className="h-full overflow-auto p-6 scroll-thin">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">{t('pron.title')}</h1>
        <label className="sr-only" htmlFor="pq">
          {t('pron.search')}
        </label>
        <input
          id="pq"
          className="input w-56"
          placeholder={t('pron.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn" onClick={() => void exportJson().catch((e) => setError(describeError(e)))}>
          {t('pron.export')}
        </button>
        <button className="btn" onClick={() => file.current?.click()}>
          {t('pron.import')}
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label={t('pron.importLabel')}
          onChange={(e) =>
            e.target.files?.[0] && void importJson(e.target.files[0]).finally(() => (e.target.value = ''))
          }
        />
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          {t('pron.add')}
        </button>
      </header>
      <p className="mb-4 max-w-3xl text-sm text-muted">{t('pron.intro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm text-ok">
          {notice}
        </p>
      )}
      {(conflicts.data?.length ?? 0) > 0 && (
        <div className="card mb-4 border-warn/40 p-3 text-sm">
          <p className="font-medium text-warn">{t('pron.conflicts', { n: conflicts.data!.length })}</p>
          <ul className="mt-1 text-xs text-muted">
            {conflicts.data!.map((c) => (
              <li key={c.locale + c.matchText}>
                {t('pron.conflictLine', { text: c.matchText, locale: c.locale, n: c.entryIds.length })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {entries.isLoading && <Spinner />}
      {entries.error && <ErrorNote error={entries.error} />}
      {entries.data?.length === 0 && (
        <Empty title={q ? t('pron.emptySearch') : t('pron.empty')}>{t('pron.emptyHint')}</Empty>
      )}
      {!!entries.data?.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-panel-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('pron.col.match')}</th>
                <th className="px-3 py-2 font-medium">{t('pron.col.replacement')}</th>
                <th className="px-3 py-2 font-medium">{t('pron.col.locale')}</th>
                <th className="px-3 py-2 font-medium">{t('pron.col.options')}</th>
                <th className="px-3 py-2 font-medium">{t('pron.col.priority')}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t('dash.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.data.map((e) => (
                <tr
                  key={e.id}
                  className={`border-b border-line last:border-0 ${e.enabled ? '' : 'opacity-50'}`}
                >
                  <td className="px-3 py-2 font-medium">{e.matchText}</td>
                  <td className="px-3 py-2">
                    {e.phonemeFormat ? (
                      <span className="font-mono text-xs text-native">/{e.replacementText}/</span>
                    ) : (
                      e.replacementText
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted">{e.locale}</td>
                  <td className="px-3 py-2 text-xs text-muted">
                    {[
                      e.caseSensitive && t('pron.caseSensitive'),
                      e.wholeWord ? t('pron.wholeWord') : t('pron.substring'),
                      e.engineScope && t('pron.engine', { e: e.engineScope }),
                      !e.enabled && t('pron.disabled'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {winner.get(e.id) && (
                      <span
                        className={`badge ml-2 ${winner.get(e.id) === 'wins' ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}
                      >
                        {winner.get(e.id) === 'wins' ? t('pron.wins') : t('pron.overridden')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.priority}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditing(e)}>
                      {t('common.edit')}
                    </button>
                    <button className="btn btn-sm btn-ghost text-danger" onClick={() => setDeleting(e)}>
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EntryEditor
          entry={editing === 'new' ? null : editing}
          defaultLocale={lang === 'vi' ? 'vi' : 'en'}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}
      {deleting && (
        <Confirm
          danger
          title={t('pron.deleteTitle')}
          message={t('pron.deleteMsg', { text: deleting.matchText })}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            void api(`/pronunciation-entries/${deleting.id}`, { method: 'DELETE' })
              .then(refresh)
              .catch((e) => setError(describeError(e)))
          }
        />
      )}
    </div>
  );
}

function EntryEditor({
  entry,
  defaultLocale,
  onClose,
  onSaved,
}: {
  entry: PronunciationEntryDto | null;
  defaultLocale: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const advanced = useUiMode((s) => s.mode) === 'advanced';
  const [d, setD] = useState<Draft>(entry ? { ...entry } : { ...EMPTY, locale: defaultLocale });
  const [error, setError] = useState<string | null>(null);
  const voices = useVoices();
  const [voiceId, setVoiceId] = useState(defaultLocale === 'vi' ? 'espeak:vi' : 'espeak:en-us');
  const [testText, setTestText] = useState('');
  const [preview, setPreview] = useState<NormalizationPreviewDto | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null);
    try {
      await api(entry ? `/pronunciation-entries/${entry.id}` : '/pronunciation-entries', {
        method: entry ? 'PATCH' : 'POST',
        body: d,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(describeError(e));
    }
  };
  /** Preview uses the saved dictionary, so save first when testing a new entry. */
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = voices.data?.find((x) => x.id === voiceId);
      if (!v) throw new Error(t('pron.chooseVoice'));
      const text = testText || t('pron.testing', { text: d.matchText });
      setPreview(
        await api<NormalizationPreviewDto>('/text/normalize-preview', {
          method: 'POST',
          body: { text, locale: v.locale, voiceId },
        }),
      );
      const job = await api<RenderJobDto>('/previews', {
        method: 'POST',
        body: { text, voiceId, locale: v.locale },
      });
      const done = await waitForJob(job);
      if (done.status !== 'succeeded' || !done.resultAsset)
        throw new Error(done.errorMessage ?? t('player.previewFailed'));
      setAudioId(done.resultAsset.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={entry ? t('pron.editTitle') : t('pron.addTitle')} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <label className="label" htmlFor="pm">
            {t('pron.f.match')}
          </label>
          <input
            id="pm"
            className="input"
            value={d.matchText}
            maxLength={200}
            onChange={(e) => setD({ ...d, matchText: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="pr">
            {d.phonemeFormat ? t('pron.f.phonemes') : t('pron.f.replacement')}
          </label>
          <input
            id="pr"
            className={`input ${d.phonemeFormat ? 'font-mono' : ''}`}
            value={d.replacementText}
            maxLength={400}
            onChange={(e) => setD({ ...d, replacementText: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="pl">
            {t('pron.f.locale')}
          </label>
          <input
            id="pl"
            className="input font-mono"
            value={d.locale}
            maxLength={20}
            onChange={(e) => setD({ ...d, locale: e.target.value })}
          />
        </div>
        {advanced && (
          <>
            <div>
              <label className="label" htmlFor="pf">
                {t('pron.f.type')}
              </label>
              <select
                id="pf"
                className="input"
                value={d.phonemeFormat ?? ''}
                onChange={(e) =>
                  setD({
                    ...d,
                    phonemeFormat: e.target.value === 'espeak' ? 'espeak' : null,
                    engineScope: e.target.value === 'espeak' ? 'espeak' : d.engineScope,
                  })
                }
              >
                <option value="">{t('pron.f.typePlain')}</option>
                <option value="espeak">{t('pron.f.typePhoneme')}</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="pp">
                {t('pron.f.priority')}
              </label>
              <input
                id="pp"
                type="number"
                className="input"
                min={-1000}
                max={1000}
                value={d.priority}
                onChange={(e) => setD({ ...d, priority: Number(e.target.value) })}
              />
            </div>
          </>
        )}
        <div className="col-span-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={d.caseSensitive}
              onChange={(e) => setD({ ...d, caseSensitive: e.target.checked })}
            />{' '}
            {t('pron.f.caseSensitive')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={d.wholeWord}
              onChange={(e) => setD({ ...d, wholeWord: e.target.checked })}
            />{' '}
            {t('pron.f.wholeWord')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={d.enabled}
              onChange={(e) => setD({ ...d, enabled: e.target.checked })}
            />{' '}
            {t('pron.f.enabled')}
          </label>
        </div>
      </div>
      <div className="card mt-4 p-3">
        <p className="label">{t('pron.test')}</p>
        <div className="flex gap-2">
          <select
            aria-label={t('pron.testVoice')}
            className="input w-56"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
          >
            <VoiceOptions voices={voices.data ?? []} />
          </select>
          <input
            aria-label={t('pron.testSentence')}
            className="input"
            placeholder={t('pron.testing', { text: d.matchText || '…' })}
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
          />
          <button className="btn shrink-0" disabled={busy} onClick={() => void test()}>
            {busy ? '…' : t('pron.testBtn')}
          </button>
        </div>
        {preview && (
          <div className="mt-2 text-xs">
            <p>
              <span className="text-dim">{t('pron.reads')}</span> {preview.normalized}
            </p>
            {advanced && (
              <p className="font-mono text-muted">
                <span className="text-dim">{t('pron.ipa')}</span> {preview.phonemes}
              </p>
            )}
          </div>
        )}
        {audioId && (
          <audio
            controls
            autoPlay
            src={assetUrl(audioId)}
            className="mt-2 h-8 w-full"
            aria-label={t('pron.testAudio')}
          />
        )}
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-primary"
          disabled={!d.matchText.trim() || !d.replacementText.trim()}
          onClick={() => void save()}
        >
          {t('pron.save')}
        </button>
      </div>
    </Dialog>
  );
}
