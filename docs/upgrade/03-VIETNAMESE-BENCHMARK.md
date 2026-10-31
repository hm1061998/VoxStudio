# 03 — Vietnamese Benchmark (vi-bench-1)

Files: `benchmark/vi/sentences.mjs` (data), `benchmark/vi/f0.mjs` (pitch tracker), `benchmark/vi/run-baseline.mjs` (runner), `benchmark/vi/results/espeak-1.52.0.json` (raw results). Reproduce: `pnpm build && node benchmark/vi/run-baseline.mjs`.

## Contents (fixed; add new versions instead of editing)

131 unique sentences plus 48 isolated tone syllables (8 minimal sets × 6 tones).

| Category                                                                   | n   | Category                              | n         |
| -------------------------------------------------------------------------- | --- | ------------------------------------- | --------- |
| tone coverage                                                              | 10  | abbreviations                         | 8         |
| initial consonants (all 22 orthographic initials incl. ngh, gh, gi, q, k)  | 26  | numbers / dates / currency / percent  | 16        |
| final consonants (c, ch, m, n, ng, nh, p, t, i/y, o/u)                     | 10  | English terms in Vietnamese text      | 10        |
| vowels, diphthongs, triphthongs (iêu, ươi, ươu, uôi, oai, oay, uai, oeo…)  | 14  | questions / statements / exclamations | 5 / 3 / 5 |
| Northern/Southern contrast (tr/ch, s/x, r/d/gi, v, hỏi/ngã, -t/-c, -n/-ng) | 10  | pauses and phrase boundaries          | 8         |
| long-form narration (stories, news, recipe, e-learning, announcement)      | 6   |                                       |           |

## What was measured (eSpeak NG 1.52.0, three Vietnamese voices, full VoxStudio pipeline)

| Measure                                                         | Northern `vi` | Central | Southern |
| --------------------------------------------------------------- | ------------- | ------- | -------- |
| Sentences rendered / failed                                     | 131 / 0       | 131 / 0 | 131 / 0  |
| Byte-identical on repeat                                        | 131           | 131     | 131      |
| Silent or clipped                                               | 0             | 0       | 0        |
| Sentences where the engine switched to another language's rules | 10            | 10      | 9        |
| Median real-time factor (synthesis time ÷ audio time)           | 0.042         | 0.042   | 0.041    |

Dialect voices really differ: Northern vs Southern differ on 125 of 131 sentences (phoneme-token edit rate 0.262); Northern vs Central 113 (0.173); Central vs Southern 112 (0.133).

Foreign-rule switches are expected in the English-terms and some abbreviation sentences; the per-sentence ids are in the results file.

### Tone contours (F0 measured on the audio)

Isolated syllables, semitones relative to each syllable's own median, 5 points start→end. The tracker was checked on synthetic glides (error ≈ ±1 semitone).

Northern voice:

| Tone  | Voiced ms | Slope (st) | Contour points                                         |
| ----- | --------- | ---------- | ------------------------------------------------------ |
| ngang | 258       | +0.65      | −0.84, −0.05, 0.01, −0.01, −0.19                       |
| huyền | 233       | −0.96      | −0.05, 0.51, 0.15, −0.39, −1.01                        |
| sắc   | 254       | **+4.74**  | −1.72, −0.66, 0.03, 1.34, 3.02                         |
| hỏi   | 249       | −0.44      | 0.59, 0.71, −0.55, −1.57, 0.15 (dip, voicing gaps 1.1) |
| ngã   | 257       | +1.29      | 0.09, 0.16, −0.57, −0.08, 1.39                         |
| nặng  | 258       | −1.68      | 1.47, 1.53, −0.2, −1.09, −0.21 (voicing gaps 1.4)      |

**Reading of the numbers (limits stated):**

- At the phoneme level eSpeak assigns six distinct tone codes (`ma má mà mả mã mạ`, tested in `integration.test.ts`).
- In the audio, only **sắc** is a clear, large rise in the Northern voice. Huyền falls only about 1 semitone, and ngã/hỏi/nặng differ mainly by small dips and voicing gaps.
- Central and Southern voices have median F0 of about 76–98 Hz, close to the tracker's 70 Hz lower limit, so their contour numbers are **unreliable** and are not interpreted here. (The raw values are in the results file.)
- These are shape measurements, not listening results. They do not say whether a native speaker hears the right tone.

### Not measured (no human listeners available)

Naturalness (MOS), intelligibility, prosody quality, pronunciation accuracy as judged by native speakers, and Northern/Southern authenticity. Any report of such scores for eSpeak NG in this repository would be invented. A listening protocol (A/B + tone identification on the 48 tone syllables, ≥ 5 native listeners per dialect) is the next step before any engine is promoted to "verified".
