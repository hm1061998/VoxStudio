import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { JobEventDto, ProjectDto, ProjectVersionDto, SegmentInput } from '@voxstudio/contracts';
import { api, describeError } from '../api/client';
import { qk, useJobEvents, useProject, useVoice } from '../api/hooks';
import { Confirm, Dialog, ErrorNote, Spinner, fmtDate } from '../components/ui';
import { newSegment, previewSegment, refreshServer } from './actions';
import { Inspector, defaultsFrom } from './Inspector';
import {
  clearLocalDraft,
  enqueue,
  readLocalDraft,
  saveNow,
  useAutosave,
  type LocalDraft,
} from './persistence';
import { Player } from './Player';
import { ExportDialog, RenderQueue, loadRenderIntoPlayer, startRender } from './RenderPanel';
import { SegmentEditor } from './SegmentEditor';
import { SegmentList } from './SegmentList';
import { fingerprint, useStudio } from './store';
import { ModeSwitch } from '../app/Shell';
import { useUiMode } from '../app/uiMode';
import { languageName, useI18n } from '../i18n';

function isTextInput(el: Element | null): boolean {
  return (
    !!el &&
    (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' &&
        !['checkbox', 'range', 'radio', 'button'].includes((el as HTMLInputElement).type)) ||
      (el as HTMLElement).isContentEditable)
  );
}

export function StudioPage() {
  const { t, lang } = useI18n();
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const qc = useQueryClient();
  const load = useStudio((s) => s.load);
  const loadedId = useStudio((s) => s.projectId);
  const [recovery, setRecovery] = useState<LocalDraft | null>(null);
  const [exporting, setExporting] = useState(false);
  const [versions, setVersions] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1100);
  const [renderError, setRenderError] = useState<string | null>(null);
  useAutosave();

  useEffect(() => {
    if (!project.data || loadedId === project.data.id) return;
    load(project.data);
    const draft = readLocalDraft(project.data.id);
    const current = JSON.stringify(project.data.segments.map((s) => [s.id, fingerprint(s)]));
    const local = draft && JSON.stringify(draft.segments.map((s) => [s.id, fingerprint(s)]));
    if (draft && local !== current) setRecovery(draft);
    else if (draft) clearLocalDraft(project.data.id);
  }, [project.data, loadedId, load]);

  useEffect(() => () => useStudio.setState({ projectId: null }), []);

  const refreshTimer = useRef<number | null>(null);
  useJobEvents(
    useCallback(
      (e: JobEventDto) => {
        if (e.job.projectId !== projectId) return;
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => void refreshServer().catch(() => undefined), 300);
        if (e.job.kind === 'project' && e.type === 'job.succeeded' && e.job.purpose !== 'preview') {
          loadRenderIntoPlayer(e.job);
          void qc.invalidateQueries({ queryKey: ['projects'] });
        }
      },
      [projectId, qc],
    ),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
        return;
      }
      if (mod && e.key === 'Enter') {
        const id = useStudio.getState().selectedId;
        if (id) void previewSegment(id);
        return;
      }
      if (isTextInput(document.activeElement)) return; // native text undo inside fields
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStudio.getState().undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        useStudio.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (project.isLoading)
    return (
      <div className="p-6">
        <Spinner label={t('studio.loading')} />
      </div>
    );
  if (project.error)
    return (
      <div className="p-6">
        <ErrorNote error={project.error} onRetry={() => void project.refetch()} />
      </div>
    );
  if (!project.data || loadedId !== project.data.id)
    return (
      <div className="p-6">
        <Spinner label={t('studio.opening')} />
      </div>
    );
  const p = project.data;

  const render = async () => {
    setRenderError(null);
    try {
      await startRender(p.id);
      await qc.invalidateQueries({ queryKey: qk.jobs(p.id) });
    } catch (e) {
      setRenderError(describeError(e));
    }
  };

  return (
    <div className="grid h-full grid-rows-[auto_auto_1fr_auto]">
      <TopBar
        project={p}
        onExport={() => setExporting(true)}
        onRender={() => void render()}
        onVersions={() => setVersions(true)}
        onToggleInspector={() => setInspectorOpen((o) => !o)}
        inspectorOpen={inspectorOpen}
      />
      <div>
        {recovery && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm"
          >
            <span>
              {t('studio.recovered', { when: fmtDate(recovery.savedAt, lang) })}
              {recovery.baseRevision !== p.revision ? t('studio.recoveredOld') : ''}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => {
                useStudio.getState().commit(recovery.segments);
                setRecovery(null);
              }}
            >
              {t('studio.restoreEdits')}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                clearLocalDraft(p.id);
                setRecovery(null);
              }}
            >
              {t('studio.discard')}
            </button>
          </div>
        )}
        {renderError && (
          <div className="px-4 py-2">
            <ErrorNote error={renderError} />
          </div>
        )}
      </div>
      <div className="grid min-h-0 grid-cols-[minmax(220px,280px)_minmax(0,1fr)_auto]">
        <div className="min-h-0 border-r border-line bg-panel">
          <SegmentListWithAdd project={p} />
        </div>
        <div className="min-h-0 overflow-hidden">
          <SegmentEditor />
        </div>
        {inspectorOpen && (
          <aside className="min-h-0 w-[300px] border-l border-line bg-panel max-[1100px]:absolute max-[1100px]:right-0 max-[1100px]:top-24 max-[1100px]:bottom-48 max-[1100px]:z-30 max-[1100px]:shadow-2xl">
            <Inspector />
          </aside>
        )}
      </div>
      <div className="grid h-[210px] grid-cols-[minmax(0,1fr)_340px] border-t border-line bg-panel max-[900px]:grid-cols-1 max-[900px]:h-auto">
        <Player />
        <div className="min-h-0 border-l border-line max-[900px]:h-48 max-[900px]:border-l-0 max-[900px]:border-t">
          <RenderQueue projectId={p.id} />
        </div>
      </div>
      {exporting && <ExportDialog project={p} onClose={() => setExporting(false)} />}
      {versions && <VersionsDialog project={p} onClose={() => setVersions(false)} />}
    </div>
  );
}

