import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  type EngineDto,
  SETTING_KEYS,
  SUPPORT_CLASS,
  type DatasetHistoryDto,
  type SettingKey,
  type SupportClass,
  type VoiceCapabilities,
  type VoiceDetailDto,
  type VoiceDto,
  type VoiceProfileDto,
} from '@voxstudio/contracts';
import {
  EngineRegistry,
  buildCatalog,
  inspectFfmpeg,
  isSelectable,
  languageOf,
  loadAllowlist,
  loadQaReportForEngine,
  type AppConfig,
  type CatalogVoice,
  type EngineHealth,
  type EngineMetadata,
  type EngineVoiceProfile,
  type FfmpegInfo,
  type TtsEngineAdapter,
} from '@voxstudio/core';
import { CONFIG, Logger, PrismaService } from '../common/infra';

export interface ResolvedVoice {
  voice: CatalogVoice;
  caps: VoiceCapabilities;
  engineVersion: string;
  adapter: TtsEngineAdapter;
}

interface EngineState {
  meta: EngineMetadata;
  health: EngineHealth & { checkedAt: string };
}

/**
 * Engine and voice catalog. Built at startup from every registered engine's installed-voice
 * manifest, reconciled against `config/voice-allowlist.json` and `config/voice-qa-report.json`,
 * and persisted so admins can disable engines/voices. The server is authoritative for capabilities.
 */
