import { create } from 'zustand';
import { SETTING_KEYS, type ProjectDto, type SegmentDto, type SynthesisSettings } from '@voxstudio/contracts';

export interface DraftSegment {
  id: string;
  sourceText: string;
  locale: string;
  voiceId: string;
  settings: SynthesisSettings;
}

/** One generated preview kept for comparison. Audio is the real server asset; nothing is synthesized client-side. */
export interface Take {
  id: string;
  segmentId: string;
  assetId: string;
  voiceId: string;
  locale: string;
  text: string;
  settings: SynthesisSettings;
  /** Engines recorded by the server for this audio (`id@version`). */
  engines: string[];
  durationMs: number;
  createdAt: string;
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface PlayerSource {
  kind: 'segment' | 'project';
  assetId: string;
  /** For project renders: shown in the player label. */
  format?: string;
  createdAt?: string;
  segmentId?: string;
  /** Fingerprint of the draft that produced this audio; used to flag stale audio. */
  fingerprint?: string;
  timeline?: {
    segmentId: string;
    startMs: number;
    endMs: number;
    speechStartMs: number;
    speechEndMs: number;
    position: number;
  }[];
}

interface StudioState {
  projectId: string | null;
  revision: number;
  segments: DraftSegment[];
  server: Record<string, SegmentDto>;
  selectedId: string | null;
  checked: string[];
  past: DraftSegment[][];
  future: DraftSegment[][];
  lastCoalesce: { key: string; at: number } | null;
  saveState: SaveState;
  saveError: string | null;
  player: {
    source: PlayerSource | null;
    status: 'idle' | 'loading' | 'ready' | 'failed';
    error: string | null;
  };
  previewing: string | null;
  takes: Take[];
  /** Bumped when the pronunciation dictionary changes, so open "how it will be read" panels refresh. */
  dictionaryVersion: number;
  bumpDictionary: () => void;

  addTake: (t: Take) => void;
  removeTake: (id: string) => void;
  load: (p: ProjectDto) => void;
  applyServer: (p: ProjectDto, opts?: { replaceDrafts?: boolean }) => void;
  commit: (next: DraftSegment[], coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[]) => void;
  setSave: (s: SaveState, error?: string | null) => void;
  setRevision: (r: number) => void;
  setPlayer: (p: Partial<StudioState['player']>) => void;
  setPreviewing: (id: string | null) => void;
}

const HISTORY_LIMIT = 100;
const TAKE_LIMIT = 12;
const COALESCE_MS = 1500;

export const toDraft = (s: SegmentDto): DraftSegment => ({
  id: s.id,
  sourceText: s.sourceText,
  locale: s.locale,
  voiceId: s.voiceId,
  settings: s.settings,
});
export const fingerprint = (s: DraftSegment): string =>
  JSON.stringify([s.sourceText, s.locale, s.voiceId, SETTING_KEYS.map((k) => s.settings[k])]);

export const useStudio = create<StudioState>((set, get) => ({
  projectId: null,
  revision: 0,
  segments: [],
  server: {},
  selectedId: null,
  checked: [],
  past: [],
  future: [],
  lastCoalesce: null,
  saveState: 'saved',
  saveError: null,
  player: { source: null, status: 'idle', error: null },
  previewing: null,
  takes: [],
  dictionaryVersion: 0,
  bumpDictionary: () => set((st) => ({ dictionaryVersion: st.dictionaryVersion + 1 })),

  addTake: (t) => set((st) => ({ takes: [t, ...st.takes].slice(0, TAKE_LIMIT) })),
  removeTake: (id) => set((st) => ({ takes: st.takes.filter((x) => x.id !== id) })),

  load: (p) =>
    set({
      projectId: p.id,
      revision: p.revision,
      segments: p.segments.map(toDraft),
      server: Object.fromEntries(p.segments.map((s) => [s.id, s])),
      selectedId: p.segments[0]?.id ?? null,
      checked: [],
      past: [],
      future: [],
      lastCoalesce: null,
      saveState: 'saved',
      saveError: null,
      player: { source: null, status: 'idle', error: null },
      previewing: null,
      takes: [],
    }),

  applyServer: (p, opts) =>
    set((st) => ({
      revision: Math.max(st.revision, p.revision),
      server: Object.fromEntries(p.segments.map((s) => [s.id, s])),
      ...(opts?.replaceDrafts ? { segments: p.segments.map(toDraft), revision: p.revision } : {}),
    })),

  commit: (next, coalesceKey) => {
    const st = get();
    const now = Date.now();
    const coalesce =
      !!coalesceKey && st.lastCoalesce?.key === coalesceKey && now - st.lastCoalesce.at < COALESCE_MS;
    set({
      segments: next,
      past: coalesce ? st.past : [...st.past, st.segments].slice(-HISTORY_LIMIT),
      future: [],
      lastCoalesce: coalesceKey ? { key: coalesceKey, at: now } : null,
      saveState: 'dirty',
    });
    if (st.selectedId && !next.some((s) => s.id === st.selectedId)) set({ selectedId: next[0]?.id ?? null });
  },

  undo: () => {
    const st = get();
    const prev = st.past[st.past.length - 1];
    if (!prev) return;
    set({
      segments: prev,
      past: st.past.slice(0, -1),
      future: [st.segments, ...st.future],
      lastCoalesce: null,
      saveState: 'dirty',
    });
  },

  redo: () => {
    const st = get();
    const next = st.future[0];
    if (!next) return;
    set({
      segments: next,
      future: st.future.slice(1),
      past: [...st.past, st.segments],
      lastCoalesce: null,
      saveState: 'dirty',
    });
  },

  select: (id) => set({ selectedId: id }),
  toggleCheck: (id) =>
    set((st) => ({
      checked: st.checked.includes(id) ? st.checked.filter((x) => x !== id) : [...st.checked, id],
    })),
  setChecked: (ids) => set({ checked: ids }),
  setSave: (s, error = null) => set({ saveState: s, saveError: error }),
  setRevision: (r) => set({ revision: r }),
  setPlayer: (p) => set((st) => ({ player: { ...st.player, ...p } })),
  setPreviewing: (id) => set({ previewing: id }),
}));
