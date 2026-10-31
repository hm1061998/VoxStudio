# 0009 — AI voices are the product default; roles and account security

- Status: accepted (owner decision, 2026-11-01)
- Date/owner: 2026-11-01, product owner; recorded by the VoxStudio coding agent
- Amends ADR 0008 (the rule-based engine is no longer the default) and refines ADR 0007

## Context

After listening, the owner found the AI voices good and the rule-based eSpeak NG voices unwanted ("bỏ luôn giọng eSpeak đi"). The application also needed a clear permission model for administrators and ordinary users, an administrator dashboard, and stronger protection against account attacks.

## Decision

1. **Engines are selected by configuration.** `ENABLED_ENGINES` (default `vieneu`) lists the engines offered to users. With the default, **no eSpeak or other rule-based voice appears anywhere** in the catalog, the UI or the API; a rule-based voice id is refused as unavailable. `espeak` and `vnunit` remain in the code for development, tests and languages other than Vietnamese, and are enabled explicitly. Consequence: the default product speaks **Vietnamese only** (the model's preset voices).
2. **No silent fallback** (ADR 0008) still holds, and now has a sharper meaning: when the model service is down nothing can speak, `/health/ready` is 503, and jobs fail with `ENGINE_UNAVAILABLE`. The application recovers without a restart once the service returns.
3. **Roles.** Two roles: `user` and `admin`. Rules: only an administrator can reach `/admin/*` (default-deny through `@AdminOnly` on the controller); an administrator cannot change their own role or status; the last active administrator cannot be demoted or suspended; role or status changes end all sessions of the account; `ADMIN_EMAILS` only bootstraps the **first** administrator (it grants nothing once any admin exists, so a listed address cannot be claimed by registering later); further administrators are promoted by an administrator or by `scripts/user-admin.mjs` (operator, needs database access). Users are scoped to their own workspaces (404 for others' resources); plans are assigned by administrators.
4. **Account security.** Per-account and per-address sign-in lockout with doubling waits (unknown addresses lock identically); scrypt N=2^16 with rehash on sign-in; password policy (common, sequential, repeated, personal data); password change or reset ends other sessions; sessions: 7 days absolute, 24 h idle, at most 10 per account, SameSite=Strict, `__Host-` cookie prefix when Secure; Origin check on state changes; `Cache-Control: no-store` on API responses; `Permissions-Policy`; `TRUST_PROXY` configurable so addresses are correct behind the proxy; optional closing of self-registration (`ALLOW_REGISTRATION`).
5. **Audit trail** for sign-ins, lockouts, registrations, password changes, role/status/plan changes and engine/voice toggles (table `audit_events`, workspace optional), visible to administrators.

## Alternatives

Delete the eSpeak code (breaks the test suite, the non-AI tooling and any non-Vietnamese deployment); auto-promote `ADMIN_EMAILS` on every sign-in (an account takeover path if the address is ever registered by someone else); email verification and 2FA (not built: no mail system, see limitations).

## Consequences

- The default deployment needs the model service (about 1.4 GB RAM per instance) and has no non-AI voice to fall back to.
- Other languages are unavailable unless an operator enables `espeak`.
- Limitations: no email verification, no 2FA, no breached-password lookup beyond a built-in list, password resets are operator-issued, no CAPTCHA, no WAF or volumetric DDoS protection (put the application behind a reverse proxy/CDN with rate limiting), no external penetration test.

## Security/license/performance impact

scrypt N=65536 costs about 64 MB and 0.1 to 0.2 s per sign-in; sign-in endpoints are rate limited to bound the cost. Licenses unchanged.
