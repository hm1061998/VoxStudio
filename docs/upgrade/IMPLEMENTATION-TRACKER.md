# Upgrade Implementation Tracker — Vietnamese non-AI TTS quality

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, `VERIFIED`.
A task is `COMPLETED` only when its code is written **and** its tests pass; `VERIFIED` additionally needs independent evidence (browser check, regression run, or external review). Code that has not been tested stays `IN_PROGRESS`.

Rules for every task: no breaking change without a migration note; no AI/ML/statistical synthesis; keep eSpeak NG working as the fallback; keep the self-hosted model.

## Tasks

| ID     | Task                                                                                                                                                                                                           | Status      | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UP-001 | Audit the existing application                                                                                                                                                                                 | COMPLETED   | `00-EXISTING-APPLICATION-AUDIT.md`. Evidence: greps and engine runs listed there. (Not VERIFIED: a second reviewer has not checked it.)                                                                                                                                                                                                                                             |
| UP-002 | Research strictly non-AI Vietnamese synthesis candidates and data licenses                                                                                                                                     | IN_PROGRESS | Written: `02-ENGINE-COMPARISON.md`, `03-VIETNAMESE-BENCHMARK.md`, `04-ENGINE-DECISION.md`; benchmark `benchmark/vi/` (131 sentences + 48 tone syllables) run on eSpeak NG. **Not written:** `01-TTS-ENGINE-RESEARCH.md` (per-source notes). Open: human listening evaluation, unverified license items listed in 04. Not COMPLETED until 01 exists and the listed items are closed. |
| UP-003 | Engine registry: replace the single `EspeakAdapter` in catalog, worker and API consumers with a registry keyed by engine id, with a golden regression test so eSpeak output is byte-identical before and after | VERIFIED    | See "UP-003 log" below                                                                                                                                                                                                                                                                                                                                                              |
| UP-004 | Engine-scoped, versioned settings schema and capability model; read-time migration for existing `settings_json`                                                                                                | NOT_STARTED | Depends on UP-003. Must keep old projects valid                                                                                                                                                                                                                                                                                                                                     |
| UP-005 | Move engine-specific text escaping and phoneme formats behind the adapter (`prepareText`, phoneme format registry); extend pronunciation `phonemeFormat` additively                                            | NOT_STARTED | Depends on UP-003                                                                                                                                                                                                                                                                                                                                                                   |
| UP-006 | Sample-rate normalization: resample engine output to the canonical rate instead of rejecting other rates                                                                                                       | NOT_STARTED | Needed by any engine that is not 22,050 Hz                                                                                                                                                                                                                                                                                                                                          |
| UP-007 | Vietnamese text front-end: fix the cases eSpeak NG actually misreads (measured, not assumed)                                                                                                                   | COMPLETED   | Scope was corrected by measurement; see "UP-007 result" below                                                                                                                                                                                                                                                                                                                       |
| UP-008 | Vietnamese diphone/unit-selection engine adapter                                                                                                                                                               | IN_PROGRESS | Engine implemented and tested against a **test fixture** (`docs/upgrade/05-VIETNAMESE-CORE.md`, ADR 0005). Not COMPLETED: no licensed data, no listening evaluation. Data remains BLOCKED on UP-002.                                                                                                                                                                                |
| UP-009 | Prosody DSP (TD-PSOLA) as a deterministic stage                                                                                                                                                                | COMPLETED   | `audio/psola.ts`; `psola.test.ts` 7/7: pitch within 0.6 st, duration within 2%, deterministic, rising contour followed                                                                                                                                                                                                                                                              |
| UP-010 | Generalize voice QA and compliance scripts to iterate over registered engines; add Vietnamese tone and intelligibility regression checks                                                                       | NOT_STARTED | Depends on UP-003                                                                                                                                                                                                                                                                                                                                                                   |
| UP-011 | CI workflow: lint, format, typecheck, build, Vitest, compliance audit (E2E optional)                                                                                                                           | NOT_STARTED | Not written yet, deliberately: an untested workflow would give false assurance. See "UP-011 design constraint" below                                                                                                                                                                                                                                                                |
| UP-012 | ADR and admission record for any new engine; update `THIRD_PARTY_NOTICES.md`                                                                                                                                   | NOT_STARTED | Depends on UP-002/UP-008                                                                                                                                                                                                                                                                                                                                                            |
| UP-013 | Migration notes and docs for the new engine and settings schema                                                                                                                                                | NOT_STARTED | Depends on UP-004/UP-008                                                                                                                                                                                                                                                                                                                                                            |
| UP-014 | Vietnamese linguistics core: syllable parser, tones, number reading, dialect profiles, phrases, lexicon                                                                                                        | COMPLETED   | `vi/linguistics.test.ts` 18/18, including the whole 131-sentence benchmark (1,430 syllables resolved; 8 tokens explicitly unresolved)                                                                                                                                                                                                                                               |
| UP-015 | Pronunciation dictionary versioning                                                                                                                                                                            | COMPLETED   | `dictionaryRevision()` + `revision` in the export API; unit-tested via the registry/dictionary tests                                                                                                                                                                                                                                                                                |
| UP-016 | Engine selection by locale and capability                                                                                                                                                                      | COMPLETED   | `selectEngineForLocale`; engine tests (unverified excluded by default, capability filter, explicit alternatives)                                                                                                                                                                                                                                                                    |
| UP-017 | Expose `vnunit` controls in the UI/settings schema (emphasis, question toggle), voice listing after allowlist/QA                                                                                               | NOT_STARTED | Depends on UP-004                                                                                                                                                                                                                                                                                                                                                                   |
| UP-018 | Native-speaker listening evaluation of the Vietnamese engine on vi-bench-1                                                                                                                                     | BLOCKED     | Needs human listeners and real recordings                                                                                                                                                                                                                                                                                                                                           |
| UP-019 | Build and QA a real unit database                                                                                                                                                                              | BLOCKED     | Needs licensed recordings (UP-002)                                                                                                                                                                                                                                                                                                                                                  |

