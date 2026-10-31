# 0003 — PostgreSQL-backed job queue instead of Redis/BullMQ

- Status: accepted
- Date/owner: 2026-10-31, VoxStudio coding agent

## Context

Docs suggest Redis + BullMQ. The target is a single-node self-hosted deployment, and render jobs already live in `render_jobs` as the source of truth for status, progress and retry. Running Redis on the Windows dev host is not natively supported.

## Decision

Use PostgreSQL as the queue: workers claim jobs with `UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1)`, heartbeat a `locked_until` lease, and publish progress with `NOTIFY render_jobs`. The API `LISTEN`s and fans events out over SSE per workspace. Expired leases (worker crash) are requeued up to `max_attempts`.

## Alternatives

BullMQ (rejected for now: second source of truth, extra service); pg-boss (rejected: we need custom job/state columns anyway).

## Consequences

One fewer service. Throughput is ample for single-node workloads. Redis is not required by Docker Compose. If multi-node scale is needed, revisit.

## Security/license/performance impact

No new dependency beyond `pg` (MIT). Job state transitions are transactional.
