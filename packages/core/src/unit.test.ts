import { describe, expect, it } from 'vitest';
import { ErrorCodes, outputProfileSchema, synthesisSettingsSchema, VoxError } from '@voxstudio/contracts';
import {
  decodeWavToFloat,
  encodeWavPcm16,
  floatToPcm16,
  msToSamples,
  parseWavHeader,
  wavHeader,
} from './audio/wav';
import { applyGainWithHeadroom, buildFilterChain, PEAK_CEILING } from './audio/dsp';
import {
  applyPreset,
  defaultSettings,
  espeakCapabilities,
  validateSettingsForVoice,
} from './engine/capabilities';
import {
  isMbrolaFile,
  parseEspeakVoiceList,
  rateToWpm,
  sanitizeEspeakText,
  isValidEspeakPhonemes,
} from './engine/espeak';
import { splitPauses } from './text/pauses';
import { splitText, textStats } from './text/segmentation';
import { normalizeText } from './text/normalize';
import {
  comparePrecedence,
  detectConflicts,
  findPronunciationMatches,
  type PronunciationRule,
} from './text/pronunciation';
import { prepareEngineText } from './text/prepare';
import { projectCacheKey, segmentCacheKey, stableStringify, type SegmentCacheInput } from './render/cache';
import { buildCatalog, isSelectable, type QaReport } from './catalog/catalog';
import { assetStorageKey, LocalStorageDriver } from './storage/local';
import { redactToolOutput } from './process';

const caps = espeakCapabilities(['m2', 'f2', 'klatt']);
const defaults = defaultSettings(caps);

describe('WAV I/O', () => {
  it('round-trips PCM16 samples and header metadata', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    const { wav } = encodeWavPcm16(samples, 22050);
    const info = parseWavHeader(wav);
    expect(info).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 22050,
      bitsPerSample: 16,
      frames: 4,
    });
    const back = decodeWavToFloat(wav).samples;
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
  });
  it('clamps and counts out-of-range samples instead of wrapping', () => {
    const { pcm, clippedSamples } = floatToPcm16(new Float32Array([1.5, -1.5, 0.1]));
    expect(clippedSamples).toBe(2);
    expect(pcm.readInt16LE(0)).toBe(32767);
    expect(pcm.readInt16LE(2)).toBe(-32768);
  });
  it('rejects non-WAV data', () => {
    expect(() => parseWavHeader(Buffer.from('not a wav file at all'))).toThrow(VoxError);
  });
  it('tolerates streaming size 0xFFFFFFFF', () => {
    const h = wavHeader({ sampleRate: 22050, channels: 1, bitsPerSample: 16, dataBytes: 0 });
    h.writeUInt32LE(0xffffffff, 40);
    const buf = Buffer.concat([h, Buffer.alloc(200)]);
    expect(parseWavHeader(buf).frames).toBe(100);
  });
  it('converts pause ms to exact sample counts', () => {
    expect(msToSamples(500, 22050)).toBe(11025);
    expect(msToSamples(1000, 44100)).toBe(44100);
    expect(msToSamples(10, 22050)).toBe(221);
  });
});

