import { LIMITS } from '@voxstudio/contracts';

/** Inline pause marker syntax: `[pause 500ms]` or `[pause 1.5s]`. */
export const PAUSE_MARKER_RE = /\[pause\s+(\d+(?:\.\d+)?)\s*(ms|s)\]/gi;

export type TextChunk = { kind: 'speech'; text: string } | { kind: 'pause'; pauseMs: number };

export function pauseMarker(ms: number): string {
  return `[pause ${Math.round(ms)}ms]`;
}

/**
 * Split text at pause markers. Adjacent pauses are merged; empty speech chunks are dropped.
 * Pause durations are clamped to the documented maximum.
 */
export function splitPauses(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let last = 0;
  const push = (c: TextChunk) => {
    const prev = chunks[chunks.length - 1];
    if (c.kind === 'pause' && prev?.kind === 'pause')
      prev.pauseMs = Math.min(LIMITS.pauseMaxMs, prev.pauseMs + c.pauseMs);
    else chunks.push(c);
  };
  for (const m of text.matchAll(PAUSE_MARKER_RE)) {
    const before = text.slice(last, m.index);
    if (before.trim()) push({ kind: 'speech', text: before.trim() });
    const value = Number(m[1]);
    const ms = m[2]!.toLowerCase() === 's' ? value * 1000 : value;
    push({ kind: 'pause', pauseMs: Math.min(LIMITS.pauseMaxMs, Math.round(ms)) });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim()) push({ kind: 'speech', text: rest.trim() });
  return chunks;
}

/** Text with pause markers removed (for counts/estimates). */
export function stripPauseMarkers(text: string): string {
  return text.replace(PAUSE_MARKER_RE, ' ');
}
