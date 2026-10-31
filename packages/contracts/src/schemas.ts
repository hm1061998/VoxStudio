import { z } from 'zod';
import { outputProfileSchema, partialSettingsSchema, synthesisSettingsSchema } from './settings';

/** Hard upper bounds enforced at the API boundary (operators can lower them via env). */
export const LIMITS = {
  nameMax: 120,
  descriptionMax: 2000,
  segmentTextMax: 5000,
  previewTextMax: 1000,
  segmentsPerProjectMax: 2000,
  pronunciationMatchMax: 200,
  pronunciationReplacementMax: 400,
  pronunciationImportMax: 5000,
  pauseMaxMs: 10000,
} as const;

const uuid = z.uuid();
const name = z.string().trim().min(1).max(LIMITS.nameMax);
/** BCP-47-ish tag such as `en-US`, `pt-BR`, `cmn`. */
export const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/);
export const voiceIdSchema = z.string().regex(/^[a-z0-9]+:[a-z0-9_-]{1,40}$/i);
export const engineIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);

// ---- auth
export const registerSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(1).max(80),
});
export const loginSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

// ---- workspaces
export const workspaceCreateSchema = z.strictObject({ name });
export const workspaceUpdateSchema = z.strictObject({ name });

// ---- projects
export const projectSettingsSchema = z.strictObject({
  defaultVoiceId: voiceIdSchema.nullable(),
  defaultSettings: partialSettingsSchema,
  outputProfile: outputProfileSchema,
  /** Optional linear fade at each segment join, in ms (0 = hard cut). */
  joinFadeMs: z.number().int().min(0).max(50),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const projectCreateSchema = z.strictObject({
  name,
  description: z.string().max(LIMITS.descriptionMax).optional(),
  defaultLocale: localeSchema,
  defaultVoiceId: voiceIdSchema.optional(),
});
export const projectUpdateSchema = z.strictObject({
  revision: z.number().int().min(0),
  name: name.optional(),
  description: z.string().max(LIMITS.descriptionMax).nullable().optional(),
  defaultLocale: localeSchema.optional(),
  settings: projectSettingsSchema.partial().optional(),
  archived: z.boolean().optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export const projectListQuerySchema = z.strictObject({
  q: z.string().max(120).optional(),
  sort: z.enum(['updated', 'created', 'name']).default('updated'),
  archived: z.enum(['true', 'false']).default('false'),
});

// ---- segments
export const segmentInputSchema = z.strictObject({
  sourceText: z.string().max(LIMITS.segmentTextMax),
  locale: localeSchema,
  voiceId: voiceIdSchema,
  settings: synthesisSettingsSchema,
});
export const segmentCreateSchema = segmentInputSchema.extend({
  /** Insert at this position (0-based); appends when omitted. */
  position: z.number().int().min(0).optional(),
  projectRevision: z.number().int().min(0),
});
export const segmentUpdateSchema = z.strictObject({
  projectRevision: z.number().int().min(0),
  sourceText: z.string().max(LIMITS.segmentTextMax).optional(),
  locale: localeSchema.optional(),
  voiceId: voiceIdSchema.optional(),
  settings: synthesisSettingsSchema.optional(),
});
export const segmentReorderSchema = z.strictObject({
  projectRevision: z.number().int().min(0),
  segmentIds: z.array(uuid).max(LIMITS.segmentsPerProjectMax),
});
/** Whole-document sync used by the editor (autosave + undo/redo). IDs are client-generated UUIDs. */
export const segmentsSyncSchema = z.strictObject({
  projectRevision: z.number().int().min(0),
  segments: z.array(segmentInputSchema.extend({ id: uuid })).max(LIMITS.segmentsPerProjectMax),
});
export type SegmentInput = z.infer<typeof segmentInputSchema>;
export type SegmentsSyncInput = z.infer<typeof segmentsSyncSchema>;

export const textSplitSchema = z.strictObject({
  text: z.string().max(200_000),
  mode: z.enum(['paragraph', 'sentence']),
  locale: localeSchema,
});

export const previewRequestSchema = z.strictObject({
  /** Optional draft overrides so users can preview unsaved slider values. */
  sourceText: z.string().max(LIMITS.segmentTextMax).optional(),
  voiceId: voiceIdSchema.optional(),
  locale: localeSchema.optional(),
  settings: synthesisSettingsSchema.optional(),
});

export const normalizePreviewSchema = z.strictObject({
  text: z.string().max(LIMITS.segmentTextMax),
  locale: localeSchema,
  voiceId: voiceIdSchema,
});

// ---- render / export
export const renderRequestSchema = z.strictObject({
  revision: z.number().int().min(0),
  outputProfile: outputProfileSchema.optional(),
});

// ---- presets
export const presetCreateSchema = z.strictObject({
  name,
  description: z.string().max(LIMITS.descriptionMax).default(''),
  localeScope: localeSchema.nullable().default(null),
  parameters: partialSettingsSchema,
});
export const presetUpdateSchema = presetCreateSchema.partial();

// ---- pronunciation
export const pronunciationEntrySchema = z.strictObject({
  locale: localeSchema,
  matchText: z.string().trim().min(1).max(LIMITS.pronunciationMatchMax),
  replacementText: z.string().trim().min(1).max(LIMITS.pronunciationReplacementMax),
  /** null = plain-text respelling; 'espeak' = eSpeak phoneme mnemonics (validated). */
  phonemeFormat: z.enum(['espeak']).nullable().default(null),
  engineScope: engineIdSchema.nullable().default(null),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(true),
  priority: z.number().int().min(-1000).max(1000).default(0),
  enabled: z.boolean().default(true),
});
export const pronunciationUpdateSchema = pronunciationEntrySchema.partial();
export const pronunciationImportSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(pronunciationEntrySchema).max(LIMITS.pronunciationImportMax),
  mode: z.enum(['merge', 'replace']).default('merge'),
});
export const pronunciationPreviewSchema = z.strictObject({
  text: z.string().min(1).max(LIMITS.previewTextMax),
  locale: localeSchema,
  voiceId: voiceIdSchema,
});
export type PronunciationEntryInput = z.infer<typeof pronunciationEntrySchema>;

// ---- admin
export const adminUserUpdateSchema = z
  .strictObject({
    role: z.enum(['user', 'admin']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, { message: 'Nothing to change.' });
export const adminUserQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const adminAuditQuerySchema = z.strictObject({
  prefix: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z_.]*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const engineToggleSchema = z.strictObject({ enabled: z.boolean() });
export const voiceToggleSchema = z.strictObject({ enabled: z.boolean() });

export const versionCreateSchema = z.strictObject({ label: z.string().trim().max(120).optional() });
