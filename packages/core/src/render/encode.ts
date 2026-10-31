import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { ErrorCodes, VoxError, normalizeOutputProfile, type OutputProfile } from '@voxstudio/contracts';
import { runProcess, redactToolOutput } from '../process';
import { CANONICAL_SAMPLE_RATE } from '../audio/dsp';

export const ENCODER_VERSION = 'enc-1';

export const FORMAT_INFO = {
  wav: { ext: 'wav', mime: 'audio/wav' },
  mp3: { ext: 'mp3', mime: 'audio/mpeg' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
} as const;

export function encodeArgs(input: string, output: string, profile: OutputProfile): string[] {
  const p = normalizeOutputProfile(profile);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    input,
    '-map_metadata',
    '-1',
    '-ar',
    String(p.sampleRate),
    '-ac',
    String(p.channels),
  ];
  if (p.format === 'wav') args.push('-c:a', p.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le', '-f', 'wav');
  else if (p.format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', `${p.bitrateKbps}k`, '-f', 'mp3');
  else args.push('-c:a', 'libvorbis', '-b:a', `${p.bitrateKbps}k`, '-f', 'ogg');
  // Deterministic container output where the muxer supports it.
  args.push('-fflags', '+bitexact', '-flags:a', '+bitexact', output);
  return args;
}

export function profileWarnings(profile: OutputProfile): string[] {
  const w: string[] = [];
  if (profile.sampleRate > CANONICAL_SAMPLE_RATE)
    w.push(
      `Exported at ${profile.sampleRate} Hz for compatibility; the engine renders at ${CANONICAL_SAMPLE_RATE} Hz, so this adds no audio detail.`,
    );
  if (profile.channels === 2) w.push('Stereo export duplicates the mono voice into both channels.');
  return w;
}

export interface ProbeResult {
  formatName: string;
  codec: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number | null;
  bitrate: number | null;
  durationMs: number;
}

export async function probeAudio(ffprobe: string, file: string, timeoutMs: number): Promise<ProbeResult> {
  const r = await runProcess(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels,bits_per_sample,bit_rate:format=format_name,duration,bit_rate',
      '-of',
      'json',
      file,
    ],
    { timeoutMs },
  );
  if (r.code !== 0)
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Output file could not be probed.', {
      tool: redactToolOutput(r.stderr),
    });
  const j = JSON.parse(r.stdout.toString('utf8')) as {
    streams?: {
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      bits_per_sample?: number;
      bit_rate?: string;
    }[];
    format?: { format_name?: string; duration?: string; bit_rate?: string };
  };
  const s = j.streams?.[0];
  if (!s || !j.format)
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Output file has no audio stream.');
  return {
    formatName: j.format.format_name ?? '',
    codec: s.codec_name ?? '',
    sampleRate: Number(s.sample_rate),
    channels: Number(s.channels),
    bitsPerSample: s.bits_per_sample ? Number(s.bits_per_sample) : null,
    bitrate: Number(s.bit_rate ?? j.format.bit_rate) || null,
    durationMs: Math.round(Number(j.format.duration) * 1000),
  };
}

/** Fully decode the file; any decoder error fails validation. */
export async function decodeTest(ffmpeg: string, file: string, timeoutMs: number): Promise<void> {
  const r = await runProcess(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'],
    { timeoutMs },
  );
  if (r.code !== 0 || r.stderr.trim())
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Output failed the decode test.', {
      tool: redactToolOutput(r.stderr),
    });
}

const EXPECTED_CODEC = { wav: ['pcm_s16le', 'pcm_s24le'], mp3: ['mp3'], ogg: ['vorbis'] } as const;

/** Validate an encoded file against its requested profile and the expected duration. */
export async function validateOutput(
  tools: { ffmpeg: string; ffprobe: string },
  file: string,
  profile: OutputProfile,
  expectedDurationMs: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  const p = normalizeOutputProfile(profile);
  const probe = await probeAudio(tools.ffprobe, file, timeoutMs);
  const codecOk = (EXPECTED_CODEC[p.format] as readonly string[]).includes(probe.codec);
  if (!codecOk) throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, `Unexpected codec ${probe.codec}.`);
  if (p.format === 'wav' && probe.codec !== (p.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le'))
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Bit depth does not match the export profile.');
  if (probe.sampleRate !== p.sampleRate || probe.channels !== p.channels)
    throw new VoxError(
      ErrorCodes.OUTPUT_VALIDATION_FAILED,
      'Sample rate or channel count does not match the export profile.',
    );
  // Lossy encoders add priming/padding; allow a small tolerance.
  const tolerance = p.format === 'wav' ? 5 : 200;
  if (Math.abs(probe.durationMs - expectedDurationMs) > tolerance)
    throw new VoxError(
      ErrorCodes.OUTPUT_VALIDATION_FAILED,
      'Output duration does not match the rendered timeline.',
      {
        expectedMs: expectedDurationMs,
        actualMs: probe.durationMs,
      },
    );
  await decodeTest(tools.ffmpeg, file, timeoutMs);
  return probe;
}

export async function encodeAndValidate(
  tools: { ffmpeg: string; ffprobe: string },
  input: string,
  output: string,
  profile: OutputProfile,
  expectedDurationMs: number,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<ProbeResult> {
  const r = await runProcess(tools.ffmpeg, encodeArgs(input, output, profile), opts);
  if (r.code !== 0)
    throw new VoxError(ErrorCodes.DSP_FAILED, 'Encoding failed.', { tool: redactToolOutput(r.stderr) });
  return validateOutput(tools, output, profile, expectedDurationMs, opts.timeoutMs);
}

export async function fileSha256(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return { sha256: hash.digest('hex'), size: (await stat(file)).size };
}
