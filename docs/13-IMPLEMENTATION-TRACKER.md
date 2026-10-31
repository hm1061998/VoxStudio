# 13 — Implementation Tracker

The coding agent must maintain this file as work progresses.

## Current status (2026-10-31)

- Product specification: complete in this pack.
- Repository implementation: **working end-to-end** on the local single-node stack (register → project → segments → preview → settings → render → export → download → reopen), verified in a real browser and by automated tests.
- Engine compliance verification: eSpeak NG 1.52.0 admitted ([ADR 0002](decisions/0002-espeak-ng-engine-admission.md)). Automated QA: 34/35 allowlisted voices pass. Native-speaker review is **pending**, so every voice is tier "experimental".
- Production deployment: Dockerfile and Compose written but **not built or run** (Docker is unavailable on this machine; see Blockers). Local `pnpm start` deployment verified.

## Environment (dev machine)

| Component           | Version                     | Source                                             | Notes                                                                          |
| ------------------- | --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Node.js             | 24.15.0                     | preinstalled                                       |                                                                                |
| pnpm                | 12.14.0                     | preinstalled                                       |                                                                                |
| eSpeak NG           | 1.52.0                      | winget `eSpeak-NG.eSpeak-NG` (official GitHub MSI) | formant synthesis, GPL-3.0-or-later                                            |
| FFmpeg              | 9.0.1 essentials (gyan.dev) | winget `Gyan.FFmpeg.Essentials`                    | the `full` build was rejected: it contains `libflite` (TTS) and `whisper` (ML) |
| PostgreSQL          | 18 binaries                 | preinstalled                                       | project-local cluster on 127.0.0.1:5433 (`pnpm db:start`)                      |
| Playwright Chromium | 1248                        | preinstalled cache                                 |                                                                                |
| Docker              | not installed               | —                                                  | see Blockers                                                                   |

## Verification evidence (latest run, 2026-10-31)

| Check                                                 | Command                                                                       | Result                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Lint                                                  | `pnpm lint`                                                                   | 0 problems                                                                                                                        |
| Format                                                | `pnpm format:check`                                                           | all files formatted                                                                                                               |
| Typecheck + build                                     | `pnpm build` / `tsc -b …` + `vite build`                                      | pass                                                                                                                              |
| Unit tests                                            | `vitest run packages/core/src/unit.test.ts`                                   | 40/40 pass                                                                                                                        |
| Engine/DSP integration (real eSpeak NG + FFmpeg)      | `vitest run packages/core/src/integration.test.ts`                            | 27/27 pass                                                                                                                        |
| API integration (real PostgreSQL + in-process worker) | `vitest run apps/api/test/api.test.ts`                                        | 37/37 pass                                                                                                                        |
| All Vitest                                            | `pnpm test`                                                                   | **104/104 pass**                                                                                                                  |
| Browser E2E (Playwright, Chromium)                    | `pnpm test:e2e`                                                               | **2/2 pass**, no console errors, no 5xx                                                                                           |
| Manual browser check (built-in browser)               | register, create project, type, preview, render, MP3 export, download headers | pass (found and fixed 3 bugs; see log)                                                                                            |
| Strict non-AI audit                                   | `pnpm audit:compliance`                                                       | 11 pass, 1 warning (inert `arnndn` filter), 0 fail. Negative test: a planted `.onnx` file and a cloud-TTS URL both fail the audit |
| Voice QA                                              | `pnpm qa:voices`                                                              | 34/35 pass. `espeak:ja` fails (kanji read with English rules)                                                                     |
| Dependency vulnerabilities                            | `pnpm audit --prod`                                                           | no known vulnerabilities (after zod 4.6.7 and the multer 2.5.0 override)                                                          |
| Backup/restore                                        | `node scripts/backup.mjs backup` then `verify`                                | counts match; 34/34 assets re-hashed OK                                                                                           |
| API readiness                                         | `GET /api/v1/health/ready`                                                    | `ok` (database, storage, engine, ffmpeg, worker)                                                                                  |

## Task board

