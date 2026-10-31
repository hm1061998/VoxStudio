# 05 — Quality report (Vietnamese speech and application QA)

Date: 2026-10-31. Engine under test: **eSpeak NG 1.52.0** (rule-based formant synthesis), the only engine that can produce speech in this installation. FFmpeg 9.0.1 Essentials (no `flite`/`whisper`). Host: 12 logical CPUs, 17 GB RAM, Windows 11.

## 0. Verdict

| Question                                                                        | Answer                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the application generate Vietnamese speech with strictly non-AI synthesis? | **Yes**, with eSpeak NG (formant, rule-based). The compliance audit passes (11 checks, 0 failures, 1 warning about an inert FFmpeg filter that is never invoked).                                                                                              |
| Is the speech understandable and usable?                                        | **Not established.** No human has listened to it. This report contains objective measurements only.                                                                                                                                                            |
| Is a replacement engine better than eSpeak NG?                                  | **There is no replacement engine.** `vnunit` (the custom concatenative engine) has no licensed recordings, is not admitted, is not selectable, and has only been run on a test fixture made from eSpeak output. No comparison can be made and none is claimed. |
| Naturalness                                                                     | **Not measured.** eSpeak NG is clearly synthetic by its own documentation.                                                                                                                                                                                     |

**I cannot listen to audio.** Every statement below about sound quality is therefore either a measurement of the signal or a statement that listening is still required. A listening pack and rating sheet were generated for a native Vietnamese listener (section 3).

## 1. Functional testing (real server, real engine)

`node scripts/qa-functional.mjs` drives the HTTP API exactly as the web client does and downloads the audio it produces. Result: **24/24 checks passed**, both on the development instance and on a clean-install instance (section 6 of the production report).

| Step                                                                                  | Evidence                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create project, add Vietnamese text (3 paragraphs: date, money and percent, question) | project created, 3 segments saved with settings                                                                                                   |
| Select Vietnamese voice                                                               | the 3 offered Vietnamese voices are the eSpeak Northern, Central and Southern voices                                                              |
| Configure speech settings                                                             | rate, pitch and pause saved per segment and read back after reopening                                                                             |
| Unsupported or invalid setting                                                        | rejected by the server (`PARAMETER_UNSUPPORTED`)                                                                                                  |
| Generate preview                                                                      | succeeded in 255 ms; downloaded file is a RIFF/WAV                                                                                                |
| Render complete project                                                               | succeeded; the job reports `espeak@1.52.0` and voice `espeak:vi`                                                                                  |
| Export WAV                                                                            | PCM 16-bit, 13.75 s, 606,296 bytes, validated with ffprobe                                                                                        |
| Export MP3                                                                            | MP3, 13.75 s, 221,119 bytes, validated with ffprobe; duration equals the WAV within 0.2 s                                                         |
| Reopen project                                                                        | text, voice and the changed rate (0.9) intact                                                                                                     |
| Re-render                                                                             | served from the render cache in 23 ms; **byte-identical** to the earlier export; a second WAV export is byte-identical to the first               |
| Regression inside the run                                                             | presets listed (6), pronunciation entry created, applied in the preview, diagnostics clean, deleted; session endpoint; project listing; duplicate |

Playwright (browser) 4/4: includes full journey with player playback (duration read from the real player), the Vietnamese UI, and the voice workflow (accent switch, voice sample, two previews fetched as different WAV files, comparison, apply to all, diagnostics, pronunciation, render with engine label).

Observation (by design, not a defect): an export stores its output profile in the project, so a later "render" reuses the last chosen format (MP3 after an MP3 export).

## 2. Vietnamese benchmark `vi-bench-1` (131 sentences, 13 categories)

`node benchmark/vi/run-baseline.mjs` renders every sentence with all three voices, twice, through the production pipeline.

| Measure                                                     | Northern      | Central       | Southern      |
| ----------------------------------------------------------- | ------------- | ------------- | ------------- |
| Rendered / failed                                           | 131 / 0       | 131 / 0       | 131 / 0       |
| Byte-identical on a second render                           | 131 / 131     | 131 / 131     | 131 / 131     |
| Silent or clipped outputs                                   | 0             | 0             | 0             |
| Median real-time factor (max)                               | 0.041 (0.102) | 0.041 (0.105) | 0.040 (0.095) |
| Total audio                                                 | 343.8 s       | 345.2 s       | 352.0 s       |
| Sentences where eSpeak switched to another language's rules | 10            | 10            | 9             |

