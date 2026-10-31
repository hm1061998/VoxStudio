import type { OutputProfile, SynthesisSettings } from '@voxstudio/contracts';
import type { EngineChunk } from '../text/prepare';

/** Immutable render plan stored with each job; workers execute it without re-reading segments. */
export const PLAN_VERSION = 1;

export interface SegmentPlan {
  segmentId: string | null;
  segmentRevision: number | null;
  position: number;
  engineId: string;
  engineVersion: string;
  voiceId: string;
  nativeVoiceId: string;
  voicePackageVersion: string;
  locale: string;
  chunks: EngineChunk[];
  settings: SynthesisSettings;
  cacheKey: string;
  warnings: string[];
}

export interface RenderPlan {
  version: number;
  kind: 'segment' | 'project';
  projectId: string | null;
  projectRevision: number | null;
  /** True when the plan reflects the saved segment state (not unsaved draft overrides). */
  matchesSaved: boolean;
  segments: SegmentPlan[];
  joinFadeMs: number;
  outputProfile: OutputProfile;
  toolVersions: { engine: string; ffmpeg: string };
  cacheKey: string;
}
