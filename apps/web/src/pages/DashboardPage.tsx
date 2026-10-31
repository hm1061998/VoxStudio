import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  SETTING_KEYS,
  type ProjectDto,
  type ProjectSummaryDto,
  type SynthesisSettings,
  type VoiceDetailDto,
} from '@voxstudio/contracts';
import { api, assetUrl, describeError } from '../api/client';
import { useProjects, useVoices } from '../api/hooks';
import { useAuth } from '../app/auth';
import { Confirm, Dialog, Empty, ErrorNote, JobBadge, Spinner, fmtDate, fmtMs } from '../components/ui';
import { accentName, languageName, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { VoiceGallery } from '../components/VoiceGallery';
import { availableAccents, availableGenders, defaultVoiceFor, type Gender } from '../studio/voicePick';

const SEGMENT_MAX = 5000;

export function DashboardPage() {
  const { workspaceId } = useAuth();
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('updated');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummaryDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const projects = useProjects(workspaceId, q, sort, archived);
  const qc = useQueryClient();
  const nav = useNavigate();
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError(describeError(e));
    }
  };
  const isEmpty = projects.data?.length === 0 && !q && !archived;

  return (
    <div className="h-full overflow-auto p-6 scroll-thin">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold">{t('dash.title')}</h1>
        <label className="sr-only" htmlFor="search">
          {t('dash.search')}
        </label>
        <input
          id="search"
          className="input w-56"
          placeholder={t('dash.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="sr-only" htmlFor="sort">
          {t('dash.sort')}
        </label>
        <select id="sort" className="input w-40" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="updated">{t('dash.sort.updated')}</option>
          <option value="created">{t('dash.sort.created')}</option>
          <option value="name">{t('dash.sort.name')}</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />{' '}
          {t('dash.archived')}
        </label>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          {t('dash.new')}
        </button>
      </header>
      {actionError && (
        <div className="mb-3">
          <ErrorNote error={actionError} />
        </div>
      )}
      {projects.isLoading && <Spinner label={t('dash.loading')} />}
      {projects.error && <ErrorNote error={projects.error} onRetry={() => void projects.refetch()} />}
      {isEmpty && <QuickStart onCreate={() => setCreating(true)} />}
      {projects.data && projects.data.length === 0 && !isEmpty && (
        <Empty title={archived ? t('dash.emptyArchived') : t('dash.emptySearch')} />
      )}
      {projects.data && projects.data.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-panel-2 text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t('dash.col.name')}</th>
                <th className="px-4 py-2 font-medium">{t('dash.col.language')}</th>
                <th className="px-4 py-2 font-medium">{t('dash.col.segments')}</th>
                <th className="px-4 py-2 font-medium">{t('dash.col.lastRender')}</th>
                <th className="px-4 py-2 font-medium">{t('dash.col.latestFile')}</th>
                <th className="px-4 py-2 font-medium">{t('dash.col.edited')}</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">{t('dash.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-panel-2/50">
                  <td className="px-4 py-2.5">
                    <Link to={`/projects/${p.id}`} className="font-medium hover:text-accent-strong">
                      {p.name}
                    </Link>
                    {p.status === 'archived' && (
                      <span className="badge ml-2 bg-line text-dim">{t('dash.archivedBadge')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{languageName(p.defaultLocale, lang)}</td>
                  <td className="px-4 py-2.5 text-muted">{p.segmentCount}</td>
                  <td className="px-4 py-2.5">
                    {p.lastRenderStatus ? (
                      <JobBadge status={p.lastRenderStatus} />
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {p.latestExport ? (
                      <a
                        className="text-accent underline underline-offset-2"
                        href={assetUrl(p.latestExport.id, 'download')}
                      >
                        ⤓ {p.latestExport.format.toUpperCase()} · {fmtMs(p.latestExport.durationMs)}
                      </a>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{fmtDate(p.updatedAt, lang)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          void act(async () =>
                            nav(
                              `/projects/${(await api<ProjectDto>(`/projects/${p.id}/duplicate`, { method: 'POST' })).id}`,
                            ),
                          )
                        }
                      >
                        {t('common.duplicate')}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          void act(() =>
                            api(`/projects/${p.id}`, {
                              method: 'PATCH',
                              body: { revision: p.revision, archived: !p.archivedAt },
                            }),
                          )
                        }
                      >
                        {p.archivedAt ? t('dash.unarchive') : t('dash.archive')}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost text-danger"
                        onClick={() => setConfirmDelete(p)}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <CreateProjectDialog onClose={() => setCreating(false)} onCreated={(id) => nav(`/projects/${id}`)} />
      )}
      {confirmDelete && (
        <Confirm
          danger
          title={t('dash.deleteTitle')}
          message={t('dash.deleteMsg', { name: confirmDelete.name })}
          confirmLabel={t('dash.deleteBtn')}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => void act(() => api(`/projects/${confirmDelete.id}`, { method: 'DELETE' }))}
        />
      )}
    </div>
  );
}

function QuickStart({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <section className="card mx-auto max-w-2xl p-6" aria-labelledby="qs-title">
      <h2 id="qs-title" className="mb-4 text-base font-semibold">
        {t('quick.title')}
      </h2>
      <ol className="mb-5 space-y-3">
        {(['quick.step1', 'quick.step2', 'quick.step3'] as const).map((k, i) => (
          <li key={k} className="flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent-strong">
              {i + 1}
            </span>
            <span className="pt-0.5">{t(k)}</span>
          </li>
        ))}
      </ol>
      <button className="btn btn-primary" onClick={onCreate}>
        {t('dash.createFirst')}
      </button>
    </section>
  );
}

function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { workspaceId } = useAuth();
  const { t, lang } = useI18n();
  const voices = useVoices();
  const [name, setName] = useState(() => t('create.untitled'));
  const [wantedLocale, setLocale] = useState(lang === 'vi' ? 'vi-VN' : 'en-US');
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locales = useMemo(
    () =>
      [...new Set((voices.data ?? []).map((v) => v.locale))]
        .map((l) => [l, languageName(l, lang)] as const)
        .sort((a, b) => a[1].localeCompare(b[1], lang)),
    [voices.data, lang],
  );
  // Only languages that have an installed voice are offered; the wish falls back to the first available one.
  const locale = locales.some(([l]) => l === wantedLocale) ? wantedLocale : (locales[0]?.[0] ?? wantedLocale);
  const [accent, setAccent] = useState('');
  const [gender, setGender] = useState('');
  const forLocale = (voices.data ?? []).filter((v) => v.locale === locale);
  const shown = forLocale.filter((v) => (!accent || v.accent === accent) && (!gender || v.gender === gender));
  const accentChoices = availableAccents(voices.data ?? [], locale, (gender || null) as Gender | null);
  const genderChoices = availableGenders(voices.data ?? [], locale, accent || null);
  // Keep the chosen voice valid when region or gender narrows the list.
  const effectiveVoice = shown.some((v) => v.id === voiceId)
    ? voiceId
    : (defaultVoiceFor(shown, locale)?.id ?? shown[0]?.id ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const p = await api<ProjectDto>(`/workspaces/${workspaceId}/projects`, {
        method: 'POST',
        body: { name, defaultLocale: locale, defaultVoiceId: effectiveVoice },
      });
      if (text.trim()) {
        const voice = await api<VoiceDetailDto>(`/voices/${encodeURIComponent(effectiveVoice)}`);
        const settings = Object.fromEntries(
          SETTING_KEYS.map((k) => [k, voice.capabilities[k].default]),
        ) as SynthesisSettings;
        const { segments } = await api<{ segments: string[] }>('/text/split', {
          method: 'POST',
          body: { text, mode: 'paragraph', locale },
        });
        const pieces = segments.flatMap((s) =>
          s.length > SEGMENT_MAX ? (s.match(new RegExp(`[\\s\\S]{1,${SEGMENT_MAX}}`, 'g')) ?? []) : [s],
        );
        await api(`/projects/${p.id}/segments`, {
          method: 'PUT',
          body: {
            projectRevision: p.revision,
            segments: pieces.map((s) => ({
              id: crypto.randomUUID(),
              sourceText: s,
              locale,
              voiceId: effectiveVoice,
              settings,
            })),
          },
        });
      }
      onCreated(p.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('create.title')} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="pname">
            {t('create.name')}
          </label>
          <input
            id="pname"
            className="input"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="plocale">
              {t('create.language')}
            </label>
            <select
              id="plocale"
              className="input"
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value);
                setAccent('');
                setGender('');
                setVoiceId(voices.data?.find((v) => v.locale === e.target.value)?.id ?? '');
              }}
            >
              {locales.map(([l, n]) => (
                <option key={l} value={l}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        {(accentChoices.length > 1 || genderChoices.length > 0) && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="paccent">
                {t('create.accent')}
              </label>
              <select
                id="paccent"
                className="input"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
              >
                <option value="">{t('create.any')}</option>
                {accentChoices.map((a) => (
                  <option key={a} value={a}>
                    {accentName(a, lang)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="pgender">
                {t('create.gender')}
              </label>
              <select
                id="pgender"
                className="input"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                <option value="">{t('create.any')}</option>
                {genderChoices.map((g) => (
                  <option key={g} value={g}>
                    {t(`profile.gender.${g}` as MessageKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {shown.length === 0 ? (
          <p className="text-sm text-warn">{t('create.noMatch')}</p>
        ) : (
          <VoiceGallery voices={shown} all={voices.data ?? []} value={effectiveVoice} onChange={setVoiceId} />
        )}
        <p className="text-xs text-muted">{t('create.voiceHint')}</p>
        <div>
          <label className="label" htmlFor="ptext">
            {t('create.text')}
          </label>
          <textarea
            id="ptext"
            className="input h-40 resize-y leading-relaxed"
            lang={locale}
            placeholder={t('create.textPlaceholder')}
            value={text}
            maxLength={200_000}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {error && <ErrorNote error={error} />}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!effectiveVoice || busy}>
            {busy ? t('create.creating') : t('create.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
