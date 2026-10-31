# 04 — Engine Decision

Status: **recommendation only; no migration started.** Evidence: primary sources read on 2026-10-31 (GitHub repositories and project pages, listed per row) and the measurements in `03-VIETNAMESE-BENCHMARK.md`. Items marked _unverified_ could not be confirmed from a source read in this session.

## Classification

### A. Fully compliant (method verified), usable now

| Candidate                       | Method                                                                                                                               | Vietnamese                                                              | Notes                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **eSpeak NG 1.52.0** (baseline) | Rule-based formant synthesis, hand-written letter-to-sound rules (`vi_rules`, 1,330 lines; `vi_list`, 148 lines, per the repository) | Yes: Northern `vi`, Central `vi-vn-x-central`, Southern `vi-vn-x-south` | Deterministic; GPL-3.0-or-later; already integrated. Intelligible, robotic. Only `sắc` is a clear pitch rise in the Northern voice (see 03). |

### B. Technically promising, but **no usable Vietnamese voice data**

| Candidate                                    | Why promising                                                                                               | Why not usable                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MBROLA** (synthesizer)                     | Diphone concatenation, no statistical model mentioned in its README; AGPL-3.0 (github.com/numediart/MBROLA) | The official voice repository has **no Vietnamese voice** (directory listing: af1…vz1, no `vn*`). Voice licenses require MBROLA-only use and prohibit sale or inclusion in sold products without the author's permission (`MBROLA-voices/LICENSE.md`). Also needs a front-end that supplies phonemes, durations and pitch; it is not a TTS. |
| **Festvox diphone / unit-selection tooling** | Documents building diphone and unit-selection databases (github.com/festvox/festvox)                        | No Vietnamese voice or front-end found; the same toolkit also contains statistical and neural methods (excluded).                                                                                                                                                                                                                           |
| **MaryTTS**                                  | LGPL-3.0 engine                                                                                             | No Vietnamese language module (directory listing: de, en, fr, it, lb, ru, sv, te, tr); its documented default voice is HSMM (statistical).                                                                                                                                                                                                  |

### C. Requires further investigation

| Candidate                                                                                                           | Open questions                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VOS** (Voice of Southern Vietnam; unit selection, syllable units, ~6,596 distinguishable syllables per the paper) | Source or binary availability and license not found (only a Langrid catalog entry and the paper). Southern only.                                                                                                                                                                                        |
| **vPhon** (rule-based Vietnamese G2P to IPA for Northern/Central/Southern; GPL-3.0 per the repository sidebar)      | Front-end only, not a synthesizer. Is its design fully rule-based (inferred from `rules.py`, not stated)? Useful as a reference front-end for a custom engine. LICENSE text not read.                                                                                                                   |
| **FPT Open Speech Dataset (FOSD)** (~30 h, 25,921 utterances, aligned transcripts)                                  | The record shows **two conflicting licenses** (field says CC BY 4.0; description contains an MIT-style "FPT Public License"). Speaker count, dialects and recording quality are not stated; files are mp3; it is general-purpose, not studio TTS data. Needs the original FPT release and legal review. |
| **Common Voice (vi)**, **VIVOS**                                                                                    | Pages could not be read (JavaScript page; DNS failure). License, hours and quality _unverified_. Crowd-sourced/ASR corpora are unlikely to suit concatenative synthesis.                                                                                                                                |

### D. Non-compliant (excluded)

| Candidate                                                                                     | Reason (source)                                                                                             |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **RHVoice**, including the Southern "Vi Vu" voice by LouderPages                              | "RHVoice uses statistical parametric synthesis… mainly HTS" (README). Also the voice license was not found. |
| **Festival CLUSTERGEN/HTS voices and Flite `cg` voices**                                      | Parametric (MLPG/MLSA, code derived from HTS).                                                              |
| **Festvox 2.9 neural features, Tacotron/VITS-style Vietnamese systems, cloud Vietnamese TTS** | Neural/learned; forbidden.                                                                                  |

## Decision

1. **No existing engine was found that is both strictly non-AI and has a Vietnamese voice better than eSpeak NG.** Only eSpeak NG qualifies today.
2. **Recommended approach: a custom deterministic Vietnamese concatenative engine**, added as a second engine behind the existing registry (UP-003, done):
   - Units: tonal syllables (or demisyllables/diphones) selected by deterministic cost functions; prosody and joins by TD-PSOLA/WSOLA as DSP.
   - Front-end: VoxStudio's normalization plus a rule-based G2P (vPhon-style rules after license review, or eSpeak's `vi` rules for phonemes).
   - eSpeak NG stays as the fallback and as the regression baseline.
3. **Gating item: licensed recorded speech.** Without it the engine cannot ship. The clean route is commissioning studio recordings (one Northern and one Southern speaker) under an explicit license that permits derivative synthesis and self-hosted redistribution. FOSD may supplement only after its license is resolved and its audio quality and speakers are inspected.
4. **Policy decision needed before data preparation:** aligning recordings to text is usually done with HMM-based forced aligners. That is an offline build-time use of a statistical model, not part of synthesis. Under a strict reading it must be avoided or explicitly approved; the alternative is deterministic alignment (known text, DTW against reference, manual correction), which is slower.
5. **Do not migrate yet.** Next steps, in order: (a) listening evaluation of eSpeak NG on the benchmark (human), (b) data license decision, (c) a small prototype: 1 speaker, tonal-syllable inventory, TD-PSOLA joins, evaluated on `vi-bench-1`.

## Unverified items to close before relying on this report

MBROLA's exact algorithm name (README says only "MBROLA method"); Festival's own license file; VOS availability; vPhon license text; FOSD original release terms; VIVOS and Common Voice details; whether any Vietnamese MBROLA database exists outside the official repository.
