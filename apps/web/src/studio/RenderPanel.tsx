import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  estimateOutputBytes,
  type OutputProfile,
  type ProjectDto,
  type RenderJobDto,
} from '@voxstudio/contracts';
import { api, assetUrl, describeError } from '../api/client';
import { qk, useProjectJobs } from '../api/hooks';
import { Dialog, ErrorNote, JobBadge, Progress, Spinner, fmtBytes, fmtDate, fmtMs } from '../components/ui';
import { engineLabel } from '../components/VoiceProfilePanel';
import { translate, translateWarning, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { saveNow } from './persistence';
import { useStudio } from './store';

export function loadRenderIntoPlayer(job: RenderJobDto): void {
  if (!job.resultAsset) return;
  useStudio.getState().setPlayer({
    status: 'ready',
    error: null,
    source: {
      kind: 'project',
      assetId: job.resultAsset.id,
      format: job.resultAsset.format,
      createdAt: job.createdAt,
      timeline: job.timeline ?? undefined,
    },
  });
}

/** Saves pending edits, then queues a render at the saved revision. */
export async function startRender(
  projectId: string,
  outputProfile?: OutputProfile,
  purpose: 'render' | 'export' = 'render',
): Promise<RenderJobDto> {
  const ok = await saveNow();
  if (!ok && useStudio.getState().saveState !== 'saved')
    throw new Error(useStudio.getState().saveError ?? translate('studio.saveError'));
  const revision = useStudio.getState().revision;
  return api<RenderJobDto>(`/projects/${projectId}/${purpose}`, {
    method: 'POST',
    body:
      purpose === 'export'
        ? { revision, outputProfile }
        : { revision, ...(outputProfile ? { outputProfile } : {}) },
  });
}

export function RenderQueue({ projectId }: { projectId: string }) {
  const { t, lang } = useI18n();
  const jobs = useProjectJobs(projectId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const projectJobs = (jobs.data ?? []).filter((j) => j.kind === 'project');
  const act = async (path: string) => {
    setError(null);
    try {
      await api(path, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: qk.jobs(projectId) });
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <section aria-label={t('queue.region')} className="flex h-full flex-col">
      <h2 className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {t('queue.title')}
      </h2>
      <div className="flex-1 space-y-2 overflow-auto p-2 scroll-thin" aria-live="polite">
        {jobs.isLoading && <Spinner />}
        {error && <ErrorNote error={error} />}
        {jobs.data && projectJobs.length === 0 && (
          <p className="p-2 text-xs text-muted">{t('queue.empty')}</p>
        )}
        {projectJobs.map((j) => (
          <div
            key={j.id}
            className="rounded-md border border-line bg-panel-2 p-2 text-xs"
            data-job={j.outputProfile.format}
          >
            <div className="mb-1 flex items-center gap-2">
              <JobBadge status={j.status} />
              <span className="font-mono text-dim">
                {j.outputProfile.format.toUpperCase()} {j.outputProfile.sampleRate / 1000}k{' '}
                {j.outputProfile.channels === 2 ? t('queue.stereo') : t('queue.mono')}
              </span>
              <span className="ml-auto text-dim">{fmtDate(j.createdAt, lang)}</span>
            </div>
            {!!j.resultAsset?.engines?.length && (
              <p className="mb-1 text-dim" data-testid="render-engine">
                {t('render.madeWith', { engine: j.resultAsset.engines.map(engineLabel).join(', ') })}
              </p>
            )}
            {(j.status === 'running' || j.status === 'queued') && (
              <Progress value={j.progressUnits} max={j.totalUnits} label={t('queue.progress')} />
            )}
            {j.errorMessage && j.status !== 'succeeded' && (
              <p className="mt-1 text-danger">{translateJobError(j)}</p>
            )}
            {j.warnings.length > 0 && j.status === 'succeeded' && (
              <ul className="mt-1 space-y-0.5 text-warn">
                {j.warnings.map((w) => (
                  <li key={w}>⚠ {translateWarning(w)}</li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1">
              {j.status === 'succeeded' && j.resultAsset && (
                <>
                  <button className="btn btn-sm" onClick={() => loadRenderIntoPlayer(j)}>
                    {t('queue.load')}
                  </button>
                  <a className="btn btn-sm" href={assetUrl(j.resultAsset.id, 'download')} download>
                    {t('queue.download', {
                      size: fmtBytes(j.resultAsset.fileSizeBytes, lang),
                      duration: fmtMs(j.resultAsset.durationMs),
                    })}
                  </a>
                </>
              )}
              {(j.status === 'queued' || j.status === 'running') && (
                <button className="btn btn-sm" onClick={() => void act(`/render-jobs/${j.id}/cancel`)}>
                  {t('queue.cancel')}
                </button>
              )}
              {(j.status === 'failed' || j.status === 'cancelled') && (
                <button className="btn btn-sm" onClick={() => void act(`/render-jobs/${j.id}/retry`)}>
                  {t('queue.retry')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Job errors are stored with stable codes; show them in the UI language. */
export function translateJobError(j: Pick<RenderJobDto, 'errorCode' | 'errorMessage'>): string {
  const key = `error.${j.errorCode}`;
  const msg = translate(key);
  return msg === key ? (j.errorMessage ?? '') : msg;
}

const FORMATS: {
  format: OutputProfile['format'];
  title: MessageKey;
  desc: MessageKey;
  recommended?: boolean;
}[] = [
  { format: 'mp3', title: 'export.mp3', desc: 'export.mp3Desc', recommended: true },
  { format: 'wav', title: 'export.wav', desc: 'export.wavDesc' },
  { format: 'ogg', title: 'export.ogg', desc: 'export.oggDesc' },
];

export function ExportDialog({ project, onClose }: { project: ProjectDto; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [profile, setProfile] = useState<OutputProfile>(
    project.settings.outputProfile.format === 'wav' && project.settings.outputProfile.sampleRate === 22050
      ? { format: 'mp3', sampleRate: 44100, channels: 1, bitrateKbps: 128 }
      : project.settings.outputProfile,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const server = useStudio((s) => s.server);
  const segments = useStudio((s) => s.segments);
  const knownMs = useMemo(
    () =>
      segments.reduce(
        (n, s) =>
          n + (server[s.id]?.audio?.durationMs ?? 0) + s.settings.pauseBeforeMs + s.settings.pauseAfterMs,
        0,
      ),
    [segments, server],
  );
  const allKnown = segments.every((s) => server[s.id]?.audio);
  const setFormat = (format: OutputProfile['format']) =>
    setProfile(
      format === 'wav'
        ? { format, sampleRate: profile.sampleRate, channels: profile.channels, bitDepth: 16 }
        : { format, sampleRate: profile.sampleRate, channels: profile.channels, bitrateKbps: 128 },
    );
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await startRender(project.id, profile, 'export');
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('export.title')} onClose={onClose}>
      <fieldset>
        <legend className="label">{t('export.choose')}</legend>
        <div className="grid gap-2">
          {FORMATS.map((f) => (
            <label
              key={f.format}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${profile.format === f.format ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'}`}
            >
              <input
                type="radio"
                name="format"
                className="mt-1"
                checked={profile.format === f.format}
                onChange={() => setFormat(f.format)}
                aria-label={t(f.title)}
              />
              <span>
                <span className="font-medium">{t(f.title)}</span>
                {f.recommended && (
                  <span className="badge ml-2 bg-accent/15 text-accent-strong">
                    {t('export.recommended')}
                  </span>
                )}
                <span className="block text-xs text-muted">{t(f.desc)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs text-muted">{t('export.advanced')}</summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="sr">
              {t('export.sampleRate')}
            </label>
            <select
              id="sr"
              className="input"
              value={profile.sampleRate}
              onChange={(e) =>
                setProfile({ ...profile, sampleRate: Number(e.target.value) as OutputProfile['sampleRate'] })
              }
            >
              <option value={22050}>{t('export.nativeRate', { rate: (22050).toLocaleString(lang) })}</option>
              <option value={44100}>{(44100).toLocaleString(lang)} Hz</option>
              <option value={48000}>{(48000).toLocaleString(lang)} Hz</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ch">
              {t('export.channels')}
            </label>
            <select
              id="ch"
              className="input"
              value={profile.channels}
              onChange={(e) => setProfile({ ...profile, channels: Number(e.target.value) as 1 | 2 })}
            >
              <option value={1}>{t('export.mono')}</option>
              <option value={2}>{t('export.stereo')}</option>
            </select>
          </div>
          {profile.format === 'wav' ? (
            <div>
              <label className="label" htmlFor="bd">
                {t('export.bitDepth')}
              </label>
              <select
                id="bd"
                className="input"
                value={profile.bitDepth ?? 16}
                onChange={(e) => setProfile({ ...profile, bitDepth: Number(e.target.value) as 16 | 24 })}
              >
                <option value={16}>16-bit</option>
                <option value={24}>24-bit</option>
              </select>
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="br">
                {t('export.bitrate')}
              </label>
              <select
                id="br"
                className="input"
                value={profile.bitrateKbps ?? 128}
                onChange={(e) => setProfile({ ...profile, bitrateKbps: Number(e.target.value) })}
              >
                {[64, 96, 128, 192, 256, 320].map((b) => (
                  <option key={b} value={b}>
                    {b} kbps
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </details>
      <p className="mt-3 text-xs text-muted">
        {knownMs
          ? t('export.size', { size: `≈ ${fmtBytes(estimateOutputBytes(profile, knownMs), lang)}` })
          : t('export.sizeUnknown')}
        {knownMs > 0 && !allKnown && t('export.sizeLow')}
        {profile.sampleRate > 22050 && t('export.upsampleNote')}
      </p>
      <p className="mt-1 text-xs text-dim">{t('export.validated')}</p>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t('export.queuing') : t('export.submit')}
        </button>
      </div>
    </Dialog>
  );
}