| UP-020 | Voice profile API/DTO (accent from voice data, defaults, controls classified ENGINE_NATIVE/DSP_DERIVED/UNSUPPORTED, validation state) | COMPLETED | Evidence in the UP-020 log below |
| UP-021 | Dataset metadata, coverage and missing-phoneme reports; auditable dataset history table | COMPLETED | Migration `20261031120000_voice_datasets`; verified with synthetic fixtures only (no real voice dataset exists) |
| UP-022 | Voice Library and Inspector: profile, dataset completeness, engine/accent filters, engine-switch settings reconciliation | COMPLETED | Browser-checked with eSpeak voices; dataset panel for recorded voices covered by unit tests, not seen in a browser |
| UP-023 | Per-engine QA reports so a non-eSpeak engine can ever become selectable; `qa-voices.mjs` for vnunit | IN_PROGRESS | Loader done (`voice-qa-report.<engineId>.json`); the QA script still only handles eSpeak (UP-010) |

## UP-003 log

Goal: no behavior change for users. Success criteria:

1. A registry holds adapters by engine id; the catalog builds voices from every registered adapter.
2. The worker builds the same registry, checks each segment's engine version and enabled state individually.
3. No `.adapter` field access remains in API controllers/services.
4. Existing 116 Vitest tests and 3 Playwright tests still pass.
5. A golden test pins the SHA-256 of eSpeak output for English and Vietnamese phrases, captured **before** the refactor.

Progress notes are appended below as work proceeds.

### UP-003 result (2026-10-31)

Changes:

- `packages/core/src/engine/registry.ts`: `EngineRegistry` (register/get/all/healthAll/initializeAll) and `createEngineRegistry(config)`. Unknown engine ids throw `ENGINE_UNAVAILABLE`; there is no fallback to another engine.
- `TtsEngineAdapter` gained `initialize()`; `EngineMetadata` gained `limitations`, `notes`, `admissionRecord`, `verifiedAt` (previously hard-coded in the API catalog).
- `buildCatalog` now takes the engine (`id`, `version`, `license`), filters the allowlist to that engine, and only accepts that engine's QA report (the GPL license string is no longer hard-coded).
- API `CatalogService` loads every registered engine, keeps per-engine flags and health, and exposes `adapterFor()` / `capabilitiesFor()`. No `catalog.adapter` access remains in controllers or services. `/health/ready` keeps its `engine` check (now aggregated over all engines).
- Worker builds the same registry, fails startup if any engine is unhealthy, validates each segment against its own engine version and enabled state, and records `engines: [...]` in export snapshots (the old `engineId`/`engineVersion` fields are kept).
- Heartbeat info keeps `espeakVersion` (read by the admin overview) and adds `engines`.

