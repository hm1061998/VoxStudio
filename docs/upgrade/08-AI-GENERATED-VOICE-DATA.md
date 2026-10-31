# 08 — Voice data generated with AI at development time (first Northern voice)

Status (2026-10-31): a database was built and measured. **No one has listened to it.** It is not allowlisted, not QA-passed and not selectable in the application. See ADR 0007 for the policy.

## What was done

| Item      | Detail                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generator | VieNeu-TTS v3 Turbo 3.8.3, Apache-2.0, run **locally on CPU** (ONNX, 48 kHz output). Python environment and weights live outside the repository (`D:\work\vox-datagen`, Hugging Face cache)                                                                                                     |
| Voice     | Preset "Ngọc Huyền" (provider description: female, Northern, natural style). Preset only, no cloning. Gender and region are the provider's description, not verified by a listener                                                                                                              |
| Text      | 666 tonal syllables = every syllable needed to read the benchmark `vi-bench-1` **after the application's own text normalization** (`config/vi-bench-syllables.json`, regenerated this way after the first run missed 11 syllables such as _phó, sư, tiến, sĩ, đại, cơ, quận, vân, ki, lô, mét_) |
| Audio     | Each syllable generated alone, 3 variants (plain, ".", "?"), resampled to 22,050 Hz mono; 1,998 units, 0 rejected in the final run (1 of 1,964 rejected earlier for clipping)                                                                                                                   |
| Build     | `tools/data-gen/build-from-generated.mjs` → `.data/vn-units/vi-north-vieneu` (git-ignored). Manifest: `provenance.kind = ai-generated`, generator, version, license, `localRun: true`                                                                                                           |
| Tools     | `tools/data-gen/generate.py`, `reference.py`, `build-from-generated.mjs`, README. Not part of any workspace package or the Docker image                                                                                                                                                         |

Generation took 21 minutes for the first 1,964 units (about 0.65 s per unit).

## Measured results (objective only)

| Measure                                           | Result                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset report                                    | 1,998 units, 666 distinct syllables, **666/666 benchmark syllables covered**, no missing initial, vowel, final or tone components; every syllable has 3 recordings                                                                       |
| Benchmark sentences rendered with the unit engine | **127 of 131** (median real-time factor 0.002). The 4 failures are English words and URL parts (`lien, vox, vn, voxstudio, huong, team, marketing, startup`) that need dictionary entries; the engine refuses to guess                   |
| Joins                                             | 1,148 joins, 46 flagged incompatible by the pitch/energy checks (4%)                                                                                                                                                                     |
| Join discontinuity metric                         | median per sentence 26.0, maximum 329.7 (sentence `vi-bench-1-100`). The metric has no calibrated threshold; earlier fixture tests gave about 10 for smooth and 80 for hard joins, so these values are **a warning sign**, not a verdict |
| Automated artifact scan (13 files per system)     | no clipping, DC, impulsive-click or dropout flags for the unit engine or for the AI reference                                                                                                                                            |
| Determinism                                       | rendering is deterministic for a given database; the generated source audio is not bit-reproducible across runs unless the same seed and library versions are used (seed 1234 is recorded)                                               |

## What this does and does not tell you

- It shows the pipeline works end to end with AI-generated source data and that the unit database, coverage and provenance records are real.
- It does **not** show that the voice sounds better than eSpeak NG, or natural. I cannot listen to audio. The pack below exists so a person can.
- Syllables generated one at a time carry no sentence context. The unit engine then adds pitch and duration with PSOLA. Expect less fluency than the AI model speaks sentences itself; the pack includes that reference to show the gap.

## Listening pack

`node benchmark/vi/run-vnunit-pack.mjs .data/vn-units/vi-north-vieneu --reference D:/work/vox-datagen/out/reference` → `qa-output/vnunit-pack/` (git-ignored):

- `espeak/`, `vnunit/`, `ai-reference/`: the same 13 benchmark sentences (one per category) with eSpeak NG Northern, the unit-selection voice, and the AI model speaking the whole sentence (a development reference only, never used by the application).
- `listening-sheet.csv`: 39 rows, ratings **blank**.
- `results.json`: per-sentence metrics for all 131 sentences.

Suggested order: listen to `vi-bench-1-001` (tones) and `-105` (a question) for the three systems first.

## Next steps

1. A native Vietnamese listener rates the pack. If `vnunit` is clearly better than eSpeak NG, continue; if not, improve unit selection or generation (for example generate syllables inside short carrier phrases) before any more work.
2. Add dictionary entries for the English terms, and extend the syllable list beyond the benchmark (a frequency list of Vietnamese syllables) so ordinary text does not hit `UNIT_MISSING`.
3. To make it selectable: `VN_UNIT_DB_DIR`, an allowlist entry, a `voice-qa-report.vnunit.json` (the QA script still only supports eSpeak, UP-023), admin approval of the engine after the admission checklist.
4. Review the unverified provenance statements (Apache-2.0 covers generated audio; preset speakers' consent) before shipping this voice anywhere.
