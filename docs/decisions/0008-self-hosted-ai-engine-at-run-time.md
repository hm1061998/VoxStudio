# 0008 — Self-hosted AI speech engine at run time (opt-in, isolated)

- Status: accepted (owner decision, 2026-10-31)
- Date/owner: 2026-10-31, product owner; recorded by the VoxStudio coding agent
- Amends ADR 0007: the "no AI at run time" clause now has one exception, defined below

## Context

ADR 0007 allowed AI-generated audio as development-time source data. Listening to the resulting unit-selection voice (`vnunit`, built from isolated AI-generated syllables) the owner found it choppy ("vấp"): joining single syllables cannot give sentence-level fluency. The only approach the owner considers acceptable for natural speech is to let a model speak whole sentences. The owner will host the model on their own VPS; there must be no per-use external fee.

## Decision

1. A neural TTS model (initially **VieNeu-TTS v3 Turbo**, Apache-2.0, CPU/ONNX) may run **at run time on the operator's own infrastructure**, as an engine adapter named `vieneu`, under these conditions:
   - It runs in a **separate model service** (own process or container, internal network only, shared-secret token). It is **not** a dependency of the API, worker, web client or `packages/*`, and no model weights or ML runtime enter those images.
   - **No external or paid API**: the service calls nothing outside the operator's host after the weights are downloaded.
   - **Opt-in**: the engine is registered only when `VIENEU_SERVICE_URLS` is configured; it ships `unverified` and is disabled until an administrator approves it. The application is fully functional without it.
   - **eSpeak NG (non-AI) stays the default** voice for new projects. There is **no silent fallback** in either direction: an AI voice that is unavailable fails with a clear error; it never becomes eSpeak, and eSpeak never becomes AI.
   - **Preset voices only**: the service exposes an operator-configured allowlist of preset voices. No reference-audio upload, no voice cloning endpoint.
   - **Disclosure**: engine metadata carries `usesAi: true`; the UI labels every such voice "AI", and docs/licence notices say so.
   - Per-request limits: text length, timeout, cancellation when the client disconnects.
2. The strict non-AI guarantee remains for the engines `espeak` and `vnunit`: no model, ML runtime or AI call. The compliance audit distinguishes the two classes (AI engines must declare `usesAi`, a licence and an admission record; non-AI engines must not).
3. **Capacity and fairness** are handled by plans (`free`, `pro`, `business`): job priority with aging so lower tiers are not starved, per-plan limits on pending jobs and monthly AI characters, and a priority queue inside the model service (the shared scarce resource). Payment/billing is **out of scope**: an administrator sets a workspace's plan.
4. Model output is not bit-reproducible across runs. The content-addressed render cache keeps the first result for identical inputs, so re-renders are stable; a changed model version changes the cache key.

## Alternatives

Keep ADR 0007 only (choppy); AI at development time with whole pre-generated sentences (works only for known text; kept as a possible later feature); a paid cloud TTS (explicitly rejected: cost and self-hosting).

## Consequences

- Needs RAM and CPU: about 1.4 GB per model instance and RTF 0.5–0.9 on 4–2 threads of a laptop CPU (measured); see `docs/upgrade/09-AI-ENGINE-CAPACITY.md`.
- The application is no longer "non-AI" as a whole. README, UI text, third-party notices and the compliance audit are updated accordingly.
- Misuse risk (impersonation) is limited by preset-only voices and the operator's configuration; the operator remains responsible for the text submitted.

## Security/license/performance impact

Model service is reachable only on the internal network and requires a token; text sent to it is not logged. Licences: VieNeu-TTS v3 Turbo Apache-2.0 (code and weights per its model card; training-data terms undisclosed by the author); its preset-voice consent statement is the author's and unverified here.
