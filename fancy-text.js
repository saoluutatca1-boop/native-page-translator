/* ========================================================================
 * NPT Fancy Text — xử lý "font đặc biệt" Unicode (𝕕𝕠𝕦𝕓𝕝𝕖-𝕤𝕥𝕣𝕦𝕔𝕜,
 * 𝓈𝒸𝓇𝒾𝓅𝓉, ᴛɪɴʏ ᴄᴀᴘs, ｆｕｌｌｗｉｄｔｈ, ⓒⓘⓡⓒⓛⓔⓓ, 🅂🅀🅄🄰🅁🄴🄳...).
 *
 * Engine dịch (Google/DeepL/LLM) KHÔNG hiểu các ký tự này là chữ cái nên
 * trả về nguyên xi. Quy trình xử lý:
 *   1. normalizeStyledText: fancy → ASCII trần + style chiếm đa số
 *   2. dịch chuỗi ASCII như bình thường
 *   3. applyStyleToText: gán lại style vào bản dịch
 *      (block fancy chỉ có a-z/A-Z/0-9 trần → bỏ dấu combining marks;
 *      đây là lựa chọn đã chốt: "bỏ dấu, giữ font đẹp").
 *
 * JS thuần (không chrome.*): chạy được trong content script lẫn node (test).
 * ====================================================================== */
