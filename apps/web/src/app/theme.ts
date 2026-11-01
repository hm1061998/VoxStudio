import { create } from 'zustand';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'vs-theme';

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** "system" leaves data-theme unset so the stylesheet follows prefers-color-scheme. */
function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  window.dispatchEvent(new Event('vs-theme'));
}

/** Per-browser colour theme. Applied at import so the first paint already has the right colours. */
export const useTheme = create<{ theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }>((set) => ({
  theme: stored(),
  setTheme: (theme) => {
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      /* storage unavailable */
    }
    apply(theme);
    set({ theme });
  },
}));

if (typeof document !== 'undefined') apply(stored());

/** Current value of a CSS colour token (e.g. "--c-accent"), for canvas drawing such as the waveform. */
export function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
