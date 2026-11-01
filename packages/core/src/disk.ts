import { statfs } from 'node:fs/promises';

export type DiskState = 'ok' | 'warn' | 'block';

export interface DiskThresholds {
  /** Below this share of free space (percent of the disk) the state is `warn`. */
  warnFreePercent: number;
  /** Below this share the state is `block`. */
  blockFreePercent: number;
  /** Below this many free bytes the state is `block`, whatever the percentage (small disks). */
  minFreeBytes: number;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

/** A measurement older than this is not trusted; the reader measures again. */
export const DISK_STATUS_STALE_MS = 5 * 60_000;

/** Pure rule: how full is the disk? An unmeasurable disk (zero total) is reported as `ok` by the caller, never here. */
export function classifyDisk(u: DiskUsage, t: DiskThresholds): DiskState {
  const freePercent = u.totalBytes > 0 ? (u.freeBytes / u.totalBytes) * 100 : 100;
  if (freePercent < t.blockFreePercent || u.freeBytes < t.minFreeBytes) return 'block';
  if (freePercent < t.warnFreePercent) return 'warn';
  return 'ok';
}

/** Free and total bytes of the file system that holds `dir` (space available to an unprivileged process). */
export async function measureDisk(dir: string): Promise<DiskUsage> {
  const s = await statfs(dir);
  return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
}