| ID      | Work item                                              |    Priority | Status                                         | Evidence                                                                                                                                     |
| ------- | ------------------------------------------------------ | ----------: | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| VS-001  | Inspect repository and create implementation plan      |          P0 | Done                                           | Repo had docs only. Plan = this board + ADRs 0001–0004                                                                                       |
| VS-002  | Verify strict non-AI engine and license                |          P0 | Done                                           | ADR 0002. Determinism: identical SHA-256 across runs (`integration.test.ts › is deterministic`). License inventory in THIRD_PARTY_NOTICES.md |
| VS-003  | Bootstrap web/API/worker and Docker Compose            |          P0 | Done (Compose unverified)                      | Monorepo builds. `pnpm start` verified. Compose/Dockerfile written, not run (Blocker B1)                                                     |
| VS-003a | pnpm monorepo, strict TS, lint, format                 |          P0 | Done                                           | lint/format/typecheck clean                                                                                                                  |
| VS-003b | Prisma schema + migrations on clean DB                 |          P0 | Done                                           | 2 migrations applied to a fresh cluster and to the test DB (`migrate deploy`)                                                                |
| VS-003c | Health live/ready, structured logs with request id     |          P0 | Done                                           | `api.test.ts › health`. JSON logs with `requestId`/`jobId`, no user text                                                                     |
| VS-003d | Auth, CSRF, ownership                                  |          P0 | Done                                           | `api.test.ts › auth`, `› authorization (cross-user isolation)`                                                                               |
| VS-004  | Real TTS preview (eSpeak adapter, worker, job queue)   |          P0 | Done                                           | `› previews a segment with real audio…`. Browser preview played a 9.6 s waveform                                                             |
| VS-004a | Voice manifest discovery + allowlist reconciliation    |          P0 | Done                                           | `unit.test.ts › catalog reconciliation`. `/voices` hides failed/uninstalled voices                                                           |
| VS-005  | Project and segment persistence                        |          P0 | Done                                           | `› CRUD, rename, duplicate, archive…`, `› creates, updates, reorders…`, `› enforces optimistic concurrency with 409`. E2E reload check       |
| VS-006  | Voice capability model and controls                    |          P0 | Done                                           | `› capabilities and settings` tests. Inspector shows Engine/DSP badges. Unsupported values rejected                                          |
| VS-007  | Render queue and WAV export                            |          P0 | Done                                           | `› renders a project with progress units…`, cancel/retry/crash-recovery tests                                                                |
| VS-008  | DSP processing and assembly                            |          P1 | Done                                           | `› segment pipeline (engine + DSP)`, `› assembly + export` (sample-exact pauses and timeline)                                                |
| VS-009  | Studio UI, waveform, timeline                          |          P1 | Done                                           | WaveSurfer waveform from real assets with segment regions, prev/next segment, zoom. E2E pass                                                 |
| VS-010  | Pronunciation, normalization preview, presets          |          P1 | Done                                           | Unit tests (precedence, literal matching, phoneme safety). API pronunciation and preset tests                                                |
| VS-011  | MP3/OGG export and validation                          |          P1 | Done                                           | `› exports MP3 and OGG with matching metadata`. ffprobe + full decode before success                                                         |
| VS-012  | Multilingual QA catalog                                |          P1 | Done (automated). Manual review blocked (B2)   | `config/voice-qa-report.json`                                                                                                                |
| VS-013  | Security, backup, monitoring, hardening                |          P0 | Done (local). Docker hardening unverified (B1) | Security tests (CSRF, CORS, 413, injection, traversal, no stack traces). Backup verify. `no-store` on audio                                  |
| VS-014  | Project version history                                |          P1 | Done                                           | `› saves and restores versions`                                                                                                              |
| VS-015  | Admin: engine health, voice toggles, failures, storage |          P1 | Done                                           | `› admin can disable a voice…`, Settings page admin panel                                                                                    |
| VS-016  | Render cache + partial rerender                        |          P1 | Done                                           | `› … reuses cached segments` (only the edited segment re-synthesized; an identical render is served from cache)                              |
| VS-017  | Strict non-AI compliance audit                         |          P0 | Done                                           | `scripts/compliance-audit.mjs` plus its negative test                                                                                        |
| VS-018  | E2E browser test of the full journey                   |          P0 | Done                                           | `e2e/studio.spec.ts` 2/2                                                                                                                     |
| VS-019  | Multiple approved engines                              |          P1 | Blocked (B3)                                   | No second strict non-AI engine has passed admission                                                                                          |
| VS-020  | S3/MinIO storage driver                                | P1/optional | Deferred                                       | Local volume driver behind the `StorageDriver` interface                                                                                     |
| VS-021  | DOCX/SRT import, workspace sharing, quotas             |          P2 | Deferred                                       | Out of P0/P1 scope                                                                                                                           |