(function attachFancyText(global) {
  'use strict';

  const STYLE_IDS = [
    'bold', 'italic', 'boldItalic', 'script', 'boldScript', 'fraktur',
    'doubleStruck', 'boldFraktur', 'sans', 'sansBold', 'sansItalic',
    'sansBoldItalic', 'monospace', 'fullwidth', 'circled', 'negativeCircled',
    'squared', 'parenthesized', 'smallCaps', 'superscript', 'subscript',
  ];

  const REVERSE = new Map(); // glyph -> { ch, style }
  const FORWARD = new Map(); // styleId -> Map(ascii -> glyph)
  for (const id of STYLE_IDS) FORWARD.set(id, new Map());

  function register(style, asciiChar, codepoint) {
    const glyph = String.fromCodePoint(codepoint);
    FORWARD.get(style).set(asciiChar, glyph);
    // KHÔNG đăng ký reverse cho mapping đồng nhất (x→x): tránh đếm nhầm
    // chữ thường thành "font đặc biệt" lúc detect.
    if (glyph !== asciiChar && !REVERSE.has(glyph)) REVERSE.set(glyph, { ch: asciiChar, style });
  }

  function registerRange(style, baseCodepoint, firstCharCode, count, holes) {
    for (let i = 0; i < count; i++) {
      const cp = baseCodepoint + i;
      if (holes && holes.has(cp)) continue;
      register(style, String.fromCharCode(firstCharCode + i), cp);
    }
  }

  const A = 65; // 'A'
  const a = 97; // 'a'
  const D0 = 48; // '0'

  /* --- Mathematical Alphanumeric Symbols (1D400–1D7FF) ---
   * Một số block có "lỗ" (codepoint reserved) — ký tự đó nằm ở block
   * Letterlike Symbols (21xx) nên map riêng qua OVERRIDES. */
  const HOLES = new Set([
    0x1D455, // italic h (thật: 210E)
    0x1D49D, 0x1D4A0, 0x1D4A1, 0x1D4A3, 0x1D4A4, 0x1D4A7, 0x1D4A8, 0x1D4AD, // script B E F H I L M R
    0x1D4BA, 0x1D4BC, 0x1D4C4, // script e g o
    0x1D506, 0x1D50B, 0x1D50C, 0x1D515, 0x1D51D, // fraktur C H I R Z
    0x1D53A, 0x1D53F, 0x1D545, 0x1D547, 0x1D548, 0x1D549, 0x1D551, // doubleStruck C H N P Q R Z
  ]);

  const MATH_STYLES = {
    bold: { upper: 0x1D400, lower: 0x1D41A, digits: 0x1D7CE },
    italic: { upper: 0x1D434, lower: 0x1D44E },
    boldItalic: { upper: 0x1D468, lower: 0x1D482 },
    script: { upper: 0x1D49C, lower: 0x1D4B6 },
    boldScript: { upper: 0x1D4D0, lower: 0x1D4EA },
    fraktur: { upper: 0x1D504, lower: 0x1D51E },
    doubleStruck: { upper: 0x1D538, lower: 0x1D552, digits: 0x1D7D8 },
    boldFraktur: { upper: 0x1D56C, lower: 0x1D586 },
    sans: { upper: 0x1D5A0, lower: 0x1D5BA, digits: 0x1D7E2 },
    sansBold: { upper: 0x1D5D4, lower: 0x1D5EE, digits: 0x1D7EC },
    sansItalic: { upper: 0x1D608, lower: 0x1D622 },
    sansBoldItalic: { upper: 0x1D63C, lower: 0x1D656 },
    monospace: { upper: 0x1D670, lower: 0x1D68A, digits: 0x1D7F6 },
  };

  const MATH_OVERRIDES = {
    italic: { h: 0x210E },
    script: { B: 0x212C, E: 0x2130, F: 0x2131, H: 0x210B, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211B, e: 0x212F, g: 0x210A, o: 0x2134 },
    fraktur: { C: 0x212D, H: 0x210C, I: 0x2111, R: 0x211C, Z: 0x2128 },
    doubleStruck: { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 },
  };

  for (const [style, ranges] of Object.entries(MATH_STYLES)) {
    registerRange(style, ranges.upper, A, 26, HOLES);
    registerRange(style, ranges.lower, a, 26, HOLES);
    if (ranges.digits) registerRange(style, ranges.digits, D0, 10, HOLES);
    for (const [ch, cp] of Object.entries(MATH_OVERRIDES[style] || {})) register(style, ch, cp);
  }

  /* --- Các block rồi --- */
  registerRange('fullwidth', 0xFF21, A, 26);
  registerRange('fullwidth', 0xFF41, a, 26);
  registerRange('fullwidth', 0xFF10, D0, 10);

  registerRange('circled', 0x24B6, A, 26);
  registerRange('circled', 0x24D0, a, 26);
  register('circled', '0', 0x24EA);
  for (let i = 1; i <= 9; i++) register('circled', String.fromCharCode(D0 + i), 0x2460 + i - 1);

  registerRange('negativeCircled', 0x1F150, A, 26); // 🅐 — chỉ có hoa
  registerRange('squared', 0x1F130, A, 26); // 🄰 — chỉ có hoa
  registerRange('parenthesized', 0x249C, a, 26); // ⓐ — chỉ có thường

  // Chỉ có 1 dạng hoa → hướng cả chữ thường về glyph hoa (và ngược lại).
  for (const style of ['negativeCircled', 'squared']) {
    for (let i = 0; i < 26; i++) {
      FORWARD.get(style).set(String.fromCharCode(a + i), FORWARD.get(style).get(String.fromCharCode(A + i)));
    }
  }
  for (let i = 0; i < 26; i++) {
    FORWARD.get('parenthesized').set(String.fromCharCode(A + i), FORWARD.get('parenthesized').get(String.fromCharCode(a + i)));
  }

  /* --- Bảng chữ rải rác (small caps / superscript / subscript) --- */
  const SMALL_CAPS = {
    a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ',
    n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ꞯ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
  };
  const SUPERSCRIPT = {
    a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ',
    n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  };
  const SUBSCRIPT = {
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
    s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  };

  function registerAlphabet(style, table, bothCases) {
    for (const [ch, glyph] of Object.entries(table)) {
      const codepoints = [...glyph];
      const cp = codepoints.length === 1 ? glyph.codePointAt(0) : null;
      if (cp !== null) register(style, ch, cp);
      if (bothCases && /[a-z]/.test(ch)) {
        // Hoa/thường cùng 1 glyph (small caps, superscript... chỉ có 1 dạng).
        FORWARD.get(style).set(ch.toUpperCase(), glyph);
      }
    }
  }
  registerAlphabet('smallCaps', SMALL_CAPS, true);
  registerAlphabet('superscript', SUPERSCRIPT, true);
  registerAlphabet('subscript', SUBSCRIPT, true);

  /* ------------------------------------------------------------------
   * normalizeStyledText(text) -> { text, style } | null
   * Đủ điều kiện khi ≥2 ký tự styled VÀ styled chiếm ≥60% tổng chữ cái
   * (text lẫn vài ký tự fancy cho vui thì để engine xử lý như thường).
   * style = style chiếm đa số trong các ký tự styled.
   * ------------------------------------------------------------------ */
  function normalizeStyledText(input) {
    const text = String(input ?? '');
    if (!text) return null;

    let styledCount = 0;
    let letterCount = 0;
    const styleVotes = new Map();
    let out = '';

    for (const ch of text) {
      if (/\p{L}/u.test(ch)) letterCount++;
      const hit = REVERSE.get(ch);
      if (hit) {
        styledCount++;
        styleVotes.set(hit.style, (styleVotes.get(hit.style) || 0) + 1);
        out += hit.ch;
      } else {
        out += ch;
      }
    }

    if (styledCount < 2 || styledCount < letterCount * 0.6) return null;

    let style = null;
    let best = 0;
    for (const [id, count] of styleVotes) {
      if (count > best) {
        best = count;
        style = id;
      }
    }
    return style ? { text: out, style } : null;
  }

  /* ------------------------------------------------------------------
   * applyStyleToText(text, styleId) -> chuỗi fancy.
   * NFD + bỏ combining marks (dấu thanh à/ế/ớ...) để còn a-z trần rồi gán
   * style — GIỮ variation selector (FE0E/FE0F) và keycap (20E3) để emoji
   * không vỡ. Ký tự không có trong bảng (emoji, punctuation, CJK) giữ nguyên.
   * ------------------------------------------------------------------ */
  const KEEP_MARKS = new Set(['︎', '️', '⃣']);

  function applyStyleToText(input, styleId) {
    const forward = FORWARD.get(styleId);
    if (!forward) return String(input ?? '');

    let out = '';
    for (const ch of String(input ?? '').normalize('NFD')) {
      if (/\p{M}/u.test(ch)) {
        if (KEEP_MARKS.has(ch)) out += ch;
        continue;
      }
      out += forward.get(ch) ?? ch;
    }
    return out;
  }

  const api = { STYLE_IDS, normalizeStyledText, applyStyleToText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_FANCY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
