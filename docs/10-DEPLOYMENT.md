# 10 — Self-hosted Deployment

> **Status note (2026-10-31):** this document is the original deployment plan. The implementation differs: the job queue is PostgreSQL (ADR 0003), so **there is no Redis service**, and storage is the local driver (no MinIO). The compose file starts PostgreSQL, a one-shot migration service, the API and the worker. The Docker path has not been built or run by QA yet; the single-node non-Docker path (`pnpm build && pnpm start`) was verified from a clean checkout (see docs/upgrade/06-PRODUCTION-READINESS.md).

## 1. Deployment target

Docker Compose single-node production baseline. Components:

- reverse proxy;
- web frontend;
- NestJS API;
- render worker;
- PostgreSQL;
- Redis;
- object storage (MinIO optional for multi-node/object semantics).

All components must be deployable without external TTS APIs.

## 2. Container principles

- Pin image versions and preferably digests.
- Use non-root users.
- Multi-stage builds.
- Minimal runtime images.
- Install only approved TTS/DSP binaries.
- Health checks and restart policies.
- Read-only root filesystem where practical.
- Separate persistent volumes for database, Redis (if persistence required), and audio storage.
- Never bake secrets into images.

## 3. Environment variables

Document and validate:

- `NODE_ENV`
- `PUBLIC_BASE_URL`
- `API_PORT`
- `DATABASE_URL`
- `REDIS_URL`
- `STORAGE_DRIVER`
- `STORAGE_LOCAL_ROOT` or S3-compatible endpoint/bucket/credentials
- `AUTH_SECRET` / cookie secrets
- `CORS_ORIGINS`
- `WORKER_CONCURRENCY`
- `PREVIEW_MAX_CHARS`
- `RENDER_MAX_CHARS`
- `RENDER_TIMEOUT_SECONDS`
- `TEMP_DIR`
- engine binary paths and approved versions
- log level

Provide `.env.example` with safe placeholders only. Fail startup when required secrets are missing or weak.

## 4. Network

- Expose only reverse proxy publicly.
- Keep PostgreSQL and Redis on private Docker networks.
- Worker should not need general internet access at runtime.
- Restrict outbound network egress.
- Use TLS at reverse proxy.
- Configure request body and upload limits.

## 5. Storage and backup

- Persist database and audio assets.
- Back up database and object storage separately.
- Test restore procedure.
- Define retention and cleanup jobs for temp/intermediate files.
- Do not delete assets referenced by active projects or versions.

## 6. Operations

- `/health/live` and `/health/ready`.
- Structured logs with request/job IDs.
- Worker queue metrics and failure counts.
- Disk usage alerts.
- Database backup status.
- Engine binary/version health.
- Rotate logs and secrets.
- Document upgrade and rollback.

## 7. Deployment checklist

- [ ] `.env` configured securely.
- [ ] TLS active.
- [ ] Migrations applied.
- [ ] Engine binary/version verified.
- [ ] Approved voice catalog loaded.
- [ ] Worker can synthesize smoke-test phrase.
- [ ] Output decodes and downloads.
- [ ] Backup and restore tested.
- [ ] No public DB/Redis ports.
- [ ] Non-root containers.
- [ ] Monitoring and log rotation configured.

---

## 8. Implementation (as built)

### Files

- `infra/docker/Dockerfile`: three stages. (1) FFmpeg 7.1.2 from a checksum-pinned tarball with `--disable-everything` plus only the protocols, codecs, muxers and filters VoxStudio uses (the build fails if `flite`, `whisper`, `arnndn` or `dnn_*` appear). (2) Monorepo build. (3) Runtime `node:24-trixie-slim` with `espeak-ng=1.52.0+dfsg-5`, running as non-root `node` under `tini`, with a version assertion and an MBROLA absence check at build time.
- `docker-compose.yml`: `postgres`, one-shot `migrate`, `api`, `worker`, `caddy`. Server containers use `read_only: true`, `tmpfs` for temp, `cap_drop: ALL`, `no-new-privileges`, and CPU/memory limits. The `backend` network is `internal: true`, so the worker and database have no route outside. Only Caddy publishes ports 80/443.
- `infra/caddy/Caddyfile`: automatic TLS (Let's Encrypt for a real `VOXSTUDIO_DOMAIN`, internal CA for `localhost`), HSTS, 4 MB body limit, and unbuffered SSE.
- `.env.docker.example`: every variable with safe placeholders. Startup fails if `AUTH_SECRET` is under 32 characters or contains `change-me`, or if `COOKIE_SECURE` is not `true` in production.

### Environment variables

See `.env.example` (local) and `.env.docker.example` (Compose). They are validated in `packages/core/src/config.ts`. Engine/DSP binaries come from `ESPEAK_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` and `ESPEAK_APPROVED_VERSION`. Limits: `PREVIEW_MAX_CHARS`, `SEGMENT_MAX_CHARS`, `RENDER_MAX_CHARS`, `RENDER_TIMEOUT_SECONDS`, `ENGINE_TIMEOUT_SECONDS`, `QUEUE_MAX_PENDING_PER_WORKSPACE`, `WORKER_CONCURRENCY`.

### Health

- `GET /api/v1/health/live`: process liveness.
- `GET /api/v1/health/ready`: database, storage writability, approved eSpeak NG version, FFmpeg without prohibited filters, and a worker heartbeat within 60 s. Returns 503 if a critical check fails, and `degraded` if only the worker is missing.
- The worker refuses to start if eSpeak NG is not the approved version or FFmpeg is non-compliant or missing required filters.

### Local (non-Docker) single node

```
pnpm install && pnpm db:start && pnpm build && pnpm start
```

For a production host without Docker: install the same tool versions, set `NODE_ENV=production`, `COOKIE_SECURE=true`, a real `DATABASE_URL`, and put a TLS reverse proxy (e.g. Caddy with the provided Caddyfile, pointing at `localhost:4000`) in front.

### Backup and restore

- Local: `node scripts/backup.mjs backup [dir]` writes `db.dump` (pg_dump custom format), `storage/`, and `manifest.json` (row counts, file count, dump checksum).
- `node scripts/backup.mjs verify <dir>` restores into a scratch database `voxstudio_restore_check` plus temporary storage, compares row counts, and re-hashes every audio asset against `audio_assets.checksum_sha256`. **Verified 2026-10-31** on the dev database: 34/34 assets OK, all tables matched.
- `node scripts/backup.mjs restore <dir> --yes` restores over the configured database and storage. Stop the API and worker first.
- Compose: `docker compose exec postgres pg_dump -U voxstudio -Fc voxstudio > db.dump`, and archive the `storage` volume (e.g. `docker run --rm -v voxstudio_storage:/s -v $PWD:/b alpine tar czf /b/storage.tgz -C /s .`).

### Upgrade and rollback

1. Back up (above). 2. Pull or build the new image. 3. `docker compose up -d` (the `migrate` service applies pending migrations before `api` and `worker` start). 4. Check `/health/ready`. Rollback: redeploy the previous image tag. If a migration must be undone, restore the pre-upgrade backup (migrations are forward-only).

- Upgrading eSpeak NG or FFmpeg changes cache keys and invalidates the QA report: run `pnpm qa:voices`, review it, update `ESPEAK_APPROVED_VERSION`, and record the review in `docs/decisions/0002-*`.

### Retention

Standalone previews (voice library and pronunciation tests) expire after 24 h and are deleted by the worker's cleanup loop unless they are referenced. Segment and export assets referenced by a project are never deleted. Deleting a project removes its files and then its rows.