function SegmentListWithAdd({ project }: { project: ProjectDto }) {
  const voiceId = project.settings.defaultVoiceId ?? 'espeak:en-us';
  const voice = useVoice(voiceId);
  const add = () => {
    const st = useStudio.getState();
    const sel = st.segments.find((s) => s.id === st.selectedId);
    const base =
      sel ??
      (voice.data
        ? {
            locale: project.defaultLocale,
            voiceId,
            settings: { ...defaultsFrom(voice.data.capabilities), ...project.settings.defaultSettings },
          }
        : null);
    if (!base) return;
    const seg = newSegment(base as Pick<SegmentInput, 'locale' | 'voiceId' | 'settings'>);
    const i = sel ? st.segments.indexOf(sel) + 1 : st.segments.length;
    const next = [...st.segments];
    next.splice(i, 0, seg);
    st.commit(next);
    st.select(seg.id);
    setTimeout(() => document.getElementById('segment-text')?.focus(), 0);
  };
  return <SegmentList onAdd={add} />;
}

function SaveStatus() {
  const { t } = useI18n();
  const saveState = useStudio((s) => s.saveState);
  const saveError = useStudio((s) => s.saveError);
  const map = {
    saved: ['text-ok', t('studio.saved')],
    dirty: ['text-muted', t('studio.dirty')],
    saving: ['text-native', t('studio.saving')],
    error: ['text-danger', t('studio.saveError')],
  } as const;
  const [cls, label] = map[saveState];
  return (
    <span role="status" aria-live="polite" className={`text-xs ${cls}`} title={saveError ?? undefined}>
      {label}
      {saveState === 'error' && (
        <button className="btn btn-sm ml-2" onClick={() => window.location.reload()}>
          {t('studio.reload')}
        </button>
      )}
    </span>
  );
}

