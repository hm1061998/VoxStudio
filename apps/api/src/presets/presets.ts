import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  Patch,
  Post,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  partialSettingsSchema,
  presetCreateSchema,
  presetUpdateSchema,
  synthesisSettingsSchema,
  type PartialSettings,
  type PresetDto,
  type SynthesisSettings,
} from '@voxstudio/contracts';
import { applyPreset } from '@voxstudio/core';
import type { VoicePreset } from '@voxstudio/db';
import { z } from 'zod';
import { CatalogService } from '../catalog/catalog.service';
import { AccessService } from '../common/access';
import { CurrentUser, UuidPipe, ZodPipe, type SessionUser } from '../common/http';
import { PrismaService } from '../common/infra';
import { ProjectsService } from '../projects/projects.service';

/** Built-in presets: deterministic parameter bundles. Descriptions state exactly what changes. */
export const BUILTIN_PRESETS: {
  id: string;
  name: string;
  description: string;
  parameters: PartialSettings;
}[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Neutral (defaults)',
    description: 'Engine defaults: rate 1×, pitch 50, range 50, no DSP.',
    parameters: {
      rate: 1,
      pitch: 50,
      pitchRange: 50,
      wordGapMs: 0,
      volumeDb: 0,
      tempo: 1,
      pitchShiftSemitones: 0,
      highpassHz: 0,
      lowShelfDb: 0,
      presenceDb: 0,
      highShelfDb: 0,
      compressor: false,
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Clear narration',
    description: 'Slightly slower rate (0.9×), wider intonation range (65), 80 Hz high-pass, +2 dB presence.',
    parameters: { rate: 0.9, pitchRange: 65, highpassHz: 80, presenceDb: 2 },
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Learner pace',
    description: 'Rate 0.75×, 40 ms extra gap between words, 500 ms pause after each segment.',
    parameters: { rate: 0.75, wordGapMs: 40, pauseAfterMs: 500 },
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Announcement',
    description: 'Rate 0.95×, pitch range 70, gentle compressor, +3 dB presence, 700 ms pause after.',
    parameters: { rate: 0.95, pitchRange: 70, compressor: true, presenceDb: 3, pauseAfterMs: 700 },
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    name: 'Lower pitch (engine)',
    description: 'Engine base pitch 35 and range 40. No DSP.',
    parameters: { pitch: 35, pitchRange: 40 },
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    name: 'Fast summary',
    description: 'Rate 1.3×, 150 ms pause after each segment.',
    parameters: { rate: 1.3, pauseAfterMs: 150 },
  },
];

function toDto(p: VoicePreset): PresetDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    localeScope: p.localeScope,
    parameters: partialSettingsSchema.parse(p.parametersJson),
    isBuiltin: p.isBuiltin,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

@Injectable()
export class PresetSeeder implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}
  async onModuleInit(): Promise<void> {
    for (const b of BUILTIN_PRESETS)
      await this.prisma.voicePreset.upsert({
        where: { id: b.id },
        create: {
          id: b.id,
          workspaceId: null,
          name: b.name,
          description: b.description,
          parametersJson: b.parameters,
          isBuiltin: true,
        },
        update: { name: b.name, description: b.description, parametersJson: b.parameters },
      });
  }
}

const applySchema = z.strictObject({
  projectRevision: z.number().int().min(0),
  segmentIds: z.array(z.uuid()).min(1).max(2000),
  dryRun: z.boolean().default(false),
});

@Controller('presets')
export class PresetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly catalog: CatalogService,
    private readonly projects: ProjectsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser): Promise<PresetDto[]> {
    const rows = await this.prisma.voicePreset.findMany({
      where: { OR: [{ isBuiltin: true }, { workspaceId: { in: user.workspaceIds } }] },
      orderBy: [{ isBuiltin: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toDto);
  }

  @Post()
  async create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(presetCreateSchema)) body: z.infer<typeof presetCreateSchema>,
  ): Promise<PresetDto> {
    const p = await this.prisma.voicePreset.create({
      data: {
        workspaceId: this.access.defaultWorkspace(user),
        name: body.name,
        description: body.description,
        localeScope: body.localeScope,
        parametersJson: body.parameters,
      },
    });
    return toDto(p);
  }

  @Patch(':presetId')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('presetId', UuidPipe) id: string,
    @Body(new ZodPipe(presetUpdateSchema)) body: z.infer<typeof presetUpdateSchema>,
  ): Promise<PresetDto> {
    await this.access.preset(user, id, true);
    const p = await this.prisma.voicePreset.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.localeScope !== undefined ? { localeScope: body.localeScope } : {}),
        ...(body.parameters !== undefined ? { parametersJson: body.parameters } : {}),
      },
    });
    return toDto(p);
  }

  @Delete(':presetId')
  async remove(@CurrentUser() user: SessionUser, @Param('presetId', UuidPipe) id: string) {
    await this.access.preset(user, id, true);
    await this.prisma.voicePreset.delete({ where: { id } });
    return { deleted: true };
  }

  /** Apply (or with dryRun, preview) a preset on segments; reports exactly which values change. */
  @Post(':presetId/apply')
  @HttpCode(200)
  async apply(
    @CurrentUser() user: SessionUser,
    @Param('presetId', UuidPipe) id: string,
    @Body(new ZodPipe(applySchema)) body: z.infer<typeof applySchema>,
  ) {
    const preset = await this.access.preset(user, id, false);
    const params = partialSettingsSchema.parse(preset.parametersJson);
    const segments = await Promise.all(body.segmentIds.map((sid) => this.access.segment(user, sid)));
    const projectId = segments[0]!.projectId;
    if (segments.some((s) => s.projectId !== projectId))
      throw new VoxError(ErrorCodes.VALIDATION_FAILED, 'Segments must belong to one project.');
    const results = segments.map((s) => {
      const v = this.catalog.findCatalogVoice(s.voiceId);
      if (!v) throw new VoxError(ErrorCodes.VOICE_NOT_AVAILABLE, 'Segment voice unavailable.');
      const r = applyPreset(
        synthesisSettingsSchema.parse(s.settingsJson) as SynthesisSettings,
        params,
        this.catalog.capabilitiesFor(v),
      );
      return { segment: s, ...r };
    });
    const report = results.map((r) => ({ segmentId: r.segment.id, changes: r.changes, skipped: r.skipped }));
    if (body.dryRun) return { changes: report, project: null };
    const project = await this.projects.get(user, projectId);
    if (project.revision !== body.projectRevision)
      throw new VoxError(ErrorCodes.REVISION_CONFLICT, 'This project was changed elsewhere. Reload first.', {
        currentRevision: project.revision,
      });
    const next = project.segments.map((s) => {
      const r = results.find((x) => x.segment.id === s.id);
      return {
        id: s.id,
        sourceText: s.sourceText,
        locale: s.locale,
        voiceId: s.voiceId,
        settings: r ? r.settings : s.settings,
      };
    });
    return {
      changes: report,
      project: await this.projects.sync(user, projectId, next, body.projectRevision),
    };
  }
}
