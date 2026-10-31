# 0005 — Vietnamese concatenative engine (`vnunit`)

- Status: **proposed** (engine implemented and tested against a test fixture; **not admitted**: no licensed voice data, no listening evaluation)
- Date/owner: 2026-10-31, VoxStudio coding agent
- Follows: `docs/upgrade/04-ENGINE-DECISION.md`

## Context

No existing engine was found that is both strictly non-AI and has a Vietnamese voice better than eSpeak NG. The decision report recommends a custom deterministic concatenative engine behind the engine registry.

## Decision

Implement `vnunit` as a second engine adapter (`packages/core/src/vi/`):

1. **Front-end (rule-based):** existing normalization (`norm-3`) → number/symbol/acronym expansion → deterministic syllable parser (onset, medial glide, nucleus, coda, tone, with Vietnamese orthographic and tone-on-stop-coda rules) → phrase boundaries and sentence types from punctuation. Ambiguity is reported (unresolved tokens, ambiguous acronyms), never guessed.
2. **Unit inventory:** the tonal syllable. Each recorded instance is a candidate with measured F0 (start/end/mean), duration, RMS (overall and boundary), position, recorded context and pitch marks.
3. **Selection:** deterministic Viterbi over target costs (context, position, pitch, duration) and join costs (pitch jump, energy jump, hard incompatibility penalty); ties by unit id. A syllable with no candidate raises `UNIT_MISSING`; no other syllable is substituted.
4. **Prosody:** rule-based plan (declination, final fall, continuation rise, question rise, exclamation, emphasis, pauses, final lengthening) applied with TD-PSOLA. Falling tones never get a rising slope.
5. **Audio:** waveform-matched crossfade joins, edge fades, silence trimming, loudness normalisation with headroom protection.
6. **Registration:** only when `VN_UNIT_DB_DIR` is set. Metadata says `complianceStatus: unverified`. Voices appear in the catalog only after an operator allowlists them and QA passes (existing mechanism).

## Alternatives

Diphone units (rejected for now: Vietnamese syllable boundaries carry the tone contour; diphones need much more careful tone-aware pitch handling); MBROLA (no Vietnamese database found); statistical engines (forbidden).

## Consequences

- No new dependencies. DSP is plain TypeScript (F0 tracking, TD-PSOLA).
- The engine cannot produce speech until a licensed unit database exists. Quality is bounded by the recordings.
- Building a database needs labelled syllable boundaries from the data provider. Automatic alignment is **not** implemented; using an HMM aligner offline is an open policy question (04 §4).

## Security/license/performance impact

Unit databases are operator-supplied data and must carry a license manifest; `pnpm audit:compliance` fails if the test fixture license is configured. Synthesis is CPU-only and fast on the fixture (real-time factor well below 1; not benchmarked on a full-size database).

## Admission checklist (docs/07 §3) status

| Item                                      | Status                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document synthesis method                 | Done (this ADR, `05-VIETNAMESE-CORE.md`)                                                                                                                              |
| No statistical/ML/neural generation       | By construction (code review of `packages/core/src/vi/`: rules, tables, Viterbi, PSOLA); the compliance audit confirms no ML packages, model files or cloud endpoints |
| Review runtime dependencies               | None added                                                                                                                                                            |
| Review engine and voice-package licenses  | Engine: project. **Voice data: pending (no data)**                                                                                                                    |
| Commercial use / redistribution rights    | **Pending data**                                                                                                                                                      |
| Pin binary and voice package versions     | Engine version in code; database checksum in manifest                                                                                                                 |
| Locale-specific pronunciation corpus      | `benchmark/vi/` (vi-bench-1)                                                                                                                                          |
| Unicode and punctuation behavior          | Covered by linguistics tests                                                                                                                                          |
| Parameter mappings and ranges             | Covered by engine tests (measured effects)                                                                                                                            |
| Reproducible integration tests            | Done against the test fixture                                                                                                                                         |
| Record approval, reviewer, date, evidence | **Not approved**                                                                                                                                                      |