function TopBar({
  project,
  onExport,
  onRender,
  onVersions,
  onToggleInspector,
  inspectorOpen,
}: {
  project: ProjectDto;
  onExport: () => void;
  onRender: () => void;
  onVersions: () => void;
  onToggleInspector: () => void;
  inspectorOpen: boolean;
}) {
  const { t, lang } = useI18n();
  const simple = useUiMode((s) => s.mode) === 'simple';
  const [help, setHelp] = useState(false);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const segments = useStudio((s) => s.segments);
  const saveError = useStudio((s) => s.saveError);
  const [name, setName] = useState(project.name);
  const qc = useQueryClient();
  const rename = () => {
    if (name.trim() === project.name || !name.trim()) return setName(project.name);
    void enqueue(async () => {
      try {
        const p = await api<ProjectDto>(`/projects/${project.id}`, {
          method: 'PATCH',
          body: { revision: useStudio.getState().revision, name: name.trim() },
        });
        useStudio.getState().setRevision(p.revision);
        qc.setQueryData(qk.project(project.id), (old: ProjectDto | undefined) =>
          old ? { ...old, name: p.name } : old,
        );
      } catch (e) {
        useStudio.getState().setSave('error', describeError(e));
        setName(project.name);
      }
    });
  };
  const canRender = segments.length > 0 && segments.every((s) => s.sourceText.trim());
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <Link to="/" className="btn btn-ghost btn-sm" aria-label={t('studio.back')}>
        ←
      </Link>
      <label className="sr-only" htmlFor="project-name">
        {t('studio.projectName')}
      </label>
      <input
        id="project-name"
        className="w-64 rounded border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-line focus:border-accent focus:outline-none"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="badge bg-line text-muted">{languageName(project.defaultLocale, lang)}</span>
      <SaveStatus />
      {saveError && (
        <span className="max-w-md truncate text-xs text-danger" title={saveError}>
          {saveError}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <button
          className="btn btn-sm"
          disabled={!canUndo}
          onClick={() => useStudio.getState().undo()}
          title={t('studio.undoTitle')}
        >
          {t('studio.undo')}
        </button>
        <button
          className="btn btn-sm"
          disabled={!canRedo}
          onClick={() => useStudio.getState().redo()}
          title={t('studio.redoTitle')}
        >
          {t('studio.redo')}
        </button>
        <ModeSwitch />
        <button className="btn btn-sm" onClick={() => setHelp(true)}>
          ? {t('common.help')}
        </button>
        <button className="btn btn-sm" onClick={onVersions}>
          {t('studio.versions')}
        </button>
        <button className="btn btn-sm" onClick={onToggleInspector} aria-pressed={inspectorOpen}>
          {t('studio.inspector')}
        </button>
        <button
          className="btn btn-sm"
          disabled={!canRender}
          onClick={onExport}
          title={canRender ? undefined : t('studio.needText')}
        >
          {t('studio.export')}
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={!canRender}
          onClick={onRender}
          title={canRender ? t('studio.renderTitle') : t('studio.needText')}
        >
          {t('studio.render')}
        </button>
      </div>
      {!simple && <p className="w-full text-[11px] text-dim">{t('studio.shortcuts')}</p>}
      {help && (
        <Dialog title={t('studio.help.title')} onClose={() => setHelp(false)}>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {(
              ['studio.help.1', 'studio.help.2', 'studio.help.3', 'studio.help.4', 'studio.help.5'] as const
            ).map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-dim">{t('studio.shortcuts')}</p>
        </Dialog>
      )}
    </header>
  );
}

function VersionsDialog({ project, onClose }: { project: ProjectDto; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<ProjectVersionDto[] | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<ProjectVersionDto | null>(null);
  const qc = useQueryClient();
  const reload = useCallback(() => {
    api<ProjectVersionDto[]>(`/projects/${project.id}/versions`)
      .then(setList)
      .catch((e) => setError(describeError(e)));
  }, [project.id]);
  useEffect(reload, [reload]);
  const save = async () => {
    setError(null);
    try {
      await saveNow();
      await api(`/projects/${project.id}/versions`, { method: 'POST', body: label ? { label } : {} });
      setLabel('');
      reload();
    } catch (e) {
      setError(describeError(e));
    }
  };
  const doRestore = async (v: ProjectVersionDto) => {
    setError(null);
    try {
      await saveNow();
      const p = await enqueue(() =>
        api<ProjectDto>(`/projects/${project.id}/versions/${v.id}/restore`, {
          method: 'POST',
          body: { projectRevision: useStudio.getState().revision },
        }),
      );
      useStudio.getState().load(p);
      qc.setQueryData(qk.project(project.id), p);
      onClose();
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <Dialog title={t('versions.title')} onClose={onClose}>
      <div className="mb-3 flex gap-2">
        <label className="sr-only" htmlFor="vlabel">
          {t('versions.label')}
        </label>
        <input
          id="vlabel"
          className="input"
          placeholder={t('versions.label')}
          value={label}
          maxLength={120}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className="btn btn-primary shrink-0" onClick={() => void save()}>
          {t('versions.save')}
        </button>
      </div>
      {error && <ErrorNote error={error} />}
      {!list && !error && <Spinner />}
      {list?.length === 0 && <p className="text-sm text-muted">{t('versions.none')}</p>}
      <ul className="max-h-80 space-y-1 overflow-auto scroll-thin">
        {list?.map((v) => (
          <li key={v.id} className="flex items-center gap-2 rounded border border-line px-3 py-2 text-sm">
            <span className="font-mono text-xs text-dim">r{v.revision}</span>
            <span className="flex-1">
              {v.label ?? <span className="text-muted">{t('versions.untitled')}</span>}
            </span>
            <span className="text-xs text-muted">
              {t('versions.meta', { n: v.segmentCount, when: fmtDate(v.createdAt, lang) })}
            </span>
            <button className="btn btn-sm" onClick={() => setRestore(v)}>
              {t('versions.restore')}
            </button>
          </li>
        ))}
      </ul>
      {restore && (
        <Confirm
          title={t('versions.restoreTitle')}
          message={t('versions.restoreMsg')}
          confirmLabel={t('versions.restore')}
          onClose={() => setRestore(null)}
          onConfirm={() => void doRestore(restore)}
        />
      )}
    </Dialog>
  );
}
