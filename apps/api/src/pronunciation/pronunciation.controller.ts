import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  pronunciationEntrySchema,
  pronunciationImportSchema,
  pronunciationUpdateSchema,
  type PronunciationConflictDto,
  type PronunciationEntryDto,
  type PronunciationEntryInput,
} from '@voxstudio/contracts';
import { detectConflicts, dictionaryRevision, isValidEspeakPhonemes } from '@voxstudio/core';
import type { PronunciationEntry } from '@voxstudio/db';
import { z } from 'zod';
import { AccessService } from '../common/access';
import { CurrentUser, UuidPipe, ZodPipe, type SessionUser } from '../common/http';
import { PrismaService } from '../common/infra';
import { toRules } from '../render/planner';

function toDto(e: PronunciationEntry): PronunciationEntryDto {
  return {
    id: e.id,
    locale: e.locale,
    matchText: e.matchText,
    replacementText: e.replacementText,
    phonemeFormat: e.phonemeFormat === 'espeak' ? 'espeak' : null,
    engineScope: e.engineScope,
    caseSensitive: e.caseSensitive,
    wholeWord: e.wholeWord,
    priority: e.priority,
    enabled: e.enabled,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function validateEntry(
  e: Pick<PronunciationEntryInput, 'phonemeFormat' | 'replacementText' | 'engineScope'>,
): void {
  if (e.phonemeFormat === 'espeak') {
    if (e.engineScope && e.engineScope !== 'espeak')
      throw new VoxError(
        ErrorCodes.PRONUNCIATION_INVALID,
        'eSpeak phonemes can only be scoped to the eSpeak engine.',
      );
    if (!isValidEspeakPhonemes(e.replacementText))
      throw new VoxError(
        ErrorCodes.PRONUNCIATION_INVALID,
        "Phonemes may only contain eSpeak mnemonic characters (letters, digits, @ ' , : _ etc.); brackets are not allowed.",
      );
  }
}

const listQuery = z.strictObject({
  q: z.string().max(200).optional(),
  locale: z.string().max(20).optional(),
});

@Controller('pronunciation-entries')
export class PronunciationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const rows = await this.prisma.pronunciationEntry.findMany({
      where: {
        workspaceId: this.access.defaultWorkspace(user),
        ...(q.locale ? { locale: q.locale } : {}),
        ...(q.q
          ? {
              OR: [
                { matchText: { contains: q.q, mode: 'insensitive' as const } },
                { replacementText: { contains: q.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ locale: 'asc' }, { matchText: 'asc' }],
      take: 5000,
    });
    return rows.map(toDto);
  }

  @Get('conflicts')
  async conflicts(@CurrentUser() user: SessionUser): Promise<PronunciationConflictDto[]> {
    const rows = await this.prisma.pronunciationEntry.findMany({
      where: { workspaceId: this.access.defaultWorkspace(user) },
    });
    return detectConflicts(toRules(rows));
  }

  @Get('export')
  async export(@CurrentUser() user: SessionUser) {
    const rows = await this.prisma.pronunciationEntry.findMany({
      where: { workspaceId: this.access.defaultWorkspace(user) },
      orderBy: [{ locale: 'asc' }, { matchText: 'asc' }],
    });
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      revision: dictionaryRevision(toRules(rows)),
      entries: rows.map((e) => ({
        locale: e.locale,
        matchText: e.matchText,
        replacementText: e.replacementText,
        phonemeFormat: e.phonemeFormat,
        engineScope: e.engineScope,
        caseSensitive: e.caseSensitive,
        wholeWord: e.wholeWord,
        priority: e.priority,
        enabled: e.enabled,
      })),
    };
  }

  @Post('import')
  @HttpCode(200)
  async import(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(pronunciationImportSchema)) body: z.infer<typeof pronunciationImportSchema>,
  ) {
    body.entries.forEach(validateEntry);
    const workspaceId = this.access.defaultWorkspace(user);
    const result = await this.prisma.$transaction(async (tx) => {
      if (body.mode === 'replace') await tx.pronunciationEntry.deleteMany({ where: { workspaceId } });
      const r = await tx.pronunciationEntry.createMany({
        data: body.entries.map((e) => ({ ...e, workspaceId })),
      });
      return r.count;
    });
    return { imported: result, mode: body.mode };
  }

  @Post()
  async create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(pronunciationEntrySchema)) body: z.infer<typeof pronunciationEntrySchema>,
  ) {
    validateEntry(body);
    return toDto(
      await this.prisma.pronunciationEntry.create({
        data: { ...body, workspaceId: this.access.defaultWorkspace(user) },
      }),
    );
  }

  @Patch(':entryId')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('entryId', UuidPipe) id: string,
    @Body(new ZodPipe(pronunciationUpdateSchema)) body: z.infer<typeof pronunciationUpdateSchema>,
  ) {
    const existing = await this.access.pronunciation(user, id);
    validateEntry({
      phonemeFormat:
        body.phonemeFormat !== undefined ? body.phonemeFormat : (existing.phonemeFormat as 'espeak' | null),
      replacementText: body.replacementText ?? existing.replacementText,
      engineScope: body.engineScope !== undefined ? body.engineScope : existing.engineScope,
    });
    return toDto(await this.prisma.pronunciationEntry.update({ where: { id }, data: body }));
  }

  @Delete(':entryId')
  async remove(@CurrentUser() user: SessionUser, @Param('entryId', UuidPipe) id: string) {
    await this.access.pronunciation(user, id);
    await this.prisma.pronunciationEntry.delete({ where: { id } });
    return { deleted: true };
  }
}
