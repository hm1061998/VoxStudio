import {
  SETTING_KEYS,
  type SettingKey,
  type SynthesisSettings,
  type VoiceCapabilities,
} from '@voxstudio/contracts';

export interface SettingsChange {
  key: SettingKey;
  from: unknown;
  to: unknown;
  reason: 'unsupported' | 'out-of-range' | 'invalid-option';
}

/**
 * Make segment settings valid for another voice (possibly another engine). Values the new voice cannot
 * honour are reset to that voice's default (unsupported) or clamped (out of range); nothing else changes.
 * The caller reports the returned changes, so a voice switch is never silent.
 */
export function reconcileSettings(
  settings: SynthesisSettings,
  caps: VoiceCapabilities,
): { settings: SynthesisSettings; changes: SettingsChange[] } {
  const next = { ...settings } as Record<SettingKey, unknown>;
  const changes: SettingsChange[] = [];
  for (const key of SETTING_KEYS) {
    const cap = caps[key];
    const cur = settings[key];
    let to: unknown = cur;
    let reason: SettingsChange['reason'] | null = null;
    if (cap.support === 'unsupported') {
      if (cur !== cap.default) {
        to = cap.default;
        reason = 'unsupported';
      }
    } else if (cap.kind === 'number') {
      const n = Number(cur);
      const clamped = Math.min(cap.max, Math.max(cap.min, Number.isFinite(n) ? n : cap.default));
      if (clamped !== cur) {
        to = clamped;
        reason = 'out-of-range';
      }
    } else if (cap.kind === 'enum') {
      if (!cap.options.some((o) => o.value === cur)) {
        to = cap.default;
        reason = 'invalid-option';
      }
    }
    if (reason) {
      next[key] = to;
      changes.push({ key, from: cur, to, reason });
    }
  }
  return { settings: next as unknown as SynthesisSettings, changes };
}
