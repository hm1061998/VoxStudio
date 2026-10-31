import { ErrorCodes, VoxError, type SettingKey } from '@voxstudio/contracts';
import type { AppConfig } from '../config';
import { languageOf } from '../text/normalize';
import { VnUnitAdapter } from '../vi/adapter';
import { loadBenchSyllables } from '../vi/dataset';
import { EspeakAdapter } from './espeak';
import { VieneuAdapter } from './vieneu';
import type { EngineHealth, TtsEngineAdapter } from './types';

/**
 * Holds every speech engine adapter by engine id. API and worker resolve adapters here instead of
 * constructing an engine directly, so adding an engine means registering one adapter (after it
 * passes the docs/07 admission checklist) rather than editing the pipeline.
 */
export class EngineRegistry {
  private readonly adapters = new Map<string, TtsEngineAdapter>();

  register(adapter: TtsEngineAdapter): this {
    if (this.adapters.has(adapter.engineId))
      throw new Error(`Engine "${adapter.engineId}" is already registered`);
    this.adapters.set(adapter.engineId, adapter);
    return this;
  }

  has(engineId: string): boolean {
    return this.adapters.has(engineId);
  }

  /** Throws a stable error instead of silently falling back to another engine. */
  get(engineId: string): TtsEngineAdapter {
    const a = this.adapters.get(engineId);
    if (!a)
      throw new VoxError(
        ErrorCodes.ENGINE_UNAVAILABLE,
        `Speech engine "${engineId}" is not installed on this server.`,
        { engineId },
      );
    return a;
  }

  all(): TtsEngineAdapter[] {
    return [...this.adapters.values()];
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  async initializeAll(): Promise<void> {
    for (const a of this.adapters.values()) await a.initialize();
  }

  /** Health of every engine, keyed by engine id (a failing engine does not hide the others). */
  async healthAll(): Promise<Record<string, EngineHealth>> {
    const out: Record<string, EngineHealth> = {};
    for (const a of this.adapters.values()) out[a.engineId] = await a.healthCheck();
    return out;
  }
}

export interface EngineSelectionOptions {
  /** Engine ids in order of preference; others follow in registration order. */
  preferred?: string[];
  /** Include engines whose compliance status is not "approved" (e.g. for evaluation). Default false. */
  allowUnverified?: boolean;
  /** Settings the engine must support natively or via DSP (not "unsupported"). */
  requireSupported?: SettingKey[];
}

export interface EngineSelection {
  engineId: string;
  /** Other eligible engines, in order, so the caller can offer them explicitly. */
  alternatives: string[];
}

/**
 * Choose an engine for a locale and capability set. Eligible engines are healthy, cover the language,
 * are approved (unless `allowUnverified`) and support every required setting. The result is explicit:
 * callers must tell the user which engine was chosen; this never silently substitutes engines.
 */
export async function selectEngineForLocale(
  registry: EngineRegistry,
  locale: string,
  opts: EngineSelectionOptions = {},
): Promise<EngineSelection> {
  const lang = languageOf(locale);
  const order = [...new Set([...(opts.preferred ?? []), ...registry.ids()])].filter((id) => registry.has(id));
  const eligible: string[] = [];
  for (const id of order) {
    const a = registry.get(id);
    const meta = await a.getMetadata();
    if (
      meta.complianceStatus === 'rejected' ||
      (meta.complianceStatus !== 'approved' && !opts.allowUnverified)
    )
      continue;
    if (!meta.supportedLocales.some((l) => languageOf(l) === lang)) continue;
    if (!(await a.healthCheck()).ok) continue;
    if (opts.requireSupported?.length) {
      const voice =
        (await a.listInstalledVoices()).find((v) => languageOf(v.nativeId) === lang) ??
        (await a.listInstalledVoices())[0];
      if (!voice) continue;
      const caps = a.getCapabilities(voice.nativeId);
      if (opts.requireSupported.some((k) => caps[k].support === 'unsupported')) continue;
    }
    eligible.push(id);
  }
  const [first, ...rest] = eligible;
  if (!first)
    throw new VoxError(
      ErrorCodes.ENGINE_UNAVAILABLE,
      `No suitable speech engine is available for ${locale}.`,
      { locale },
    );
  return { engineId: first, alternatives: rest };
}

/** The engines this deployment ships. Only engines with an approved admission record belong in the default set. */
export function createEngineRegistry(config: AppConfig): EngineRegistry {
  const registry = new EngineRegistry();
  const on = (id: string) => config.enabledEngines.includes(id);
  // The rule-based eSpeak NG engine: offered only when listed in ENABLED_ENGINES.
  if (on('espeak'))
    registry.register(
      new EspeakAdapter({ executable: config.tools.espeak, approvedVersion: config.espeakApprovedVersion }),
    );
  // The Vietnamese unit-selection engine exists only where it is enabled and an operator supplies a unit database.
  if (on('vnunit') && config.vnUnitDbDir)
    registry.register(
      new VnUnitAdapter({ dbRoot: config.vnUnitDbDir, bench: loadBenchSyllables(config.repoRoot) }),
    );
  // The AI engine (ADR 0008) exists only where it is enabled and the operator runs the model service.
  if (on('vieneu')) {
    if (!config.vieneuServiceUrls.length)
      throw new Error('ENABLED_ENGINES includes vieneu but VIENEU_SERVICE_URLS is empty.');
    if (!config.vieneuServiceToken)
      throw new Error('VIENEU_SERVICE_TOKEN is required when the vieneu engine is enabled.');
    registry.register(
      new VieneuAdapter({
        urls: config.vieneuServiceUrls,
        token: config.vieneuServiceToken,
        approved: config.vieneuApproved,
      }),
    );
  }
  if (!registry.all().length) throw new Error('No speech engine is enabled (check ENABLED_ENGINES).');
  return registry;
}
