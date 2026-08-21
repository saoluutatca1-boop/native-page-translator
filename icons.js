/* ========================================================================
 * NPT Icons — bộ icon riêng của extension, một nguồn duy nhất.
 *
 * Trước đây mỗi file tự chép một đoạn <svg> inline: popup.html, options.js,
 * content.js và pdf-viewer mỗi nơi một nét, một cỡ, một stroke-width — nhìn
 * là biết chắp vá. Giờ toàn bộ icon nằm ở đây, cùng một lưới 24×24, cùng
 * stroke 1.7, bo tròn đầu nét, tô bằng currentColor.
 *
 * Cách dùng:
 *   - HTML tĩnh: <i class="ico" data-icon="key"></i>  (hydrate() tự điền)
 *   - JS dựng DOM: element.innerHTML = NPT_ICONS.svg('key', { size: 14 })
 *   - Nhãn thương hiệu provider: NPT_ICONS.brand('deepl')
 *
 * File này chạy được trong: trang extension (popup/options/pdf-viewer) và
 * content script — không dùng chrome.* nên nạp ở đâu cũng được.
 * ====================================================================== */
(function attachIcons(global) {
  'use strict';

  /* Nét vẽ 24×24. Quy ước: chừa lề ~2px, nét 1.7, cap/join tròn, KHÔNG fill
   * (trừ vài chấm đặc), để icon nào đứng cạnh nhau cũng cùng một "cân nặng". */
  const PATHS = {
    /* --- Dịch thuật --- */
    // Chữ 文 + chữ A: đúng ngôn ngữ hình ảnh của mọi công cụ dịch.
    translate: '<path d="M3.5 6.2h7.8M7.4 4v2.2"/><path d="M9.6 8.6c-.7 2.9-2.8 5.2-6.1 6.4"/><path d="M5.2 10.9c1 2 2.6 3.4 4.8 4.2"/><path d="m13.2 20 3.9-9.2L21 20"/><path d="M14.6 16.6h5"/>',
    // Bản soi gương của translate (A trước, 文 sau): VI và EN đứng cạnh nhau
    // trong bộ chọn ngôn ngữ mà vẫn phân biệt được ngay.
    languages: '<path d="m3 12.4 3.9-9.2 3.9 9.2"/><path d="M4.4 9h5"/><path d="M12.8 8.6h7.8M16.7 6.4v2.2"/><path d="M18.9 11c-.7 2.9-2.8 5.2-6.1 6.4"/><path d="M14.5 13.3c1 2 2.6 3.4 4.8 4.2"/>',
    globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.1 2.3 3.2 5.3 3.2 8.6s-1.1 6.3-3.2 8.6c-2.1-2.3-3.2-5.3-3.2-8.6S9.9 5.7 12 3.4Z"/>',
    // Quay lại bản gốc: mũi tên vòng ngược.
    revert: '<path d="M8.8 13.6 4.4 9.2l4.4-4.4"/><path d="M4.4 9.2h9.4a5.8 5.8 0 0 1 0 11.6h-3.2"/>',
    sparkles: '<path d="M12 3.2c.72 4.3 2.28 5.86 6.6 6.6-4.32.74-5.88 2.3-6.6 6.6-.72-4.3-2.28-5.86-6.6-6.6 4.32-.74 5.88-2.3 6.6-6.6Z"/><path d="M18.2 15.4c.3 1.9.98 2.58 2.9 2.9-1.92.32-2.6 1-2.9 2.9-.3-1.9-.98-2.58-2.9-2.9 1.92-.32 2.6-1 2.9-2.9Z"/>',
    wand: '<path d="m4 20 9.6-9.6"/><path d="M15.6 4.2c.34 2 1.06 2.72 3.06 3.06-2 .34-2.72 1.06-3.06 3.06-.34-2-1.06-2.72-3.06-3.06 2-.34 2.72-1.06 3.06-3.06Z"/><path d="M7.4 3.6c.2 1.2.62 1.62 1.82 1.82-1.2.2-1.62.62-1.82 1.82-.2-1.2-.62-1.62-1.82-1.82 1.2-.2 1.62-.62 1.82-1.82Z"/><path d="M19.6 14.2c.2 1.2.62 1.62 1.82 1.82-1.2.2-1.62.62-1.82 1.82-.2-1.2-.62-1.62-1.82-1.82 1.2-.2 1.62-.62 1.82-1.82Z"/>',
    summary: '<path d="M4 6.4h10.4M4 11h8M4 15.6h6.4M4 20.2h4.4"/><path d="M18.4 4.2c.36 2.2 1.14 2.98 3.34 3.34-2.2.36-2.98 1.14-3.34 3.34-.36-2.2-1.14-2.98-3.34-3.34 2.2-.36 2.98-1.14 3.34-3.34Z"/>',

    /* --- Trang & tài liệu --- */
    page: '<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="2.6"/><path d="M3.2 8.6h17.6"/><path d="M6.4 12.4h7.2M6.4 15.8h4.8"/>',
    file: '<path d="M13.4 3.4H7.6a2.2 2.2 0 0 0-2.2 2.2v12.8a2.2 2.2 0 0 0 2.2 2.2h8.8a2.2 2.2 0 0 0 2.2-2.2V8.4Z"/><path d="M13.4 3.4v5h5.2"/><path d="M8.8 13.2h6.4M8.8 16.4h4.4"/>',
    image: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><circle cx="8.8" cy="10" r="1.6"/><path d="m4.4 17.6 4.6-4.6 3 3 3.4-3.4 5 5"/>',
    doc: '<path d="M6.6 3.6h7l4.8 4.8v12a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 20.4V5.2a1.6 1.6 0 0 1 1.6-1.6Z"/><path d="M13.6 3.6v4.8h4.8"/>',
    scan: '<path d="M5.5 8v-2.5h2.5"/><path d="M18.5 8v-2.5h-2.5"/><path d="M5.5 16v2.5h2.5"/><path d="M18.5 16v2.5h-2.5"/><path d="M4 12h16"/>',

    /* --- API & key --- */
    key: '<circle cx="7.6" cy="12" r="3.6"/><path d="M11.2 12h9.2"/><path d="M17.4 12v3.2M20.4 12v2.4"/>',
    plug: '<path d="M9 3.4v5M15 3.4v5"/><path d="M6.4 8.4h11.2v3.2a5.6 5.6 0 0 1-5.6 5.6 5.6 5.6 0 0 1-5.6-5.6Z"/><path d="M12 17.2v3.4"/>',
    server: '<rect x="3.4" y="4" width="17.2" height="6.4" rx="2"/><rect x="3.4" y="13.6" width="17.2" height="6.4" rx="2"/><path d="M7 7.2h.01M7 16.8h.01"/>',
    zap: '<path d="M13.4 2.6 4.8 13.4h5.6l-1 8 8.6-10.8h-5.6Z"/>',
    gauge: '<path d="M4 17.4a8.8 8.8 0 1 1 16 0"/><path d="m12 13.6 3.6-3.6"/><circle cx="12" cy="17.4" r="1.4"/>',
    shield: '<path d="M12 3.2 5.2 6v5.4c0 4.2 2.8 7.9 6.8 9.4 4-1.5 6.8-5.2 6.8-9.4V6Z"/><path d="m9.4 12 1.9 1.9 3.5-3.7"/>',
    database: '<ellipse cx="12" cy="6" rx="7.4" ry="2.9"/><path d="M4.6 6v11.8c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9V6"/><path d="M4.6 12c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9"/>',

    /* --- Hành động --- */
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="m4.8 12.6 4.8 4.8L19.2 7.8"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    trash: '<path d="M4.4 6.6h15.2"/><path d="M9.2 6.6V5a1.6 1.6 0 0 1 1.6-1.6h2.4A1.6 1.6 0 0 1 14.8 5v1.6"/><path d="M6.6 6.6l.9 12.2a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6l.9-12.2"/><path d="M10.4 10.4v6.4M13.6 10.4v6.4"/>',
    copy: '<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.4"/><path d="M4.8 15.4A1.8 1.8 0 0 1 3.6 13.6V5.4a1.8 1.8 0 0 1 1.8-1.8h8.2a1.8 1.8 0 0 1 1.8 1.8"/>',
    save: '<path d="M5.6 3.6h10l4.2 4.2v12.6a.8.8 0 0 1-.8.8H5.6a.8.8 0 0 1-.8-.8V4.4a.8.8 0 0 1 .8-.8Z"/><path d="M8 3.6v5.2h6.8V3.6"/><path d="M8 20.4v-6h8v6"/>',
    download: '<path d="M12 3.8v10.6"/><path d="m7.6 10.4 4.4 4.4 4.4-4.4"/><path d="M4.4 17.2v1.6a1.8 1.8 0 0 0 1.8 1.8h11.6a1.8 1.8 0 0 0 1.8-1.8v-1.6"/>',
    upload: '<path d="M12 20.2V9.6"/><path d="m7.6 13.6 4.4-4.4 4.4 4.4"/><path d="M4.4 6.8V5.2a1.8 1.8 0 0 1 1.8-1.8h11.6a1.8 1.8 0 0 1 1.8 1.8v1.6"/>',
    refresh: '<path d="M20.4 5.6v5.2h-5.2"/><path d="M3.6 18.4v-5.2h5.2"/><path d="M5.8 9.4a6.8 6.8 0 0 1 11.2-2.5l3.4 3.9M3.6 13.2l3.4 3.9a6.8 6.8 0 0 0 11.2-2.5"/>',
    reset: '<path d="M3.6 5.6v5.2h5.2"/><path d="M4.8 10.8a7.6 7.6 0 1 1 .6 6.2"/>',
    external: '<path d="M14.4 4.4h5.2v5.2"/><path d="M19.6 4.4 11.2 12.8"/><path d="M17.6 13.6v5a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8V8.2a1.8 1.8 0 0 1 1.8-1.8h5"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m20.4 20.4-4.9-4.9"/>',
    edit: '<path d="M11.6 5.2H5.4a1.8 1.8 0 0 0-1.8 1.8v11.6a1.8 1.8 0 0 0 1.8 1.8H17a1.8 1.8 0 0 0 1.8-1.8v-6.2"/><path d="M17.4 3.8a2.05 2.05 0 0 1 2.9 2.9L12.6 14.4l-3.8 1 1-3.8Z"/>',
    play: '<path d="M7.6 4.8 19 12 7.6 19.2Z"/>',
    ban: '<circle cx="12" cy="12" r="8.6"/><path d="m6 6 12 12"/>',
    eye: '<path d="M2.6 12S6.4 5.4 12 5.4 21.4 12 21.4 12 17.6 18.6 12 18.6 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3"/>',
    link: '<path d="M10.2 13.8a4.4 4.4 0 0 0 6.6.5l2.6-2.6a4.4 4.4 0 0 0-6.2-6.2l-1.5 1.5"/><path d="M13.8 10.2a4.4 4.4 0 0 0-6.6-.5l-2.6 2.6a4.4 4.4 0 0 0 6.2 6.2l1.5-1.5"/>',

    /* --- Trạng thái --- */
    info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5"/><path d="M12 7.9h.01"/>',
    alert: '<path d="M10.3 4.1 2.9 17.2a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z"/><path d="M12 9.4v4"/><path d="M12 17h.01"/>',
    success: '<circle cx="12" cy="12" r="8.6"/><path d="m8.2 12.2 2.6 2.6 5-5.2"/>',
    error: '<circle cx="12" cy="12" r="8.6"/><path d="m14.8 9.2-5.6 5.6M9.2 9.2l5.6 5.6"/>',
    spinner: '<path d="M12 3.4a8.6 8.6 0 1 0 8.6 8.6" stroke-linecap="round"/>',
    clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.2 1.9"/>',

    /* --- Giao diện & cài đặt --- */
    sliders: '<path d="M4 7.4h9.6M18.4 7.4h1.6M4 16.6h3.6M12.4 16.6h7.6"/><circle cx="15.8" cy="7.4" r="2.4"/><circle cx="9.8" cy="16.6" r="2.4"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.85 1.85M16.65 16.65 18.5 18.5M18.5 5.5l-1.85 1.85M7.35 16.65 5.5 18.5"/>',
    moon: '<path d="M20.4 13.6A8.6 8.6 0 1 1 10.4 3.6a6.8 6.8 0 0 0 10 10Z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v1.8M12 19.4v1.8M4.2 12H2.4M21.6 12h-1.8M6.2 6.2 4.9 4.9M19.1 19.1l-1.3-1.3M17.8 6.2l1.3-1.3M4.9 19.1l1.3-1.3"/>',
    monitor: '<rect x="2.8" y="4.2" width="18.4" height="12.6" rx="2.2"/><path d="M8.4 20.4h7.2M12 16.8v3.6"/>',
    volume: '<path d="M11.6 4.8 6.8 8.8H3.6v6.4h3.2l4.8 4Z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6M18.4 6.4a8 8 0 0 1 0 11.2"/>',
    book: '<path d="M4 4.6h5.2a3.2 3.2 0 0 1 3.2 3.2v12a2.4 2.4 0 0 0-2.4-2.4H4Z"/><path d="M20.4 4.6h-5.2a3.2 3.2 0 0 0-3.2 3.2v12a2.4 2.4 0 0 1 2.4-2.4h6Z"/>',
    layers: '<path d="m12 3.2 8.6 4.4-8.6 4.4-8.6-4.4Z"/><path d="m3.4 12.4 8.6 4.4 8.6-4.4"/><path d="m3.4 16.8 8.6 4.4 8.6-4.4"/>',
    bookmark: '<path d="M6.4 3.8h11.2a1.2 1.2 0 0 1 1.2 1.2v15.2L12 16.4l-6.8 3.8V5a1.2 1.2 0 0 1 1.2-1.2Z"/>',
    chevron: '<path d="m6.4 9.2 5.6 5.6 5.6-5.6"/>',
    grip: '<circle cx="9" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>',
  };

  const DEFAULT_SIZE = 16;

  function escapeAttribute(value) {
    return String(value || '').replace(/[<>"'&]/g, char => ({
      '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
    }[char]));
  }

  /* Chuỗi <svg> hoàn chỉnh. Luôn aria-hidden: icon ở đây chỉ đi kèm chữ, phần
   * đọc được cho screen reader nằm ở text của nút/nhãn. */
  function svg(name, options = {}) {
    const paths = PATHS[name];
    if (!paths) return '';
    const size = Number(options.size) || DEFAULT_SIZE;
    const className = options.className ? ` class="${escapeAttribute(options.className)}"` : '';
    const width = options.strokeWidth || 1.7;
    return `<svg${className} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
      + ` stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`
      + ` aria-hidden="true" focusable="false">${paths}</svg>`;
  }

  function has(name) {
    return Boolean(PATHS[name]);
  }

  /* ------------------------------------------------------------------
   * Nhãn thương hiệu provider: ô bo góc có gradient + glyph trắng.
   * Đây là dấu hiệu GỢI Ý dịch vụ (không phải logo chính thức của họ):
   * DeepL = chữ D dựng bằng nét, Gemini = tia 4 cánh, OpenAI-compatible =
   * lục giác endpoint. Slot tùy chỉnh xoay màu theo số thứ tự để Groq /
   * OpenRouter / API nhà nhìn là phân biệt được ngay.
   * ------------------------------------------------------------------ */
  const BRAND_GLYPHS = {
    deepl: '<path d="M7.2 6h3.4a5 5 0 0 1 0 10H7.2Z" fill="none" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/>',
    gemini: '<path d="M11 4.6c.55 3.3 1.75 4.5 5.05 5.05-3.3.55-4.5 1.75-5.05 5.05-.55-3.3-1.75-4.5-5.05-5.05C9.25 9.1 10.45 7.9 11 4.6Z" fill="#fff"/><path d="M16.6 13.4c.24 1.45.77 1.98 2.22 2.22-1.45.24-1.98.77-2.22 2.22-.24-1.45-.77-1.98-2.22-2.22 1.45-.24 1.98-.77 2.22-2.22Z" fill="#fff" opacity=".9"/>',
    openai: '<path d="M11 4.8 16.6 8v6.4L11 17.6 5.4 14.4V8Z" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/><circle cx="11" cy="11.2" r="2" fill="#fff"/>',
  };

  const BRAND_GRADIENTS = {
    deepl: ['#0b3b57', '#12b8a6'],
    gemini: ['#4285f4', '#9b72cb'],
    openai: ['#1f2937', '#4b5563'],
  };

  // Dải màu cho slot tùy chỉnh — mỗi số thứ tự một cặp, quay vòng.
  const CUSTOM_GRADIENTS = [
    ['#f97316', '#ef4444'],
    ['#0ea5e9', '#6366f1'],
    ['#10b981', '#0d9488'],
    ['#ec4899', '#8b5cf6'],
    ['#eab308', '#f97316'],
    ['#64748b', '#334155'],
  ];

  let gradientSeed = 0;

  /* variant: 'deepl' | 'gemini' | 'openai'; custom = số thứ tự slot tùy chỉnh
   * (2, 3, ...) để đổi màu, bỏ trống là dùng màu gốc của variant. */
  function brand(variant, options = {}) {
    const kind = BRAND_GLYPHS[variant] ? variant : 'openai';
    const size = Number(options.size) || 22;
    const custom = Number(options.custom) || 0;
    const [from, to] = custom
      ? CUSTOM_GRADIENTS[(custom - 2) % CUSTOM_GRADIENTS.length]
      : BRAND_GRADIENTS[kind];
    const id = `npt-brand-${(gradientSeed += 1)}`;
    return `<svg class="provider-badge" width="${size}" height="${size}" viewBox="0 0 22 22" aria-hidden="true" focusable="false">`
      + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">`
      + `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`
      + `</linearGradient></defs>`
      + `<rect width="22" height="22" rx="6.5" fill="url(#${id})"/>`
      + BRAND_GLYPHS[kind]
      + '</svg>';
  }

  /* Logo app: ĐÚNG một dấu hiệu dùng ở mọi nơi — icon trên thanh công cụ
   * (icons/icon.svg + 4 file png) và header của popup/Cài đặt/trang PDF. Glyph
   * 文 vẽ bằng nét nên rõ từ 16px, tia spark ở góc là phần "dịch bản địa". */
  function logo(size = 30) {
    const id = `npt-logo-${(gradientSeed += 1)}`;
    return `<svg class="brand-logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">`
      + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">`
      + '<stop offset="0" stop-color="#6366f1"/><stop offset=".55" stop-color="#4f7bf7"/><stop offset="1" stop-color="#22d3ee"/>'
      + '</linearGradient></defs>'
      + `<rect width="32" height="32" rx="9" fill="url(#${id})"/>`
      + '<g fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round">'
      + '<path d="M14.6 6.6 16 9.4"/>'
      + '<path d="M7.4 12.2h15.2"/>'
      + '<path d="M15 12.2 8.8 25.2"/>'
      + '<path d="M15 12.2 22.6 25"/>'
      + '</g>'
      + '<path d="M24.4 4.6c.5 2.4 1.3 3.2 3.7 3.7-2.4.5-3.2 1.3-3.7 3.7-.5-2.4-1.3-3.2-3.7-3.7 2.4-.5 3.2-1.3 3.7-3.7Z" fill="#fff"/>'
      + '</svg>';
  }

  /* Điền icon cho markup tĩnh: <i class="ico" data-icon="key" data-icon-size="18">.
   * Chỉ chạy trên trang của extension — content script không được đụng vào
   * DOM của trang web người ta. */
  function hydrate(root) {
    const scope = root || document;
    for (const node of scope.querySelectorAll('[data-icon]')) {
      const name = node.dataset.icon;
      if (!PATHS[name]) continue;
      node.innerHTML = svg(name, { size: Number(node.dataset.iconSize) || DEFAULT_SIZE });
      node.dataset.iconReady = '1';
    }
  }

  const api = { PATHS, svg, has, brand, logo, hydrate, names: () => Object.keys(PATHS) };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_ICONS = api;

  /* KHÔNG tự hydrate: file này cũng chạy như content script, mà content script
   * thì không được đụng vào DOM của trang người ta. Trang của extension
   * (popup/options/pdf-viewer) tự gọi NPT_ICONS.hydrate() trong lúc khởi động. */
})(typeof globalThis !== 'undefined' ? globalThis : this);
