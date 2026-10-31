import type { SupportTier } from '@voxstudio/contracts';
import type { InstalledVoice } from '../engine/types';

export interface AllowlistEntry {
  id: string;
  engineId: string;
  nativeId: string;
  locale: string;
  displayName: string;
  accent: string | null;
}

export interface QaCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface QaVoiceResult {
  status: 'passed' | 'failed';
  checks: QaCheck[];
  sampleText: string;
  durationMs?: number;
  /** Set only when a qualified human reviewer has listened and signed off. */
  manualReview?: { reviewer: string; date: string; notes: string } | null;
}

export interface QaReport {
  engineId: string;
  engineVersion: string;
  corpusVersion: string;
  generatedAt: string;
  results: Record<string, QaVoiceResult>;
}

export interface CatalogVoice {
  id: string;
  engineId: string;
  nativeId: string;
  displayName: string;
  languageName: string;
  locale: string;
  accent: string | null;
  packageVersion: string;
  license: string;
  installed: boolean;
  qaStatus: 'untested' | 'passed' | 'failed';
  supportTier: SupportTier;
  qaNotes: string;
  qaReport: QaVoiceResult | null;
}

/**
 * Reconcile the allowlist with voices actually installed and the QA report.
 * A voice is selectable only if allowlisted, installed, and QA-passed for this engine version.
 */
export function buildCatalog(
  allowlist: AllowlistEntry[],
  installed: InstalledVoice[],
  report: QaReport | null,
  engine: { id: string; version: string; license: string },
): CatalogVoice[] {
  const installedById = new Map(installed.map((v) => [v.nativeId, v]));
  const engineVersion = engine.version;
  const reportValid = !!report && report.engineId === engine.id && report.engineVersion === engineVersion;
  return allowlist
    .filter((a) => a.engineId === engine.id)
    .map((a) => {
      const inst = installedById.get(a.nativeId);
      const qa = reportValid ? (report.results[a.id] ?? null) : null;
      const qaStatus = qa ? qa.status : 'untested';
      let supportTier: SupportTier = 'unavailable';
      let qaNotes: string;
      if (!inst) qaNotes = 'Voice data is not installed on this server.';
      else if (!qa)
        qaNotes = reportValid
          ? 'Not yet tested.'
          : `QA report does not match installed engine version ${engineVersion}; re-run QA.`;
      else if (qa.status === 'failed')
        qaNotes = `Automated QA failed: ${qa.checks
          .filter((c) => !c.ok)
          .map((c) => c.detail)
          .join('; ')}`;
      else if (qa.manualReview) {
        supportTier = 'verified';
        qaNotes = `Automated QA passed; reviewed by ${qa.manualReview.reviewer} on ${qa.manualReview.date}.`;
      } else {
        supportTier = 'experimental';
        qaNotes =
          'Automated QA passed (synthesis, signal, determinism, rate control, language fallback). Native-speaker review pending.';
        const fallback = qa.checks.find(
          (c) => c.name === 'no-language-fallback' && c.detail !== 'stayed in voice language',
        );
        if (fallback) qaNotes += ` Note: ${fallback.detail} in the QA corpus.`;
      }
      return {
        id: a.id,
        engineId: a.engineId,
        nativeId: a.nativeId,
        displayName: a.displayName,
        languageName: inst?.languageName ?? a.displayName,
        locale: a.locale,
        accent: a.accent,
        packageVersion: engineVersion,
        license: engine.license,
        installed: !!inst,
        qaStatus,
        supportTier,
        qaNotes,
        qaReport: qa,
      };
    });
}

export function isSelectable(v: CatalogVoice): boolean {
  return v.installed && v.qaStatus === 'passed' && v.supportTier !== 'unavailable';
}
