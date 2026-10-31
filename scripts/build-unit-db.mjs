#!/usr/bin/env node
// Build a Vietnamese unit database from labelled recordings (docs/upgrade/05-VIETNAMESE-CORE.md).
// Usage: node scripts/build-unit-db.mjs <spec.json> <outDir>
// spec.json: { id, name, locale, dialect, license: {id, notes}, datasetVersion?, attribution?, speaker?: {gender, genderVerified, notes}, recordingNotes?, provenance?: {kind: "human-recording"|"ai-generated", generator?: {name, version, license, localRun}}, equivalences?, recordings: [
//   { id, wav: "path/to/mono-22050.wav", segments: [{ label: "chào", start: <sample>, end: <sample>, position?: "initial|medial|final|isolated" }] } ] }
// Segment boundaries must come from the data provider (no automatic alignment is performed).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import core from '../packages/core/dist/index.js';

const [specPath, outDir] = process.argv.slice(2);
if (!specPath || !outDir) {
  console.error('usage: node scripts/build-unit-db.mjs <spec.json> <outDir>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const base = path.dirname(path.resolve(specPath));
const recordings = spec.recordings.map((r) => ({
  id: r.id,
  wav: readFileSync(path.resolve(base, r.wav)),
  segments: r.segments,
}));
const manifest = core.buildUnitDb({ ...spec, outDir: path.resolve(outDir), recordings });
const db = core.UnitDb.load(path.resolve(outDir));
const keys = new Set(db.units.map((u) => u.key));
console.log(
  JSON.stringify(
    {
      id: manifest.id,
      units: manifest.units,
      distinctSyllables: keys.size,
      f0MedianHz: manifest.f0Median,
      license: manifest.license.id,
    },
    null,
    2,
  ),
);
