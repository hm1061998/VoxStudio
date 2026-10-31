# 0002 — eSpeak NG engine admission (strict non-AI)

- Status: accepted (engine); voices gated individually by automated QA (see `config/voice-qa-report.json`)
- Date/owner: 2026-10-31, VoxStudio coding agent

## Context

Docs 07 require an admission checklist before enabling any engine.

## Evidence

| Checklist item                      | Result                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthesis method                    | Upstream README (github.com/espeak-ng/espeak-ng): "eSpeak NG uses a formant synthesis method". Optional Klatt formant synthesizer and MBROLA diphone back-end. Phoneme rules and dictionaries (`*_rules`, `*_list`) are hand-written rule files compiled into `espeak-ng-data`.                      |
| No statistical/ML/neural generation | Confirmed: source tree contains no model weights or learned acoustic models; synthesis is rule/formant based. MBROLA voices are **not installed and not allowed** (separate licenses; would need their own review).                                                                                  |
| Runtime dependencies                | Windows MSI ships `espeak-ng.exe`, `libespeak-ng.dll`, `espeak-ng-data`. Docker: Debian `espeak-ng` package (+ `libpcaudio`, `libsonic` — sonic is a deterministic speed-up DSP library, Apache-2.0).                                                                                                |
| Engine license                      | GPL-3.0-or-later (engine and data). Used as a separate executable via process spawn (aggregate, not linked). Redistribution of the binary in our container requires providing corresponding source / written offer — recorded in `THIRD_PARTY_NOTICES.md`. Commercial use permitted under GPL terms. |
| Pinned versions                     | 1.52.0. Worker refuses to start if `espeak-ng --version` does not match `ESPEAK_APPROVED_VERSION`.                                                                                                                                                                                                   |
| Determinism                         | `-D` (deterministic random mode) always passed. Two identical invocations produced byte-identical WAV (SHA-256 `c6cd82bd…0505` for the smoke phrase).                                                                                                                                                |
| Unicode/punctuation                 | Input passed via UTF-8 file (`-b 1 -f`), never via command-line argument. Tested in `packages/core` integration tests.                                                                                                                                                                               |
| Parameter mapping                   | `-s` rate (80–450 wpm), `-p` pitch (0–99), `-P` pitch range (0–99), `-g` word gap (10 ms units), `-v lang+variant`. Amplitude fixed at 100; volume is DSP gain with headroom protection.                                                                                                             |
| Locale corpus                       | `config/qa-corpus.json`; automated QA via `pnpm qa:voices`.                                                                                                                                                                                                                                          |
| Reviewer                            | Automated checks by agent. Native-speaker review **pending** — all voices shown as tier "experimental" until a human review is recorded.                                                                                                                                                             |

## Decision

Approve eSpeak NG 1.52.0 (formant back-end only). Expose only voices that are in `config/voice-allowlist.json` **and** discovered on the host **and** passed automated QA.

## Consequences

Robotic but intelligible, fully deterministic output. Quality claims in UI are limited to that.
