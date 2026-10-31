# 09 — Testing Strategy

## 1. Test layers

### Unit

- DTO validation and capability mapping.
- Text segmentation and normalization.
- Pronunciation dictionary precedence.
- Preset resolution.
- Cache-key generation.
- DSP parameter validation.
- Project revision logic.

### Integration

- Database repositories and migrations.
- Engine adapter invokes pinned binary safely.
- WAV parsing and metadata validation.
- DSP chain output validation.
- Queue enqueue/retry/cancel behavior.
- Storage upload/download authorization.
- Render plan reproducibility.

### End-to-end

- Register/login.
- Create project.
- Enter text and create segments.
- Choose approved voice.
- Preview audio.
- Change settings and preview again.
- Render project.
- Observe progress.
- Download output.
- Reopen project and confirm settings/assets persist.

### Audio regression

Maintain fixed test text per approved locale. Compare:

- duration within tolerance;
- sample rate/channel/codec;
- non-empty signal;
- peak and clipping;
- silence boundaries;
- deterministic metadata;
- optional perceptual/manual review.
  Do not rely solely on byte-for-byte equality if encoder/toolchain behavior varies.

## 2. Strict non-AI compliance tests

- Dependency and container SBOM review.
- Search source/config for prohibited cloud TTS endpoints and SDKs.
- Network egress policy test for worker.
- Verify engine binary and voice package checksums.
- Review synthesis method and licenses.
- Fail CI if unapproved engine is enabled.
- No neural/ML model files in runtime image unless explicitly approved for a non-speech unrelated purpose (default policy: none).

## 3. Security tests

- Cross-user project/asset/job access denied.
- Path traversal and arbitrary file access blocked.
- Command injection payloads handled safely.
- Oversized text and request limits.
- Rate limits on preview/render.
- Cookie/CSRF/CORS checks.
- File download headers and authorization.
- Secrets not present in logs or images.

## 4. Performance tests

- Concurrent previews.
- Long project render.
- Queue backpressure.
- Worker restart during render.
- Redis unavailable and recovery.
- Storage unavailable and recovery.
- Memory use under long audio.
- API responsiveness during CPU-heavy work.

## 5. Browser tests

Use Playwright or equivalent. Test supported current browsers. Verify keyboard operation, responsive layout, audio playback, download, and no console/network errors.

## 6. Definition of test completion

A release candidate requires:

- all P0 tests passing;
- no open critical/high security defects;
- no unapproved engine;
- successful clean deployment from documented instructions;
- successful end-to-end audio export;
- manual review of every released locale/voice combination.
