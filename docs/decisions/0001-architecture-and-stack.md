# 0001 — Architecture and stack

- Status: accepted
- Date/owner: 2026-10-31, VoxStudio coding agent

## Context

The repository started as a specification pack. Docs 03 suggest React/Vite, NestJS, PostgreSQL, Redis/BullMQ, a worker and eSpeak NG. Library majors released in 2026 (TypeScript 7 native compiler, NestJS 12, Prisma 8 RC) are less proven for decorator metadata and driver behaviour.

## Decision

- pnpm monorepo: `apps/web` (React 19 + Vite 7 + Tailwind 4 + TanStack Query + Zustand + WaveSurfer 7), `apps/api` (NestJS 11), `apps/worker` (plain Node process), `packages/contracts` (zod schemas/types shared by all), `packages/db` (Prisma 6 schema, migrations, client), `packages/core` (engine adapters, text normalization, pronunciation, DSP, assembly, WAV I/O, cache keys, render plans).
- TypeScript 5.9 strict, CommonJS for Node packages; web consumes `contracts` source via a Vite alias.
- Prisma 6.19 as the only ORM; migrations via `prisma migrate deploy`.
- Validation with zod at API boundaries (`ZodValidationPipe`).
- Session auth: opaque random session token in HttpOnly SameSite=Lax cookie, stored hashed (SHA-256) in `sessions`; passwords hashed with Node `crypto.scrypt`; double-submit CSRF token for cookie-authenticated mutations.
- Storage: local filesystem driver behind a `StorageDriver` interface; server-generated keys only.

## Alternatives

TypeORM (rejected: weaker migration ergonomics for this team size); TS 7/Nest 12 (deferred until proven); JWT (rejected: revocation complexity).

## Consequences

Single-node deployment is simple; S3/MinIO driver is a documented future extension (not shipped, not advertised).

## Security/license/performance impact

All listed libraries are MIT/Apache-2.0/BSD-3 (see `THIRD_PARTY_NOTICES.md`).
