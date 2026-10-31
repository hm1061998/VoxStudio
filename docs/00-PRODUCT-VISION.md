# 00 — Product Vision

## Product

**Name:** VoxStudio (working name)  
**Tagline:** Your Text. Your Voice. Your Control.  
**Category:** Self-hosted multilingual non-AI text-to-speech production studio.

## Vision

Give creators precise control over how text is converted into speech using deterministic, non-AI synthesis engines and conventional digital signal processing (DSP). VoxStudio is a production workspace, not merely a text-to-MP3 form.

## Product principles

1. **Strict non-AI:** synthesis must not rely on neural networks, statistical/ML speech models, LLMs, voice cloning, or generative audio.
2. **Self-hosted:** application, synthesis, processing, database, queue, and storage can run on infrastructure controlled by the operator.
3. **Control over claims:** expose only controls actually supported by an engine or deterministic DSP stage.
4. **Honest quality:** do not market synthesized output as indistinguishable from a human performance.
5. **Multilingual architecture:** language and voice capability is discovered, tested, versioned, and reported per engine.
6. **Non-destructive editing:** preserve source text and settings; render outputs as versioned assets.
7. **Reproducibility:** persist engine and DSP versions and full render configuration.

## Target users

- Video and social-content creators.
- Educators and e-learning producers.
- Audiobook and narration creators.
- Product documentation and tutorial authors.
- Localization and language-learning workflows.
- Internal teams creating announcements and instructional audio.

## Core user journey

Create workspace → create project → choose locale and voice → enter/import text → split into segments → configure voice and pronunciation → preview → edit → render project → inspect timeline → export audio.

## Product boundaries

### In scope

- Text-to-speech with approved deterministic engines.
- Segment-level voice and synthesis settings.
- Pronunciation dictionary and text normalization.
- Deterministic style presets.
- Audio preview, waveform, assembly, and export.
- Project persistence and render history.
- Self-hosted deployment and administration.

### Out of scope

- Neural or statistical/ML TTS.
- Voice cloning or speaker imitation.
- Generative music, sound effects, or ambient audio.
- AI emotion recognition or AI-directed acting.
- Cloud TTS dependency.
- Real-time collaborative editing in initial release.
- Mobile-native applications.

## Strict non-AI interpretation

“Strict” means no learned or statistical speech-generation model, including statistical parametric synthesis. Rule-based synthesis, deterministic phoneme/grapheme conversion, formant synthesis, concatenative synthesis using properly licensed fixed recordings, and conventional DSP may be considered. Each engine and voice package requires review before approval. A library being open source does not automatically make its synthesis method compliant.

## Product success measures

- A user can complete the full text-to-export workflow without manual server intervention.
- Every advertised voice/locale combination has a passing test record.
- No unapproved speech-generation dependency or outbound speech API exists.
- Render jobs are recoverable and observable.
- Re-rendering unchanged content reuses cache when safe.
- Users understand which controls are engine-native versus DSP approximations.
