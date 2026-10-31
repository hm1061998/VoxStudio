import { describe, expect, it } from 'vitest';
import { SENTENCES, TONE_NAMES, TONE_SETS } from '../../../../benchmark/vi/sentences.mjs';
import { readInteger, readNumber } from './numbers';
import { prepareEngineText } from '../text/prepare';
import { PROFILES, pronounce } from './profiles';
import { identifyTone, parseSyllable, TONES } from './syllable';
import { BUILTIN_LEXICON, LETTER_NAMES, analyzeVietnamese } from './text';

const N = PROFILES.northern;
const S = PROFILES.southern;
const parts = (s: string) => {
  const r = parseSyllable(s);
  if (!r.ok) throw new Error(`${s}: ${r.reason}`);
  const { onset, glide, nucleus, coda, tone } = r.syllable;
  return [onset, glide, nucleus, coda, tone].join('|');
};

describe('syllable segmentation', () => {
  it('splits onset, medial glide, nucleus, coda and tone', () => {
    expect(parts('chào')).toBe('ch||a|o|huyen');
    expect(parts('nghiêng')).toBe('ngh||iê|ng|ngang');
    expect(parts('quyền')).toBe('q|u|yê|n|huyen');
    expect(parts('toán')).toBe('t|o|a|n|sac');
    expect(parts('hoa')).toBe('h|o|a||ngang');
    expect(parts('huy')).toBe('h|u|y||ngang');
    expect(parts('thuê')).toBe('th|u|ê||ngang');
    expect(parts('tuần')).toBe('t|u|â|n|huyen');
    expect(parts('mua')).toBe('m||ua||ngang');
    expect(parts('cuối')).toBe('c||uô|i|sac');
    expect(parts('người')).toBe('ng||ươ|i|huyen');
    expect(parts('yêu')).toBe('||yê|u|ngang');
    expect(parts('oai')).toBe('|o|a|i|ngang');
  });
  it('handles gi, gì, qu and zero onsets', () => {
    expect(parts('giá')).toBe('gi||a||sac');
    expect(parts('gì')).toBe('gi||i||huyen');
    expect(parts('gin')).toBe('gi||i|n|ngang');
    expect(parts('quá')).toBe('q|u|a||sac');
    expect(parts('ăn')).toBe('||ă|n|ngang');
    expect(parts('Ôi')).toBe('||ô|i|ngang');
  });
  it('identifies all six tones, including marks combined with vowel accents', () => {
    for (const set of TONE_SETS)
      set.forEach((syl: string, i: number) => expect(identifyTone(syl), syl).toBe(TONES[i]));
    expect(identifyTone('ập')).toBe('nang');
    expect(identifyTone('ẫu')).toBe('nga');
    expect(identifyTone('Việt')).toBe('nang');
    expect(TONE_NAMES).toHaveLength(6);
  });
  it('rejects strings that are not well-formed syllables instead of guessing', () => {
    for (const bad of ['ci', 'ngha', 'qa', 'hello', 'wifi', 'cac', 'mías', 'xyz'])
      expect(parseSyllable(bad).ok, bad).toBe(false);
    expect(parseSyllable('qa')).toMatchObject({ ok: false, reason: 'q-without-u' });
    expect(parseSyllable('càc')).toMatchObject({ ok: false, reason: 'stop-coda-requires-sac-or-nang' });
    expect(parseSyllable('mía')).toMatchObject({ ok: true });
    for (const good of ['các', 'cạc', 'mìa', 'nghe', 'ghế', 'kia', 'quý', 'khuya'])
      expect(parseSyllable(good).ok, good).toBe(true);
  });
});

describe('pronunciation conversion', () => {
  const p = (w: string, prof = N) => {
    const r = parseSyllable(w);
    if (!r.ok) throw new Error(w);
    return pronounce(r.syllable, prof);
  };
  it('converts syllables to phonemes with tone numbers', () => {
    expect(p('má').phonemes).toEqual(['m', 'a']);
    expect(p('má').toneNumber).toBe(3);
    expect(p('quốc').phonemes).toEqual(['k', 'w', 'o', 'k']);
    expect(p('nặng').toneNumber).toBe(6);
    expect(p('nặng').phonemes).toEqual(['n', 'ă', 'ŋ']);
  });
  it('differs between regional profiles only where modelled', () => {
    expect(p('vui', N).phonemes[0]).toBe('v');
    expect(p('vui', S).phonemes[0]).toBe('j');
    expect(p('má', N).ipa).toBe(p('má', S).ipa);
  });
});

