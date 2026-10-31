# 06 — Voice library and voice profiles

Status (2026-10-31): implemented and tested. Only **eSpeak NG** voices exist in a running system today; recorded-unit (`vnunit`) profiles and dataset reports are verified with synthetic fixtures, because no licensed Vietnamese recordings are available. Nothing here claims a recorded voice exists.

## Voice profile (`GET /api/v1/voices/:id/profile`)

| Field                                    | Source                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice ID, display name, locale, language | allowlist (`config/voice-allowlist.json`) + installed-voice manifest                                                                                                 |
| Regional accent (`accent`, `region`)     | **the voice data** when the engine can say (`vnunit`: manifest `dialect`); otherwise the allowlist label. A disagreeing allowlist label is logged and not advertised |
| Gender                                   | only when the data provider states it and sets `genderVerified`; otherwise `null` ("Not stated"). eSpeak variants are parameter sets, not people                     |
| Engine, version, synthesis method        | engine metadata                                                                                                                                                      |
| Voice data version                       | dataset `datasetVersion` (`unversioned` + warning when absent); eSpeak: "built-in voice data" of that engine version                                                 |
| Phonetic inventory                       | recorded-unit voices: orthographic onsets/nuclei/codas/tones that occur in the recordings; rule-based voices: stated as not enumerable                               |
| Capabilities and control classes         | adapter capabilities; `ENGINE_NATIVE` / `DSP_DERIVED` / `UNSUPPORTED`                                                                                                |
| Defaults (rate, pitch, volume, pauses)   | the capability defaults of that voice                                                                                                                                |
| Audio sample                             | sample text (QA report) + live synthesis through the normal preview job with the selected voice; no stored audio is presented as a recording                         |
| License                                  | engine license; dataset license id, notes and attribution                                                                                                            |
| Status / validation                      | `unvalidated`, `automated-passed`, `automated-failed`, `reviewed` (reviewer and date); support tier                                                                  |

Dataset audit: `GET /voices/:id/dataset` (404 for rule-based voices).

## Vietnamese profiles

Northern, Central and Southern are listed **only** because the installed eSpeak NG data has those three voices (`vi`, `vi-vn-x-central`, `vi-vn-x-south`). A recorded-unit profile appears only when a unit database exists, is allowlisted, has a QA report and its engine is approved. Its accent is read from the database manifest. No other regional profile exists or is advertised.

## Dataset metadata and reports (`vnunit`)

Manifest additions (all optional so older databases still load): `datasetVersion`, `attribution`, `speaker {gender, genderVerified, notes}`, `recordingNotes`. Loading rejects a stated gender without `genderVerified`.

`buildDatasetReport(db, benchSyllables)` measures: unit and distinct-syllable counts, single-recording syllables, units per tone, component coverage (initial consonants, vowels, final sounds, tones) with **missing lists**, coverage of the syllables needed by `vi-bench-1` (`config/vi-bench-syllables.json`, regenerate with `node scripts/gen-bench-syllables.mjs`) with the **missing syllable list**, recording quality (sample rate, format, total/mean duration, F0 and level percentiles, very short units), license and attribution, and checksums. `complete` is true only if every required component and every benchmark syllable has a unit, and the benchmark list was available. Orthographic components `k`, `p`, `ya` are reported as optional.

Audit trail: table `tts_voice_datasets` stores one row per distinct `manifest.json` SHA-256 a voice has had (version, units checksum, license, attribution, full report). Rows are never updated; a changed dataset adds a row.

## Capability-aware settings

Each setting is classified by the adapter and shown as "Engine", "Audio processing" or "Not supported". The server validates every save (`validateSettingsForVoice`): an unsupported setting with a non-default value, an out-of-range number or an unknown option is rejected. In the UI, unsupported controls are hidden in Simple mode and disabled with a reason in Advanced mode. `vnunit` classifies `variant` and `wordGapMs` as unsupported.

**Switching voices** (also across engines): `reconcileSettings` resets unsupported values to the new voice's default, clamps out-of-range numbers and replaces unknown options, then the Inspector lists exactly what changed. Stored projects are not rewritten until the user switches a voice; the server independently rejects invalid combinations. Undo restores the previous settings.

## Per-engine QA reports

`voice-qa-report.json` belongs to the engine named inside it (eSpeak NG). Other engines use `voice-qa-report.<engineId>.json`; a report is never applied to another engine. `scripts/qa-voices.mjs` still generates only the eSpeak report (UP-023).

## Known limitations

- No recorded voice exists, so the dataset panel was exercised only through tests with synthetic tone fixtures.
- The Voice Library lists engine names from a small client table (`eSpeak NG`, `VoxStudio Vietnamese`); a new engine needs an entry.
- "Reviewed" validation requires a manual-review record in the QA report; none exists for any voice.
- The default voice for a new Vietnamese project is the first alphabetical voice (Central); choosing Northern is a manual step.
- Switching engines across a real engine boundary (eSpeak to `vnunit`) is tested for settings reconciliation and server validation, but not end to end, because no `vnunit` voice can be selected yet.
