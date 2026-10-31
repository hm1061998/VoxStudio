import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, assetUrl, describeError } from '../api/client';
import { qk, useJobEvents, useRecentJobs } from '../api/hooks';
import { Empty, ErrorNote, JobBadge, Progress, Spinner, fmtBytes, fmtDate, fmtMs } from '../components/ui';
import { engineLabel } from '../components/VoiceProfilePanel';
import { useI18n } from '../i18n';
import { translateJobError } from '../studio/RenderPanel';

export function RenderCenterPage() {
  const { t, lang } = useI18n();
  const jobs = useRecentJobs();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  useJobEvents();
  const act = async (path: string) => {
    setError(null);
    try {
      await api(path, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: qk.recentJobs });
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className="h-full overflow-auto p-6 scroll-thin">
      <h1 className="mb-4 text-lg font-semibold">{t('renders.title')}</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted">{t('renders.intro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {jobs.isLoading && <Spinner />}
      {jobs.error && <ErrorNote error={jobs.error} onRetry={() => void jobs.refetch()} />}
      {jobs.data?.length === 0 && <Empty title={t('renders.empty')}>{t('renders.emptyHint')}</Empty>}
      {!!jobs.data?.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-panel-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('renders.col.status')}</th>
                <th className="px-3 py-2 font-medium">{t('renders.col.project')}</th>
                <th className="px-3 py-2 font-medium">{t('renders.col.output')}</th>
                <th className="w-64 px-3 py-2 font-medium">{t('renders.col.progress')}</th>
                <th className="px-3 py-2 font-medium">{t('renders.col.queued')}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t('dash.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody aria-live="polite">
              {jobs.data.map((j) => (
                <tr key={j.id} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2">
                    <JobBadge status={j.status} />
                  </td>
                  <td className="px-3 py-2">
                    <Link className="hover:text-accent-strong" to={`/projects/${j.projectId}`}>
                      {t('renders.open')}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted">
                    {j.outputProfile.format.toUpperCase()} {j.outputProfile.sampleRate.toLocaleString(lang)}{' '}
                    Hz {j.outputProfile.channels === 2 ? t('queue.stereo') : t('queue.mono')}
                    {!!j.resultAsset?.engines?.length && (
                      <span className="block font-sans text-dim" data-testid="render-engine">
                        {t('render.madeWith', { engine: j.resultAsset.engines.map(engineLabel).join(', ') })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Progress value={j.progressUnits} max={j.totalUnits} label={t('queue.progress')} />
                    {j.errorMessage && j.status !== 'succeeded' && (
                      <p className="mt-1 text-xs text-danger">{translateJobError(j)}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{fmtDate(j.createdAt, lang)}</td>
                  <td className="px-3 py-2 text-right">
                    {j.status === 'succeeded' && j.resultAsset && (
                      <a className="btn btn-sm" href={assetUrl(j.resultAsset.id, 'download')}>
                        ⤓ {fmtBytes(j.resultAsset.fileSizeBytes, lang)} · {fmtMs(j.resultAsset.durationMs)}
                      </a>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
