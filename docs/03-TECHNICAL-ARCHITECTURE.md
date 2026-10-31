# 03 — Technical Architecture

## 1. Architecture style

Use a modular monolith for business APIs and separate worker process(es) for CPU-intensive synthesis/DSP. Deploy all components self-hosted. Avoid microservices until measurable scaling or isolation needs justify them.

## 2. Suggested stack

- Web: React, TypeScript, Vite.
- UI: Tailwind CSS and accessible component primitives.
- Client state: Zustand for local studio state; TanStack Query for server state.
- Audio: Web Audio API for playback; WaveSurfer.js for waveform display.
- API: NestJS, TypeScript.
- Persistence: PostgreSQL with Prisma or TypeORM (choose one; do not mix).
- Queue: Redis + BullMQ.
- Worker: Node orchestration invoking isolated, pinned CLI tools.
- Speech: approved strict non-AI engine; eSpeak NG initial candidate.
- DSP: FFmpeg and optional Rubber Band after license/platform review.
- Storage: local volume for single-node deployment; S3-compatible MinIO for scalable self-hosted storage.
- Reverse proxy: Nginx or Caddy.
- Observability: structured logs, health checks, metrics, error tracking self-hosted if possible.

Verify current versions, maintenance, security advisories, platform compatibility, and license before pinning dependencies.

## 3. Logical components

### Web client

Project editor, voice inspector, timeline, waveform, job status, export UI.

### API

Auth, workspaces, projects, segments, voice catalog, presets, pronunciation dictionary, jobs, assets.

### Engine registry

Approved engine adapters and capability metadata.

### Render orchestrator

Builds immutable render plans, calculates cache keys, queues work.

### Worker

Runs text normalization, engine synthesis, DSP, assembly, validation, storage.

### Database

Metadata, project state, jobs, asset references, versions.

### Object storage

Generated WAV intermediates and final assets, with retention policy.

## 4. Engine adapter contract

```ts
export interface TtsEngineAdapter {
  readonly engineId: string;
  getMetadata(): Promise<EngineMetadata>;
  listVoices(locale?: string): Promise<VoiceMetadata[]>;
  getCapabilities(voiceId: string): Promise<VoiceCapabilities>;
  synthesize(input: SynthesisInput, context: EngineContext): Promise<EngineAudioOutput>;
  healthCheck(): Promise<EngineHealth>;
}
```

`EngineAudioOutput` must describe file path/stream, codec, sample rate, channels, duration, and engine metadata. Adapters must not return an untyped buffer without metadata.

## 5. Capability model

Each voice advertises supported parameters:

- native: directly mapped to engine options;
- dsp: implemented by post-processing;
- unsupported: rejected or disabled.
  Capability metadata includes min/max/default/step, units, and notes. Server is authoritative.

## 6. Render plan

A render plan is immutable and contains:

- project and segment revision IDs;
- normalized text and locale;
- engine ID/version and voice package version;
- synthesis parameters;
- pronunciation dictionary revision;
- DSP chain and version;
- output format/profile;
- cache key.
  A change to any synthesis-affecting field invalidates the relevant segment asset.

## 7. Security boundaries

- API never accepts arbitrary executable paths or shell fragments.
- Spawn subprocesses with argument arrays and fixed executable allowlists.
- Run workers as non-root with CPU, memory, process, and time limits.
- Restrict worker filesystem access to per-job temp directories.
- Validate file paths and never trust client-provided storage keys.
- Apply authorization to every resource lookup.
- Rate-limit preview and render endpoints.
- Restrict CORS and configure secure cookies.
- Do not log full user text or audio.
- Keep internal worker network access minimal.

## 8. Data flow

1. Client saves project and segment settings.
2. API validates and persists changes.
3. Client requests preview/render.
4. API creates job and immutable render plan.
5. Queue dispatches job to worker.
6. Worker normalizes text and invokes selected adapter.
7. Worker applies DSP, assembles, validates, and stores output.
8. Worker updates job/asset records.
9. Client receives progress through SSE or WebSocket.
10. Client requests authorized asset playback/download.

## 9. Caching

Cache key must include normalized text, locale, engine binary/version, voice package/version, all synthesis parameters, pronunciation revision, DSP implementation/version/settings, and output profile. Do not reuse cache across different license or voice-package versions without explicit compatibility.

## 10. Repository layout

```text
apps/
  web/
  api/
  worker/
packages/
  contracts/
  config/
  validation/
  ui/
services/
  tts-engines/
    espeak/
  audio/
  text-normalization/
  rendering/
infra/
  docker/
  nginx/
docs/
  decisions/
```

## 11. ADR template

Create `docs/decisions/NNNN-title.md`:

- Status: proposed/accepted/rejected/superseded
- Context
- Decision
- Alternatives
- Consequences
- Security/license/performance impact
- Date and owner

## 12. Operational health

Expose liveness/readiness endpoints. Readiness checks database, Redis, storage, and approved engine executables. Worker startup should fail clearly if a required executable is missing or version is unsupported.
