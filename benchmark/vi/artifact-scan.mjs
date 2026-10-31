#!/usr/bin/env node
// Automated screen for gross audio defects in a directory of WAV files (recursive). It can find clipping,
// DC offset, impulsive clicks, long dropouts and silence padding. It CANNOT judge naturalness, tone
// correctness or intelligibility: those need human listeners (see run-sample-pack.mjs).
// Usage: node benchmark/vi/artifact-scan.mjs <dir> [--json <file>]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import core from '../../packages/core/dist/index.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node benchmark/vi/artifact-scan.mjs <dir>');
  process.exit(2);
}
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.wav') ? [path.join(d, e.name)] : [],
  );
const SR = 22050;
const FRAME = Math.round(0.01 * SR);

function scan(file) {
  const { samples: x, info } = core.decodeWavToFloat(readFileSync(file));
  const n = x.length;
  let sum = 0;
  let full = 0;
  let maxStep = 0;
  for (let i = 0; i < n; i++) {
    sum += x[i];
    if (Math.abs(x[i]) >= 0.999) full++;
    if (i) maxStep = Math.max(maxStep, Math.abs(x[i] - x[i - 1]));
  }
  const rms = core.rms(x);
  const frames = [];
  for (let a = 0; a + FRAME <= n; a += FRAME) frames.push(core.rms(x.subarray(a, a + FRAME)));
  const thr = 10 ** (-50 / 20);
  const silent = frames.map((r) => r < thr);
  let lead = 0;
  while (lead < silent.length && silent[lead]) lead++;
  let trail = 0;
  while (trail < silent.length - lead && silent[silent.length - 1 - trail]) trail++;
  let run = 0;
  let longest = 0;
  for (let i = lead; i < silent.length - trail; i++) {
    run = silent[i] ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const flags = [];
  if (full > 0) flags.push(`clipping:${full}`);
  if (Math.abs(sum / n) > 0.01) flags.push('dc-offset');
  // A step far larger than the typical level is an impulsive click.
  if (rms > 0 && maxStep / rms > 12) flags.push(`click-candidate:${(maxStep / rms).toFixed(1)}`);
  if (longest * 10 > 1500) flags.push(`internal-silence:${longest * 10}ms`);
  if (lead * 10 > 600 || trail * 10 > 1200) flags.push(`edge-silence:${lead * 10}/${trail * 10}ms`);
  if (rms < 0.01) flags.push('very-quiet');
  if (info.sampleRate !== SR || info.channels !== 1) flags.push('format');
  return {
    file: path.relative(dir, file),
    ms: Math.round((n / info.sampleRate) * 1000),
    peak: Number(core.peakAbs(x).toFixed(3)),
    rms: Number(rms.toFixed(4)),
    stepOverRms: Number((maxStep / Math.max(rms, 1e-9)).toFixed(1)),
    leadMs: lead * 10,
    trailMs: trail * 10,
    longestInternalSilenceMs: longest * 10,
    flags,
  };
}

const rows = walk(dir).map(scan);
const flagged = rows.filter((r) => r.flags.length);
console.log(`${rows.length} files scanned, ${flagged.length} with automated flags`);
for (const r of flagged) console.log(`  ${r.file}: ${r.flags.join(', ')}`);
const stat = (k) => {
  const v = rows.map((r) => r[k]).sort((a, b) => a - b);
  return { min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1] };
};
const summary = {
  files: rows.length,
  flagged: flagged.length,
  rms: stat('rms'),
  peak: stat('peak'),
  stepOverRms: stat('stepOverRms'),
  ms: stat('ms'),
};
console.log(JSON.stringify(summary));
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0) writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ summary, rows }, null, 2));
process.exit(0);
