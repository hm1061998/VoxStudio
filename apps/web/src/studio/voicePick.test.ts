import { describe, expect, it } from 'vitest';
import type { VoiceDto } from '@voxstudio/contracts';
import { availableAccents, availableGenders, pickVoice } from './voicePick';

const v = (
  id: string,
  engineId: string,
  accent: string,
  gender: 'female' | 'male' | null,
  locale = 'vi-VN',
): VoiceDto => ({ id, engineId, displayName: id, accent, gender, locale }) as unknown as VoiceDto;

const ALL = [
  v('espeak:vi', 'espeak', 'northern', null),
  v('espeak:vi-vn-x-central', 'espeak', 'central', null),
  v('espeak:vi-vn-x-south', 'espeak', 'southern', null),
  v('vieneu:ngoc-huyen', 'vieneu', 'northern', 'female'),
  v('vieneu:hai-dang', 'vieneu', 'northern', 'male'),
  v('vieneu:ngoc-tran', 'vieneu', 'central', 'female'),
  v('vieneu:quang-son', 'vieneu', 'central', 'male'),
  v('vieneu:thuy-dung', 'vieneu', 'southern', 'female'),
  v('vieneu:adam', 'vieneu', 'southern', 'male'),
  v('espeak:en-us', 'espeak', 'general', null, 'en-US'),
];
const byId = (id: string) => ALL.find((x) => x.id === id)!;

describe('choosing a voice by region and gender', () => {
  it('lists only accents and genders that really exist', () => {
    expect(availableAccents(ALL, 'vi-VN')).toEqual(['central', 'northern', 'southern']);
    expect(availableGenders(ALL, 'vi-VN')).toEqual(['female', 'male']);
    expect(availableGenders(ALL, 'en-US')).toEqual([]);
    expect(availableAccents(ALL, 'vi-VN', 'male')).toEqual(['central', 'northern', 'southern']);
    const noSouthMale = ALL.filter((x) => x.id !== 'vieneu:adam');
    expect(availableAccents(noSouthMale, 'vi-VN', 'male')).toEqual(['central', 'northern']);
    expect(availableGenders(noSouthMale, 'vi-VN', 'southern')).toEqual(['female']);
  });

  it('switches gender within the same region and keeps the engine', () => {
    expect(pickVoice(ALL, byId('vieneu:ngoc-huyen'), { accent: 'northern', gender: 'male' })?.id).toBe(
      'vieneu:hai-dang',
    );
    expect(pickVoice(ALL, byId('vieneu:hai-dang'), { accent: 'central', gender: 'male' })?.id).toBe(
      'vieneu:quang-son',
    );
    expect(pickVoice(ALL, byId('vieneu:quang-son'), { accent: 'southern', gender: 'male' })?.id).toBe(
      'vieneu:adam',
    );
  });

  it('keeps the current voice when it already satisfies the wish', () => {
    expect(pickVoice(ALL, byId('vieneu:hai-dang'), { accent: 'northern', gender: 'male' })?.id).toBe(
      'vieneu:hai-dang',
    );
    expect(pickVoice(ALL, byId('espeak:vi'), { accent: 'northern' })?.id).toBe('espeak:vi');
  });

  it('moves from a rule-based voice to an AI voice only when a gender is asked for (the caller explains the switch)', () => {
    expect(pickVoice(ALL, byId('espeak:vi'), { accent: 'northern', gender: 'female' })?.id).toBe(
      'vieneu:ngoc-huyen',
    );
  });

  it('prefers the same engine when only the region changes', () => {
    expect(pickVoice(ALL, byId('espeak:vi'), { accent: 'southern' })?.id).toBe('espeak:vi-vn-x-south');
    expect(pickVoice(ALL, byId('vieneu:ngoc-huyen'), { accent: 'southern' })?.id).toBe('vieneu:adam');
  });

  it('never crosses language and returns nothing when nothing matches', () => {
    expect(pickVoice(ALL, byId('vieneu:ngoc-huyen'), { accent: 'general' })).toBeUndefined();
    const noSouthMale = ALL.filter((x) => x.id !== 'vieneu:adam');
    expect(
      pickVoice(noSouthMale, byId('vieneu:quang-son'), { accent: 'southern', gender: 'male' }),
    ).toBeUndefined();
  });
});
