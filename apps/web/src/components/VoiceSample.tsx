import { useRef, useState } from 'react';
import type { RenderJobDto } from '@voxstudio/contracts';
import { api, assetUrl, describeError } from '../api/client';
import { waitForJob } from '../api/hooks';
import { useI18n } from '../i18n';
import { ErrorNote } from './ui';

/**
 * Plays a real sample of a voice: the server synthesizes the sample text with that voice and engine
 * (a normal preview job). Nothing is pre-recorded or faked.
 */
export function VoiceSample({
  voiceId,
  locale,
  text,
  compact,
}: {
  voiceId: string;
  locale: string;
  text: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [asset, setAsset] = useState<{ id: string; voiceId: string } | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const speak = async () => {
    setState('busy');
    setError(null);
    try {
      const job = await api<RenderJobDto>('/previews', { method: 'POST', body: { text, voiceId, locale } });
      const done = await waitForJob(job);
      if (done.status !== 'succeeded' || !done.resultAsset)
        throw new Error(done.errorMessage ?? t('player.previewFailed'));
      setAsset({ id: done.resultAsset.id, voiceId });
      setState('idle');
      setTimeout(() => void audio.current?.play().catch(() => undefined), 50);
    } catch (e) {
      setError(describeError(e));
      setState('error');
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          className={`btn btn-sm ${compact ? '' : 'btn-primary'}`}
          disabled={state === 'busy' || !text}
          onClick={() => void speak()}
        >
          {state === 'busy' ? t('insp.sampling') : t('insp.sample')}
        </button>
        {asset?.voiceId === voiceId && (
          <audio
            ref={audio}
            controls
            src={assetUrl(asset.id)}
            className="h-8 min-w-0 flex-1"
            aria-label={t('insp.sampleAria')}
          />
        )}
      </div>
      {error && <ErrorNote error={error} />}
    </div>
  );
}
