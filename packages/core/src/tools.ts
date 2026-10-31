import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { runProcess } from './process';

export interface ToolPaths {
  espeak: string;
  ffmpeg: string;
  ffprobe: string;
}

function winGetFfmpeg(name: 'ffmpeg' | 'ffprobe'): string | null {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : null;
  if (!base || !existsSync(base)) return null;
  // Only the essentials build is acceptable (the full build bundles flite/whisper — see ADR 0004).
  for (const pkg of readdirSync(base).filter((d) => d.startsWith('Gyan.FFmpeg.Essentials'))) {
    const pkgDir = path.join(base, pkg);
    for (const sub of readdirSync(pkgDir)) {
      const exe = path.join(pkgDir, sub, 'bin', `${name}.exe`);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/** Resolve fixed executable paths from env or well-known install locations. Never from request input. */
export function resolveToolPaths(env: NodeJS.ProcessEnv = process.env): ToolPaths {
  const win = process.platform === 'win32';
  const espeakDefault =
    win && existsSync('C:\\Program Files\\eSpeak NG\\espeak-ng.exe')
      ? 'C:\\Program Files\\eSpeak NG\\espeak-ng.exe'
      : 'espeak-ng';
  return {
    espeak: env.ESPEAK_PATH || espeakDefault,
    ffmpeg: env.FFMPEG_PATH || (win && winGetFfmpeg('ffmpeg')) || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || (win && winGetFfmpeg('ffprobe')) || 'ffprobe',
  };
}

/**
 * Filters whose presence in the FFmpeg build violates the strict non-AI policy (ADR 0004):
 * `flite` can generate speech; `whisper`/`dnn_*` link ML inference runtimes into the binary.
 */
export const PROHIBITED_FFMPEG_FILTERS = [
  'flite',
  'whisper',
  'dnn_processing',
  'dnn_detect',
  'dnn_classify',
] as const;
/**
 * Present in nearly every FFmpeg build; inert without an external model file, cannot generate speech.
 * Never invoked; reported by the compliance audit, which also verifies no model files are installed.
 */
export const FLAGGED_FFMPEG_FILTERS = ['arnndn'] as const;
/** The only filters VoxStudio ever passes to FFmpeg. */
export const ALLOWED_FFMPEG_FILTERS = [
  'aformat',
  'aresample',
  'atempo',
  'rubberband',
  'highpass',
  'equalizer',
  'bass',
  'treble',
  'acompressor',
  'anull',
] as const;

export interface FfmpegInfo {
  version: string;
  prohibitedFilters: string[];
  flaggedFilters: string[];
  missingFilters: string[];
  encoders: { mp3: boolean; vorbis: boolean };
}

export async function inspectFfmpeg(ffmpeg: string): Promise<FfmpegInfo> {
  const v = await runProcess(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
  const version = /ffmpeg version (\S+)/.exec(v.stdout.toString('utf8'))?.[1] ?? 'unknown';
  const f = await runProcess(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 });
  const filters = new Set(
    f.stdout
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => /^\s*[TSC.]{2,3}\s+(\S+)/.exec(l)?.[1])
      .filter((x): x is string => !!x),
  );
  const e = await runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 });
  const enc = e.stdout.toString('utf8');
  return {
    version,
    prohibitedFilters: PROHIBITED_FFMPEG_FILTERS.filter((x) => filters.has(x)),
    flaggedFilters: FLAGGED_FFMPEG_FILTERS.filter((x) => filters.has(x)),
    missingFilters: ALLOWED_FFMPEG_FILTERS.filter((x) => !filters.has(x)),
    encoders: { mp3: /\blibmp3lame\b/.test(enc), vorbis: /\blibvorbis\b/.test(enc) },
  };
}

/** Throws unless FFmpeg is present, compliant, and has every filter we rely on. */
export async function assertFfmpegCompliant(ffmpeg: string): Promise<FfmpegInfo> {
  const info = await inspectFfmpeg(ffmpeg);
  if (info.prohibitedFilters.length) {
    throw new VoxError(
      ErrorCodes.ENGINE_UNAVAILABLE,
      `FFmpeg build contains prohibited speech/ML filters (${info.prohibitedFilters.join(', ')}). Install a compliant build (see docs/decisions/0004).`,
    );
  }
  if (info.missingFilters.length) {
    throw new VoxError(
      ErrorCodes.ENGINE_UNAVAILABLE,
      `FFmpeg build lacks required filters: ${info.missingFilters.join(', ')}.`,
    );
  }
  return info;
}
