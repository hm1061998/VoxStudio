import { describe, expect, it } from 'vitest';
import { normalizeText } from './text/normalize';
import { splitText } from './text/segmentation';

const n = (s: string) => normalizeText(s, 'vi-VN').text;

describe('Vietnamese normalization', () => {
  it('expands dates', () => {
    expect(n('Hôm nay là 31/10/2026.')).toBe('Hôm nay là ngày 31 tháng 10 năm 2026.');
    expect(n('Hạn chót 05-01-2027')).toBe('Hạn chót ngày 5 tháng 1 năm 2027');
    expect(n('2026-10-31')).toBe('ngày 31 tháng 10 năm 2026');
    expect(n('vào ngày 3/4 tới')).toBe('vào ngày 3 tháng 4 tới');
    expect(n('chiếm 3/4 diện tích')).toBe('chiếm 3/4 diện tích');
    expect(n('mã 45/13/2026')).toBe('mã 45/13/2026');
  });
  it('expands times', () => {
    expect(n('Họp lúc 14h30 và 8:05.')).toBe('Họp lúc 14 giờ 30 và 8 giờ 5.');
    expect(n('Mở cửa từ 7h đến 22h')).toBe('Mở cửa từ 7 giờ đến 22 giờ');
  });
  it('reads currency, percent, units', () => {
    expect(n('Giá 150.000đ, giảm 15%.')).toBe('Giá 150.000 đồng, giảm 15 phần trăm.');
    expect(n('Tổng 2.500.000 VNĐ hoặc $20')).toBe('Tổng 2.500.000 đồng hoặc 20 đô la');
    expect(n('Đi 12km với 60 km/h, nặng 3kg')).toBe(
      'Đi 12 ki lô mét với 60 ki lô mét trên giờ, nặng 3 ki lô gam',
    );
    expect(n('Nhiệt độ 30°C')).toBe('Nhiệt độ 30 độ C');
  });
  it('expands common abbreviations only as whole tokens', () => {
    expect(n('UBND TP.HCM thông báo')).toBe('Ủy ban nhân dân Thành phố Hồ Chí Minh thông báo');
    expect(n('PGS. TS. Lan, ThS. Minh, v.v.')).toBe('phó giáo sư tiến sĩ Lan, thạc sĩ Minh, vân vân');
    expect(n('nhà ở Q.3')).toBe('nhà ở quận 3');
    expect(n('UBNDX')).toBe('UBNDX');
  });
  it('spells URLs and emails in Vietnamese', () => {
    expect(n('Xem https://voxstudio.vn/huong-dan')).toBe(
      'Xem voxstudio chấm vn gạch chéo huong gạch ngang dan',
    );
    expect(n('lien.he@vox.vn')).toBe('lien chấm he a còng vox chấm vn');
  });
  it('records nothing for plain text', () => {
    const r = normalizeText('Xin chào các bạn.', 'vi-VN');
    expect(r).toEqual({ text: 'Xin chào các bạn.', steps: [], warnings: [] });
  });
  it('splits Vietnamese sentences', () => {
    expect(splitText('Xin chào. Hôm nay trời đẹp! Bạn khỏe không?', 'sentence', 'vi-VN')).toEqual([
      'Xin chào.',
      'Hôm nay trời đẹp!',
      'Bạn khỏe không?',
    ]);
  });
});

describe('Vietnamese normalization: ranges, phone numbers, Roman numerals', () => {
  it('reads numeric ranges with "đến"', () => {
    expect(n('10-20 người')).toBe('10 đến 20 người');
    expect(n('từ 5–7 giờ')).toBe('từ 5 đến 7 giờ');
    expect(n('giá 1,5 - 2 triệu')).toBe('giá 1,5 đến 2 triệu');
    expect(n('năm 2025-2026')).toBe('năm 2025 đến 2026');
  });
  it('leaves things that are not ranges alone', () => {
    expect(n('COVID-19 và Wi-Fi')).toBe('COVID-19 và Wi-Fi');
    expect(n('tỉ số 3-2')).toBe('tỉ số 3-2');
    expect(n('nhiệt độ -5 độ')).toBe('nhiệt độ -5 độ');
    expect(n('mã A10-20')).toBe('mã A10-20');
  });
  it('does not turn dates into ranges', () => {
    expect(n('hạn 05-01-2027')).toBe('hạn ngày 5 tháng 1 năm 2027');
  });
  it('reads phone numbers digit by digit in groups', () => {
    expect(n('Gọi 0912 345 678 nhé')).toBe('Gọi không chín một hai, ba bốn năm, sáu bảy tám nhé');
    expect(n('0912.345.678')).toBe('không chín một hai, ba bốn năm, sáu bảy tám');
    expect(n('+84 912 345 678')).toBe('cộng tám bốn, chín một hai, ba bốn năm, sáu bảy tám');
    expect(n('SĐT 024 3825 1234')).toBe('SĐT không hai bốn, ba tám hai năm, một hai ba bốn');
  });
  it('does not treat ordinary numbers as phone numbers', () => {
    expect(n('1.250.000 đồng')).toBe('1.250.000 đồng');
    expect(n('mã số 12345678')).toBe('mã số 12345678');
  });
  it('converts Roman numerals only in a known context', () => {
    expect(n('thế kỷ XXI')).toBe('thế kỷ 21');
    expect(n('Thế chiến II')).toBe('Thế chiến 2');
    expect(n('Chương IV và quý III')).toBe('Chương 4 và quý 3');
    expect(n('Đại hội XIII')).toBe('Đại hội 13');
    expect(n('phần IIII')).toBe('phần IIII');
    expect(n('phần i')).toBe('phần i');
    expect(n('Quang Trung II')).toBe('Quang Trung II');
  });
});
