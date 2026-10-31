# 00 — Existing Application Audit (Vietnamese non-AI TTS upgrade)

Audit date: 2026-10-31. Method: reading the source, grepping for coupling, and running the real engine and test suites. Statements below were checked against the code, not copied from the specification docs. Where this audit disagrees with the task brief or the original docs, it says so.

## 0. Corrections to the task brief

| Brief assumed             | Reality (verified)                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis and BullMQ jobs     | **Neither exists.** `grep -ri "redis\|bullmq"` over `apps/`, `packages/`, `scripts/`, Compose and `package.json` finds nothing. The queue is PostgreSQL (`FOR UPDATE SKIP LOCKED` lease claiming, `LISTEN/NOTIFY` events). See [ADR 0003](../decisions/0003-postgres-job-queue.md). The upgrade plan must not assume Redis. |
| CI workflows exist        | **No CI.** There is no `.github/` (or any other CI config). Tests exist but are only run by hand.                                                                                                                                                                                                                           |
| Docker Compose deployment | Written (`docker-compose.yml`, `infra/docker/Dockerfile`, Caddy) but **never built or run** (no Docker on the dev machine). Treat as unverified.                                                                                                                                                                            |

## 1. Existing architecture

```text
apps/web      React 19 + Vite 7 + Tailwind 4 + TanStack Query + Zustand + WaveSurfer. Vietnamese/English UI.
apps/api      NestJS 11 modular monolith: auth, projects, catalog, render planning, SSE, assets, admin, presets, pronunciation
apps/worker   Plain Node process: claims jobs from PostgreSQL, synthesizes, applies DSP, assembles, encodes, validates
packages/core Engine adapter, capabilities, text pipeline, DSP, WAV, assembly, encode/validate, cache keys, storage, config
packages/db   Prisma 6 schema + 2 migrations (PostgreSQL)
packages/contracts  zod schemas, DTO types, error codes shared by api, worker and web
config/       voice-allowlist.json, qa-corpus.json, voice-qa-report.json
scripts/      qa-voices, compliance-audit, backup, dev-db, start-all, reset-password
```

Stack is unchanged from the original architecture except the queue (PostgreSQL instead of Redis/BullMQ, by ADR).

## 2. Implemented features (verified by tests or in the browser)

Auth/sessions/CSRF, per-user authorization (404 for foreign resources), projects (CRUD, duplicate, archive, versions with restore), segment editor with autosave/undo/redo/crash recovery, pause markers, text split/merge/import, normalization preview, pronunciation dictionary (precedence, conflicts, import/export), presets, voice catalog with QA tiers, preview and project render with progress units, cancel/retry, crash recovery by lease expiry, content-addressed render cache, WAV/MP3/OGG export with decode validation, authorized streaming with Range, admin overview and toggles, backup/restore verification, compliance audit, Vietnamese/English UI with Simple/Advanced modes.

Test inventory: 116 Vitest tests (40 unit, 27 engine+DSP integration against the real binaries, 7 Vietnamese normalization, 37 API integration against real PostgreSQL with an in-process worker, 5 i18n) and 3 Playwright tests. All pass at the time of this audit.

## 3. Current TTS pipeline (verified)

1. **Plan** (`apps/api/src/render/planner.ts`): resolve voice via `CatalogService.resolveSelectable` → validate settings against the voice's capabilities → `prepareEngineText` → compute `segmentCacheKey` → immutable `RenderPlan` stored on the job.
2. **Text** (`packages/core/src/text/prepare.ts`): split at `[pause …]` markers → pronunciation matches on the original text (placeholders) → locale normalization (`normalize.ts`, rules for `en` and `vi`) → `sanitizeEspeakText` → substitute replacements/phoneme spans.
3. **Synthesis** (`packages/core/src/engine/espeak.ts`): spawns `espeak-ng -D -b 1 -z -v <voice>[+variant] -s <wpm> -p <pitch> -P <range> -a 100 [-g gap] -f <utf8 file> -w <wav>`. Text goes through a file, never argv. Output must be mono s16 at 22,050 Hz.
4. **DSP** (`audio/dsp.ts`): optional FFmpeg chain (atempo → rubberband → highpass/bass/equalizer/treble → acompressor), then gain with deterministic headroom attenuation, then exact-sample pauses, all at 22,050 Hz mono.
5. **Assembly/encode** (`render/assembly.ts`, `render/encode.ts`): streamed concatenation with optional edge fades, FFmpeg encode, ffprobe + full decode validation, SHA-256 asset.

### Answers to the audit questions

