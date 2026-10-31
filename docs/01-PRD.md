# 01 — Product Requirements Document

## 1. Summary

VoxStudio is a self-hosted, multilingual web application for creating speech from text with strict non-AI synthesis and conventional DSP.

## 2. Goals

- Deliver a complete browser-based studio.
- Support multiple languages through verified engine/voice packages.
- Offer segment-level control and deterministic presets.
- Produce previewable and downloadable WAV/MP3 (OGG optional after validation).
- Keep all processing under operator control.
- Make the architecture extensible without relaxing the non-AI policy.

## 3. Non-goals

No neural TTS, statistical/ML speech synthesis, LLM generation, cloning, external speech API, or claims of human-level expressive performance.

## 4. Personas

### Creator

Needs quick narration, presets, preview, and export.

### Educator

Needs accurate pronunciation, repeatable output, and segment-level pacing.

### Studio operator

Needs reliable queue processing, storage controls, auditability, and deployment tools.

## 5. User stories

- As a user, I can create and rename a project.
- I can choose a locale and see only compatible, approved voices.
- I can enter text and split it into editable segments.
- I can configure voice and synthesis settings per segment.
- I can add pauses and pronunciation overrides.
- I can preview one segment without rendering the whole project.
- I can render the complete project and see progress.
- I can retry failed jobs without duplicating assets.
- I can export a valid audio file in a selected format.
- I can reopen a project and continue editing.
- I can inspect engine limitations before applying unsupported settings.
- As an administrator, I can enable/disable approved engines and voice packages.

## 6. Product requirements

### P0 — release blockers

- Authentication and ownership authorization.
- Project CRUD and autosave.
- Text editor with segment ordering.
- Engine/voice registry.
- One compliant deterministic TTS engine integrated end-to-end.
- Preview and project render.
- Basic speed/pitch/volume controls with truthful capability mapping.
- Background job processing and progress.
- WAV export; MP3 export if encoder is available and license reviewed.
- Persistent assets and project settings.
- Docker Compose deployment.
- Automated tests and strict non-AI dependency audit.

### P1 — full studio

- Multiple approved engines.
- Locale-aware normalization and pronunciation dictionary.
- Style presets and automation rules.
- Waveform and multi-segment timeline.
- DSP chain with preview.
- Render cache and partial rerender.
- Project version history.
- Export profiles and metadata.
- Admin capability management.

### P2 — expansion

- More verified locales and voice packages.
- Batch project export.
- Import DOCX/HTML/SRT where robust.
- Advanced audio editing (fade, trim, gain envelope).
- Workspace sharing and roles.
- Usage quotas and SaaS billing only if later requested.

## 7. Quality requirements

- No external TTS service required.
- Clear errors for unsupported language/voice/parameter.
- Never silently substitute a voice or engine.
- Text and audio are private to the owning workspace.
- Long renders do not block API request threads.
- UI remains usable on desktop and tablet.
- All user text is treated as untrusted input.
- Render output records synthesis engine/version and DSP configuration.

## 8. MVP/full-release language policy

The product is architected for all locales, but the release catalog must be evidence-based. Initial release must include only locales whose complete pipeline passes pronunciation, intelligibility, and regression checks. “All languages” is a long-term coverage objective, not a promise that every language has a high-quality voice on day one.

## 9. Risks and mitigations

- Engine language coverage varies → capability registry and per-locale QA.
- Strict non-AI narrows engine options → approve only deterministic rule-based engines.
- DSP can introduce artifacts → bounded controls, preview, regression fixtures.
- License restrictions → per-component license inventory and release gate.
- Browser audio differences → server-generated canonical export; browser playback is for preview.
