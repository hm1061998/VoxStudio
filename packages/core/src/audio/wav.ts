import { ErrorCodes, VoxError } from '@voxstudio/contracts';

export interface WavInfo {
  /** 1 = PCM integer, 3 = IEEE float */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  frames: number;
  durationMs: number;
}

/** Parse a RIFF/WAVE header. Tolerates the 0xFFFFFFFF "unknown size" written by streaming encoders. */
export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Audio is not a valid WAV file.');
  }
  let offset = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes' | 'frames' | 'durationMs'> | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      let audioFormat = buf.readUInt16LE(body);
      if (audioFormat === 0xfffe && size >= 26) audioFormat = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        audioFormat,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt)
        throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'WAV data chunk precedes format chunk.');
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      const frameBytes = fmt.channels * (fmt.bitsPerSample / 8);
      if (!frameBytes || !fmt.sampleRate)
        throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'WAV format is invalid.');
      const frames = Math.floor(size / frameBytes);
      return {
        ...fmt,
        dataOffset: body,
        dataBytes: frames * frameBytes,
        frames,
        durationMs: Math.round((frames / fmt.sampleRate) * 1000),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'WAV file has no data chunk.');
}

/** Decode mono/multi-channel PCM s16 or float32 WAV into interleaved Float32 samples in [-1, 1]. */
export function decodeWavToFloat(buf: Buffer): { info: WavInfo; samples: Float32Array } {
  const info = parseWavHeader(buf);
  const n = info.frames * info.channels;
  const samples = new Float32Array(n);
  const d = info.dataOffset;
  if (info.audioFormat === 1 && info.bitsPerSample === 16) {
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(d + i * 2) / 32768;
  } else if (info.audioFormat === 3 && info.bitsPerSample === 32) {
    for (let i = 0; i < n; i++) samples[i] = buf.readFloatLE(d + i * 4);
  } else {
    throw new VoxError(
      ErrorCodes.OUTPUT_VALIDATION_FAILED,
      `Unsupported WAV sample format (${info.audioFormat}/${info.bitsPerSample}).`,
    );
  }
  return { info, samples };
}

export function wavHeader(opts: {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16 | 24 | 32;
  float?: boolean;
  dataBytes: number;
}): Buffer {
  if (opts.dataBytes > 0xffffffff - 36)
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Audio exceeds the 4 GiB WAV limit.');
  const h = Buffer.alloc(44);
  const blockAlign = opts.channels * (opts.bitsPerSample / 8);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + opts.dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(opts.float ? 3 : 1, 20);
  h.writeUInt16LE(opts.channels, 22);
  h.writeUInt32LE(opts.sampleRate, 24);
  h.writeUInt32LE(opts.sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(opts.bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(opts.dataBytes, 40);
  return h;
}

/**
 * Convert float samples to s16 PCM. Values are expected to already be within [-1, 1]
 * (headroom is applied upstream); out-of-range values are clamped and counted, never wrapped.
 */
export function floatToPcm16(samples: Float32Array): { pcm: Buffer; clippedSamples: number } {
  const pcm = Buffer.alloc(samples.length * 2);
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    let v = Math.round((samples[i] ?? 0) * 32767);
    if (v > 32767) {
      v = 32767;
      clipped++;
    } else if (v < -32768) {
      v = -32768;
      clipped++;
    }
    pcm.writeInt16LE(v, i * 2);
  }
  return { pcm, clippedSamples: clipped };
}

export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number,
  channels = 1,
): { wav: Buffer; clippedSamples: number } {
  const { pcm, clippedSamples } = floatToPcm16(samples);
  return {
    wav: Buffer.concat([wavHeader({ sampleRate, channels, bitsPerSample: 16, dataBytes: pcm.length }), pcm]),
    clippedSamples,
  };
}

export function peakAbs(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] ?? 0);
    if (a > peak) peak = a;
  }
  return peak;
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Exact sample count for a pause, rounded to the nearest sample. */
export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

export const dbToLinear = (db: number): number => Math.pow(10, db / 20);
export const linearToDb = (v: number): number => (v <= 0 ? -Infinity : 20 * Math.log10(v));