@Injectable()
export class CatalogService implements OnModuleInit {
  private catalog: CatalogVoice[] = [];
  private profiles = new Map<string, EngineVoiceProfile>();
  private engines_ = new Map<string, EngineState>();
  private ffmpeg: FfmpegInfo | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistry,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    // An optional engine (the AI model service) may start after the API: pick it up without a restart.
    if (this.registry.all().some((a) => a.optional)) {
      const timer = setInterval(() => {
        const missing = this.registry.all().some((a) => a.optional && !this.engines_.has(a.engineId));
        if (missing) void this.refresh().catch(() => undefined);
      }, 30_000);
      timer.unref();
    }
  }

  async refresh(): Promise<void> {
    try {
      this.ffmpeg = await inspectFfmpeg(this.config.tools.ffmpeg);
    } catch {
      this.ffmpeg = null;
    }
    const allowlist = loadAllowlist(this.config.repoRoot);
    const catalog: CatalogVoice[] = [];
    const profiles = new Map<string, EngineVoiceProfile>();
    const states = new Map<string, EngineState>();

    for (const adapter of this.registry.all()) {
      const health = await adapter.healthCheck();
      const checkedAt = new Date().toISOString();
      if (!health.version) {
        this.logger.error('engine unavailable', { engine: adapter.engineId, detail: health.detail });
        continue;
      }
      await adapter.initialize();
      const meta = await adapter.getMetadata();
      states.set(adapter.engineId, { meta, health: { ...health, checkedAt } });
      const installed = await adapter.listInstalledVoices();
      const voices = buildCatalog(
        allowlist,
        installed,
        loadQaReportForEngine(this.config.repoRoot, adapter.engineId),
        {
          id: meta.id,
          version: meta.version,
          license: meta.license,
        },
      ).map((v) => {
        if (!v.installed || !adapter.getVoiceProfile) return v;
        const prof = adapter.getVoiceProfile(v.nativeId);
        profiles.set(v.id, prof);
        // The accent comes from the voice data itself; an allowlist label that disagrees is not advertised.
        if (v.accent !== prof.region)
          this.logger.warn('allowlist accent differs from voice data; using the data', {
            voice: v.id,
            allowlist: v.accent,
            data: prof.region,
          });
        return { ...v, accent: prof.region };
      });
      catalog.push(...voices);
      await this.prisma.ttsEngine.upsert({
        where: { id: meta.id },
        create: {
          id: meta.id,
          displayName: meta.name,
          version: meta.version,
          synthesisMethod: meta.synthesisMethod,
          complianceStatus: meta.complianceStatus,
          enabled: meta.complianceStatus === 'approved',
          licenseId: meta.license,
          verifiedAt: new Date(meta.verifiedAt),
          metadataJson: { admission: meta.admissionRecord, notes: meta.notes, usesAi: !!meta.usesAi },
        },
        update: {
          version: meta.version,
          synthesisMethod: meta.synthesisMethod,
          complianceStatus: meta.complianceStatus,
          licenseId: meta.license,
          metadataJson: { admission: meta.admissionRecord, notes: meta.notes, usesAi: !!meta.usesAi },
        },
      });
      for (const v of voices) {
        const data = {
          engineId: v.engineId,
          displayName: v.displayName,
          locale: v.locale,
          accent: v.accent,
          voicePackageVersion: v.packageVersion,
          licenseId: v.license,
          installed: v.installed,
          capabilitiesJson: adapter.getCapabilities(v.nativeId) as object,
          qaStatus: v.qaStatus,
          qaReportJson: (v.qaReport ?? {}) as object,
        };
        await this.prisma.ttsVoice.upsert({
          where: { id: v.id },
          create: { id: v.id, enabled: isSelectable(v), ...data },
          update: data,
        });
        const ds = profiles.get(v.id)?.dataset;
        if (ds)
          // Append-only: one row per distinct manifest checksum, so dataset changes stay auditable.
          await this.prisma.ttsVoiceDataset.upsert({
            where: { voiceId_manifestSha256: { voiceId: v.id, manifestSha256: ds.manifestSha256 } },
            create: {
              voiceId: v.id,
              datasetVersion: ds.datasetVersion,
              manifestSha256: ds.manifestSha256,
              unitsSha256: ds.unitsSha256,
              licenseId: ds.license.id,
              attribution: ds.license.attribution,
              reportJson: ds as object,
            },
            update: {},
          });
      }
    }
    this.catalog = catalog;
    this.profiles = profiles;
    this.engines_ = states;
    this.logger.info('catalog loaded', {
      engines: [...states.values()].map((s) => `${s.meta.id}@${s.meta.version}`),
      voices: catalog.length,
      selectable: catalog.filter(isSelectable).length,
    });
  }

  get ffmpegInfo(): FfmpegInfo | null {
    return this.ffmpeg;
  }

  /** Aggregate engine health for readiness: ok only if every registered engine is healthy. */
  async engineHealth(): Promise<{ ok: boolean; detail: string }> {
    const all = await this.registry.healthAll();
    const entries = Object.entries(all);
    const optional = new Set(
      this.registry
        .all()
        .filter((a) => a.optional)
        .map((a) => a.engineId),
    );
    // An optional engine (AI model service) being down must not make the whole application "not ready".
    return {
      ok: entries.some(([id]) => !optional.has(id)) && entries.every(([id, h]) => h.ok || optional.has(id)),
      detail:
        entries
          .map(([id, h]) => (h.ok ? h.detail : `${id}${optional.has(id) ? ' (optional)' : ''}: ${h.detail}`))
          .join('; ') || 'no engines',
    };
  }

  /** True when the engine runs an AI model (ADR 0008). Unknown engines are treated as non-AI. */
  engineUsesAi(engineId: string): boolean {
    return !!this.engines_.get(engineId)?.meta.usesAi;
  }

  adapterFor(engineId: string): TtsEngineAdapter {
    return this.registry.get(engineId);
  }

  capabilitiesFor(voice: Pick<CatalogVoice, 'engineId' | 'nativeId'>): VoiceCapabilities {
    return this.registry.get(voice.engineId).getCapabilities(voice.nativeId);
  }

  private async flags(): Promise<{
    engines: Map<string, { enabled: boolean; approved: boolean }>;
    voiceEnabled: Map<string, boolean>;
  }> {
    const engines = await this.prisma.ttsEngine.findMany();
    const voices = await this.prisma.ttsVoice.findMany({ select: { id: true, enabled: true } });
    return {
      engines: new Map(
        engines.map((e) => [e.id, { enabled: e.enabled, approved: e.complianceStatus === 'approved' }]),
      ),
      voiceEnabled: new Map(voices.map((v) => [v.id, v.enabled])),
    };
  }

  private toDto(v: CatalogVoice, enabled: boolean, admin: boolean): VoiceDto {
    return {
      id: v.id,
      engineId: v.engineId,
      displayName: v.displayName,
      locale: v.locale,
      languageName: v.languageName,
      accent: v.accent,
      packageVersion: v.packageVersion,
      license: v.license,
      enabled,
      qaStatus: v.qaStatus,
      supportTier: v.supportTier,
      qaNotes: v.qaNotes,
      usesAi: !!this.engines_.get(v.engineId)?.meta.usesAi,
      gender: this.profiles.get(v.id)?.gender ?? null,
      ...(admin ? { installed: v.installed } : {}),
    };
  }

  /** Users see only selectable voices; admins also see unverified/disabled ones (diagnostics). */
  async listVoices(opts: { locale?: string; engineId?: string; admin?: boolean }): Promise<VoiceDto[]> {
    const f = await this.flags();
    return this.catalog
      .filter((v) => !opts.engineId || v.engineId === opts.engineId)
      .filter(
        (v) =>
          !opts.locale ||
          v.locale.toLowerCase() === opts.locale.toLowerCase() ||
          languageOf(v.locale) === opts.locale.toLowerCase(),
      )
      .map((v) => {
        const e = f.engines.get(v.engineId);
        return {
          v,
          enabled: (f.voiceEnabled.get(v.id) ?? false) && !!e?.enabled && !!e.approved && isSelectable(v),
        };
      })
      .filter((x) => opts.admin || x.enabled)
      .map((x) => this.toDto(x.v, x.enabled, !!opts.admin))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getVoice(id: string, admin = false): Promise<VoiceDetailDto> {
    const v = this.catalog.find((x) => x.id === id);
    const list = await this.listVoices({ admin });
    const dto = list.find((x) => x.id === id);
    if (!v || !dto) throw new VoxError(ErrorCodes.NOT_FOUND, 'Voice not found.');
    return {
      ...dto,
      capabilities: this.capabilitiesFor(v),
      qaReport: v.qaReport,
      limitations: this.engines_.get(v.engineId)?.meta.limitations ?? [],
    };
  }

  /** Full voice profile: catalog facts + engine facts + defaults + validation state + dataset audit. */
  async getProfile(id: string, admin = false): Promise<VoiceProfileDto> {
    const detail = await this.getVoice(id, admin);
    const v = this.catalog.find((x) => x.id === id)!;
    const state = this.engines_.get(v.engineId)!;
    const caps = detail.capabilities;
    const prof = this.profiles.get(id);
    const controls = Object.fromEntries(
      SETTING_KEYS.map((k) => [k, SUPPORT_CLASS[caps[k].support]]),
    ) as Record<SettingKey, SupportClass>;
    const def = (k: SettingKey): number => Number(caps[k].default);
    const review = v.qaReport?.manualReview ?? null;
    const history = await this.prisma.ttsVoiceDataset.findMany({
      where: { voiceId: id },
      orderBy: { recordedAt: 'desc' },
      take: 20,
    });
    return {
      ...detail,
      region: v.accent,
      gender: prof?.gender ?? null,
      engineName: state.meta.name,
      engineVersion: state.meta.version,
      synthesisMethod: state.meta.synthesisMethod,
      voiceDatabaseVersion:
        prof?.voiceDatabaseVersion ?? `${state.meta.name} ${state.meta.version} built-in voice data`,
      inventory: prof?.inventory ?? {
        kind: 'rule-based',
        onsets: [],
        nuclei: [],
        codas: [],
        tones: [],
        recordedSyllables: null,
        note: 'Rule-based synthesis from phonological rules; there is no recorded unit inventory to enumerate.',
      },
      defaults: {
        rate: def('rate'),
        pitch: def('pitch'),
        volumeDb: def('volumeDb'),
        pauseBeforeMs: def('pauseBeforeMs'),
        pauseAfterMs: def('pauseAfterMs'),
      },
      controls,
      sample: { text: v.qaReport?.sampleText ?? '' },
      validation: review
        ? {
            state: 'reviewed',
            detail: review.notes,
            reviewer: review.reviewer,
            reviewedOn: review.date,
          }
        : {
            state:
              v.qaStatus === 'passed'
                ? 'automated-passed'
                : v.qaStatus === 'failed'
                  ? 'automated-failed'
                  : 'unvalidated',
            detail: v.qaNotes,
            reviewer: null,
            reviewedOn: null,
          },
      dataset: prof?.dataset ?? null,
      datasetHistory: history.map((h): DatasetHistoryDto => ({
        datasetVersion: h.datasetVersion,
        manifestSha256: h.manifestSha256,
        licenseId: h.licenseId,
        recordedAt: h.recordedAt.toISOString(),
      })),
    };
  }

  /** Resolve a voice for use in synthesis; never substitutes another voice or engine. */
  async resolveSelectable(voiceId: string, locale?: string): Promise<ResolvedVoice> {
    const v = this.catalog.find((x) => x.id === voiceId);
    const f = await this.flags();
    const state = v ? this.engines_.get(v.engineId) : undefined;
    if (!v || !state)
      throw new VoxError(
        ErrorCodes.VOICE_NOT_AVAILABLE,
        'The selected voice is not available on this server.',
        { voiceId },
      );
    const e = f.engines.get(v.engineId);
    if (!e?.enabled || !e.approved)
      throw new VoxError(
        ErrorCodes.ENGINE_DISABLED,
        'The speech engine for this voice is disabled by the administrator.',
      );
    if (!isSelectable(v) || !f.voiceEnabled.get(v.id))
      throw new VoxError(
        ErrorCodes.VOICE_NOT_AVAILABLE,
        `Voice "${v.displayName}" is not available (${v.qaNotes}).`,
        { voiceId },
      );
    if (locale && languageOf(locale) !== languageOf(v.locale))
      throw new VoxError(
        ErrorCodes.VOICE_LOCALE_UNSUPPORTED,
        `Voice "${v.displayName}" does not support locale ${locale}.`,
        { voiceId, locale },
      );
    const adapter = this.registry.get(v.engineId);
    return {
      voice: v,
      caps: adapter.getCapabilities(v.nativeId),
      engineVersion: state.meta.version,
      adapter,
    };
  }

  findCatalogVoice(voiceId: string): CatalogVoice | undefined {
    return this.catalog.find((x) => x.id === voiceId);
  }

  async engines(): Promise<EngineDto[]> {
    const rows = await this.prisma.ttsEngine.findMany();
    return rows.map((e) => {
      const state = this.engines_.get(e.id);
      const meta = e.metadataJson as { admission?: string; notes?: string; usesAi?: boolean } | null;
      return {
        id: e.id,
        displayName: e.displayName,
        version: e.version,
        synthesisMethod: e.synthesisMethod,
        complianceStatus: e.complianceStatus as EngineDto['complianceStatus'],
        usesAi: !!(state?.meta.usesAi ?? meta?.usesAi),
        license: e.licenseId,
        enabled: e.enabled,
        verifiedAt: e.verifiedAt?.toISOString() ?? null,
        notes: [meta?.admission && `Admission record: ${meta.admission}.`, meta?.notes]
          .filter(Boolean)
          .join(' '),
        health: state
          ? { ok: state.health.ok, detail: state.health.detail, checkedAt: state.health.checkedAt }
          : { ok: false, detail: 'engine not loaded', checkedAt: new Date().toISOString() },
      };
    });
  }
}