The foreign-language switches are the English-term sentences (`vi-bench-1-095` to `-103`) and `-089/-090`; the engine reads those words with English rules unless the user adds a dictionary entry (the UI now makes that one click).

### What each criterion could and could not be checked with

| Criterion                   | What was measured                                                                                                                                                                                                                                                                  | Conclusion allowed                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pronunciation accuracy      | eSpeak phoneme output exists for all 131 sentences; normalization of dates, numbers, money, percentages, ranges and phone numbers is covered by tests and benchmark rows; 10 sentences contain words read with foreign rules                                                       | Text expansion is correct for the covered patterns. **Whether the phonemes sound right: unknown.** |
| Tone correctness            | F0 contours of 8 isolated syllables per tone (table below)                                                                                                                                                                                                                         | See below. **Not a listening result.**                                                             |
| Syllable transitions        | none possible for formant synthesis beyond artifact scan                                                                                                                                                                                                                           | not assessed                                                                                       |
| Regional accent consistency | the three voices produce different text/phoneme output for 113 to 125 of 131 sentences (token edit rate 0.13 to 0.26) and different F0 levels (median of medians 113 / 82 / 88 Hz for Northern / Central / Southern on the sample pack)                                            | The profiles are **different**; whether they sound like the named regions is **unknown**.          |
| Natural pauses              | punctuation and `[pause]` markers produce measurable silences (unit tests)                                                                                                                                                                                                         | pauses exist and are controllable; naturalness not assessed                                        |
| Sentence intonation         | not measured on this engine in this stage                                                                                                                                                                                                                                          | not assessed                                                                                       |
| Intelligibility             | not measurable without listeners                                                                                                                                                                                                                                                   | **not assessed**                                                                                   |
| Audio artifacts             | automated scan of the 67 pack files: clipping, DC offset, impulsive clicks, long gaps, edge silence, level (peak 0.835 to 0.891, RMS 0.081 to 0.153, step/RMS at most 4.5). **0 files flagged.** The scanner was verified to flag a synthetic click, clipping and a too-quiet file | No gross defects. **Subtle artifacts cannot be excluded.**                                         |

### Tone contours (benchmark baseline, 8 syllables per tone, semitones; slope = end minus start)

| Tone  | Northern  | Central | Southern |
| ----- | --------- | ------- | -------- |
| ngang | +0.65     | +2.83   | +0.20    |
| huyền | −0.96     | −0.04   | −0.44    |
| sắc   | **+4.74** | −0.01   | +2.76    |
| hỏi   | −0.44     | −0.20   | +0.23    |
| ngã   | +1.29     | +0.02   | +0.07    |
| nặng  | −1.68     | −0.65   | 0.00     |

Reading (measurement, not a verdict): the Northern voice shows a clear rise for sắc and a fall for nặng and huyền; hỏi and ngã are weak. The **Central voice shows almost no pitch movement for most tones** (slopes within about 0.7 semitone except ngang), and its F0 is low (about 76 to 84 Hz), which may also be where the tracker is least reliable. The Southern voice shows a rise for sắc only. Southern speech merges hỏi/ngã, so flat hỏi/ngã is plausible there, but a flat nặng is not obviously expected. **These contours are a reason to prioritise listening to the Central and Southern voices and to treat tone distinction there as at risk.** The F0 tracker has no independent validation on synthetic low-pitched voices.

## 3. Listening pack (for human evaluation)

`node benchmark/vi/run-sample-pack.mjs` wrote `qa-output/sample-pack/` (git-ignored):

- `voices/`: 39 WAV files, the first sentence of each of the 13 categories × Northern / Central / Southern.
- `prosody/`: 28 WAV files, 4 sentences (tones, question, statement, long narration) × default plus rate 0.75 / 1.4, pitch 30 / 70, pitch range 10 / 90.
- `listening-sheet.csv`: one row per file, **ratings blank**. Criteria: pronunciation, tone correctness, syllable transitions, accent consistency, natural pauses, sentence intonation, intelligibility, artifacts (1 to 5).
- `manifest.json`: SHA-256 and measurements for every file.

**Status: 0 of 67 files rated by a listener.**

## 4. Prosody configurations: measured effect (Northern voice, 4 sentences)

| Setting        | Duration ratio vs default | Median-F0 ratio vs default | Verdict                                                    |
| -------------- | ------------------------- | -------------------------- | ---------------------------------------------------------- |
| rate 0.75      | 1.33 to 1.38              | 0.98 to 1.00               | rate works, pitch unchanged                                |
| rate 1.4       | 0.67 to 0.74              | 1.00 to 1.01               | rate works                                                 |
| pitch 30       | 1.00                      | 0.80 to 0.83               | pitch works, duration unchanged                            |
| pitch 70       | 0.99 to 1.00              | 1.22 to 1.26               | pitch works                                                |
| pitch range 10 | 0.99 to 1.00              | 1.08 to 1.15               | changes contour; median moves because the contour flattens |
| pitch range 90 | 1.00                      | 0.85 to 0.96               | changes contour                                            |

