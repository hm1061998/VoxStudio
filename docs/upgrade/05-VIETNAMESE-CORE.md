# 05 — Vietnamese Non-AI TTS Core (implementation)

Status (2026-10-31): the pipeline is implemented and tested end to end against a **test fixture** unit database. It is **not production-ready**: there are no licensed Vietnamese recordings, and no listening evaluation has been done. See ADR 0005.

## Pipeline and code map

```text
Text → normalization (text/normalize.ts, norm-3) → dictionary respelling (text/prepare.ts)
     → analysis: numbers, symbols, lexicon, acronyms, tokens, phrases      vi/text.ts, vi/numbers.ts
     → syllable parsing + tone + pronunciation (dialect profile)            vi/syllable.ts, vi/profiles.ts
     → prosody plan                                                          vi/prosody.ts
     → unit selection (Viterbi)                                              vi/select.ts, vi/unitdb.ts
     → TD-PSOLA prosody, smooth joins, trim, loudness                        audio/psola.ts, vi/synth.ts
     → engine adapter → existing DSP chain / assembly / export               vi/adapter.ts
```

## 1. Text normalization

Existing `norm-3` rules (dates, times, đồng, units, abbreviations, URLs, emails, ranges, phone numbers, Roman numerals) plus, inside the Vietnamese front-end: integers up to 15 digits with regional words (`linh`/`lẻ`, `nghìn`/`ngàn`), mốt/lăm/tư rules, decimals read digit by digit after "phẩy", codes and leading-zero numbers digit by digit, symbols (+ = @ / * ~ < > & # %), acronyms spelled by letter names, and a small versioned lexicon (`vi-lex-1`) for common English terms. Mixed Vietnamese/English text: unknown Latin words are **reported** (`UNRESOLVED_TOKENS`) and must be added to the pronunciation dictionary.

## 2. Linguistic processing (rule-based)

`parseSyllable` splits orthography into onset (incl. `gi`, `qu`, `ngh`, `gh`), medial glide (`o`/`u`), nucleus (incl. diphthongs and triphthongs via nucleus+coda), coda, and tone (NFD tone marks), and rejects ill-formed syllables with a reason (spelling rules, stop codas need sắc/nặng, diphthongs cannot take codas). Dialect profiles (`northern`, `central`, `southern`) change number words and phoneme transcription only where modelled (status text in the code states what is **not** modelled). Phrase boundaries come from punctuation; phrases over 12 syllables split before a conjunction. No disambiguation beyond these rules is attempted (e.g. `1/2`, unmarked acronyms) and ambiguity is reported.

## 3. Pronunciation dictionary

The existing dictionary supplies custom words, phrase-level entries (multi-word match text), locale and engine scope, priority, JSON import/export. Added: `dictionaryRevision()` (deterministic hash, independent of order/timestamps) returned as `revision` in the export. For `vnunit`, replacements are Vietnamese respellings; eSpeak-phoneme entries are rejected explicitly.

## 4. Concatenative synthesis

- Unit = tonal syllable; metadata in `UnitMeta` (key, source range, duration, F0 start/end/mean, RMS, boundary RMS, position, recorded context, pitch marks).
- Database = `manifest.json` + `units.json` (SHA-256 checked) + `audio/*.wav`; built by `buildUnitDb` / `node scripts/build-unit-db.mjs spec.json outDir` from recordings **with provider-supplied syllable boundaries** (edge silence is trimmed; F0 and pitch marks are measured). Invalid labels are rejected.
- Selection: target cost (context, position, pitch, duration) + join cost (pitch jump, energy jump, incompatibility penalty, free for contiguous units); candidates capped at 24 per target; ties by id.
- Compatibility: `joinCompatibility` reports pitch jump (default limit 5 st), energy jump (12 dB) and adjacency; incompatible joins are counted in the metrics.
- **Missing units:** `UnitMissingError` / `UNIT_MISSING` lists the syllables. Nothing is substituted.

## 5. Prosody (all measured in tests)

| Control                          | Mechanism                                        | Measured effect (fixture)                                    |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| Rate                             | PSOLA duration factor                            | 1.5× → duration within 12% of 1/1.5                          |
| Pause scale                      | exact silence samples                            | total duration changes by the planned pause lengths (±25 ms) |
| Pitch                            | PSOLA shift                                      | ±4 st → measured F0 within 1.5 st                            |
| Pitch range                      | scales declination/final/emphasis                | question rise and declination vanish at 0                    |
| Question intonation              | final offset + rising slope (not for huyền/nặng) | end F0 ≥ 2 st higher than the statement                      |
| Emphasis `*word*`                | +duration, +pitch, +gain                         | marked syllable ≥ 10% longer with the same units             |
| Final lengthening, phrase pauses | planner                                          | pauses 220/450/700 ms (minor/major/paragraph)                |

Emphasis and the other contour controls are rule-based; the engine does not perform emotional acting.

## 6. Audio quality

Waveform-matched crossfade joins (6 ms, offset search ±2 ms), 3 ms phrase-edge fades, DC removal, per-unit gain matching, silence trimming (−50 dBFS), active-speech loudness normalisation to −20 dBFS with headroom protection (no clipping), canonical 22,050 Hz mono s16 WAV, then the existing DSP chain, encoding and validation.

## 7. Engine integration

`VnUnitAdapter implements TtsEngineAdapter`; registered when `VN_UNIT_DB_DIR` is set. `selectEngineForLocale(registry, locale, {preferred, allowUnverified, requireSupported})` chooses by locale and capability and returns the alternatives; unverified engines are excluded unless requested, and nothing is substituted silently. `wordGapMs` is declared **unsupported**. Existing eSpeak behavior is unchanged (golden audio hashes identical).

## 8. Tests (all in `packages/core/src`)

`psola.test.ts` (7), `vi/linguistics.test.ts` (18), `vi/engine.test.ts` (37, uses the real eSpeak NG to build the fixture), plus the existing suites. Full run: **199/199**. Areas: pronunciation conversion, tone handling, unit selection, missing-unit handling, prosody parameters, audio duration, output validity, determinism, adapter and registry, pipeline integration, regression hash.

## 9. What the evaluation showed (fixture audio, objective measurements only)

- Smooth joins cut the measured join discontinuity 7.5× versus hard concatenation (10.7 vs 79.9 on one sentence).
- **Residual issue:** the same metric still reaches 18–29 in some sentences. It may be an artifact (loud consonant onset after quiet audio) or an audible click; **only listening can tell**.
- The fixture is eSpeak output, so its sound says nothing about the naturalness of real recordings.

## 10. Known limitations

No licensed data; no listening test; no automatic alignment; simplified dialect profiles; no word segmentation (so no word-gap control); `1/2`-style ambiguity left to the user; sample rate must be 22,050 Hz; UI/settings do not yet expose emphasis or question controls (emphasis is `*word*` in text; question rise follows `?`), and the voice stays hidden until allowlisted and QA-passed.

## 11. Operating it with real data (when available)

Source audio may be human recordings or, under ADR 0007, audio generated by a locally run AI model during development. Either way the spec must carry ( or with ); an AI-generated database without a complete declaration does not load and fails the compliance audit.

1. Obtain recordings with a license permitting derivative synthesis and self-hosted use; label syllable boundaries.
2. `node scripts/build-unit-db.mjs spec.json /data/vn-units/<voice-id>`; set `VN_UNIT_DB_DIR=/data/vn-units`.
3. Add the voice to `config/voice-allowlist.json` (`engineId: vnunit`), run QA, run a native-speaker listening evaluation on `vi-bench-1`, then update the ADR and `complianceStatus`.
