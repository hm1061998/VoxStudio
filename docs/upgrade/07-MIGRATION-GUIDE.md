# 07 — Migration guide (pre-upgrade VoxStudio → current)

Audience: an operator running the application as it was before the upgrade tasks (single eSpeak NG engine). Everything below is backward compatible: existing projects, segments, presets, dictionaries and exports keep working. Verified by applying all migrations to an empty database and by the unchanged golden audio hashes for eSpeak output; **not** verified by upgrading a populated production database from an older release (only the development database, which was upgraded in place by the new migration).

## 1. Before you start

1. Back up: `node scripts/backup.mjs backup <dir>` then `node scripts/backup.mjs verify <dir>`.
2. Stop writers (API and worker), or accept that running jobs finish against the old schema.

## 2. What changes

| Area                    | Change                                                                                                                                                                   | Impact                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                | one new migration, `20261031120000_voice_datasets`: table `tts_voice_datasets` (append-only dataset audit trail)                                                         | additive; applied by `pnpm --filter @voxstudio/db migrate:deploy` (or automatically by `scripts/start-all.mjs`, or by the `migrate` service in `docker-compose.yml`) |
| Environment             | optional `VN_UNIT_DB_DIR` (path to Vietnamese unit databases)                                                                                                            | leave empty: `vnunit` is not registered and nothing changes                                                                                                          |
| Config files            | new `config/vi-bench-syllables.json` (generated from `vi-bench-1`); per-engine QA reports `config/voice-qa-report.<engineId>.json` (eSpeak keeps `voice-qa-report.json`) | must be deployed with the application (they are in the repository and in the image)                                                                                  |
| Normalization           | `NORMALIZATION_VERSION` is now `norm-3` (Vietnamese ranges, phone numbers, Roman numerals)                                                                               | render cache keys include it, so old cached Vietnamese audio is regenerated automatically on next render; other languages are unaffected                             |
| API                     | additive only: `GET /voices/:id/profile`, `GET /voices/:id/dataset`; `AssetSummaryDto.engines/voices`; `NormalizationPreviewDto.diagnostics`                             | existing clients keep working                                                                                                                                        |
| Segment settings schema | unchanged (version 1); engine-specific schema work is still open (UP-004)                                                                                                | no data migration                                                                                                                                                    |
| Engines                 | engines register through `EngineRegistry`; eSpeak behaviour is byte-identical (golden hashes unchanged)                                                                  | none                                                                                                                                                                 |
| Web client              | voice labels add the engine name when two engines offer the same accent; new panels (previews to compare, diagnostics, pronunciation dialog)                             | no action; UI language preference unchanged                                                                                                                          |
| Render exports          | older exports have an engine snapshot without the list of engines; the UI shows the engine from the snapshot's `engineId`/`engineVersion`                                | no re-render needed                                                                                                                                                  |

## 3. Steps

```bash
git pull   # or deploy the new build
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @voxstudio/db migrate:deploy
node scripts/compliance-audit.mjs
pnpm start
node scripts/qa-functional.mjs      # smoke test against the running instance
```

Docker: rebuild the image (`docker compose build`), then `docker compose up -d`. **The Docker path has not been built by the QA that produced this guide.**

## 4. Rollback

The migration only adds a table. To roll back the application, redeploy the previous build; the extra table is ignored. To remove it: `DROP TABLE tts_voice_datasets;` and delete the row from `_prisma_migrations` for `20261031120000_voice_datasets`. For anything else restore the backup (`node scripts/backup.mjs restore <dir> --yes`, which overwrites the configured database and storage).

## 5. Optional: adding a recorded Vietnamese voice

Not possible until licensed recordings exist. When they do (details in `docs/upgrade/05-VIETNAMESE-CORE.md` and `06-VOICE-LIBRARY.md`):

1. Build a database with provider-supplied syllable boundaries: `node scripts/build-unit-db.mjs spec.json <dir>`; set `datasetVersion`, `attribution`, `speaker` (gender only if verified) in the spec.
2. Set `VN_UNIT_DB_DIR`, add the voice to `config/voice-allowlist.json` (`engineId: vnunit`), produce `config/voice-qa-report.vnunit.json` (the QA script does not yet generate it: UP-023) and have a native speaker review the benchmark.
3. Approve the engine in the admin console only after the admission checklist in `docs/07-TTS-ENGINE-SPECIFICATION.md` is recorded in an ADR. Until then the voice stays hidden.

## 6. Documentation to read with this guide

`docs/decisions/0003-postgres-job-queue.md` (there is no Redis), `0005`, `0006`; `docs/10-DEPLOYMENT.md` describes the original plan and still lists Redis and MinIO, which the implementation does not use.

## 7. Addendum: AI voice engine and plans (2026-10-31, ADR 0008)

| Area            | Change                                                                                                                                                                                  | Action                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Database        | migration `20261031180000_plans_priority_ai_usage`: `workspaces.plan` (default `free`), `render_jobs.priority` (default 0), table `ai_usage`, index on `(status, priority, created_at)` | `migrate:deploy`; existing workspaces become `free`. Queued jobs created before the migration have priority 0 |
| Queue order     | highest `priority + aging + interactive boost` first instead of oldest first                                                                                                            | none; with every workspace on `free` the order is the old one (previews first, then oldest)                   |
| Limits          | per-plan pending-job limit (free 5) replaces the single `QUEUE_MAX_PENDING_PER_WORKSPACE` ceiling for ordinary use (the variable still caps it)                                         | review `PLAN_LIMITS_JSON` if you had raised the old limit                                                     |
| New environment | `VIENEU_SERVICE_URLS`, `VIENEU_SERVICE_TOKEN`, `VIENEU_APPROVED`, `VIENEU_TIMEOUT_SECONDS`, `QUEUE_AGING_SECONDS`, `PLAN_LIMITS_JSON`                                                   | all optional; without `VIENEU_SERVICE_URLS` nothing changes                                                   |
| API             | `GET /me/plan`, `GET /admin/workspaces`, `PATCH /admin/workspaces/:id/plan`; `usesAi` on engines and voices; error codes `QUOTA_EXCEEDED` (402) and `ENGINE_BUSY` (503)                 | additive                                                                                                      |
| QA reports      | one report per engine: `voice-qa-report.vieneu.json`                                                                                                                                    | run `node scripts/qa-vieneu.mjs` after starting the model service                                             |
| Docker          | `docker compose --profile ai up` adds the model service (never built by QA)                                                                                                             | optional                                                                                                      |

Rollback: redeploy the previous build; the new columns and table are ignored. To remove them: drop `ai_usage`, the two columns and the index, and delete the migration row.
