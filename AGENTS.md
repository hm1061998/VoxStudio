# VoxStudio — Agent Operating Contract

## Mission

Build VoxStudio into a working, self-hosted, multilingual web Voice Studio using **strict non-AI speech synthesis at run time** (see ADR 0007: AI may create voice data during development). Continue autonomously through implementation, testing, debugging, and acceptance review until the application works end-to-end. Milestones are checkpoints, not stopping points.

## Non-negotiable product constraints

1. **No AI speech generation at run time.** The application must not call or embed neural TTS, LLM speech, voice-cloning, generative-audio, cloud speech-generation APIs, or learned speech-generation models. **Exception (ADR 0007):** audio produced by a locally run AI model during development may be used as source data for a concatenative unit database if its provenance, generator, version and license are declared in the dataset manifest, the generator license allows the use, no real person is cloned without consent, and the UI/docs disclose it. The generator is never part of the application. **Second exception (ADR 0008):** a neural TTS model may run at run time **only** as an opt-in engine in a separate, self-hosted model service (internal network, token, no external API, preset voices only, disabled until an administrator approves it, labelled "AI" in the UI, never a silent fallback to or from the non-AI engines). The `espeak` and `vnunit` engines remain strictly non-AI. **ADR 0009:** the AI engine is the product default and the rule-based engines are opt-in through `ENABLED_ENGINES`.
2. **Strict non-AI at run time means no statistical/ML speech synthesis either.** Use deterministic, rule-based/concatenative/formant/rule-driven engines only, subject to documented review. eSpeak NG is the initial engine candidate. Any additional engine must pass the engine-admission checklist in `docs/07-TTS-ENGINE-SPECIFICATION.md`.
3. DSP is allowed: deterministic signal processing such as filtering, time-domain processing, resampling, time-stretching, pitch-shifting, dynamics, silence insertion, mixing, and encoding.
4. Self-host all application services and speech engines. No mandatory external runtime APIs.
5. Do not claim that DSP creates human-like emotional acting. Presets are deterministic parameter bundles.
6. Never ship fake controls, mocked audio presented as real synthesis, placeholder success states, or unimplemented export actions.
7. Respect all engine, voice, and DSP-library licenses. Do not redistribute voice data unless its license permits it.

## Required working loop

For every task:

1. Read the relevant product and technical docs.
2. Inspect the existing repository before changing it.
3. Identify the smallest end-to-end vertical slice.
4. Implement production behavior, not visual-only placeholders.
5. Add/update unit, integration, and E2E tests.
6. Run formatter, lint, typecheck, tests, build, and relevant audio smoke tests.
7. Launch the application and verify the user journey in a real browser when browser tooling is available.
8. Inspect logs, network errors, console errors, audio output, and persisted data.
9. Fix failures and repeat. Do not stop at the first failing test.
10. Update docs, task status, and known limitations.
11. Continue to the next highest-priority incomplete acceptance criterion.

A task is complete only when its acceptance criteria pass and the relevant tests have been run. If an external blocker genuinely prevents progress, document the exact blocker, evidence, workaround attempted, and next action; continue with independent work.

## Engineering standards

- TypeScript strict mode; avoid `any`. Validate all untrusted input at API boundaries.
- Prefer modular monolith architecture with isolated worker processes for CPU-heavy audio jobs.
- Keep engine adapters behind a stable interface. UI must not know engine-specific command syntax.
- Keep all generated files outside source-controlled directories unless intentionally committed as fixtures.
- Use parameterized database access through the selected ORM.
- Use migrations; never rely on production schema synchronization.
- Make render jobs idempotent where practical. Use deterministic cache keys that include text, locale, engine/version, voice, synthesis parameters, DSP chain/version, and output format.
- Store project configuration separately from transient job state.
- Use structured logs with correlation/job IDs. Never log full user text or audio contents by default.
- Enforce per-user authorization on every project, asset, and job operation.
- Use safe temporary directories, argument arrays (not shell interpolation), file-size limits, timeouts, and cleanup for subprocesses.
- Do not silently fall back to another engine or voice. Explain unsupported controls and engine changes to the user.
- Accessibility: keyboard operation, visible focus, labels, and sufficient contrast.
- Responsive target: desktop-first studio, usable tablet layout.

## Definition of done

- App starts from documented commands and Docker Compose.
- Database migrations run on a clean database.
- User can create a project, enter text, choose a supported voice, synthesize real audio, preview, edit segment settings, render a project, and download a valid output file.
- Strict non-AI policy is demonstrably enforced in dependencies, code, configuration, and documentation.
- Tests cover engine invocation, parameter mapping, DSP, authorization, rendering, and export.
- No critical console, API, worker, or build errors remain.
- README and docs match actual implementation.

## Decision process

- Record material architecture decisions in `docs/decisions/` using the ADR template in `docs/03-TECHNICAL-ARCHITECTURE.md`.
- When a requested feature conflicts with strict non-AI or self-hosting constraints, do not implement the conflicting approach. Propose a compliant alternative. (The development-time data exception in ADR 0007 is not a conflict.)
- Prefer proven, maintained libraries. Verify license and platform compatibility before adoption.
- Do not invent language/voice coverage. Derive the visible catalog from installed and tested engine capabilities.
