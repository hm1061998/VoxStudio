import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AllowlistEntry, QaReport } from './catalog';

export function loadAllowlist(repoRoot: string): AllowlistEntry[] {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'config', 'voice-allowlist.json'), 'utf8'),
  ) as AllowlistEntry[];
}

export function loadQaReport(repoRoot: string): QaReport | null {
  const p = path.join(repoRoot, 'config', 'voice-qa-report.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as QaReport) : null;
}

/**
 * QA report for one engine. `voice-qa-report.json` belongs to the engine named inside it (eSpeak NG);
 * other engines keep their own `voice-qa-report.<engineId>.json`. A report never applies to another engine.
 */
export function loadQaReportForEngine(repoRoot: string, engineId: string): QaReport | null {
  const main = loadQaReport(repoRoot);
  if (main && main.engineId === engineId) return main;
  const p = path.join(repoRoot, 'config', `voice-qa-report.${engineId}.json`);
  if (!existsSync(p)) return null;
  const r = JSON.parse(readFileSync(p, 'utf8')) as QaReport;
  return r.engineId === engineId ? r : null;
}

export interface QaCorpusEntry {
  voiceId: string;
  text: string;
}

export function loadQaCorpus(repoRoot: string): { version: string; entries: QaCorpusEntry[] } {
  return JSON.parse(readFileSync(path.join(repoRoot, 'config', 'qa-corpus.json'), 'utf8')) as {
    version: string;
    entries: QaCorpusEntry[];
  };
}