| #   | Question                              | Answer                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How is text converted to speech?      | Steps above. eSpeak NG converts text to phonemes by its own language rules and renders with its formant synthesizer.                                                                                                                                                                                                                     |
| 2   | Which engine synthesizes?             | **eSpeak NG 1.52.0 only.** MBROLA is excluded by the adapter and by the compliance audit.                                                                                                                                                                                                                                                |
| 3   | Deterministic and non-AI?             | **Yes.** `-D` plus tests: two runs give identical SHA-256 (`integration.test.ts › is deterministic`; re-checked for Vietnamese during this audit). Compliance audit (11 checks) passes and fails correctly on planted violations.                                                                                                        |
| 4   | Vietnamese pronunciation and tones?   | **Implemented by eSpeak NG's `vi` language rules, not by VoxStudio.** Checked: `ma má mà mả mã mạ` yields six distinct tone codes (1,3,2,4,5,6). Three regional voices (`vi`, `vi-vn-x-central`, `vi-vn-x-south`) give three different outputs. VoxStudio adds only the text front-end (dates, times, đồng, units, abbreviations, URLs). |
| 5   | Do settings really affect synthesis?  | **Yes**, proven by tests: native `rate`, `pitch`, `pitchRange`, `variant`, `wordGapMs` change the audio or its duration; DSP `tempo`, `pitchShiftSemitones`, EQ, compressor, gain and pauses change it too. One caveat: `pitchRange` and `variant` effects on Vietnamese tones are untested.                                             |
| 6   | What is tightly coupled to eSpeak NG? | See §6.                                                                                                                                                                                                                                                                                                                                  |
| 7   | What can another engine reuse?        | See §7.                                                                                                                                                                                                                                                                                                                                  |

## 4. Existing Vietnamese capabilities

- 3 voices, all passing automated QA (synthesis, level, determinism, rate control, language fallback). Tier "experimental" (no native-speaker review).
- Text front-end `norm-2` (`vi` rules): ISO and `d/m/yyyy` dates, `ngày d/m`, times (`14h30`, `8:05`), đồng/VNĐ/₫, `$`, `€`, percent, °C, units (km, kg, cm, mm, m², ha, km/h), abbreviations (UBND, TP.HCM, THPT, PGS., TS., Q.3, v.v.…), URLs and emails. 7 tests.
- Sentence splitting via `Intl.Segmenter` (checked for Vietnamese).
- Pronunciation dictionary with literal matching; engine-scoped phoneme entries (eSpeak mnemonics).
- UI in Vietnamese with plain-language labels.

## 5. Technical limitations

1. **Quality ceiling.** Formant synthesis sounds robotic. Not fixable by settings or DSP. This is the reason for the upgrade.
2. **No VoxStudio-owned Vietnamese linguistics.** Tone, syllable and number reading are all inside eSpeak. VoxStudio cannot fix a wrong tone except by respelling or eSpeak phoneme overrides.
3. **Normalization gaps (Vietnamese)** _(updated after UP-007)_: ranges, phone numbers and context-bound Roman numerals are now handled (`norm-3`). Remaining: bare fractions (`1/2`), Roman numerals without a context word, and house-number style `15/3` are left to the engine because a guess could be wrong.
4. **Settings schema is eSpeak-shaped** (`variant`, `pitchRange`, `wordGapMs`, wpm mapping). It is a `strictObject` stored in `project_segments.settings_json` with no stored schema version (`SETTINGS_SCHEMA_VERSION` exists but is not persisted).
5. **Single canonical sample rate** (22,050 Hz) and a hard check that rejects any engine output at another rate (`render/segment.ts:59`). There is no resampling stage.
6. **Single-engine plans.** `RenderPlan.toolVersions.engine` holds the first segment's engine version; the worker compares it with one eSpeak version (`apps/worker/src/executor.ts:46`). A mixed-engine project would be mis-validated.
7. **Voice QA and compliance scripts call `EspeakAdapter` directly** and use `mnemonics()`, which is not part of the adapter interface.
8. **No CI**, and Docker is unverified.
9. Voice limitation notes and admin diagnostics are English-only.

## 6. Components tightly coupled to eSpeak NG (verified by grep)

| Area          | Location                                                                                                                                           | Coupling                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Catalog       | `apps/api/src/catalog/catalog.service.ts` (lines 44, 55, 66–117, 146, 201, 234)                                                                    | One `EspeakAdapter` field; engine row `'espeak'`; `listVariants()` called directly                                   |
| Catalog       | `packages/core/src/catalog/catalog.ts`                                                                                                             | License string `GPL-3.0-or-later` and `packageVersion = engineVersion` hard-coded                                    |
| API consumers | `catalog.controller.ts:86`, `health.controller.ts:39`, `presets.ts:211`, `projects.service.ts:362`                                                 | Call `catalog.adapter.*` (single adapter)                                                                            |
| Worker        | `apps/worker/src/worker.ts:39`, `executor.ts` (27, 46, 53, 89, 222)                                                                                | Builds one `EspeakAdapter`; compares one version; checks engine `'espeak'`; snapshot `engineId: 'espeak'`            |
| Planner       | `apps/api/src/render/planner.ts:142,199`                                                                                                           | Single engine version per plan                                                                                       |
| Text pipeline | `packages/core/src/text/prepare.ts`                                                                                                                | Imports `espeakPhonemeSpan`/`sanitizeEspeakText` from the engine module (engine escaping inside the shared pipeline) |
| Contracts     | `contracts/src/settings.ts`, `schemas.ts:146`                                                                                                      | eSpeak-shaped setting keys; `phonemeFormat: z.enum(['espeak'])`                                                      |
| Capabilities  | `engine/capabilities.ts`                                                                                                                           | `ESPEAK_VARIANTS`, wpm semantics in labels                                                                           |
| Config/tools  | `config.ts`, `tools.ts`                                                                                                                            | `ESPEAK_*` environment variables, binary resolution                                                                  |
| Scripts       | `qa-voices.mjs`, `compliance-audit.mjs`                                                                                                            | `EspeakAdapter`, MBROLA/data-dir checks                                                                              |
| Docker        | `infra/docker/Dockerfile`                                                                                                                          | `apt espeak-ng=1.52.0+dfsg-5` pin                                                                                    |
| Web           | `DashboardPage.tsx`, `PronunciationPage.tsx`, `PresetsPage.tsx` (default voice ids `espeak:vi` / `espeak:en-us`), `Inspector`, i18n variant labels | Default voices and variant labels assume eSpeak                                                                      |

