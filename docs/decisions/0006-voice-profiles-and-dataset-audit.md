# 0006 — Voice profiles, dataset reports and dataset audit trail

- Status: accepted
- Date/owner: 2026-10-31, VoxStudio coding agent
- Follows: 0005 (Vietnamese concatenative engine)

## Context

The catalog described voices only by locale, accent label and QA status. Multi-engine support needs per-voice facts that only the engine knows (real accent, recorded dataset, inventory) and an auditable record of the data behind a voice.

## Decision

1. Adapters may implement `getVoiceProfile()`; the catalog merges it into a `VoiceProfileDto`. The accent from voice data overrides the allowlist label.
2. Dataset metadata lives in the unit-database manifest (optional fields, schema unchanged). `buildDatasetReport` computes coverage and quality from the stored unit metadata only.
3. A new append-only table `tts_voice_datasets` (unique on voice id + manifest SHA-256) records each distinct dataset a voice has had.
4. QA reports are per engine (`voice-qa-report.<engineId>.json`) so a non-eSpeak engine can be validated without touching the eSpeak report.
5. Settings classification reuses the existing `native | dsp | unsupported` and adds the task names through `SUPPORT_CLASS`.

## Alternatives

Store the report in `tts_voices.qa_report_json` (overwritten on refresh, not auditable); compute coverage in the browser (duplicate logic, no audit).

## Consequences

One new table and migration. Reports need `config/vi-bench-syllables.json`; without it `complete` is never true. Gender is `null` unless a provider-verified record exists.

## Security/license/performance impact

Dataset reports contain no audio or user text; license and attribution are shown to every user. Reports are computed at catalog refresh (in memory, cheap for the sizes seen); each profile request adds one history query.
