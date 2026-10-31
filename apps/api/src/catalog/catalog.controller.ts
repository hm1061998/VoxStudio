import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  normalizePreviewSchema,
  textSplitSchema,
  type NormalizationPreviewDto,
  type ToneDiagnosticsDto,
} from '@voxstudio/contracts';
import {
  analyzeVietnamese,
  languageOf,
  prepareEngineText,
  splitText,
  withTempDir,
  type AppConfig,
} from '@voxstudio/core';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../common/access';
import { CurrentUser, ZodPipe, type SessionUser } from '../common/http';
import { CONFIG } from '../common/infra';
import { PlannerService } from '../render/planner';
import { CatalogService } from './catalog.service';

const voiceQuery = z.strictObject({
  locale: z.string().max(20).optional(),
  engineId: z.string().max(40).optional(),
  all: z.enum(['true', 'false']).optional(),
});

@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly planner: PlannerService,
    private readonly access: AccessService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('engines')
  engines() {
    return this.catalog.engines();
  }

  @Get('engines/:engineId')
  async engine(@Param('engineId') id: string) {
    const e = (await this.catalog.engines()).find((x) => x.id === id);
    if (!e) throw new VoxError(ErrorCodes.NOT_FOUND, 'Engine not found.');
    return e;
  }

  @Get('voices')
  voices(@CurrentUser() user: SessionUser, @Query(new ZodPipe(voiceQuery)) q: z.infer<typeof voiceQuery>) {
    return this.catalog.listVoices({
      locale: q.locale,
      engineId: q.engineId,
      admin: user.role === 'admin' && q.all === 'true',
    });
  }

  @Get('voices/:voiceId')
  voice(@CurrentUser() user: SessionUser, @Param('voiceId') id: string) {
    return this.catalog.getVoice(id, user.role === 'admin');
  }

  @Get('voices/:voiceId/profile')
  profile(@CurrentUser() user: SessionUser, @Param('voiceId') id: string) {
    return this.catalog.getProfile(id, user.role === 'admin');
  }

  @Get('voices/:voiceId/dataset')
  async dataset(@CurrentUser() user: SessionUser, @Param('voiceId') id: string) {
    const p = await this.catalog.getProfile(id, user.role === 'admin');
    if (!p.dataset)
      throw new VoxError(ErrorCodes.NOT_FOUND, 'This voice has no recorded dataset (rule-based synthesis).');
    return { report: p.dataset, history: p.datasetHistory };
  }

  @Get('voices/:voiceId/capabilities')
  async capabilities(@CurrentUser() user: SessionUser, @Param('voiceId') id: string) {
    return (await this.catalog.getVoice(id, user.role === 'admin')).capabilities;
  }

  private viDiagnostics(text: string): ToneDiagnosticsDto {
    const MAX = 400;
    const a = analyzeVietnamese(text);
    const all = a.phrases.flatMap((p) => p.tokens);
    return {
      kind: 'vi-orthography',
      syllables: all.slice(0, MAX).map((t) => ({
        surface: t.surface,
        syllable: t.syllable.text,
        onset: t.syllable.onset,
        glide: t.syllable.glide,
        nucleus: t.syllable.nucleus,
        coda: t.syllable.coda,
        tone: t.syllable.tone,
      })),
      unreadable: a.unresolved.slice(0, 50),
      truncated: all.length > MAX,
    };
  }

  @Post('text/split')
  @HttpCode(200)
  split(@Body(new ZodPipe(textSplitSchema)) body: z.infer<typeof textSplitSchema>) {
    return { segments: splitText(body.text, body.mode, body.locale) };
  }

  /** Show exactly what the engine will receive: normalization steps, pronunciation hits, phonemes. */
  @Post('text/normalize-preview')
  @HttpCode(200)
  async normalizePreview(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(normalizePreviewSchema)) body: z.infer<typeof normalizePreviewSchema>,
  ): Promise<NormalizationPreviewDto> {
    const { voice } = await this.catalog.resolveSelectable(body.voiceId, body.locale);
    const rules = await this.planner.rules(this.access.defaultWorkspace(user));
    const prepared = prepareEngineText(body.text, body.locale, voice.engineId, rules);
    const speech = prepared.chunks
      .filter((c) => c.kind === 'speech')
      .map((c) => c.text)
      .join(' ');
    const phonemes = speech
      ? await withTempDir(this.config.tempDir, 'ph', (dir) =>
          this.catalog
            .adapterFor(voice.engineId)
            .phonemes(speech, voice.nativeId, { tempDir: dir, timeoutMs: 10_000 }),
        )
      : '';
    return {
      original: body.text,
      normalized: prepared.normalized,
      engineChunks: prepared.chunks.map((c) =>
        c.kind === 'speech' ? { kind: 'speech', text: c.text } : { kind: 'pause', pauseMs: c.pauseMs },
      ),
      steps: prepared.steps,
      pronunciationApplied: prepared.applied,
      phonemes,
      diagnostics: languageOf(body.locale) === 'vi' ? this.viDiagnostics(speech) : null,
      warnings: prepared.warnings,
    };
  }
}