Already engine-neutral: the `TtsEngineAdapter` interface itself (`engine/types.ts`), `segment.ts` (takes an adapter), voice id format `engine:native`, `tts_engines`/`tts_voices` tables, `project_segments.engine_id`, `audio_assets.engine_snapshot_json`.

## 7. Reusable components (no change needed for another engine)

Auth, authorization, projects, versions, segment editor and autosave, job queue, lease recovery, cancel/retry, SSE events, progress units, render cache and cache-key construction (already includes engine id and version, voice package version, normalization version), assembly, encoding and validation, storage, asset streaming, backup/restore, i18n, presets and pronunciation matching (engine scope already exists), compliance-audit framework, voice QA report format, UI voice picker and player.

## 8. Components requiring modification

1. Engine registry replacing the single adapter in the catalog and worker (**in progress**, UP-003).
2. Engine-scoped, versioned settings schema and capability model (UP-004).
3. Move engine-specific text escaping and phoneme formats behind the adapter (UP-005).
4. Sample-rate normalization (resample on ingest) (UP-006).
5. Vietnamese text front-end completion (UP-007).
6. Generalize QA and compliance scripts per engine (UP-010).
7. CI (UP-011).

## 9. Database and API compatibility concerns

- **Voice ids** (`espeak:vi`) are stored in `project_segments.voice_id` and in versions/snapshots. They must stay valid. New engines get new prefixes; no renames.
- **`settings_json`** is validated by a strict schema. Adding engine-specific keys requires a persisted schema version and a read-time migration, or existing projects fail validation. Never tighten the schema for existing documents.
- **Cache keys** include engine/voice versions and `NORMALIZATION_VERSION` (bumped to `norm-2` for Vietnamese rules), so changes invalidate caches safely. Changing the settings schema must also bump the cache schema.
- **Render plans** are stored on jobs (`render_plan_json`). Plans in flight at upgrade time have `toolVersions.engine` only; keep reading that field.
- **Pronunciation entries**: `phoneme_format` is a free string in the database but `z.enum(['espeak'])` in the API. A new phoneme format needs an enum extension (additive).
- **Prisma migrations** are forward-only. Any new column must be nullable or defaulted.
- **API responses** (`VoiceDto`, `EngineDto`) are consumed by the web app. Additive fields only.
- **Asset downloads/exports** are unaffected.

## 10. Technical risks

| Risk                                                                | Likelihood | Impact                       | Mitigation                                                                                                                                           |
| ------------------------------------------------------------------- | ---------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No licensed Vietnamese unit-selection/diphone data is available** | High       | Blocks the main quality goal | UP-002 research; UP-008 stays BLOCKED until data and license are confirmed. Until then, improve the text front-end and keep eSpeak NG as the engine. |
| Candidate engines are statistical (HTS, clustergen, neural)         | High       | Violates the non-AI rule     | Engine admission checklist (docs/07) before any code is enabled; compliance audit extended per engine                                                |
| Concatenative output needs tone-aware prosody; poor joins           | Medium     | Worse than eSpeak            | Objective tone minimal-pair tests and native review before exposing                                                                                  |
| Settings schema change breaks stored projects                       | Medium     | Data loss                    | Persisted schema version, additive migration, tests on old documents                                                                                 |
| Refactor regresses eSpeak output                                    | Medium     | Visible regression           | Golden SHA-256 tests for eSpeak outputs before refactoring (done in UP-003)                                                                          |
| GPL/data licenses restrict redistribution                           | Medium     | Legal                        | THIRD_PARTY_NOTICES, per-engine license in catalog                                                                                                   |
| No CI                                                               | High       | Regressions go unnoticed     | UP-011                                                                                                                                               |
| Docker path unverified                                              | Medium     | Deployment surprises         | Verify on a Docker host (existing blocker B1)                                                                                                        |

## 11. Conclusion

The application is sound and reusable. The synthesis layer is almost, but not quite, engine-neutral. The honest path to better Vietnamese is: (1) remove the single-engine assumptions, (2) improve what VoxStudio controls (text front-end, QA), and (3) add a second, strictly non-AI engine only when licensed Vietnamese data exists. eSpeak NG stays as the fallback and the baseline for regression tests.
