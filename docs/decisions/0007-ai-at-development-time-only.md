# 0007 — AI may create voice data at development time; no AI at run time

- Status: accepted (owner decision, 2026-10-31)
- Date/owner: 2026-10-31, product owner; recorded by the VoxStudio coding agent
- Supersedes the strict reading of AGENTS.md constraints 1 and 2, and clarifies ADR 0005

## Context

The original constraint "strict non-AI speech synthesis" was read as covering the origin of all audio. The owner has clarified the intent: **the running application must not use AI to generate speech**; AI may be used **while developing** to create voice data. With eSpeak NG as the only engine the product sounds robotic, and no licensed human recordings are available (docs/upgrade/04, 06).

## Decision

1. **Run time (unchanged and still enforced):** no neural, statistical, learned or cloud speech generation, no model files or ML runtimes in the application, its dependencies, its Docker image or its configuration. Speech is produced only by rule-based, formant or concatenative engines and conventional DSP. Self-hosted; no runtime external API.
2. **Development time (new):** audio produced by an AI model may be used as **source data** for a concatenative unit database (`vnunit`), subject to the conditions below. The generator is a build tool; it is never part of the application.
3. **Conditions for AI-generated source data**
   - The generator runs **locally** (no cloud TTS: provider terms commonly forbid building synthesis datasets from output).
   - The generator's license must allow using its output to build and distribute a product; the license text, model name and version are recorded in the dataset manifest.
   - No voice of an identifiable real person is cloned without that person's documented consent.
   - The dataset manifest declares `provenance.kind = "ai-generated"` with `generator {name, version, license, localRun}`. Missing or incomplete provenance fails loading of an AI-generated database and the compliance audit.
   - The UI and docs must say that such a voice is assembled from audio generated with AI during development. It must never be described as "no AI" or as a human recording.
   - Generator tooling lives outside the application packages (no new dependency in any `package.json` of the application).
4. The engine-admission checklist (docs/07) still applies; the voice stays unverified until a native speaker has listened to it.

## Alternatives

Keep the strict reading (needs licensed human recordings that do not exist today); use a neural engine at run time (explicitly not wanted).

## Consequences

- The shipped product contains AI-generated audio in its unit database. Naturalness is bounded by cutting a model's output into syllables; it may be less fluent than the model itself and has not been listened to.
- Labels are exact because each unit can be generated on its own; no automatic alignment is needed.
- Documentation, UI strings and the compliance audit distinguish "AI inside the application" (forbidden) from "AI-generated data" (allowed, declared).

## Security/license/performance impact

Generator weights and training-data terms must be reviewed per model; they are not redistributed with the application. Run-time cost is unchanged (unit selection and PSOLA).
