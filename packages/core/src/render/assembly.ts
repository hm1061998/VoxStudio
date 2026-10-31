import { open } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { ErrorCodes, VoxError, type TimelineEntryDto } from '@voxstudio/contracts';
import { CANONICAL_SAMPLE_RATE } from '../audio/dsp';
import { msToSamples, parseWavHeader, wavHeader } from '../audio/wav';

export const ASSEMBLY_VERSION = 'asm-1';

export interface AssemblyItem {
  segmentId: string;
  position: number;
  wavPath: string;
  pauseBeforeMs: number;
  pauseAfterMs: number;
}

export interface AssemblyResult {
  frames: number;
  durationMs: number;
  timeline: TimelineEntryDto[];
}

/**
 * Concatenate canonical segment WAVs in order with exact silence, streaming to `outPath` so the
 * full project is never held in memory. Optional linear fades of `joinFadeMs` at each segment edge.
 */
export async function assembleSegments(
  items: AssemblyItem[],
  outPath: string,
  joinFadeMs: number,
): Promise<AssemblyResult> {
  if (!items.length)
    throw new VoxError(ErrorCodes.NOTHING_TO_RENDER, 'The project has no segments to render.');
  const sr = CANONICAL_SAMPLE_RATE;
  // First pass: headers only, to compute the exact output size and timeline.
  const infos: ReturnType<typeof parseWavHeader>[] = [];
  for (const item of items) {
    const head = await readHead(item.wavPath);
    const info = parseWavHeader(head.buf);
    if (info.audioFormat !== 1 || info.bitsPerSample !== 16 || info.channels !== 1 || info.sampleRate !== sr)
      throw new VoxError(
        ErrorCodes.OUTPUT_VALIDATION_FAILED,
        'Segment audio is not in the canonical format.',
      );
    infos.push({ ...info, frames: Math.floor((head.size - info.dataOffset) / 2) });
  }
  let cursor = 0;
  const timeline: TimelineEntryDto[] = [];
  items.forEach((item, i) => {
    const before = msToSamples(item.pauseBeforeMs, sr);
    const after = msToSamples(item.pauseAfterMs, sr);
    const frames = infos[i]!.frames;
    const toMs = (f: number) => Math.round((f / sr) * 1000);
    timeline.push({
      segmentId: item.segmentId,
      position: item.position,
      startMs: toMs(cursor),
      speechStartMs: toMs(cursor + before),
      speechEndMs: toMs(cursor + before + frames),
      endMs: toMs(cursor + before + frames + after),
    });
    cursor += before + frames + after;
  });
  const totalFrames = cursor;
  const fh = await open(outPath, 'w');
  try {
    await fh.write(wavHeader({ sampleRate: sr, channels: 1, bitsPerSample: 16, dataBytes: totalFrames * 2 }));
    const fadeFrames = msToSamples(joinFadeMs, sr);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const info = infos[i]!;
      await writeSilence(fh, msToSamples(item.pauseBeforeMs, sr));
      const buf = await readFile(item.wavPath);
      const pcm = Buffer.from(buf.subarray(info.dataOffset, info.dataOffset + info.frames * 2));
      if (fadeFrames > 0) applyEdgeFades(pcm, Math.min(fadeFrames, Math.floor(info.frames / 2)));
      await fh.write(pcm);
      await writeSilence(fh, msToSamples(item.pauseAfterMs, sr));
    }
  } finally {
    await fh.close();
  }
  return { frames: totalFrames, durationMs: Math.round((totalFrames / sr) * 1000), timeline };
}

async function readHead(p: string): Promise<{ buf: Buffer; size: number }> {
  const fh = await open(p, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, 4096));
    await fh.read(buf, 0, buf.length, 0);
    return { buf, size };
  } finally {
    await fh.close();
  }
}

const SILENCE_BLOCK = Buffer.alloc(64 * 1024);
async function writeSilence(fh: Awaited<ReturnType<typeof open>>, frames: number): Promise<void> {
  let bytes = frames * 2;
  while (bytes > 0) {
    const n = Math.min(bytes, SILENCE_BLOCK.length);
    await fh.write(SILENCE_BLOCK, 0, n);
    bytes -= n;
  }
}

/** Linear fade-in/out over `frames` samples at both ends of s16 PCM (in place). */
export function applyEdgeFades(pcm: Buffer, frames: number): void {
  const total = pcm.length / 2;
  for (let i = 0; i < frames; i++) {
    const g = i / frames;
    pcm.writeInt16LE(Math.round(pcm.readInt16LE(i * 2) * g), i * 2);
    const j = total - 1 - i;
    pcm.writeInt16LE(Math.round(pcm.readInt16LE(j * 2) * g), j * 2);
  }
}