describe('numbers', () => {
  const n = (d: string, prof = N) => readNumber(d, prof);
  it('reads integers', () => {
    expect(n('0')).toBe('không');
    expect(n('5')).toBe('năm');
    expect(n('10')).toBe('mười');
    expect(n('11')).toBe('mười một');
    expect(n('15')).toBe('mười lăm');
    expect(n('21')).toBe('hai mươi mốt');
    expect(n('25')).toBe('hai mươi lăm');
    expect(n('100')).toBe('một trăm');
    expect(n('105')).toBe('một trăm linh năm');
    expect(n('105', S)).toBe('một trăm lẻ năm');
    expect(n('110')).toBe('một trăm mười');
    expect(n('2025')).toBe('hai nghìn không trăm hai mươi lăm');
    expect(n('2025', S)).toBe('hai ngàn không trăm hai mươi lăm');
    expect(n('1.250.000')).toBe('một triệu hai trăm năm mươi nghìn');
    expect(n('1.000.005')).toBe('một triệu không trăm linh năm');
    expect(n('20.000')).toBe('hai mươi nghìn');
    expect(n('1000000000')).toBe('một tỉ');
  });
  it('reads decimals digit by digit and codes digit by digit', () => {
    expect(n('3,14')).toBe('ba phẩy một bốn');
    expect(n('12,5')).toBe('mười hai phẩy năm');
    expect(n('3.14')).toBe('ba phẩy một bốn');
    expect(n('0,05')).toBe('không phẩy không năm');
    expect(n('007')).toBe('không không bảy');
    expect(readInteger('1234567890123456', N)).toMatch(/^một hai ba/);
  });
  it('produces only valid Vietnamese syllables across a wide range', () => {
    for (let i = 0; i < 100000; i += 37)
      for (const w of readNumber(String(i), N).split(' '))
        expect(parseSyllable(w).ok, `${i}: ${w}`).toBe(true);
  });
});

describe('text analysis', () => {
  const words = (t: string, o = {}) =>
    analyzeVietnamese(t, o)
      .phrases.flatMap((p) => p.tokens.map((x) => x.syllable.text))
      .join(' ');
  it('expands numbers, symbols and Latin terms', () => {
    expect(words('Có 21 người')).toBe('có hai mươi mốt người');
    expect(words('Thứ 4')).toBe('thứ tư');
    expect(words('5 + 3 = 8')).toBe('năm cộng ba bằng tám');
    expect(words('Gửi email cho tôi')).toBe('gửi i meo cho tôi');
    expect(words('Đài VTV')).toBe('đài vê tê vê');
    expect(words('Chuyến bay VN123')).toBe('chuyến bay vê en một hai ba');
    expect(words('Wi-Fi')).toBe('oai phai');
  });
  it('reports unknown Latin words instead of guessing', () => {
    expect(analyzeVietnamese('Tôi dùng blockchain mỗi ngày').unresolved).toEqual(['blockchain']);
  });
  it('user lexicon overrides the built-in one', () => {
    expect(words('email', { userLexicon: { email: 'thư điện tử' } })).toBe('thư điện tử');
  });
  it('builds phrases with boundaries and sentence types', () => {
    const a = analyzeVietnamese('Xin chào, bạn khỏe không? Tôi khỏe. Tuyệt vời!');
    expect(a.phrases.map((p) => [p.tokens.length, p.type, p.boundary])).toEqual([
      [2, 'statement', 'minor'],
      [3, 'question', 'major'],
      [2, 'statement', 'major'],
      [2, 'exclamation', 'end'],
    ]);
    expect(a.phrases[1]!.terminal).toBe('?');
  });
  it('marks emphasis with *word*', () => {
    const a = analyzeVietnamese('Tôi *rất* thích');
    expect(a.phrases[0]!.tokens.map((t) => t.emphasis)).toEqual([false, true, false]);
  });
  it('splits long phrases before a conjunction', () => {
    const a = analyzeVietnamese(
      'Hôm nay tôi đi chợ mua rau thịt cá và sau đó tôi về nhà nấu cơm cho cả gia đình',
    );
    expect(a.phrases.length).toBeGreaterThan(1);
    expect(a.phrases[0]!.boundary).toBe('minor');
    expect(a.phrases[1]!.tokens[0]!.syllable.text).toBe('và');
  });
  it('lexicon respellings and letter names are all valid syllables', () => {
    for (const v of [...Object.values(BUILTIN_LEXICON), ...Object.values(LETTER_NAMES)])
      for (const w of v.split(' ')) expect(parseSyllable(w).ok, w).toBe(true);
  });
});

describe('coverage of the fixed benchmark (vi-bench-1), after the real normalization step', () => {
  it('lists exactly which tokens remain unresolved (they need dictionary entries; never guessed)', () => {
    const unresolved = new Set<string>();
    for (const s of SENTENCES)
      for (const c of prepareEngineText(s.text, 'vi-VN', 'vnunit', []).chunks)
        if (c.kind === 'speech') for (const u of analyzeVietnamese(c.text).unresolved) unresolved.add(u);
    expect([...unresolved].sort()).toEqual([
      'huong',
      'lien',
      'marketing',
      'startup',
      'team',
      'vn',
      'vox',
      'voxstudio',
    ]);
  });
  it('every other benchmark token becomes a valid Vietnamese syllable', () => {
    let syllables = 0;
    for (const s of SENTENCES)
      for (const c of prepareEngineText(s.text, 'vi-VN', 'vnunit', []).chunks)
        if (c.kind === 'speech')
          syllables += analyzeVietnamese(c.text).phrases.reduce((n, p) => n + p.tokens.length, 0);
    expect(syllables).toBe(1430);
  });
});