describe('capabilities and settings', () => {
  it('defaults match capability defaults and pass schema + voice validation', () => {
    expect(synthesisSettingsSchema.parse(defaults)).toEqual(defaults);
    expect(() => validateSettingsForVoice(defaults, caps)).not.toThrow();
  });
  it('rejects unknown settings keys', () => {
    expect(synthesisSettingsSchema.safeParse({ ...defaults, emotion: 'happy' }).success).toBe(false);
  });
  it('rejects out-of-range values with a stable code', () => {
    try {
      validateSettingsForVoice({ ...defaults, rate: 5 }, caps);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as VoxError).code).toBe(ErrorCodes.PARAMETER_OUT_OF_RANGE);
    }
  });
  it('rejects uninstalled variants', () => {
    expect(() => validateSettingsForVoice({ ...defaults, variant: 'f4' }, caps)).toThrow(/not an available/);
  });
  it('rejects non-default values for unsupported parameters', () => {
    const c = { ...caps, compressor: { ...caps.compressor, support: 'unsupported' as const } };
    expect(() => validateSettingsForVoice({ ...defaults, compressor: true }, c)).toThrow(/not supported/);
  });
  it('maps rate multiplier to bounded eSpeak wpm', () => {
    expect(rateToWpm(1)).toBe(175);
    expect(rateToWpm(2)).toBe(350);
    expect(rateToWpm(0.1)).toBe(80);
  });
  it('applies presets reporting changes and skipped values', () => {
    const r = applyPreset(defaults, { rate: 1.2, pitch: 50, variant: 'f4', volumeDb: -3 }, caps);
    expect(r.changes.map((c) => c.key).sort()).toEqual(['rate', 'volumeDb']);
    expect(r.skipped).toEqual(['variant']);
    expect(r.settings.rate).toBe(1.2);
    expect(r.settings.variant).toBe('default');
  });
  it('carries speed and pitch of a style over to the audio processing for a voice without those controls', () => {
    const ai = {
      ...caps,
      rate: { ...caps.rate, support: 'unsupported' as const },
      pitch: { ...caps.pitch, support: 'unsupported' as const },
      pitchRange: { ...caps.pitchRange, support: 'unsupported' as const },
      wordGapMs: { ...caps.wordGapMs, support: 'unsupported' as const },
    };
    const r = applyPreset(defaults, { rate: 0.75, pitch: 35, pitchRange: 40, wordGapMs: 40 }, ai);
    expect(r.settings.tempo).toBe(0.75);
    expect(r.settings.pitchShiftSemitones).toBe(-3);
    expect(r.changes.map((c) => c.key).sort()).toEqual(['pitchShiftSemitones', 'tempo']);
    expect(r.skipped.sort()).toEqual(['pitchRange', 'wordGapMs']);
    // A style that sets the audio-processing value itself keeps it.
    expect(applyPreset(defaults, { rate: 0.75, tempo: 1.1 }, ai).settings.tempo).toBe(1.1);
  });
  it('validates output profiles', () => {
    expect(
      outputProfileSchema.safeParse({ format: 'mp3', sampleRate: 44100, channels: 2, bitrateKbps: 192 })
        .success,
    ).toBe(true);
    expect(
      outputProfileSchema.safeParse({ format: 'wav', sampleRate: 44100, channels: 1, bitrateKbps: 192 })
        .success,
    ).toBe(false);
    expect(outputProfileSchema.safeParse({ format: 'flac', sampleRate: 44100, channels: 1 }).success).toBe(
      false,
    );
    expect(outputProfileSchema.safeParse({ format: 'wav', sampleRate: 12345, channels: 1 }).success).toBe(
      false,
    );
  });
});

describe('DSP chain', () => {
  it('returns null when no FFmpeg stage is needed', () => {
    expect(buildFilterChain({ ...defaults, volumeDb: 6, pauseAfterMs: 900 })).toBeNull();
  });
  it('builds filters in documented order', () => {
    const chain = buildFilterChain({
      ...defaults,
      tempo: 1.1,
      pitchShiftSemitones: 2,
      highpassHz: 80,
      presenceDb: 3,
      compressor: true,
    })!;
    expect(chain.map((f) => f.split('=')[0])).toEqual([
      'aformat',
      'atempo',
      'rubberband',
      'highpass',
      'equalizer',
      'acompressor',
    ]);
    expect(chain[2]).toBe(`rubberband=pitch=${Number(Math.pow(2, 2 / 12).toFixed(6))}`);
  });
  it('never lets gain clip: attenuates to the ceiling and reports it', () => {
    const r = applyGainWithHeadroom(new Float32Array([0.5, -0.8, 0.2]), 12);
    expect(Math.max(...r.samples.map(Math.abs))).toBeLessThanOrEqual(PEAK_CEILING + 1e-6);
    expect(r.attenuationDb).toBeGreaterThan(0);
  });
  it('leaves quiet audio untouched apart from gain', () => {
    const r = applyGainWithHeadroom(new Float32Array([0.1, -0.1]), -6);
    expect(r.attenuationDb).toBe(0);
    expect(r.samples[0]).toBeCloseTo(0.1 * Math.pow(10, -6 / 20), 6);
  });
});

