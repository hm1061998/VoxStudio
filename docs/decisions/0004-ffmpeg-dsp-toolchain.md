# 0004 — FFmpeg (with Rubber Band) as DSP toolchain; prohibited-filter gate

- Status: accepted
- Date/owner: 2026-10-31, VoxStudio coding agent

## Context

Docs 08 require deterministic DSP: time stretch, pitch shift, EQ, dynamics, encoding, decode validation. Many distro and "full" FFmpeg builds compile in `libflite` (a TTS engine whose voices include statistical/clustergen models) and `whisper` (neural ASR). Their presence in the runtime image violates the strict non-AI policy even if unused.

## Decision

- Use FFmpeg for decode/encode/filters with an explicit **filter allowlist** in code: `aformat, aresample, atempo, rubberband, highpass, equalizer, bass, treble, acompressor, volume, afade, anull`.
- Use the `rubberband` filter (Rubber Band Library, GPL-2.0-or-later, phase-vocoder DSP, no ML) for pitch shift independent of duration; `atempo` (FFmpeg native WSOLA-style) for time stretch.
- The worker's startup compliance check runs `ffmpeg -filters` and **refuses to start** if `flite` or `whisper` filters are present.
- Dev: gyan.dev "essentials" build 9.0.1 (no flite/whisper). Docker: FFmpeg built from pinned source with only `libmp3lame`, `libvorbis`, `librubberband` enabled.
- Encoding: WAV (PCM s16/s24), MP3 (libmp3lame, LGPL-2.0; MP3 patents expired), OGG Vorbis (BSD-3).

## Consequences

FFmpeg GPL build → we provide source offer for the image. Clipping protection is done in our own code (float pipeline + measured peak + deterministic headroom scaling), not by hidden limiter behaviour.