The controls the UI shows as engine-native therefore have measurable effects. Whether the extremes sound acceptable was not judged.

## 5. Audio comparison

| Comparison                                   | Done?                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eSpeak NG baseline (3 voices, 131 sentences) | **Yes**, measured and sampled                                                                                                                                                                                 |
| Different prosody configurations             | **Yes**, 6 configurations measured and sampled                                                                                                                                                                |
| Different Vietnamese voice profiles          | **Yes**, Northern / Central / Southern, measured and sampled                                                                                                                                                  |
| Replacement engine (`vnunit`) vs eSpeak      | **Not possible.** No licensed recordings exist; the only database is a test fixture rendered by eSpeak itself, so comparing it with eSpeak would compare eSpeak with itself. No claim of improvement is made. |

## 6. Performance (`node scripts/perf-qa.mjs`, eSpeak, 8-paragraph projects, WORKER_CONCURRENCY=2)

| Measure                                      | Result                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold render, 8 paragraphs (45.5 s of audio)  | 974 ms run time, **RTF 0.021**, 122 ms per paragraph, 8 ms queue latency                                                                                                            |
| Identical re-render                          | 0 ms run time (render cache), warning "Served from render cache" shown to the user                                                                                                  |
| One paragraph edited, re-render              | 333 ms (0.34× of cold): only the changed paragraph is synthesized again                                                                                                             |
| Interactive preview (12 runs)                | p50 155 ms, p95 177 ms, max 210 ms from click to finished job                                                                                                                       |
| 6 projects rendered at once (276 s of audio) | all 6 succeeded, 0 failed, 3.9 s wall, aggregate RTF 0.014; queue latency p50 1.2 s, max 2.3 s (two jobs run at a time, the rest wait); run time per job 1.05 to 1.19 s             |
| CPU                                          | average 0.26 cores busy (single job) and 0.51 cores (concurrent), counted only for processes caught by 300 ms sampling, so **under-counted** for short-lived eSpeak/FFmpeg children |
| Memory (peak resident, sampled)              | node 294 to 320 MB (API plus worker), PostgreSQL 355 to 374 MB, eSpeak 6 to 16 MB per process, FFmpeg 10 MB; total about 700 MB                                                     |

Not measured: behaviour with hundreds of paragraphs, sustained load, large concurrent user counts, or memory growth over time.

## 7. Regression

| Area                                                                                                                                      | Evidence                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Projects, segments, voice selection, presets, pronunciation dictionary, render queue, audio preview, export, user settings, authorization | Vitest 231/231 (incl. 52 API integration tests on a real PostgreSQL, real eSpeak and FFmpeg), Playwright 4/4, `qa-functional` 24/24 |
| Lint / format / typecheck / build                                                                                                         | clean                                                                                                                               |
| Compliance audit                                                                                                                          | 11 passed, 1 warning, 0 failed                                                                                                      |
| Dependency vulnerabilities (`pnpm audit --prod`)                                                                                          | none known                                                                                                                          |

## 8. Unsupported controls

Capabilities are declared per voice and enforced by the server; the UI disables unsupported controls (hides them in Simple mode). Native controls were checked by measurement (section 4) and by the existing real-engine tests (pitch, pitch range, variant and word gap change the audio). Nothing shown as functional is a placeholder. Not checked by listening: whether DSP controls (EQ, time-stretch, pitch-shift) sound acceptable at extremes; the UI warns about artifacts at extremes.

## 9. Limitations and next engineering steps

1. **Human evaluation is the main gap.** A native speaker must rate the sample pack; the Central voice should be checked first because its tone contours are nearly flat.
2. Formant synthesis is intelligible but clearly synthetic; no fix exists inside the strict non-AI constraint except a recorded-unit engine.
3. Licensed Vietnamese recordings with syllable labels are required before `vnunit` can be evaluated or admitted (ADR 0005, `docs/upgrade/06-VOICE-LIBRARY.md`).
4. English words and unknown acronyms are read with foreign rules unless added to the dictionary; a larger curated lexicon would reduce this.
5. Tone and intonation measurements need a validated F0 tracker for low-pitched synthetic voices.
6. Extend performance tests to long projects and sustained load.