describe('eSpeak adapter helpers', () => {
  it('neutralises phoneme-input syntax in user text', () => {
    expect(sanitizeEspeakText('say [[h@l"oU]] now')).toBe('say [h@l"oU] now');
    expect(sanitizeEspeakText('a [[[x]]] b')).toBe('a [x] b');
  });
  it('validates phoneme strings', () => {
    expect(isValidEspeakPhonemes(`h@l'oU`)).toBe(true);
    expect(isValidEspeakPhonemes('x]] $(rm -rf /)')).toBe(false);
  });
  it('parses voice lists and excludes MBROLA', () => {
    const out = `Pty Language       Age/Gender VoiceName          File                 Other Languages
 5  af              --/M      Afrikaans          gmw\\af
 7  af              --/M      afrikaans-mbrola-1 mb\\mb-af1
 2  en-us           --/M      English_(America)  gmw\\en-US            (en 3)`;
    const voices = parseEspeakVoiceList(out);
    expect(voices.map((v) => v.nativeId)).toEqual(['af', 'af', 'en-us']);
    expect(voices.filter((v) => !isMbrolaFile(v.file)).map((v) => v.languageName)).toEqual([
      'Afrikaans',
      'English (America)',
    ]);
  });
});

describe('text processing', () => {
  it('splits pause markers into exact chunks', () => {
    expect(splitPauses('Hello [pause 500ms] world [pause 1.5s][pause 200ms] end')).toEqual([
      { kind: 'speech', text: 'Hello' },
      { kind: 'pause', pauseMs: 500 },
      { kind: 'speech', text: 'world' },
      { kind: 'pause', pauseMs: 1700 },
      { kind: 'speech', text: 'end' },
    ]);
    expect(splitPauses('[pause 99s]')).toEqual([{ kind: 'pause', pauseMs: 10000 }]);
  });
  it('splits sentences and paragraphs deterministically, keeping abbreviations', () => {
    expect(splitText('One. Two!\n\nThree?', 'paragraph', 'en-US')).toEqual(['One. Two!', 'Three?']);
    expect(splitText('Dr. Smith arrived. He sat down.', 'sentence', 'en-US')).toEqual([
      'Dr. Smith arrived.',
      'He sat down.',
    ]);
    expect(splitText('Привет. Как дела?', 'sentence', 'ru-RU')).toEqual(['Привет.', 'Как дела?']);
  });
  it('counts Unicode characters and words', () => {
    const s = textStats('Café 日本 [pause 1s] ok');
    expect(s.words).toBe(3);
    expect(s.characters).toBe([...'Café 日本 ok'].length);
  });
  it('normalizes English patterns and records each step', () => {
    const r = normalizeText(
      'Dr. Lee paid $1,234.50 (15%) on 2026-10-31, see https://example.com/docs e.g. now.',
      'en-US',
    );
    expect(r.text).toBe(
      'Doctor Lee paid 1234 dollars and 50 cents (15 percent) on October 31, 2026, see example dot com slash docs for example now.',
    );
    expect(r.steps.map((s) => s.rule)).toEqual([
      'url',
      'iso-date',
      'currency',
      'percent',
      'abbreviation',
      'abbreviation',
    ]);
  });
  it('preserves unknown patterns and warns for locales without rules', () => {
    const r = normalizeText('Il a payé 20 € le 3/4.', 'fr-FR');
    expect(r.text).toBe('Il a payé 20 € le 3/4.');
    expect(r.steps).toEqual([]);
    expect(r.warnings[0]).toMatch(/No VoxStudio normalization rules/);
  });
  it('does not expand invalid dates', () => {
    expect(normalizeText('Code 2026-13-45', 'en-US').text).toBe('Code 2026-13-45');
  });
});