Evidence:

- Golden test `packages/core/src/golden.test.ts` pinned the SHA-256 of 4 end-to-end renders (English plain, English with DSP chain, Vietnamese northern, Vietnamese southern with normalization and a pause) **before** the refactor; it also fails when a hash is wrong (checked). It passes after the refactor, so eSpeak output is byte-identical.
- `registry.test.ts`: duplicate ids rejected, no fallback for unknown ids, per-engine health, catalog built per engine with that engine's license, another engine's QA report rejected (uses a fake engine that is never registered in production).
- Full Vitest: 127/127 (was 116). Playwright 3/3 on the rebuilt server. `pnpm audit:compliance`: 11 passed, 0 failed. `/health/ready` ok.

Not changed by UP-003 (still coupled, tracked elsewhere): eSpeak-shaped settings schema (UP-004), engine-specific text escaping in `text/prepare.ts` (UP-005), the 22,050 Hz check (UP-006), `qa-voices.mjs`/`compliance-audit.mjs` (UP-010), and the default voice ids `espeak:vi`/`espeak:en-us` in three web pages (to be picked from the voice list; part of UP-004).

Compatibility: no database migration, no API shape change, no stored-data change. Existing voice ids, segments, plans and exports are untouched.

### UP-007 result (2026-10-31)

Method: instead of implementing every rule in the original wish-list, the engine was probed with 22 Vietnamese edge cases and the output compared with the correct reading.

Already read correctly by eSpeak NG (no rule added): ordinals (`thứ 3`, `lần thứ 21`), thousands (`1.250.000`), decimals (`3,14`, `1,5 triệu`), negatives (`-5 độ`), years, letter acronyms (`VTV`, `ĐH`), arithmetic signs, and English loanwords (`Wi-Fi`, `iPhone`, `COVID-19`, switched to English rules by the engine).

Misread, now fixed (`NORMALIZATION_VERSION` bumped to `norm-3`; old cache entries are invalidated automatically):

| Input                                                                | Before                                     | After                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `từ 10-20 người`, `5–7 giờ`, `2025-2026`                             | "mười hai mươi" (no _đến_)                 | "mười **đến** hai mươi"                                                                  |
| `0912 345 678`, `+84 912 345 678`, `024 3825 1234`                   | read as hundreds ("ba trăm bốn mươi lăm…") | digit by digit, keeping the writer's grouping, or 4-3-3 / 3-3-3 / 4-4-3                  |
| `thế kỷ XXI`, `Thế chiến II`, `Chương IV`, `quý III`, `Đại hội XIII` | Roman numerals read as letters             | "…hai mươi mốt", "…hai", etc. (only after a known context word, canonical numerals only) |