## Acceptance criteria status (docs/11)

- **A. Product and policy**: all met. Audit enforces it. UI distinguishes Engine / DSP / unsupported controls.
- **B. Identity and projects**: all met.
- **C. Text and voice**: all met (normalization rules are English-only; other locales warn and defer to eSpeak's own rules).
- **D. Synthesis and DSP**: all met.
- **E. Timeline and export**: all met.
- **F. Jobs and resilience**: all met (worker crash → lease expiry → requeue, tested).
- **G. Deployment and quality**: met locally. **Open:** clean Docker Compose deployment (B1) and manual QA of released voice/locale combinations (B2).

## Blockers

| ID  | Blocker                                                                                | Evidence                                                                                         | Workaround attempted                                                                                                          | Next action                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Docker not installed; WSL not installed (Docker Desktop needs WSL2/admin and a reboot) | `docker: command not found`; `wsl` reports not installed                                         | Verified the non-Docker deployment (`pnpm start`) end to end; validated Compose YAML structure; pinned FFmpeg source checksum | On a Docker host: `docker compose up -d --build`, check `/health/ready`, run `E2E_BASE_URL=https://localhost pnpm test:e2e`                    |
| B2  | Native-speaker/qualified review of each released voice                                 | Cannot be performed by the agent                                                                 | All voices labelled "experimental" with the automated QA record shown in the UI                                               | Reviewers add `manualReview` entries in `config/voice-qa-report.json` (preserved across QA re-runs), which promotes those voices to "verified" |
| B3  | Second strict non-AI engine                                                            | MBROLA voices carry non-commercial/per-voice licenses; Festival/Flite include statistical voices | Architecture supports more adapters (`TtsEngineAdapter`)                                                                      | Admit a candidate via the docs/07 checklist                                                                                                    |

| B4 | “Natural-sounding” Vietnamese | eSpeak NG is a formant synthesizer; its Vietnamese output is intelligible but robotic. A strictly non-AI engine cannot produce human-natural speech by rule | Added regional voices, correct number/date/currency reading, pronunciation dictionary, intonation/speed controls | Needs licensed recorded Vietnamese speech units for a concatenative (diphone) engine, admitted via the docs/07 checklist. See the summary for options |

## Known limitations

- eSpeak NG formant output is intelligible but robotic. There is no per-word emphasis control (only intonation range, rate, word gap and pauses).
- Text normalization rules exist for English and Vietnamese. Other languages rely on eSpeak NG's built-in rule-based number and symbol handling (shown as a warning in the preview).
- The UI is available in Vietnamese and English. Voice limitation notes and admin diagnostics from the server remain in English. Adding a language means adding one file in `apps/web/src/i18n/` (TypeScript enforces every key).
- Hebrew and Arabic pass automated QA, but eSpeak quality depends on vowel diacritics; Thai lacks word segmentation. All are tier "experimental".
- French QA corpus: one word ("rythme") is read with English rules by eSpeak's dictionary (recorded in the voice notes).
- Undo/redo history lasts for the browser session only. Unsaved edits are recoverable from local storage after a crash.
- Rate limiting is in-memory (single node).
- Storage is a local volume only. There is no S3/MinIO driver yet.
- Password reset is operator-issued (`pnpm user:reset-password`) because no email service is assumed.
- The timeline is a waveform with segment regions; timing is edited through segment pause settings, not by dragging.

## Bug log (found during verification)

- Settings compared with `JSON.stringify` against JSONB values (JSONB reorders keys) → segments flagged stale and revisions bumped needlessly. Fixed with key-order-independent `settingsEqual`.
- The session probe returned 401 on every signed-out page load (console error) → added `GET /auth/session` returning `null`.
- Tablet layout: the inspector overlay hid the Preview button → the inspector now starts closed below 1100 px.
- Audio responses were browser-cacheable after sign-out → `Cache-Control: private, no-store`.
- Backup verification misparsed Windows CRLF psql output → fixed.
- Built-in presets returned 404 instead of 403 on edit → fixed.

## Status rules

Allowed statuses: Todo, In Progress, Blocked, Done, Deferred.
A task may be marked Done only with test command(s), result, and evidence (commit, screenshot, test report, or deployment URL). Do not mark tasks Done based only on code being written.
