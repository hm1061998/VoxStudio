# 12 — Development Roadmap (Continuous Execution)

## Execution model

Milestones are verification checkpoints, not stop conditions. The coding agent must keep working across milestones until all release acceptance criteria pass. At each checkpoint, update status and continue automatically unless blocked by a genuine external dependency or an explicit user decision.

## Milestone 0 — Repository reconnaissance and plan

- Inspect repo and existing conventions.
- Create task board from acceptance criteria.
- Verify candidate engine synthesis method and licenses.
- Verify DSP library license and platform support.
- Record ADRs and dependency inventory.
  **Exit:** implementation plan, risks, and compliant dependency set recorded.

## Milestone 1 — Running foundation

- Monorepo/workspaces and TypeScript strict config.
- React web, NestJS API, worker app.
- PostgreSQL migrations, Redis/BullMQ.
- Docker Compose dev environment.
- Health checks and structured logging.
  **Exit:** clean startup and basic authenticated API/UI.

## Milestone 2 — Real TTS vertical slice

- Integrate approved deterministic engine.
- Add engine registry and voice manifest.
- Implement preview endpoint and worker.
- Generate actual WAV and play/download it.
  **Exit:** end-to-end text-to-audio with no mock data.

## Milestone 3 — Projects and segment editor

- Project CRUD and persistence.
- Segment create/edit/split/merge/reorder.
- Autosave and optimistic concurrency.
- Per-segment engine/voice/settings.
  **Exit:** reopen and continue editing project.

## Milestone 4 — Voice controls and pronunciation

- Capability model.
- Native speed/pitch/volume mappings.
- Locale normalization.
- Pronunciation dictionary.
- Preset management.
  **Exit:** tested parameter effects and deterministic pronunciation override.

## Milestone 5 — DSP and assembly

- Canonical audio format.
- Time stretch/pitch shift/gain/filters.
- Silence and segment assembly.
- Validation and cache.
  **Exit:** valid full-project WAV with tested DSP.

## Milestone 6 — Studio UI

- Full dashboard and editor shell.
- Voice inspector.
- Audio player and waveform.
- Timeline and render queue.
- Responsive and accessible behavior.
  **Exit:** usable studio UI with real backend behavior.

## Milestone 7 — Export and reliability

- WAV/MP3 profiles.
- Job retry/cancel/recovery.
- Asset retention and cleanup.
- Version history.
  **Exit:** stable long-project render and download.

## Milestone 8 — Multilingual verification

- Add candidate locales only after engine evidence.
- Build corpus and regression suite.
- Native/qualified language review.
- Mark voice support tiers.
  **Exit:** release catalog reflects tested combinations.

## Milestone 9 — Security and production deployment

- Threat review and dependency audit.
- Docker hardening, TLS, backup/restore.
- Observability and resource limits.
- Production smoke tests.
  **Exit:** clean self-hosted deployment passes release gate.

## Continuous loop after each milestone

1. Run full regression suite.
2. Inspect failures and logs.
3. Fix defects.
4. Review UI against spec.
5. Verify real audio output.
6. Update docs and status.
7. Select next incomplete acceptance criterion.
8. Continue.

## Prioritization

P0 correctness and end-to-end synthesis first; P1 studio productivity second; P2 breadth and convenience last. Never add more locales or visual polish while the core render pipeline is unreliable.
