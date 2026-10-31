# 08 — Audio DSP Specification

## 1. Purpose

Provide deterministic post-processing and audio assembly around compliant TTS output. DSP must not be represented as generative speech or human emotion synthesis.

## 2. Canonical intermediate format

Use a documented internal format, e.g. PCM WAV, mono unless source/voice requires otherwise. Normalize sample format before combining segments. Preserve original engine output as an optional diagnostic asset according to retention policy.

## 3. Processing chain

1. Validate source audio.
2. Convert to canonical sample format.
3. Apply optional time stretch.
4. Apply optional pitch shift.
5. Apply EQ/filtering.
6. Apply gain/compression/limiting if enabled.
7. Insert exact pause samples.
8. Assemble segments in timeline order.
9. Apply optional fades/crossfades.
10. Loudness/peak validation.
11. Encode requested output.
12. Decode output again and validate.

Order must be versioned because changing order changes output.

## 4. DSP controls

### Time stretch

- Keep pitch constant.
- Bound supported ratio, initially conservative (e.g. 0.8–1.25).
- Warn about artifacts outside recommended range.

### Pitch shift

- Independent of duration.
- Use semitone or ratio internally with clear UI units.
- Bound range and preview changes.

### Gain

- Linear gain or dB; choose one canonical API representation.
- Prevent clipping with true-peak check/limiter.

### EQ

- Small set of fixed filters initially (high-pass, low shelf, presence, high shelf).
- Validate frequency and Q ranges.

### Dynamics

- Optional compressor and limiter with documented parameters.
- Avoid aggressive defaults.

### Silence and timing

- Store pause duration in milliseconds.
- Convert to exact sample count at target sample rate.

### Assembly

- Align sample rate/channel layout.
- Use deterministic ordering.
- Avoid clicks at joins; optional short fade only when configured.
- Preserve intended pauses.

## 5. Tooling

- FFmpeg for decode/encode, filters, concatenation, and format validation.
- Rubber Band only after license and deployment compatibility review.
- Web Audio API for browser playback and monitoring, not canonical server export.
- WaveSurfer.js for waveform visualization, not audio generation.

## 6. Quality safeguards

- Peak/clipping detection.
- Silence duration checks.
- Duration bounds.
- Decode output after encoding.
- Detect empty/corrupt files.
- Do not upsample and claim improved source quality.
- Warn that pitch/time processing can introduce artifacts.
- Keep source audio immutable; produce derived assets.

## 7. Reproducibility

Store DSP library/version, processing-chain version, parameters, sample rate, channels, and output codec with every asset. Include these values in cache keys.

## 8. Performance and safety

- Process in isolated worker with CPU/memory/time limits.
- Avoid loading unbounded audio into memory; stream/chunk where supported.
- Limit input text and output duration.
- Use per-job temp directories and cleanup.
- Never construct shell command strings from user values.
