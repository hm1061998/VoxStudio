import { create } from 'zustand';

export type UiMode = 'simple' | 'advanced';
const KEY = 'vs-mode';

function initial(): UiMode {
  try {
    return localStorage.getItem(KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

/** Simple mode (default) hides technical controls; Advanced shows everything. Per-browser preference. */
export const useUiMode = create<{ mode: UiMode; setMode: (m: UiMode) => void }>((set) => ({
  mode: initial(),
  setMode: (mode) => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* storage unavailable */
    }
    set({ mode });
  },
}));
