# VoxStudio

**Tiếng Việt:** VoxStudio là web studio tự lưu trữ để chuyển văn bản thành giọng đọc. Bản mặc định chỉ dùng giọng AI tiếng Việt (VieNeu-TTS) chạy trong một dịch vụ riêng trên máy chủ của bạn, chọn được vùng miền (Bắc, Trung, Nam) và giới tính, xuất MP3 hoặc WAV. Văn bản không gửi ra dịch vụ bên ngoài. Có phân quyền người dùng và quản trị viên, trang quản trị, gói dịch vụ có hạn mức, và bảo vệ ổ đĩa. Phần còn lại của tài liệu viết bằng tiếng Anh.

VoxStudio is a self-hosted web voice studio. In the default configuration it offers **Vietnamese AI voices** only: the VieNeu-TTS model runs in a separate, self-hosted service on your own server (internal network, token, preset voices only, no cloning, no outside API). Users choose region and gender, hear a real preview, edit a project paragraph by paragraph, and export MP3 or WAV.

> **Voice policy (ADR 0007, 0008, 0009).** The rule-based engines in the code base (`espeak`: eSpeak NG 1.52.0 formant synthesis, and `vnunit`: a Vietnamese unit-selection experiment) are **not offered unless an operator lists them in `ENABLED_ENGINES`**. They stay strictly non-AI, are kept for development, tests and other languages, and are never a silent fallback for the AI engine. AI voices are labelled "AI" everywhere in the UI. Without the model service no voice is available and `/health/ready` returns 503.
>
> VoxStudio makes no claim about how natural or human the voices sound: nobody has done a listening evaluation yet (tracker UP-045). Presets are deterministic parameter bundles, not emotional acting.

## What works