const rule = (over: Partial<PronunciationRule>): PronunciationRule => ({
  id: over.id ?? 'r',
  locale: 'en',
  matchText: 'x',
  replacementText: 'y',
  phonemeFormat: null,
  engineScope: null,
  caseSensitive: false,
  wholeWord: true,
  priority: 0,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('pronunciation dictionary', () => {
  it('matches literally (no regex injection) and respects whole-word', () => {
    const rules = [rule({ id: 'a', matchText: 'a.b', replacementText: 'A B' })];
    expect(findPronunciationMatches('axb a.b a.bc', rules)).toEqual([{ ruleId: 'a', start: 4, end: 7 }]);
  });
  it('resolves overlaps by precedence regardless of storage order', () => {
    const long = rule({ id: 'long', matchText: 'New York City', replacementText: 'N Y C' });
    const short = rule({ id: 'short', matchText: 'New York', replacementText: 'Nu York' });
    const text = 'I love New York City.';
    expect(findPronunciationMatches(text, [short, long])).toEqual(
      findPronunciationMatches(text, [long, short]),
    );
    expect(findPronunciationMatches(text, [short, long])[0]!.ruleId).toBe('long');
    const boosted = { ...short, priority: 5 };
    expect(findPronunciationMatches(text, [boosted, long])[0]!.ruleId).toBe('short');
  });
  it('orders ties deterministically', () => {
    const a = rule({ id: 'a', createdAt: '2026-01-02T00:00:00Z' });
    const b = rule({ id: 'b', createdAt: '2026-01-01T00:00:00Z' });
    expect([a, b].sort(comparePrecedence).map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('detects conflicts and names the winner', () => {
    const c = detectConflicts([
      rule({ id: 'a', matchText: 'SQL' }),
      rule({ id: 'b', matchText: 'sql', priority: 2 }),
      rule({ id: 'c', matchText: 'other' }),
    ]);
    expect(c).toEqual([{ locale: 'en', matchText: 'sql', entryIds: ['b', 'a'], winnerId: 'b' }]);
  });
  it('applies entries before normalization and inserts phonemes safely', () => {
    const rules = [
      rule({
        id: 'p',
        matchText: 'GIF',
        replacementText: "dZ'If",
        phonemeFormat: 'espeak',
        caseSensitive: true,
      }),
      rule({ id: 't', matchText: 'Dr.', replacementText: 'Drive', wholeWord: false }),
      rule({ id: 'fr', locale: 'fr', matchText: 'GIF', replacementText: 'zzz' }),
    ];
    const r = prepareEngineText(
      'A GIF on Main Dr. costs $5 [pause 250ms] [[x]] done',
      'en-US',
      'espeak',
      rules,
    );
    expect(r.chunks).toEqual([
      { kind: 'speech', text: "A [[dZ'If]] on Main Drive costs 5 dollars" },
      { kind: 'pause', pauseMs: 250 },
      { kind: 'speech', text: '[x] done' },
    ]);
    expect(r.normalized).toBe("A /dZ'If/ on Main Drive costs 5 dollars [pause 250ms] [[x]] done");
    expect(r.applied.map((a) => a.entryId).sort()).toEqual(['p', 't']);
  });
  it('scopes entries by engine and locale', () => {
    const rules = [rule({ id: 'e', matchText: 'hi', replacementText: 'hey', engineScope: 'other-engine' })];
    expect(prepareEngineText('hi', 'en-US', 'espeak', rules).applied).toEqual([]);
    expect(prepareEngineText('hi', 'de-DE', 'espeak', [rule({ id: 'x', matchText: 'hi' })]).applied).toEqual(
      [],
    );
  });
});

describe('cache keys', () => {
  const base: SegmentCacheInput = {
    engineId: 'espeak',
    engineVersion: '1.52.0',
    voiceId: 'espeak:en-us',
    voicePackageVersion: '1.52.0',
    locale: 'en-US',
    chunks: [{ kind: 'speech', text: 'Hello' }],
    settings: defaults,
    dspToolVersion: '9.0.1',
  };
  it('is stable for equal input regardless of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(segmentCacheKey(base)).toBe(segmentCacheKey({ ...base, settings: { ...defaults } }));
  });
  it('changes when any synthesis-affecting input changes', () => {
    const k = segmentCacheKey(base);
    const variants: Partial<SegmentCacheInput>[] = [
      { engineVersion: '1.53.0' },
      { voiceId: 'espeak:en-gb' },
      { voicePackageVersion: 'x' },
      { locale: 'en-GB' },
      { chunks: [{ kind: 'speech', text: 'Hello!' }] },
      {
        chunks: [
          { kind: 'speech', text: 'Hello' },
          { kind: 'pause', pauseMs: 10 },
        ],
      },
      { settings: { ...defaults, rate: 1.05 } },
      { settings: { ...defaults, variant: 'f2' } },
      { settings: { ...defaults, compressor: true } },
      { dspToolVersion: '9.0.2' },
    ];
    for (const v of variants) expect(segmentCacheKey({ ...base, ...v })).not.toBe(k);
  });
  it('ignores assembly-only settings for segment audio', () => {
    expect(segmentCacheKey({ ...base, settings: { ...defaults, pauseAfterMs: 2000 } })).toBe(
      segmentCacheKey(base),
    );
  });
  it('project key covers pauses, fades and output profile', () => {
    const p = {
      segments: [{ cacheKey: 'a', pauseBeforeMs: 0, pauseAfterMs: 300 }],
      joinFadeMs: 0,
      outputProfile: { format: 'wav' as const, sampleRate: 22050 as const, channels: 1 as const },
      encoderToolVersion: '9.0.1',
    };
    const k = projectCacheKey(p);
    expect(projectCacheKey({ ...p, outputProfile: { ...p.outputProfile, bitDepth: 16 } })).toBe(k);
    expect(projectCacheKey({ ...p, joinFadeMs: 5 })).not.toBe(k);
    expect(
      projectCacheKey({ ...p, segments: [{ cacheKey: 'a', pauseBeforeMs: 0, pauseAfterMs: 301 }] }),
    ).not.toBe(k);
    expect(
      projectCacheKey({ ...p, outputProfile: { format: 'mp3', sampleRate: 22050, channels: 1 } }),
    ).not.toBe(k);
  });
});

const ENGINE = { id: 'espeak', version: '1.52.0', license: 'GPL-3.0-or-later' };

describe('catalog reconciliation', () => {
  const allow = [
    {
      id: 'espeak:en-us',
      engineId: 'espeak',
      nativeId: 'en-us',
      locale: 'en-US',
      displayName: 'English (US)',
      accent: null,
    },
    {
      id: 'espeak:ja',
      engineId: 'espeak',
      nativeId: 'ja',
      locale: 'ja-JP',
      displayName: 'Japanese',
      accent: null,
    },
    {
      id: 'espeak:xx',
      engineId: 'espeak',
      nativeId: 'xx',
      locale: 'xx',
      displayName: 'Missing',
      accent: null,
    },
  ];
  const installed = [
    { nativeId: 'en-us', languageName: 'English (America)', file: 'gmw/en-US' },
    { nativeId: 'ja', languageName: 'Japanese', file: 'jpx/ja' },
  ];
  const report: QaReport = {
    engineId: 'espeak',
    engineVersion: '1.52.0',
    corpusVersion: 'c',
    generatedAt: '',
    results: {
      'espeak:en-us': { status: 'passed', checks: [], sampleText: '' },
      'espeak:ja': {
        status: 'failed',
        checks: [{ name: 'x', ok: false, detail: 'fallback' }],
        sampleText: '',
      },
    },
  };
  it('exposes only installed + QA-passed voices', () => {
    const c = buildCatalog(allow, installed, report, ENGINE);
    expect(c.filter(isSelectable).map((v) => v.id)).toEqual(['espeak:en-us']);
    expect(c.find((v) => v.id === 'espeak:en-us')!.supportTier).toBe('experimental');
    expect(c.find((v) => v.id === 'espeak:xx')!.qaNotes).toMatch(/not installed/);
  });
  it('invalidates QA when the engine version changes', () => {
    const c = buildCatalog(allow, installed, report, { ...ENGINE, version: '1.53.0' });
    expect(c.filter(isSelectable)).toEqual([]);
  });
});

describe('storage + redaction', () => {
  it('only accepts server-generated keys and blocks traversal', () => {
    const s = new LocalStorageDriver('/tmp/vs');
    expect(() => s.localPath('../../etc/passwd')).toThrow();
    expect(() => s.localPath('a/b/c.wav')).toThrow();
    const id = '00000000-0000-4000-8000-000000000000';
    expect(assetStorageKey(id, id, id, 'wav')).toBe(`${id}/${id}/${id}.wav`);
  });
  it('redacts paths from tool output', () => {
    expect(redactToolOutput('error in C:\\Users\\me\\x.wav and /var/tmp/job/a.wav')).toBe(
      'error in <path> and <path>',
    );
  });
});
