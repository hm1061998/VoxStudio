import { useEffect } from 'react';
import type { ProjectDto } from '@voxstudio/contracts';
import { ApiError, api, describeError } from '../api/client';
import { translate } from '../i18n';
import { useStudio, type DraftSegment } from './store';

let chain: Promise<unknown> = Promise.resolve();
/** All writes that bump the project revision go through one queue, so our own requests never conflict. */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const draftKey = (projectId: string) => `vs-draft-${projectId}`;

export interface LocalDraft {
  baseRevision: number;
  savedAt: string;
  segments: DraftSegment[];
}

export function readLocalDraft(projectId: string): LocalDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(projectId));
    return raw ? (JSON.parse(raw) as LocalDraft) : null;
  } catch {
    return null;
  }
}
export function clearLocalDraft(projectId: string): void {
  try {
    localStorage.removeItem(draftKey(projectId));
  } catch {
    /* storage unavailable */
  }
}
function writeLocalDraft(projectId: string, d: LocalDraft): void {
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify(d));
  } catch {
    /* storage unavailable or full: server autosave still applies */
  }
}

/** Persist the current document. Resolves true when the server has the latest draft. */
export function saveNow(): Promise<boolean> {
  return enqueue(async () => {
    const st = useStudio.getState();
    if (!st.projectId || st.saveState === 'saved') return true;
    const snapshot = st.segments;
    useStudio.getState().setSave('saving');
    try {
      const p = await api<ProjectDto>(`/projects/${st.projectId}/segments`, {
        method: 'PUT',
        body: { projectRevision: useStudio.getState().revision, segments: snapshot },
      });
      const now = useStudio.getState();
      now.setRevision(p.revision);
      now.applyServer(p);
      if (now.segments === snapshot) {
        now.setSave('saved');
        clearLocalDraft(p.id);
        return true;
      }
      now.setSave('dirty');
      return false;
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'REVISION_CONFLICT'
          ? translate('studio.conflict')
          : translate('studio.saveFailed', { msg: describeError(e) });
      useStudio.getState().setSave('error', msg);
      return false;
    }
  });
}

/** Debounced autosave + local crash-recovery copy of unsaved edits. */
export function useAutosave(): void {
  const segments = useStudio((s) => s.segments);
  const saveState = useStudio((s) => s.saveState);
  const projectId = useStudio((s) => s.projectId);
  const revision = useStudio((s) => s.revision);
  useEffect(() => {
    if (!projectId || saveState !== 'dirty') return;
    writeLocalDraft(projectId, { baseRevision: revision, savedAt: new Date().toISOString(), segments });
    const t = setTimeout(() => void saveNow(), 800);
    return () => clearTimeout(t);
  }, [segments, saveState, projectId, revision]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const s = useStudio.getState().saveState;
      if (s === 'dirty' || s === 'saving' || s === 'error') e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
}
