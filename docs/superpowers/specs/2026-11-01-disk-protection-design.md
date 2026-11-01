# Disk protection — design

Date: 2026-11-01. Status: approved in conversation by the owner ("ổn, hãy thực hiện đi"). Supersedes nothing; extends the per-plan storage allowance (UP-055).

## Intent

A long-running VoxStudio server must not fill its disk unexpectedly. The VPS size is unknown, so protection must measure the real disk rather than assume a size. Success: when free space gets low the system cleans up faster and warns the administrator; when it is critically low it refuses new audio jobs with a clear message while stored results stay playable; it recovers by itself when space returns. Not a goal: external object storage, per-day quotas, backups, billing.

## Understanding of the problem

Audio is 22.05 kHz mono 16-bit WAV, about 3.1 KB per spoken character. The default export profile is the same; heavy profiles (48 kHz, stereo, 24-bit) are up to 4.4 times larger. Superseded segment audio is already deleted after 24 hours and standalone previews expire after 24 hours (UP-055). Other growth: `render_jobs`, `audit_events`, container logs.

## Design

### DiskGuard (worker + shared status)

- The worker measures free space of `STORAGE_LOCAL_ROOT` with `fs.statfs` every 60 seconds and upserts one row in table `disk_status` (`id=1`, `total_bytes`, `free_bytes`, `state`, `checked_at`).
- State from the free fraction and absolute free bytes: `ok`, `warn` (free below `DISK_WARN_FREE_PERCENT`, default 20), `block` (free below `DISK_BLOCK_FREE_PERCENT`, default 8, or below `DISK_MIN_FREE_MB`, default 1024).
- A status older than 5 minutes is treated as unknown: the API then measures itself once (fail-open is wrong, fail-closed is wrong; measuring is right).
- Every state change writes an `audit_events` row (`disk.state`).

### Behaviour by state

- `warn`: the worker retention uses shortened lifetimes (previews 2 h, unreferenced project audio 1 h instead of 24 h); the admin dashboard shows a banner.
- `block`: enqueueing a job that would synthesize new audio fails with 503 `DISK_FULL`. Cache hits, downloads, sign-in and everything else keep working. `/health/ready` stays 200 and reports `disk: block`.
- Recovery is automatic on the next measurement.

### Heavy exports

- Heavy = WAV with sample rate above 22,050, or stereo, or 24-bit. MP3 and OGG are not heavy.
- Plan field `heavyExports` (free false, pro true, business true; `PLAN_LIMITS_JSON`). A request with a heavy profile on a plan without it fails with 403 `PLAN_FEATURE_UNAVAILABLE`. The web UI disables heavy options with the reason.

### Housekeeping

- Daily in the worker: delete finished `render_jobs` older than `JOB_RETENTION_DAYS` (30) and `audit_events` older than `AUDIT_RETENTION_DAYS` (180) in batches.
- docker-compose: `logging` with `max-size`/`max-file` for every service, and Caddy log rotation.

### Admin dashboard data

`GET /admin/overview` gains `disk` (total, free, state, checkedAt) and `topWorkspaces` (five largest by stored bytes).

## Testing

Unit tests for the state function (percent and absolute thresholds, stale status), API tests for `DISK_FULL` (with the measuring function replaced), the heavy-export rule and the housekeeping delete. Not tested: a really full disk.

## Out of scope

Object storage, daily quotas, backups, notifications by email.
