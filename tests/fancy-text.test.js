/* Test cho fancy-text.js — chạy: node tests/fancy-text.test.js */
'use strict';

const FANCY = require('../fancy-text.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`✘ ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `nhận ${JSON.stringify(actual)}, muốn ${JSON.stringify(expected)}`);
}

/* 1. Detect + normalize từng style phổ biến */
{
  const r = FANCY.normalizeStyledText('𝕙𝕖𝕝𝕝𝕠 𝕨𝕠𝕣𝕝𝕕');
  eq('doubleStruck detect style', r?.style, 'doubleStruck');
  eq('doubleStruck normalize', r?.text, 'hello world');
}
{
  const r = FANCY.normalizeStyledText('𝐡𝐞𝐥𝐥𝐨');
  eq('bold detect', r?.style, 'bold');
  eq('bold normalize', r?.text, 'hello');
}
{
  const r = FANCY.normalizeStyledText('𝓈𝓉𝓎𝓁𝑒');
  eq('script detect (qua override ℯ)', r?.style, 'script');
  eq('script normalize', r?.text, 'style');
}
{
  const r = FANCY.normalizeStyledText('ᴛɪɴʏ ᴄᴀᴘs');
  eq('smallCaps detect', r?.style, 'smallCaps');
  eq('smallCaps normalize', r?.text, 'tiny caps');
}
{
  const r = FANCY.normalizeStyledText('ｈｅｌｌｏ　ｗｏｒｌｄ');
  eq('fullwidth detect', r?.style, 'fullwidth');
  eq('fullwidth normalize', r?.text, 'hello　world'); // space fullwidth giữ nguyên
}
{
  const r = FANCY.normalizeStyledText('ⓗⓔⓛⓛⓞ');
  eq('circled detect', r?.style, 'circled');
  eq('circled normalize', r?.text, 'hello');
}
{
  const r = FANCY.normalizeStyledText('ᵐᵒⁿᵒᵈᵉⁿ');
  eq('superscript detect', r?.style, 'superscript');
  eq('superscript normalize', r?.text, 'monoden');
}

/* 2. Ký tự "lỗ" nằm ngoài dải chính (Letterlike Symbols 21xx) */
{
  const r = FANCY.normalizeStyledText('ℬℰ');
  eq('script override B E detect', r?.style, 'script');
  eq('script override normalize', r?.text, 'BE');
}
{
  const r = FANCY.normalizeStyledText('ℭ𝔞𝔱');
  eq('fraktur override C detect', r?.style, 'fraktur');
  eq('fraktur override normalize', r?.text, 'Cat');
}
{
  const r = FANCY.normalizeStyledText('ℎ𝑒𝑙𝑙𝑜');
  eq('italic override h detect', r?.style, 'italic');
  eq('italic override normalize', r?.text, 'hello');
}
{
  const r = FANCY.normalizeStyledText('ℂ𝕠𝕠𝕝');
  eq('doubleStruck override C detect', r?.style, 'doubleStruck');
  eq('doubleStruck override normalize', r?.text, 'Cool');
}

/* 3. Text thường / lẫn ít fancy → KHÔNG coi là fancy */
eq('plain text -> null', FANCY.normalizeStyledText('hello world'), null);
eq('chủ yếu plain, vài fancy -> null', FANCY.normalizeStyledText('hello bạn 𝕩𝕚𝕟'), null);
eq('chỉ 1 ký tự fancy -> null', FANCY.normalizeStyledText('𝕩in chào'), null);

/* 4. applyStyle: gán style + bỏ dấu thanh */
{
  const out = FANCY.applyStyleToText('hello world', 'doubleStruck');
  eq('apply doubleStruck', out, '𝕙𝕖𝕝𝕝𝕠 𝕨𝕠𝕣𝕝𝕕');
}
{
  const out = FANCY.applyStyleToText('xin chao the gioi', 'bold');
  eq('apply bold quay vòng', FANCY.normalizeStyledText(out)?.text, 'xin chao the gioi');
}
{
  const out = FANCY.applyStyleToText('xin chào thế giới', 'doubleStruck');
  check('apply bỏ dấu (không còn combining mark)', !/\p{M}/u.test(out.normalize('NFD')));
  eq('apply bỏ dấu quay vòng', FANCY.normalizeStyledText(out)?.text, 'xin chao the gioi');
}
{
  const out = FANCY.applyStyleToText('ok 🔥❤️ nhé', 'bold');
  check('emoji giữ nguyên', out.includes('🔥') && out.includes('❤️'));
  check('emoji không bị bóc variation selector', out.includes('❤️'));
}
{
  const out = FANCY.applyStyleToText('ABC xyz 123', 'circled');
  eq('circled hoa+thường+số', out, 'ⒶⒷⒸ ⓧⓨⓩ ①②③');
}
{
  const out = FANCY.applyStyleToText('ab', 'negativeCircled');
  eq('negativeCircled thường -> hoa 🅐', out, '🅐🅑');
}
{
  const out = FANCY.applyStyleToText('STYLE', 'squared');
  eq('squared', out, '🅂🅃🅈🄻🄴');
}
{
  eq('style lạ -> nguyên văn', FANCY.applyStyleToText('abc', 'khong-ton-tai'), 'abc');
}

/* 5. Quay vòng đầy đủ mọi style đăng ký: normalize(apply(ascii)) == ascii.
 * Style 1 dạng chữ (negativeCircled/squared: chỉ hoa; parenthesized/smallCaps/
 * superscript/subscript: dạng thường) không giữ được case — so sánh lowercase. */
const SINGLE_FORM_STYLES = new Set(['negativeCircled', 'squared', 'parenthesized', 'smallCaps', 'superscript', 'subscript']);
for (const id of FANCY.STYLE_IDS) {
  const styled = FANCY.applyStyleToText('Abc Xyz 09', id);
  const back = FANCY.normalizeStyledText(styled);
  const actual = SINGLE_FORM_STYLES.has(id) ? back?.text.toLowerCase() : back?.text;
  const expected = SINGLE_FORM_STYLES.has(id) ? 'abc xyz 09' : 'Abc Xyz 09';
  eq(`round-trip ${id}`, actual, expected);
}

/* 6. applyStyle với chữ không có trong bảng (subscript thiếu nhiều chữ) */
{
  const out = FANCY.applyStyleToText('bd', 'subscript'); // b,d không có subscript
  eq('subscript thiếu chữ -> giữ nguyên chữ đó', out, 'bd');
}

console.log(failed ? `\n${failed} test FAIL, ${passed} PASS` : `Tất cả test fancy-text.js đều PASS ✔ (${passed} test)`);
process.exit(failed ? 1 : 0);
