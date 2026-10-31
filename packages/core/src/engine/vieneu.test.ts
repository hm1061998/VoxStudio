import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_LIMITS, effectivePriority, resolvePlanLimits, usageMonth } from '../plans';
import { splitForModel, voiceSlug } from './vieneu';

describe('voice ids for the AI engine', () => {
  it('turns Vietnamese preset names into ASCII slugs the catalog accepts', () => {
    expect(voiceSlug('Ngọc Huyền')).toBe('ngoc-huyen');
    expect(voiceSlug('Hải Đăng')).toBe('hai-dang');
    expect(voiceSlug('Thùy Dung')).toBe('thuy-dung');
    expect(voiceSlug('  Đức   Trí ')).toBe('duc-tri');
    for (const n of ['Ngọc Huyền', 'Quang Sơn', 'Ngọc Trân'])
      expect(`vieneu:${voiceSlug(n)}`).toMatch(/^[a-z0-9]+:[a-z0-9_-]{1,40}$/);
  });
});

describe('splitting long text for the model service', () => {
  it('keeps short text as one piece', () => {
    expect(splitForModel('Xin chào các bạn.', 600)).toEqual(['Xin chào các bạn.']);
    expect(splitForModel('   ', 600)).toEqual([]);
  });

  it('breaks at sentence ends and never exceeds the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Đây là câu số ${i} của đoạn văn thử nghiệm.`).join(
      ' ',
    );
    const pieces = splitForModel(text, 200);
    expect(pieces.length).toBeGreaterThan(5);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect(p).toMatch(/[.]$/); // pieces end at sentence boundaries
    }
    expect(pieces.join(' ')).toBe(text);
  });

  it('splits one very long sentence at commas, then spaces, losing no words', () => {
    const text = Array.from({ length: 80 }, (_, i) => `từ${i}`).join(', ');
    const pieces = splitForModel(text, 120);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(120);
    expect(pieces.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
    const noSpaces = 'a'.repeat(500);
    expect(splitForModel(noSpaces, 100).every((p) => p.length <= 100)).toBe(true);
  });
});

describe('plans', () => {
  it('defaults rise from free to business and meter AI characters', () => {
    const { free, pro, business } = DEFAULT_PLAN_LIMITS;
    expect(free.priority).toBeLessThan(pro.priority);
    expect(pro.priority).toBeLessThan(business.priority);
    expect(free.aiMonthlyChars).not.toBeNull();
    expect(business.aiMonthlyChars).toBeNull();
  });

  it('accepts partial overrides and rejects mistakes loudly', () => {
    const l = resolvePlanLimits('{"pro":{"aiMonthlyChars":1000000},"free":{"maxPendingJobs":2}}');
    expect(l.pro.aiMonthlyChars).toBe(1_000_000);
    expect(l.pro.priority).toBe(DEFAULT_PLAN_LIMITS.pro.priority);
    expect(l.free.maxPendingJobs).toBe(2);
    expect(resolvePlanLimits('')).toEqual(DEFAULT_PLAN_LIMITS);
    expect(() => resolvePlanLimits('{"gold":{}}')).toThrow();
    expect(() => resolvePlanLimits('{"free":{"priority":50}}')).toThrow(/must not decrease/);
    expect(() => resolvePlanLimits('{"free":{"bogus":1}}')).toThrow();
    expect(() => resolvePlanLimits('not json')).toThrow();
  });

  it('aging adds one point per interval waited, never a negative amount', () => {
    expect(effectivePriority(10, 0, 30)).toBe(10);
    expect(effectivePriority(0, 299, 30)).toBe(9);
    expect(effectivePriority(0, 300, 30)).toBe(10);
    expect(effectivePriority(5, -10, 30)).toBe(5);
    expect(usageMonth(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
  });
});