Deliberately not done (ambiguous; a wrong guess would be worse than the engine's reading): bare fractions such as `1/2` (conflicts with house numbers like `15/3` and dates), Roman numerals without a context word (`Quang Trung II`), scores such as `3-2` (left alone because first ≥ second), `COVID-19`/`A10-20` (letters before the digits).

Evidence:

- `vi.test.ts`: 13 tests (ranges, non-ranges, dates not turned into ranges, phone grouping, non-phone numbers, Roman context rules, plus the earlier date/time/currency/unit/abbreviation rules).
- Real-engine tests in `integration.test.ts` (4 new): the engine's own phoneme output shows "đến" present after normalization and absent before; "trăm" absent from the phone reading but present in the raw reading; the century is read "hai mươi mốt" instead of letters; the six tones stay distinct (`ma má mà mả mã mạ`).
- Golden audio hashes unchanged (the new rules do not touch the golden phrases).
- Full Vitest 137/137; Playwright 3/3; compliance audit 11 passed; lint and format clean.

### UP-011 design constraint

The engine tests pin exact output of eSpeak NG **1.52.0** and require an FFmpeg without `flite`/`whisper`. A stock `ubuntu-latest` runner has a different eSpeak version and a distro FFmpeg that includes `libflite`, so those tests would fail or, worse, be skipped. A trustworthy CI therefore needs either the project's own image (Debian trixie `espeak-ng=1.52.0+dfsg-5` plus the pinned FFmpeg build from `infra/docker/Dockerfile`, which has not been built yet because Docker is unavailable here) or a split into a static job (lint, format, typecheck, build, lockfile compliance) and an engine job that runs in that image. It will be written together with the first verified Docker build rather than blind.

### Vietnamese core result (2026-10-31)

Implemented (see `05-VIETNAMESE-CORE.md`): syllable parser, number/symbol/acronym expansion, phrase analysis, prosody planner, unit database format and builder, deterministic Viterbi selection with explicit missing-unit errors, TD-PSOLA, smooth joins, loudness/trim, `vnunit` adapter, locale/capability engine selection, dictionary revision, `scripts/build-unit-db.mjs`, compliance-audit check against shipping the test fixture.

Evidence: full Vitest 199/199 (was 137); lint and format clean; compliance audit 11 passed. Evaluation audio was rendered from the fixture and measured (question +4.3 st, rate 672 vs 1,379 ms, smooth joins 7.5× fewer discontinuities), with residual join discontinuities of up to 29 left **unevaluated by ear**.

**Not production-ready:** the engine is unverified, hidden by default, and unusable without licensed data. The fixture is eSpeak-derived and says nothing about naturalness.

## UP-020..023 log (voice library and profiles, 2026-10-31)

Implemented: `GET /voices/:id/profile` and `GET /voices/:id/dataset`; `VoiceProfileDto` (locale, language, accent, gender only if verified, engine, voice-data version, inventory, defaults, per-setting class, sample text, license, validation state, dataset report and history); unit-database manifest fields (`datasetVersion`, `attribution`, `speaker`, `recordingNotes`); `buildDatasetReport`; `tts_voice_datasets` append-only audit table keyed by manifest checksum; `reconcileSettings` for engine switches; Voices page with engine/accent filters and full profile; Inspector shows engine name, dataset completeness and the profile.

Evidence: Vitest 227/227 (was 199); new files `vi/dataset.test.ts` (11), `apps/api/test/profiles.test.ts` (10, real PostgreSQL), `studio/reconcile.test.ts` (4), plus 3 voice-selection tests in `api.test.ts`; lint, format and compliance audit clean; browser check of the Voices page and Inspector with the three eSpeak Vietnamese voices (profile requests 200, no console errors).

Playwright 3/3 after the UI changes. Not verified: the dataset panel with a real recorded voice (none exists; synthetic tone fixtures only) and a keyboard/contrast review of the new panels.

## UP-024 log (Voice Studio UI upgrade, 2026-10-31)

| ID     | Task                                                                                            | Status    | Notes                                                  |
| ------ | ----------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------ |
| UP-024 | Voice summary, accent selector, engine explanation, voice sample, apply-to-all in the Inspector | COMPLETED | Playwright voice-workflow test                         |
| UP-025 | Previews to compare (takes), difference view, apply to paragraph/project                        | COMPLETED | `takes.test.ts` + Playwright; takes are in memory only |
| UP-026 | Vietnamese spelling diagnostics, pronunciation dialog, dictionary refresh                       | COMPLETED | API test + Playwright                                  |
| UP-027 | Actual engine and voices shown per render (from stored engine snapshot)                         | COMPLETED | API provenance test + Playwright                       |

See `07-STUDIO-UI.md`. Vitest 231/231, Playwright 4/4, lint/format/compliance clean. Not verified: recorded-voice UI paths in a browser, automated accessibility audit.

## UP-028..033 log (quality assurance and production readiness, 2026-10-31)

| ID     | Task                                                                                         | Status      | Notes                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| UP-028 | Functional QA script (project → preview → render → WAV/MP3 → reopen → re-render, regression) | COMPLETED   | `scripts/qa-functional.mjs` 24/24 on dev and clean-install instances                                         |
| UP-029 | Vietnamese benchmark run, listening pack, artifact scan, prosody measurements                | COMPLETED   | Objective part only. `05-QUALITY-REPORT.md`                                                                  |
| UP-030 | Performance, concurrency, cache, CPU/memory measurements                                     | COMPLETED   | `scripts/perf-qa.mjs`; small scale only                                                                      |
| UP-031 | Clean-environment install, migrations, security probe, backup/verify                         | COMPLETED   | non-Docker path. `qa-security.mjs` 22/22; backup verify OK                                                   |
| UP-032 | Docker build and compose deployment verification                                             | BLOCKED     | Docker not installed on the QA machine; never built. Next: run build, `qa-functional`, `qa-security` on it   |
| UP-018 | Native-speaker listening evaluation                                                          | NOT_STARTED | Pack generated (67 files, ratings blank). **0 files rated.** Central voice first (tone contours almost flat) |
| UP-033 | Deliverables: 05-QUALITY-REPORT, 06-PRODUCTION-READINESS, 07-MIGRATION-GUIDE                 | COMPLETED   |                                                                                                              |

**Completion requirements not met:** Docker deployment not verified; Vietnamese naturalness and intelligibility not assessed by any listener; no replacement engine exists (`vnunit` has no licensed data). Redis is not applicable (PostgreSQL queue, ADR 0003). The application is therefore **not declared production-ready**.

Fixed during QA: `.dockerignore` now excludes `qa-output`; `docs/10-DEPLOYMENT.md` carries a status note (no Redis/MinIO in the implementation); the e2e locators that matched "▶ Listen" were made exact after the Inspector gained a second button.

## UP-034 log (AI allowed at development time only, 2026-10-31)

Owner clarified: no AI at run time; AI-generated voice data is acceptable during development. Done: ADR 0007; `AGENTS.md` constraints 1 and 2 and `docs/07` scope note updated; `provenance` in the unit-database manifest (validated on build and load: AI-generated data needs generator name, version, license and `localRun: true`); provenance in the dataset report (`unknown` for older databases, warning for AI-generated); compliance audit check; UI shows the source in the voice details and the Voices intro no longer says all voices are free of AI-made audio. Tests: 5 new in `dataset.test.ts`.

| ID     | Task                                                                                                             | Status      | Notes                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| UP-034 | Policy, provenance field, audit and UI disclosure                                                                | COMPLETED   |                                                                             |
| UP-035 | Choose a local generator (license reviewed) and a dev-time data generation tool outside the application packages | NOT_STARTED | Candidates in the chat summary; licenses unverified. Needs the owner's pick |
| UP-036 | Generate source audio, build unit database, coverage report, native-speaker listening                            | NOT_STARTED | Depends on UP-035; vnunit has never been listened to                        |

## UP-035/036 log (first AI-generated source voice, 2026-10-31)

| ID     | Task                                                                                  | Status      | Notes                                                                                             |
| ------ | ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| UP-035 | Choose a local generator and write the dev-time tool outside the application packages | COMPLETED   | VieNeu-TTS v3 Turbo (Apache-2.0, local CPU); `tools/data-gen/`; ADR 0007 conditions met           |
| UP-036 | Generate source audio, build the unit database, coverage report, comparison pack      | IN_PROGRESS | Built (1,998 units, 666/666 benchmark syllables). **Listening not done**; not allowlisted or QA'd |
| UP-037 | Extend syllable coverage beyond the benchmark; dictionary entries for English terms   | NOT_STARTED | 4 benchmark sentences fail on English words                                                       |
| UP-023 | vnunit QA report generation so the voice can be selectable                            | NOT_STARTED | blocks making the voice available in the application                                              |

Details: `docs/upgrade/08-AI-GENERATED-VOICE-DATA.md`. Vitest 236/236, lint clean, compliance audit 13 passed with the new database configured.

## UP-038..046 log (self-hosted AI voice engine and paid-plan priority, 2026-10-31)

Owner decisions: AI is acceptable at development time (ADR 0007) and, after listening to the unit-selection voice ("vấp"), as an isolated self-hosted engine at run time (ADR 0008). No payment integration was requested; plans are assigned by an administrator.

| ID     | Task                                                                                                | Status      | Evidence                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| UP-038 | ADR 0008, `AGENTS.md`, README, third-party notices, compliance audit (AI isolation checks)          | COMPLETED   | audit 14–16 passed; a public service URL fails it                                                              |
| UP-039 | Model service (`services/vieneu`): preset voices, token, priority queue with aging, limits          | COMPLETED   | `test-service.mjs` 13/13 against the real model                                                                |
| UP-040 | `vieneu` engine adapter, optional-engine readiness, config, QA script, allowlist, QA report         | COMPLETED   | `qa-vieneu` 5/5; `ai-engine.test.ts` 9 tests; splitter bug (limit+1) found and fixed by a unit test            |
| UP-041 | Plans, job priority with aging, per-plan pending limit, monthly AI quota and metering, admin API    | COMPLETED   | migration `plans_priority_ai_usage` (no drift); claim-order and quota tests                                    |
| UP-042 | UI: AI badge, Simple-mode speed/pitch stand-ins, plan and usage card, admin plan table, error texts | COMPLETED   | Playwright 5/5 incl. real model playback; Vitest 255/255                                                       |
| UP-023 | Per-engine QA for non-eSpeak engines                                                                | COMPLETED   | `scripts/qa-vieneu.mjs`; `qa-voices.mjs` now ignores other engines                                             |
| UP-043 | Capacity and priority measurements with the real model                                              | COMPLETED   | 1×4 threads 2.47 audio-s/s, 2×3 threads 2.90; every pro job before every free job (`09-AI-ENGINE-CAPACITY.md`) |
| UP-044 | Docker image and compose profile for the model service                                              | BLOCKED     | written, **never built** (Docker unavailable)                                                                  |
| UP-045 | Native-speaker listening evaluation of the AI voices vs eSpeak                                      | NOT_STARTED | no one has listened; still the main unknown                                                                    |
| UP-046 | Payment/billing, VPS-specific measurement, more than 2 instances, soak test                         | NOT_STARTED | out of scope or needs the real VPS                                                                             |

The `vnunit` experiment (UP-035/036) stays in the repository as a non-AI engine but is not the recommended voice.

## UP-047 log (region and gender selection, 2026-10-31)

Owner feedback after listening: the AI voice is good and smooth; users must be able to choose gender and region; all three regions must be heard.

| ID     | Task                                                                                                                  | Status    | Evidence                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| UP-047 | Gender and region choice (new project dialog, Inspector, Voices page); `gender` on voices; Southern male voice (Adam) | COMPLETED | `voicePick.test.ts` (6), API test for genders per region, Playwright AI test over all six combinations |
| UP-048 | Listening pack of all six AI voices                                                                                   | COMPLETED | `qa-output/ai-voices-pack/` 42 files, no automated artifact flags; **not yet heard by a listener**     |

## UP-049 log (UI/UX review, AI voice as default, roles, admin dashboard, security, 2026-11-01)

| ID     | Task                                                                                                   | Status      | Evidence                                                              |
| ------ | ------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------- |
| UP-049 | Voice gallery with per-voice sample, accent and gender filters; AI badge; engine switch reconciliation | COMPLETED   | `voicePick.test.ts`, Playwright gallery test, AI E2E (`E2E_AI=1`)     |
| UP-050 | eSpeak and vnunit hidden by default (`ENABLED_ENGINES=vieneu`), ADR 0009                               | COMPLETED   | `ai-only.test.ts` (4 tests)                                           |
| UP-051 | Roles, admin-only guard, last-admin protection, admin dashboard, audit trail                           | COMPLETED   | `security.test.ts`, Playwright admin test                             |
| UP-052 | Lockout, password policy, session limits, Origin/CSRF, headers, first-admin bootstrap, operator CLI    | COMPLETED   | `qa-security.mjs` 31/31; `password-policy.test.ts`                    |
| UP-053 | Accessibility pass (axe-core) on login, studio, admin                                                  | COMPLETED   | Playwright axe test                                                   |
| UP-054 | 2FA, email verification, mailed reset, penetration test, Docker build                                  | NOT_STARTED | out of scope or needs infrastructure; see `10-SECURITY-AND-ACCESS.md` |

| ID     | Task                                                                                                              | Status    | Evidence                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| UP-056 | Disk guard (measure, warn/block, urgent cleanup), heavy-export limit, record purge, log rotation, admin disk card | COMPLETED | `disk.test.ts` (7), `core/disk.test.ts` (4); no real full-disk test; export dialog does not grey out heavy options yet |
| UP-055 | Per-plan stored-audio allowance, orphaned segment/export cleanup, usage meter in Settings                         | COMPLETED | `storage.test.ts` (2 tests); not measured on a long-running deployment                                                 |
