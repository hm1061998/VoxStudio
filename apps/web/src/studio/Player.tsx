import { cssColor } from '../app/theme';
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { assetUrl } from '../api/client';
import { ErrorNote, Spinner, fmtDate, fmtMs } from '../components/ui';
import { translateWarning, useI18n } from '../i18n';
import { fingerprint, useStudio } from './store';

type PlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';

/**
 * Waveform player for real rendered audio (server assets). Segment boundaries come from the
 * render timeline; clicking a region selects that segment.
 */
export function Player() {
  const { t, lang } = useI18n();
  const player = useStudio((s) => s.player);
  const segments = useStudio((s) => s.segments);
  const select = useStudio((s) => s.select);
  const container = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const [state, setState] = useState<PlayState>('idle');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const source = player.source;

  useEffect(() => {
    if (!container.current) return;
    const regions = RegionsPlugin.create();
    const w = WaveSurfer.create({
      container: container.current,
      height: 72,
      waveColor: cssColor('--c-wave'),
      progressColor: cssColor('--c-accent'),
      cursorColor: cssColor('--c-fg'),
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      normalize: true,
      plugins: [regions],
    });
    ws.current = w;
    w.on('play', () => setState('playing'));
    w.on('pause', () => setState('paused'));
    w.on('finish', () => setState('paused'));
    w.on('timeupdate', (t) => setTime(t));
    w.on('error', (e) => {
      setState('failed');
      setLoadError(String(e));
    });
    w.on('ready', (d) => {
      setDuration(d);
      setState('paused');
      regions.clearRegions();
      const tl = useStudio.getState().player.source?.timeline;
      tl?.forEach((t, i) =>
        regions.addRegion({
          start: t.speechStartMs / 1000,
          end: t.speechEndMs / 1000,
          content: String(i + 1),
          color: i % 2 ? 'rgba(122,167,255,0.10)' : 'rgba(62,207,178,0.10)',
          drag: false,
          resize: false,
          id: t.segmentId,
        }),
      );
      void w.play().catch(() => undefined);
    });
    regions.on('region-clicked', (r, e) => {
      e.stopPropagation();
      select(r.id);
      w.setTime(r.start);
    });
    return () => w.destroy();
  }, [select]);

  useEffect(() => {
    if (!ws.current || !source) return;
    setLoadError(null);
    setState('loading');
    setTime(0);
    void ws.current.load(assetUrl(source.assetId)).catch(() => undefined);
  }, [source]);

  useEffect(() => {
    if (ws.current && duration) ws.current.zoom(zoom);
  }, [zoom, duration]);

  const label = !source
    ? t('player.empty')
    : source.kind === 'segment'
      ? t('player.segmentLabel', { n: segments.findIndex((x) => x.id === source.segmentId) + 1 })
      : t('player.projectLabel', {
          format: source.format?.toUpperCase() ?? '',
          when: source.createdAt ? fmtDate(source.createdAt, lang) : '',
        });
  const seg = source?.segmentId ? segments.find((s) => s.id === source.segmentId) : undefined;
  const stale = source?.kind === 'segment' && seg && source.fingerprint !== fingerprint(seg);
  const w = ws.current;
  const jump = (dir: -1 | 1) => {
    const tl = source?.timeline;
    if (!w || !tl?.length) return;
    const ms = w.getCurrentTime() * 1000;
    const target =
      dir > 0
        ? tl.find((t) => t.speechStartMs > ms + 50)
        : [...tl].reverse().find((t) => t.speechStartMs < ms - 300);
    if (target) {
      w.setTime(target.speechStartMs / 1000);
      select(target.segmentId);
    }
  };

  return (
    <section aria-label={t('player.region')} className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-sm"
          aria-label={state === 'playing' ? t('player.pauseAria') : t('player.playAria')}
          disabled={!source || state === 'loading' || state === 'failed'}
          onClick={() => void w?.playPause()}
        >
          {state === 'playing' ? t('player.pause') : t('player.play')}
        </button>
        <button
          className="btn btn-sm"
          aria-label={t('player.stopAria')}
          disabled={!source}
          onClick={() => w?.stop()}
        >
          {t('player.stop')}
        </button>
        {source?.timeline && (
          <>
            <button className="btn btn-sm" aria-label={t('player.prev')} onClick={() => jump(-1)}>
              ⏮
            </button>
            <button className="btn btn-sm" aria-label={t('player.next')} onClick={() => jump(1)}>
              ⏭
            </button>
          </>
        )}
        <span className="font-mono text-xs text-muted" aria-live="off">
          {fmtMs(time * 1000)} / {fmtMs(duration * 1000)}
        </span>
        <span className="truncate text-xs text-muted">{label}</span>
        <span role="status" className="text-xs">
          {player.status === 'loading' && <Spinner label={t('player.synthesizing')} />}
          {state === 'loading' && player.status !== 'loading' && <Spinner label={t('player.loadingAudio')} />}
          {stale && <span className="badge bg-warn/15 text-warn">{t('player.stale')}</span>}
        </span>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          {t('player.zoom')}
          <input
            type="range"
            min={0}
            max={300}
            step={10}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label={t('player.zoomAria')}
          />
        </label>
      </div>
      <div
        ref={container}
        role="group"
        className="min-h-[72px] rounded-md border border-line bg-bg"
        aria-label={t('player.waveform')}
      />
      {player.status === 'failed' && player.error && <ErrorNote error={player.error} />}
      {player.status === 'ready' &&
        player.error?.split('\n').map((w) => (
          <p key={w} className="text-xs text-warn">
            ⚠ {translateWarning(w)}
          </p>
        ))}
      {loadError && <ErrorNote error={t('player.loadError')} />}
    </section>
  );
}
