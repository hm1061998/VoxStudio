# 09 — AI voice engine: architecture, capacity and plan priority

Status (2026-10-31): implemented and tested on a laptop; **not tested on a VPS, not run in Docker**. Policy: ADR 0008 (a self-hosted neural model is allowed at run time as an isolated, opt-in engine). The rule-based engines (`espeak`, `vnunit`) remain non-AI and remain the default.

## 1. Architecture

```
Browser ── API ──(PostgreSQL job queue, priority + aging)── Worker(s) ──HTTP, token──► Model service (VieNeu-TTS v3 Turbo)
                                                                    └─ eSpeak NG / FFmpeg (as before)    priority queue → K model instances
```

- **Model service** (`services/vieneu`): its own process or container on the internal network. Preset voices only, token on every call, bounded queue and text, drops queued requests when the client disconnects, never logs text. Not a workspace package; its sources are excluded from the application image.
- **Engine adapter** (`packages/core/src/engine/vieneu.ts`): registered only when `VIENEU_SERVICE_URLS` is set; optional (if the service is down the application stays ready and AI jobs fail with a clear error; **no fallback to another engine**); splits long text at sentence boundaries; forwards the job's priority; speed and pitch are audio-processing controls (`tempo`, `pitchShiftSemitones`), not engine controls.
- **Disclosure**: `usesAi` on engines and voices; "AI" badge in the voice lists, the Inspector, the profile; engine recorded per render.
- **Admission**: ships `unverified`; `VIENEU_APPROVED=true` is the operator's admission decision; the compliance audit checks that the service URL is internal, the token is set, the ADR exists and that the application image excludes the service.
- **Output is not reproducible bit for bit** across runs. The render cache keeps the first result, so re-renders of unchanged content are identical and free.

## 2. Plans and priority

| Plan     | Queue priority | Pending jobs | AI characters per month |
| -------- | -------------- | ------------ | ----------------------- |
| free     | 0              | 5            | 20,000                  |
| pro      | 10             | 15           | 500,000                 |
| business | 20             | 20           | unlimited               |

Defaults live in `packages/core/src/plans.ts` and can be overridden with `PLAN_LIMITS_JSON`. An administrator assigns the plan (`PATCH /api/v1/admin/workspaces/:id/plan`, Settings → administrator panel). **There is no payment or billing integration.** A plan change applies to jobs created afterwards.

**Scheduling.** A worker claims the queued job with the highest score: `priority + floor(seconds waited / QUEUE_AGING_SECONDS) + 5 for single-segment jobs (previews)`. The model service orders its own queue the same way, using the priority the job carries. Consequences with the default 30 s aging:

- a paid job goes before a free job that arrived at the same time or earlier;
- a preview goes before a long render of the same plan;
- a free job that has waited 5 minutes is as urgent as a new `pro` job and after 10 minutes as a new `business` job, so nobody waits forever.

**Allowance.** AI characters are counted per workspace and UTC month, only for audio that is really generated (a cache hit costs nothing). A request that would exceed the allowance is refused up front with `QUOTA_EXCEEDED` (HTTP 402) and queues nothing; the non-AI voices are never limited by it. To make AI a paid-only feature set `{"free":{"aiMonthlyChars":0}}`.

## 3. Measurements (laptop, Intel i5-12450HX, 12 logical CPUs, 17 GB RAM; model fp32 on CPU)

| Measure                                                                                                                               | Result                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory per model instance                                                                                                             | 1.1 GB after loading, 1.4 GB peak while synthesizing                                                                                                                                                                                                                |
| Load time                                                                                                                             | 11–15 s (weights cached); 57 s the first time (includes the download)                                                                                                                                                                                               |
| One stream, 2 CPU threads                                                                                                             | real-time factor **0.91** (1 s of speech takes 0.91 s)                                                                                                                                                                                                              |
| One stream, 4 CPU threads                                                                                                             | real-time factor **0.48**                                                                                                                                                                                                                                           |
| Preview of a short sentence (1.2 s of speech)                                                                                         | about 0.5 to 2 s (2.2 s for the first request)                                                                                                                                                                                                                      |
| 10 jobs (2 long "blocker" jobs holding both workers, then 4 free + 4 pro submitted together, free first) — **1 instance × 4 threads** | 318 s of audio in 129 s: **2.47 audio-seconds per second**. The 4 pro jobs finished at 74–94 s (queue wait 53–73 s); the 4 free jobs at 109–129 s (queue wait 88–107 s). **Every pro job finished before every free job**, although free users pressed render first |
| Same test — **2 instances × 3 threads**                                                                                               | 317 s of audio in 109 s: **2.90 audio-seconds per second** (only +17%: the machine, the database, FFmpeg and the test client share the same CPUs). Pro 62–82 s, free 90–109 s                                                                                       |
| Speech density                                                                                                                        | about 14 characters per second of speech (17 characters → 1.1 s)                                                                                                                                                                                                    |
| Quality of the audio                                                                                                                  | **not evaluated by a listener** (see 05-QUALITY-REPORT); the checks are signal sanity, format and tests                                                                                                                                                             |

