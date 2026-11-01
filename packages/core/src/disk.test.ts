import { describe, expect, it } from 'vitest';
import { classifyDisk, type DiskThresholds } from './disk';

const GB = 1024 ** 3;
const t: DiskThresholds = { warnFreePercent: 20, blockFreePercent: 8, minFreeBytes: 1 * GB };

describe('classifyDisk', () => {
  it('is ok with plenty of space', () => {
    expect(classifyDisk({ totalBytes: 100 * GB, freeBytes: 50 * GB }, t)).toBe('ok');
  });
  it('warns below the warning percentage and blocks below the block percentage', () => {
    expect(classifyDisk({ totalBytes: 100 * GB, freeBytes: 19 * GB }, t)).toBe('warn');
    expect(classifyDisk({ totalBytes: 100 * GB, freeBytes: 7 * GB }, t)).toBe('block');
  });
  it('blocks on a small disk by absolute free bytes even when the percentage looks fine', () => {
    expect(classifyDisk({ totalBytes: 8 * GB, freeBytes: 0.9 * GB }, t)).toBe('block');
    expect(classifyDisk({ totalBytes: 8 * GB, freeBytes: 3 * GB }, t)).toBe('ok');
  });
  it('treats the thresholds as exclusive lower bounds', () => {
    expect(classifyDisk({ totalBytes: 100 * GB, freeBytes: 20 * GB }, t)).toBe('ok');
    expect(classifyDisk({ totalBytes: 100 * GB, freeBytes: 8 * GB }, t)).toBe('warn');
  });
});
