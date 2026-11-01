# 10 — Security and access control

Decision record: [ADR 0009](../decisions/0009-ai-voices-only-roles-and-account-security.md). This page describes what is implemented and what is not. It is not a penetration test report.

## Roles and permissions

| Capability                                                     | Anonymous | `user` | `admin`                     |
| -------------------------------------------------------------- | --------- | ------ | --------------------------- |
| Register / sign in (when `ALLOW_REGISTRATION=true`)            | yes       | n/a    | n/a                         |
| Own projects, segments, renders, previews, presets, dictionary | no        | yes    | yes                         |
| Other users' projects and assets                               | no        | 404    | 404                         |
| `/admin/*` (dashboard, users, engines, voices, jobs, audit)    | 401       | 403    | yes                         |
| Change a user's role, status or plan                           | no        | no     | yes (not their own account) |
| Demote or suspend the last active admin                        | no        | no     | refused                     |

Enforcement: a global guard denies `/admin/*` unless the session user is an active admin (`@AdminOnly`); every project, asset and job lookup is scoped to the caller's workspaces and returns 404 otherwise. Admin dashboard (web, `/admin`): overview, users, engines and voices, jobs, audit log.

## Controls

- **Passwords**: scrypt N=65536, rehash on sign-in when parameters change; policy rejects common, sequential, repeated and personal-data passwords.
- **Brute force**: 5 failures lock the account and the source address with doubling waits; unknown emails lock identically (no enumeration); sign-in and registration are rate limited per address.
- **Sessions**: 7-day absolute and `SESSION_IDLE_HOURS` (24) idle expiry, at most 10 per account, ended on suspension, demotion and password change; cookie HttpOnly, SameSite=Strict, `__Host-` prefix when Secure.
- **CSRF**: per-session token plus an Origin check on every state-changing request.
- **Input**: strict schemas (unknown fields rejected), body-size limits, parameterised queries, argument-array subprocesses, no CORS grants.
- **Headers**: CSP, `nosniff`, frame protection, `Permissions-Policy`, `Cache-Control: no-store` on `/api`, no `X-Powered-By`; errors never expose stack traces or paths.
- **Audit**: sign-ins, lockouts, registrations, password and role/status/plan changes, engine and voice toggles.
- **Model service**: internal network only, shared-secret token, body limit, preset voices only, no cloning endpoint.

## Configuration

| Variable             | Default  | Meaning                                                           |
| -------------------- | -------- | ----------------------------------------------------------------- |
| `ENABLED_ENGINES`    | `vieneu` | Engines offered to users (`espeak`, `vnunit` are opt-in)          |
| `ADMIN_EMAILS`       | empty    | Bootstraps the **first** admin only                               |
| `ALLOW_REGISTRATION` | `true`   | `false` closes self-registration                                  |
| `SESSION_IDLE_HOURS` | `24`     | Idle session expiry                                               |
| `TRUST_PROXY`        | see env  | Which proxies' `X-Forwarded-For` is trusted (set it behind Caddy) |

Operator CLI (needs database access): `node scripts/user-admin.mjs` to list users, promote/demote, suspend/activate, set a plan or reset a password.

## Verification

- `apps/api/test/security.test.ts`, `password-policy.test.ts`, `ai-only.test.ts` (API level).
- `scripts/qa-security.mjs`: 31 black-box checks against a running server (31/31 on the AI-only configuration).
- Playwright: admin dashboard, lockout, axe-core accessibility.

## Not done

No 2FA, email verification or mailed password reset; no CAPTCHA; no WAF/volumetric DDoS protection (use the reverse proxy or a CDN); no TLS in the application itself (Caddy terminates it in the compose stack, never built here); no independent penetration test; the Docker images have not been built.

## Stored audio (disk) limits

- Each plan has a `storageBytes` allowance (free 300 MB, pro 5 GB, business 50 GB; override with `PLAN_LIMITS_JSON`). New render and preview jobs are refused with `STORAGE_QUOTA_EXCEEDED` (402) once a workspace has used it; results already stored still play. Usage is shown in Settings and returned by `GET /me/plan`.
- Standalone previews expire after 24 hours. Superseded project audio (the old take of a re-rendered segment) and replaced exports are deleted by the worker 24 hours after they stop being referenced (`ORPHAN_GRACE_MS`, checked every 10 minutes). Earlier builds never deleted them.
- Audio is 22.05 kHz mono 16-bit WAV, about 2.6 MB per minute. No per-file or per-day creation limit beyond the above and the character and pending-job limits.