- **Studio:** projects with paragraphs, split/merge/reorder, `[pause 500ms]` markers, `.txt` import, undo/redo, autosave with conflict handling, version snapshots, pronunciation dictionary, voice styles (presets).
- **Voices:** a gallery of six AI voices with per-voice real samples, filtered by region (Bắc, Trung, Nam) and gender. Simple mode shows voice, speed, pitch, volume and pause; Advanced mode shows every engine and DSP control, each labelled Engine or DSP.
- **Rendering:** PostgreSQL-backed job queue with an isolated worker, progress over SSE, retry and cancel, content-addressed render cache (editing one paragraph re-synthesizes only that paragraph). Export to MP3, OGG or WAV; every file is probed and decoded before it is offered.
- **Home:** "Hear it first" (paste text, choose region and gender, hear a real preview, then save as a project).
- **Interface:** Vietnamese and English, light and dark themes (Auto follows the system), desktop rail and phone bottom bar, keyboard and screen-reader support (axe-core checks in both themes).
- **Accounts and roles:** `user` and `admin`. Every project, asset and job is owner-scoped (other users' resources return 404). The account area has separate pages: Profile, Plan and usage, Password, Signed-in devices, My data.
- **Admin dashboard (`/admin`, administrators only):** overview (users, queue, AI service, disk space, largest workspaces, security counters), users (role, status, plan), engines and voices, jobs, audit log. Ordinary users get 403 on every admin route.
- **Plans:** free, pro, business. They set queue priority, pending-job limit, monthly AI characters, stored-audio allowance and whether large WAV exports are allowed. An administrator assigns them; there is no billing.
- **Security:** scrypt passwords with a policy, account and address lockout, session limits and idle timeout, CSRF token plus Origin check, strict cookies, security headers, audit trail. See [docs/upgrade/10-SECURITY-AND-ACCESS.md](docs/upgrade/10-SECURITY-AND-ACCESS.md).
- **Disk protection:** the worker measures the storage volume every minute. Low space shortens retention and warns the admin; critically low space refuses new audio jobs (`DISK_FULL`) while saved audio keeps playing. Old drafts, unreferenced audio, finished jobs and old audit events are cleaned up automatically.
- **Search engines:** `robots.txt`, `sitemap.xml`, canonical and social-preview tags are generated from `PUBLIC_BASE_URL`; only the sign-in and registration pages are indexable; the signed-in app and the API ask not to be indexed.

## Quick start (local, Windows, macOS or Linux)

Prerequisites: Node.js 22 or newer, pnpm, PostgreSQL binaries 16 or newer, and a **compliant FFmpeg** (no `flite` or `whisper`, see [ADR 0004](docs/decisions/0004-ffmpeg-dsp-toolchain.md)). eSpeak NG 1.52.0 is needed only if you enable the `espeak` engine. The AI voice service needs Python 3.12 and the model weights (see [services/vieneu/README.md](services/vieneu/README.md)); weights are never committed.

```bash
pnpm install
```

```bash
pnpm db:start
```

`db:start` starts a project-local PostgreSQL on 127.0.0.1:5433 and writes `.env`. Open `.env` and set the AI service (the token is any random string of at least 16 characters, and must match on both sides):

```bash
ENABLED_ENGINES=vieneu
VIENEU_SERVICE_URLS=http://127.0.0.1:8765
VIENEU_SERVICE_TOKEN=<random token>
VIENEU_APPROVED=true
```

Start the model service in one terminal (it reads the token from `.env`; set `VIENEU_PYTHON` if your Python is not found automatically). Wait about a minute for the model to load:

```bash
node scripts/start-ai-service.mjs
```

Then in another terminal (stop the app first whenever you rebuild: Prisma cannot replace its engine file while the app runs):

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm start` runs the migrations, then the API (which also serves the web app) and the worker. Open http://localhost:4000 and register. The first account registered with an email listed in `ADMIN_EMAILS` becomes the administrator, only while no administrator exists. After that, promote people in the dashboard or with the operator command:

```bash
node scripts/user-admin.mjs list
```

`node scripts/user-admin.mjs promote <email>` (also `demote`, `suspend`, `activate`, `revoke`) works on the database directly.

For UI development with hot reload, run `pnpm dev:web` (port 5173, proxies `/api` to 4000) alongside `pnpm start`.

## Configuration

Set in `.env` (local) or `.env.docker` (Compose). See `.env.example` for the full list.

| Variable                                                                | Default                 | Meaning                                                                          |
| ----------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `ENABLED_ENGINES`                                                       | `vieneu`                | Engines offered to users: `vieneu`, `espeak`, `vnunit`                           |
| `VIENEU_SERVICE_URLS`, `VIENEU_SERVICE_TOKEN`, `VIENEU_APPROVED`        | empty                   | AI model service address, shared token, admin approval flag                      |
| `PUBLIC_BASE_URL`                                                       | `http://localhost:4000` | Public address; used for canonical links, sitemap and the allowed origin         |
| `ADMIN_EMAILS`                                                          | empty                   | Bootstraps the **first** administrator only                                      |
| `ALLOW_REGISTRATION`                                                    | `true`                  | `false` closes self-registration                                                 |
| `SESSION_IDLE_HOURS`                                                    | `24`                    | Idle session expiry                                                              |
| `TRUST_PROXY`                                                           | `loopback`              | Which proxies may set `X-Forwarded-For` (set it correctly behind Caddy or a CDN) |
| `PLAN_LIMITS_JSON`                                                      | empty                   | Override plan limits, e.g. `{"pro":{"aiMonthlyChars":1000000}}`                  |
| `QUEUE_AGING_SECONDS`                                                   | `30`                    | Seconds of waiting that add one priority point to a queued job                   |
| `DISK_WARN_FREE_PERCENT`, `DISK_BLOCK_FREE_PERCENT`, `DISK_MIN_FREE_MB` | `20`, `8`, `1024`       | Free-space thresholds for the disk guard                                         |
| `JOB_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`                            | `30`, `180`             | Age after which finished jobs and audit events are deleted                       |
| `STORAGE_LOCAL_ROOT`                                                    | `./storage`             | Where audio files are stored (put it on a volume you monitor)                    |

Set `PUBLIC_BASE_URL` to your real address before going public; it is what search engines and link previews see.

## Docker Compose (production baseline)

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker` and replace every `CHANGE_ME`, then:

```bash
docker compose up -d --build
```

Services: `caddy` (TLS reverse proxy), `api`, `worker` (internal network only), `vieneu` (the AI voice service, internal network only), `postgres`, and a one-shot `migrate`. Container logs rotate. FFmpeg is built from pinned, checksum-verified source. See [docs/10-DEPLOYMENT.md](docs/10-DEPLOYMENT.md) and [docs/upgrade/06-PRODUCTION-READINESS.md](docs/upgrade/06-PRODUCTION-READINESS.md). **Not verified:** Docker was not available on the development machine, so no image has ever been built.

## Commands

| Command                                              | Purpose                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                         | Generate the Prisma client and build all packages and the web app (stop the app first)                                    |
| `pnpm test`                                          | Unit and API integration tests (Vitest, real PostgreSQL and FFmpeg; stop the model service first if memory is tight)      |
| `pnpm test:e2e`                                      | Playwright journeys including accessibility. `E2E_PORT=4010 pnpm test:e2e` runs beside your own app, on the test database |
| `E2E_AI=1 pnpm test:e2e`                             | Adds the real AI voice test (needs the model service and `VIENEU_*` variables)                                            |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | Static checks                                                                                                             |
| `pnpm audit:compliance`                              | Compliance audit: dependencies, endpoints, model files, FFmpeg filters, engine versions, AI service isolation             |
| `node scripts/qa-security.mjs`                       | Black-box security probe against a running server (not a penetration test)                                                |
| `node scripts/user-admin.mjs`                        | Operator commands: list, promote, demote, suspend, activate, revoke                                                       |
| `pnpm user:reset-password <email>`                   | Issue a one-time password reset code (no email service is assumed)                                                        |
| `node scripts/backup.mjs backup\|verify\|restore`    | Database and audio backup with restore verification                                                                       |
| `node scripts/make-og-image.mjs`                     | Regenerate the social preview image                                                                                       |

## Architecture

```text
apps/web          React 19 + Vite + Tailwind + TanStack Query + Zustand + WaveSurfer
apps/api          NestJS 11: auth, roles, projects, catalog, render planning, SSE, assets, admin, SEO files
apps/worker       Claims jobs (SKIP LOCKED), synthesizes, applies DSP, encodes, validates; disk guard and cleanup
packages/core     Engine adapters (vieneu, espeak, vnunit), capabilities, text, DSP, plans, disk rules, storage
packages/db       Prisma schema and migrations (PostgreSQL)
packages/contracts  Shared zod schemas, DTOs, error codes
services/vieneu   The AI voice model service (separate process, internal network, token)
config/           Voice allowlist, QA corpus, QA reports
docs/             Product and technical specifications, ADRs, upgrade notes, design prototype
```

## Documentation

- Start with [AGENTS.md](AGENTS.md), then `docs/00`–`docs/12` (original specifications; they predate the AI-default decision, so read them with the ADRs).
- Decisions: [docs/decisions](docs/decisions) (0007 AI data at development time, 0008 self-hosted AI engine, 0009 AI voices by default, roles and account security).
- Current state: [docs/upgrade](docs/upgrade): `07-MIGRATION-GUIDE.md` (upgrading an existing install), `07-STUDIO-UI.md`, `09-AI-ENGINE-CAPACITY.md`, `10-SECURITY-AND-ACCESS.md`, and the [implementation tracker](docs/upgrade/IMPLEMENTATION-TRACKER.md) with evidence and open items.
- UI prototype that was approved for the redesign: [docs/design/ui-prototype.html](docs/design/ui-prototype.html).
- Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Known limitations

- The default product speaks Vietnamese only; other languages need the optional `espeak` engine.
- If the AI model service is down, nothing can speak (by design: no silent fallback).
- No listening evaluation of the AI voices has been done; no measurements on a real VPS; no billing; no 2FA, email verification or penetration test; no account deletion; Docker images never built.
- No LICENSE file has been chosen yet; until one is added, all rights are reserved by the author.