## 4. Sizing

Rule of thumb: one instance running 4 threads produced about 2.5 audio-seconds per second on this laptop, i.e. about **120,000 characters per hour of continuous load**. Plan for roughly a third of that as sustained load: **about 1 million characters a day (30 million a month) per instance**. Waiting time for a request is roughly _audio seconds queued ahead ÷ throughput_.

| Class                    | Hardware (assumption) | Layout                                                                     | Estimated throughput                           | Status                                                               |
| ------------------------ | --------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Minimum                  | 4 vCPU, 8 GB RAM      | PostgreSQL + API + worker + 1 instance × 3 threads, `WORKER_CONCURRENCY=2` | about 1.5 audio-s/s                            | **estimate**, not measured on a VPS                                  |
| Standard                 | 8 vCPU, 16 GB RAM     | 2 instances × 3 threads, `WORKER_CONCURRENCY=3`                            | about 3 audio-s/s (2.9 measured on the laptop) | partly measured                                                      |
| Larger                   | 16 vCPU, 32 GB RAM    | 4 instances × 3 threads, `WORKER_CONCURRENCY=5`                            | about 5–6 audio-s/s                            | **estimate**, scaling beyond 2 instances not measured                |
| Small VPS (2 vCPU, 4 GB) | —                     | 1 instance × 2 threads (RTF about 0.9), free plan AI quota 0 (paid only)   | about 1 audio-s/s                              | **estimate**; memory 1.4 GB + 1 GB application + PostgreSQL is tight |

Rules: instances × threads should not exceed the **physical** cores left after the application; each instance needs about 2 GB of RAM in practice; `WORKER_CONCURRENCY` = instances + 1 so that non-AI jobs still run while the model is busy. A separate machine for the model service works (private network, token) and lets the application server stay small.

Example (Minimum class): ten paid users each ask for one minute of speech (about 840 characters) at the same instant: 600 s of audio at 1.5 audio-s/s means the last one waits about 400 s and the average about 200 s; free users queue behind them. Previews of a sentence stay at a few seconds. Raise capacity before promising such peaks.

Disk: 22.05 kHz mono WAV is about 2.6 MB per minute (MP3 128 kbit/s about 1 MB per minute); retention of previews is 24 hours.

**"No extra cost" holds only if the existing VPS already meets the class you need.** If it has fewer than 4 vCPU or 8 GB RAM, either keep AI for paid plans on the small layout above or move the model service to a larger machine.

## 5. Operating it

1. Start the service (`services/vieneu/README.md`), set `VIENEU_SERVICE_URLS`, `VIENEU_SERVICE_TOKEN`, `VIENEU_APPROVED=true` in the API and worker, restart them. The API picks up an AI service that starts later within 30 s.
2. `node scripts/qa-vieneu.mjs` writes the automated QA report that makes the voices selectable (re-run after upgrading the model package). A native speaker should still listen: the report cannot judge naturalness.
3. Watch `GET /v1/health` of the service (`busy`, `queued`), the render queue (Settings → administrator panel) and AI usage per workspace.
4. Measure your own hardware before launch: `node scripts/perf-ai.mjs --free 4 --pro 4 --blockers 2` (real model, real queue) and `node services/vieneu/test-service.mjs`.

## 6. Verified and not verified

Verified: the service protocol and limits (13 checks against the real model), the adapter and plans against a stand-in service (9 integration tests), plan priority and aging in the database queue, quota metering, optional-engine readiness, the compliance checks, and the full path with the real model and a real browser (preview, render, WAV/MP3 export, reopen, re-render: `qa-functional --voice vieneu:ngoc-huyen` 24/24, Playwright AI test).

Not verified: Docker image and compose profile (never built), any VPS, more than 2 instances, sustained load or memory over time, `int8` quality, billing, whether the voices sound natural or pronounce correctly, and the claims in the model card (Apache-2.0 for generated audio, consent of the preset speakers), which are the author's statements.

## 7. Choosing region and gender (2026-10-31)

The AI engine offers six preset voices: Northern (Ngọc Huyền female, Hải Đăng male), Central (Ngọc Trân female, Quang Sơn male), Southern (Thùy Dung female, Adam male). Region and gender are the model provider's description of each preset and **have not been verified by a listener**.

- New project dialog: "Regional accent" and "Voice gender" narrow the voice list; only combinations that exist are offered.
- Studio Inspector (also in Simple mode): the same two choices switch to the matching voice. Changing between engines (for example rule-based → AI) is announced with a notice, and settings the new voice lacks are reset and listed.
- Voices page: gender filter next to the engine, accent and level filters. Voice labels show region, gender and the preset name.
- Rule-based voices state no gender (their "male/female" is a parameter set, not a person), so the gender choice appears only where voices have one.
- Listening pack for all six voices: `node benchmark/vi/run-ai-voices-pack.mjs` → `qa-output/ai-voices-pack/` (42 files, ratings blank).
