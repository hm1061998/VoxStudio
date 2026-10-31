import { useState } from 'react';
import { settingsEqual } from '@voxstudio/contracts';
import { AudioStateBadge, Confirm } from '../components/ui';
import { useI18n } from '../i18n';
import { move, newSegment, previewSegment, remove } from './actions';
import { useStudio } from './store';

export function SegmentList({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  const segments = useStudio((s) => s.segments);
  const server = useStudio((s) => s.server);
  const selectedId = useStudio((s) => s.selectedId);
  const checked = useStudio((s) => s.checked);
  const select = useStudio((s) => s.select);
  const toggleCheck = useStudio((s) => s.toggleCheck);
  const setChecked = useStudio((s) => s.setChecked);
  const previewing = useStudio((s) => s.previewing);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);

  return (
    <section aria-label={t('seg.list')} className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <input
          type="checkbox"
          aria-label={t('seg.selectAll')}
          checked={segments.length > 0 && checked.length === segments.length}
          onChange={(e) => setChecked(e.target.checked ? segments.map((s) => s.id) : [])}
        />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('seg.count', { n: segments.length })}
        </h2>
        <button className="btn btn-sm ml-auto" onClick={onAdd}>
          {t('seg.add')}
        </button>
      </div>
      {checked.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-1.5 text-xs">
          <span className="text-muted">{t('seg.selected', { n: checked.length })}</span>
          <button className="btn btn-sm btn-danger ml-auto" onClick={() => setConfirmIds(checked)}>
            {t('common.delete')}
          </button>
        </div>
      )}
      <ol className="flex-1 overflow-auto p-2 scroll-thin">
        {segments.map((s, i) => {
          const srv = server[s.id];
          const changed =
            srv &&
            (srv.sourceText !== s.sourceText ||
              srv.voiceId !== s.voiceId ||
              !settingsEqual(srv.settings, s.settings));
          const state = !srv ? 'missing' : changed && srv.audioState === 'ready' ? 'stale' : srv.audioState;
          return (
            <li key={s.id} className="mb-1">
              <div
                className={`group flex items-start gap-2 rounded-md border px-2 py-2 ${selectedId === s.id ? 'border-accent/60 bg-accent/10' : 'border-transparent hover:bg-panel-2'}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={t('seg.select', { n: i + 1 })}
                  checked={checked.includes(s.id)}
                  onChange={() => toggleCheck(s.id)}
                />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => select(s.id)}
                  onKeyDown={(e) => {
                    if (e.altKey && e.key === 'ArrowUp') {
                      e.preventDefault();
                      move(s.id, -1);
                    } else if (e.altKey && e.key === 'ArrowDown') {
                      e.preventDefault();
                      move(s.id, 1);
                    }
                  }}
                  aria-current={selectedId === s.id}
                  aria-label={t('seg.aria', { n: i + 1, text: s.sourceText.slice(0, 60) || t('seg.empty') })}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-dim">{String(i + 1).padStart(2, '0')}</span>
                    <AudioStateBadge state={previewing === s.id ? 'rendering' : state} />
                    {srv?.audio && (
                      <span className="font-mono text-[11px] text-dim">
                        {(srv.audio.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  <p className={`mt-0.5 line-clamp-2 text-sm ${s.sourceText ? '' : 'italic text-dim'}`}>
                    {s.sourceText || t('seg.empty')}
                  </p>
                </button>
                <div className="flex flex-col gap-0.5 opacity-60 group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    className="btn btn-ghost btn-sm px-1"
                    aria-label={t('seg.moveUp', { n: i + 1 })}
                    disabled={i === 0}
                    onClick={() => move(s.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-ghost btn-sm px-1"
                    aria-label={t('seg.moveDown', { n: i + 1 })}
                    disabled={i === segments.length - 1}
                    onClick={() => move(s.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-ghost btn-sm px-1"
                    aria-label={t('seg.listen', { n: i + 1 })}
                    disabled={!s.sourceText.trim() || !!previewing}
                    onClick={() => void previewSegment(s.id)}
                  >
                    ▶
                  </button>
                </div>
              </div>
            </li>
          );
        })}
        {segments.length === 0 && <li className="p-4 text-center text-sm text-muted">{t('seg.none')}</li>}
      </ol>
      <p className="border-t border-line px-3 py-1.5 text-[11px] text-dim">{t('seg.reorderHint')}</p>
      {confirmIds && (
        <Confirm
          danger
          title={t('seg.deleteTitle', { n: confirmIds.length })}
          message={t('seg.deleteMsg')}
          confirmLabel={t('common.delete')}
          onClose={() => setConfirmIds(null)}
          onConfirm={() => remove(confirmIds)}
        />
      )}
    </section>
  );
}

export { newSegment };
