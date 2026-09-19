/* ------------------------------------------------------------------
 * AI Quick Solver (qa-solver.js) - STEALTH & ISOLATED VERSION
 * 
 * Các tính năng bảo vệ tàng hình (Anti-Detection / Stealth):
 * 1. Closed Shadow DOM (mode: 'closed'): Toàn bộ UI (card giải, overlay,
 *    nút) nằm hoàn toàn trong shadow root đóng kín. Website gọi querySelector,
 *    getElementById hay quét element.shadowRoot đều nhận về null / không thấy.
 * 2. Ngắt bắt phím (stopImmediatePropagation): Khi bấm Alt+Q, Alt+Shift+Q
 *    hoặc Esc, event bị chặn ngay từ capture phase, trang web không bắt được
 *    log phím bấm.
 * 3. Miễn nhiễm CSS: CSS của trang web thi không thể làm vỡ giao diện card.
 * ------------------------------------------------------------------ */
(function attachQaSolver(global) {
  'use strict';

  // Chỉ chạy ở window top trong trình duyệt
  if (typeof window !== 'undefined' && window !== window.top) return;

  let shadowHost = null;
  let shadowRoot = null;
  let activePanel = null;
  let activeCropOverlay = null;
  let miniTriggerBtn = null;

  /* ------------------------------------------------------------------
   * Khởi tạo Closed Shadow DOM container (ẩn hoàn toàn với website)
   * ------------------------------------------------------------------ */
  function ensureShadowRoot() {
    if (!shadowHost || !shadowHost.isConnected) {
      shadowHost = document.createElement('div');
      // Không đặt id/class dễ bị quét, gán style tối giản
      Object.assign(shadowHost.style, {
        all: 'initial',
        position: 'static',
        zIndex: '2147483647',
      });
      // mode: 'closed' -> host.shadowRoot sẽ luôn trả về null với script trang web
      shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

      // Inject style reset cơ bản vào bên trong Shadow DOM
      const style = document.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes nptFadeIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes nptPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `;
      shadowRoot.appendChild(style);

      const targetParent = document.body || document.documentElement;
      if (targetParent) {
        targetParent.appendChild(shadowHost);
      }
    }
    return shadowRoot;
  }

  /* ------------------------------------------------------------------
   * Helper: Crop ảnh canvas
  /* ------------------------------------------------------------------
   * Helper: Nén ảnh và scale down canvas (tối đa maxDim, chất lượng JPEG)
   * Giảm 70-80% payload gửi sang API và tăng tốc độ xử lý vision
   * ------------------------------------------------------------------ */
  function compressAndResizeCanvas(sourceCanvas, maxDim = 1600, quality = 0.85) {
    if (!sourceCanvas) return '';
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (!sw || !sh) {
      return sourceCanvas.toDataURL ? sourceCanvas.toDataURL('image/jpeg', quality) : '';
    }

    let targetW = sw;
    let targetH = sh;
    const maxSide = Math.max(sw, sh);
    if (maxSide > maxDim) {
      const scale = maxDim / maxSide;
      targetW = Math.round(sw * scale);
      targetH = Math.round(sh * scale);
    }

    if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
      }
      return canvas.toDataURL ? canvas.toDataURL('image/jpeg', quality) : '';
    }
    return sourceCanvas.toDataURL ? sourceCanvas.toDataURL('image/jpeg', quality) : '';
  }

  function cropImage(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const vW = window.innerWidth || document.documentElement.clientWidth || 1;
          const vH = window.innerHeight || document.documentElement.clientHeight || 1;
          const scaleX = img.naturalWidth / vW;
          const scaleY = img.naturalHeight / vH;

          const cropX = Math.max(0, Math.round(rect.x * scaleX));
          const cropY = Math.max(0, Math.round(rect.y * scaleY));
          const cropW = Math.max(1, Math.min(img.naturalWidth - cropX, Math.round(rect.width * scaleX)));
          const cropH = Math.max(1, Math.min(img.naturalHeight - cropY, Math.round(rect.height * scaleY)));

          const canvas = document.createElement('canvas');
          canvas.width = cropW;
          canvas.height = cropH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          resolve(compressAndResizeCanvas(canvas, 1600, 0.85));
        } catch (_) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /* ------------------------------------------------------------------
   * Bảng ký hiệu LaTeX -> Unicode ký tự toán học chuẩn
   * ------------------------------------------------------------------ */
  const LATEX_SYMBOLS = {
    // Ký tự Hy Lạp thường
    '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
    '\\epsilon': 'ε', '\\varepsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η',
    '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
    '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ',
    '\\pi': 'π', '\\varpi': 'ϖ', '\\rho': 'ρ', '\\varrho': 'ϱ',
    '\\sigma': 'σ', '\\varsigma': 'ς', '\\tau': 'τ', '\\upsilon': 'υ',
    '\\phi': 'φ', '\\varphi': 'φ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
    // Ký tự Hy Lạp hoa
    '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
    '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Upsilon': 'Υ',
    '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
    // Tập hợp số & không gian
    '\\mathbb{N}': 'ℕ', '\\mathbf{N}': 'ℕ',
    '\\mathbb{Z}': 'ℤ', '\\mathbf{Z}': 'ℤ',
    '\\mathbb{Q}': 'ℚ', '\\mathbf{Q}': 'ℚ',
    '\\mathbb{R}': 'ℝ', '\\mathbf{R}': 'ℝ',
    '\\mathbb{C}': 'ℂ', '\\mathbf{C}': 'ℂ',
    '\\mathbb{P}': 'ℙ', '\\mathbb{H}': 'ℍ',
    '\\ell': 'ℓ',
    // Toán tử & Quan hệ
    '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥',
    '\\ne': '≠', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡',
    '\\pm': '±', '\\mp': '∓', '\\times': '×', '\\div': '÷',
    '\\cdot': '·', '\\circ': '∘', '\\bullet': '•',
    '\\to': '→', '\\rightarrow': '→', '\\implies': '⇒', '\\Rightarrow': '⇒',
    '\\gets': '←', '\\leftarrow': '←', '\\iff': '⇔', '\\Leftrightarrow': '⇔',
    '\\leftrightarrow': '↔',
    '\\infty': '∞', '\\in': '∈', '\\notin': '∉',
    '\\subset': '⊂', '\\subseteq': '⊆', '\\supset': '⊃', '\\supseteq': '⊇',
    '\\cap': '∩', '\\cup': '∪', '\\setminus': '∖',
    '\\forall': '∀', '\\exists': '∃', '\\nexists': '∄',
    '\\emptyset': '∅', '\\varnothing': '∅',
    '\\partial': '∂', '\\nabla': '∇',
    '\\dots': '…', '\\ldots': '…', '\\cdots': '…', '\\vdots': '⋮', '\\ddots': '⋱',
    '\\sum': '∑', '\\prod': '∏', '\\int': '∫',
  };

  /* ------------------------------------------------------------------
   * Helper: Render một đoạn snippet TeX / LaTeX thành chuỗi HTML toán học đẹp
   * ------------------------------------------------------------------ */
  function renderLatexSnippet(tex) {
    if (!tex) return '';
    let s = String(tex).trim();

    // Escape ký tự HTML trước khi chèn thẻ <sup>, <sub>, <span>
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 1. Tập hợp \mathbb{...}
    s = s.replace(/\\mathbb\{([A-Za-z])\}/g, (_, ch) => {
      const sets = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ', P: 'ℙ', H: 'ℍ' };
      return sets[ch] || ch;
    });

    // 2. Chuyển các ký hiệu LaTeX thông dụng
    for (const [cmd, sym] of Object.entries(LATEX_SYMBOLS)) {
      s = s.split(cmd).join(sym);
    }

    // 3. Phân số \frac{a}{b}
    let fracLimit = 5;
    while (/\\frac\{([^{}]+)\}\{([^{}]+)\}/.test(s) && fracLimit-- > 0) {
      s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, (_, num, den) => {
        return `<span style="display:inline-flex; flex-direction:column; vertical-align:middle; text-align:center; padding:0 2px; font-size:0.9em;"><span style="border-bottom:1px solid currentColor; padding-bottom:1px; line-height:1.1;">${renderLatexSnippet(num)}</span><span style="line-height:1.1; padding-top:1px;">${renderLatexSnippet(den)}</span></span>`;
      });
    }

    // 4. Căn bậc hai \sqrt{x}
    let sqrtLimit = 5;
    while (/\\sqrt\{([^{}]+)\}/.test(s) && sqrtLimit-- > 0) {
      s = s.replace(/\\sqrt\{([^{}]+)\}/g, (_, val) => {
        return `<span style="white-space:nowrap;">√<span style="border-top:1px solid currentColor; padding-top:1px; margin-left:1px;">${renderLatexSnippet(val)}</span></span>`;
      });
    }

    // 5. Số mũ ^{...} và chỉ số dưới _{...}
    s = s.replace(/\^\{([^{}]+)\}/g, (_, p) => `<sup>${renderLatexSnippet(p)}</sup>`);
    s = s.replace(/\_\{([^{}]+)\}/g, (_, b) => `<sub>${renderLatexSnippet(b)}</sub>`);
    s = s.replace(/\^([0-9a-zA-Z])/g, (_, p) => `<sup>${p}</sup>`);
    s = s.replace(/\_([0-9a-zA-Z])/g, (_, b) => `<sub>${b}</sub>`);

    // 6. Text, font modifiers
    s = s.replace(/\\text\{([^{}]+)\}/g, '$1');
    s = s.replace(/\\mathrm\{([^{}]+)\}/g, '$1');
    s = s.replace(/\\mathbf\{([^{}]+)\}/g, '<b>$1</b>');
    s = s.replace(/\\mathit\{([^{}]+)\}/g, '<i>$1</i>');
    s = s.replace(/\\vec\{([^{}]+)\}/g, '$1⃗');
    s = s.replace(/\\overline\{([^{}]+)\}/g, '<span style="text-decoration:overline">$1</span>');

    // 7. Hàm toán
    s = s.replace(/\\(sin|cos|tan|cot|log|ln|exp|det|ker|dim|max|min|sup|inf|lim)\b/g, '$1');

    // 8. Dấu ngoặc & thanh chuẩn |
    s = s.replace(/\\left\(/g, '(').replace(/\\right\)/g, ')');
    s = s.replace(/\\left\[/g, '[').replace(/\\right\]/g, ']');
    s = s.replace(/\\left\\\{/g, '{').replace(/\\right\\\}/g, '}');
    s = s.replace(/\\left\|/g, '|').replace(/\\right\|/g, '|');
    s = s.replace(/\\\{/g, '{').replace(/\\\}/g, '}');

    // 9. Khoảng trắng LaTeX
    s = s.replace(/\\(quad|qquad|,|;|!)/g, ' ');

    return s;
  }

  /* ------------------------------------------------------------------
   * Helper: Chuẩn hóa câu trả lời toán học thành Plain Text thuần
   * (Dùng khi người dùng bấm nút Sao chép để dán vào Word/Chat/Notion đẹp)
   * ------------------------------------------------------------------ */
  function cleanMathToPlainText(text) {
    if (!text) return '';
    let s = String(text);

    // Gỡ các delimiter $ và $$
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, '$1');
    s = s.replace(/\$([^\$\n]+?)\$/g, '$1');
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, '$1');
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, '$1');

    // Chuyển LaTeX sang Unicode
    for (const [cmd, sym] of Object.entries(LATEX_SYMBOLS)) {
      s = s.split(cmd).join(sym);
    }
    s = s.replace(/\\mathbb\{([A-Za-z])\}/g, (_, ch) => {
      const sets = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ', P: 'ℙ', H: 'ℍ' };
      return sets[ch] || ch;
    });

    // Mũ số & chỉ số Unicode thông dụng
    const supers = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', 'n': 'ⁿ', 'x': 'ˣ' };
    const subs = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', 'n': 'ₙ', 'i': 'ᵢ', 'j': 'ⱼ' };

    s = s.replace(/\^\{([0-9+\-nx])\}/g, (_, ch) => supers[ch] || `^${ch}`);
    s = s.replace(/\^([0-9+\-nx])\b/g, (_, ch) => supers[ch] || `^${ch}`);
    s = s.replace(/\_\{([0-9+\-nixy])\}/g, (_, ch) => subs[ch] || `_${ch}`);
    s = s.replace(/\_([0-9+\-nixy])\b/g, (_, ch) => subs[ch] || `_${ch}`);

    let fracLimit = 5;
    while (/\\frac\{([^{}]+)\}\{([^{}]+)\}/.test(s) && fracLimit-- > 0) {
      s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)');
    }
    s = s.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');

    s = s.replace(/\\text\{([^{}]+)\}/g, '$1');
    s = s.replace(/\\mathrm\{([^{}]+)\}/g, '$1');
    s = s.replace(/\\mathbf\{([^{}]+)\}/g, '$1');
    s = s.replace(/\\mathit\{([^{}]+)\}/g, '$1');
    s = s.replace(/\\vec\{([^{}]+)\}/g, '$1⃗');
    s = s.replace(/\\(sin|cos|tan|cot|log|ln|exp|det|ker|dim|max|min|sup|inf|lim)\b/g, '$1');
    s = s.replace(/\\left[()\[\]|{}]/g, '');
    s = s.replace(/\\right[()\[\]|{}]/g, '');
    s = s.replace(/\\(quad|qquad|,|;|!)/g, ' ');
    s = s.replace(/[{}]/g, '');

    s = s.replace(/\*\*(.+?)\*\*/g, '$1');
    return s.trim();
  }

  /* ------------------------------------------------------------------
   * Helper: Format Markdown & LaTeX thành HTML giao diện
   * ------------------------------------------------------------------ */
  function formatMarkdown(text) {
    if (!text) return '';

    const mathTokens = [];
    let processed = String(text);

    // 1. Block math: $$ ... $$ hoặc \[ ... \]
    processed = processed.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, p1, p2) => {
      const formula = (p1 || p2 || '').trim();
      const rendered = renderLatexSnippet(formula);
      const token = `@@NPTBLOCK${mathTokens.length}@@`;
      mathTokens.push(`<div class="npt-math-block" style="text-align:center; margin:8px 0; font-family:'Cambria Math','KaTeX_Math','Times New Roman',serif; font-style:italic; font-size:1.05em; color:inherit;">${rendered}</div>`);
      return token;
    });

    // 2. Inline math: $ ... $ hoặc \( ... \)
    processed = processed.replace(/\$([^\$\n]+?)\$|\\\(([\s\S]+?)\\\)/g, (_, p1, p2) => {
      const formula = (p1 || p2 || '').trim();
      const rendered = renderLatexSnippet(formula);
      const token = `@@NPTINLINE${mathTokens.length}@@`;
      mathTokens.push(`<span class="npt-math-inline" style="font-family:'Cambria Math','KaTeX_Math','Times New Roman',serif; font-style:italic; padding:0 2px; color:inherit;">${rendered}</span>`);
      return token;
    });

    // 3. Escape HTML an toàn cho phần văn bản thông thường
    let safe;
    if (typeof document !== 'undefined' && document.createElement) {
      const div = document.createElement('div');
      div.textContent = processed;
      safe = div.innerHTML !== undefined ? div.innerHTML : processed;
    } else {
      safe = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    // 4. TeX loose command modifiers (chỉ thay các lệnh TeX cụ thể có backslash, KHÔNG thay _ bừa bãi làm vỡ snake_case)
    for (const [cmd, sym] of Object.entries(LATEX_SYMBOLS)) {
      if (cmd.startsWith('\\')) {
        safe = safe.split(cmd).join(sym);
      }
    }

    // 5. Markdown (bold, code, italic, newlines)
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/`([^`\n]+?)`/g, '<code style="background:rgba(128,128,128,0.2); padding:1px 4px; border-radius:3px; font-family:monospace; font-size:12px;">$1</code>');
    safe = safe.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    safe = safe.replace(/\n/g, '<br>');

    // 6. Khôi phục các math tokens
    mathTokens.forEach((renderedHtml, idx) => {
      safe = safe.split(`@@NPTBLOCK${idx}@@`).join(renderedHtml);
      safe = safe.split(`@@NPTINLINE${idx}@@`).join(renderedHtml);
    });

    return safe;
  }

  /* ------------------------------------------------------------------
   * Helper: Trích xuất Text & Công thức Toán học thông minh từ Selection
   * Hỗ trợ: KaTeX, MathJax, MathML, <sup>/<sub>, ảnh công thức (alt/data-latex),
   * và giữ đúng dấu xuống dòng giữa các câu hỏi/phương án A, B, C, D.
   * ------------------------------------------------------------------ */
  function extractSmartTextFromSelection(selection) {
    if (!selection || selection.rangeCount === 0) return '';
    const rawString = (selection.toString() || '').trim();
    if (typeof document === 'undefined') return rawString;

    let range;
    try {
      range = selection.getRangeAt(0);
    } catch (_) {
      return rawString;
    }
    if (!range || range.collapsed) return rawString;

    try {
      const fragment = range.cloneContents();
      if (!fragment || !fragment.childNodes || fragment.childNodes.length === 0) {
        return rawString;
      }

      const container = document.createElement('div');
      container.appendChild(fragment);

      // 1. KaTeX: Thay bằng mã LaTeX gốc nếu có annotation
      container.querySelectorAll('.katex').forEach((katexEl) => {
        const annotation = katexEl.querySelector('annotation[encoding*="tex"], annotation');
        if (annotation && annotation.textContent.trim()) {
          const tex = annotation.textContent.trim();
          const textNode = document.createTextNode(` $${tex}$ `);
          katexEl.parentNode?.replaceChild(textNode, katexEl);
        } else {
          katexEl.querySelectorAll('.katex-html').forEach((h) => h.remove());
        }
      });

      // 2. MathJax: mjx-container, script type="math/tex", hoặc annotation
      container.querySelectorAll('mjx-container, .MathJax, .MathJax_Display').forEach((mjxEl) => {
        const tex = mjxEl.getAttribute('data-tex') ||
                    mjxEl.getAttribute('data-formula') ||
                    mjxEl.querySelector('annotation[encoding*="tex"], annotation')?.textContent?.trim() ||
                    mjxEl.querySelector('script[type*="math/tex"]')?.textContent?.trim();
        if (tex) {
          const textNode = document.createTextNode(` $${tex.trim()}$ `);
          mjxEl.parentNode?.replaceChild(textNode, mjxEl);
        }
      });

      // 3. Ảnh công thức toán (Wikipedia, LMS Canvas, web thi: img có alt/data-latex)
      container.querySelectorAll('img').forEach((img) => {
        const alt = img.getAttribute('alt') ||
                    img.getAttribute('data-latex') ||
                    img.getAttribute('data-formula') ||
                    img.getAttribute('title');
        if (alt && alt.trim()) {
          const textNode = document.createTextNode(` ${alt.trim()} `);
          img.parentNode?.replaceChild(textNode, img);
        }
      });

      // 4. MathML: Xử lý các thẻ msup, msub, mfrac
      container.querySelectorAll('math').forEach((mathEl) => {
        const annotation = mathEl.querySelector('annotation[encoding*="tex"], annotation');
        if (annotation && annotation.textContent.trim()) {
          const textNode = document.createTextNode(` $${annotation.textContent.trim()}$ `);
          mathEl.parentNode?.replaceChild(textNode, mathEl);
          return;
        }
        mathEl.querySelectorAll('msup').forEach((el) => {
          const children = Array.from(el.children);
          if (children.length >= 2) {
            const base = children[0].textContent.trim();
            const exp = children[1].textContent.trim();
            el.replaceWith(document.createTextNode(`${base}^{${exp}}`));
          }
        });
        mathEl.querySelectorAll('msub').forEach((el) => {
          const children = Array.from(el.children);
          if (children.length >= 2) {
            const base = children[0].textContent.trim();
            const sub = children[1].textContent.trim();
            el.replaceWith(document.createTextNode(`${base}_{${sub}}`));
          }
        });
        mathEl.querySelectorAll('mfrac').forEach((el) => {
          const children = Array.from(el.children);
          if (children.length >= 2) {
            const num = children[0].textContent.trim();
            const den = children[1].textContent.trim();
            el.replaceWith(document.createTextNode(`(${num})/(${den})`));
          }
        });
      });

      // 5. Thẻ sup và sub thông thường
      container.querySelectorAll('sup').forEach((sup) => {
        const text = sup.textContent.trim();
        if (text) sup.replaceWith(document.createTextNode(`^{${text}}`));
      });
      container.querySelectorAll('sub').forEach((sub) => {
        const text = sub.textContent.trim();
        if (text) sub.replaceWith(document.createTextNode(`_{${text}}`));
      });

      // 6. Xuống dòng cho các block để các phương án A, B, C, D không bị dính liền
      container.querySelectorAll('br').forEach((br) => {
        br.replaceWith(document.createTextNode('\n'));
      });
      container.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach((block) => {
        block.appendChild(document.createTextNode('\n'));
      });

      let extracted = container.innerText || container.textContent || '';
      extracted = extracted
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();

      return extracted || rawString;
    } catch (_) {
      return rawString;
    }
  }

  // Extension vừa reload/update thì content script trong tab cũ bị mồ côi —
  // mọi lệnh gọi background đều lỗi "Extension context invalidated".
  const CONTEXT_DEAD_MESSAGE = '⚠️ Extension vừa cập nhật/nạp lại — hãy F5 (Reload) trang web này để tiếp tục dùng nhé!';

  function isExtensionContextAlive() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function friendlyError(err) {
    const msg = String(err?.message || err || '');
    if (/Extension context invalidated/i.test(msg)) {
      return CONTEXT_DEAD_MESSAGE;
    }
    return msg;
  }

  /* ------------------------------------------------------------------
   * Toast thông báo nhẹ
   * ------------------------------------------------------------------ */
  function showToast(message, duration = 2800) {
    const root = ensureShadowRoot();
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '30px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: isDark ? '#1f2937' : '#111827',
      color: '#ffffff',
      padding: '10px 18px',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '500',
      zIndex: '2147483647',
      boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
      transition: 'opacity 0.2s ease',
      pointerEvents: 'none',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      animation: 'nptFadeIn 0.15s ease-out',
    });
    root.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => {
        try { toast.remove(); } catch (_) {}
      }, 250);
    }, duration);
  }

  /* ------------------------------------------------------------------
   * Helper: Mở rộng vùng chọn thông minh nếu người dùng bôi đen thiếu A, B, C, D
   * ------------------------------------------------------------------ */
  function expandSelectionIfIncomplete(range, originalText) {
    const text = String(originalText || '').trim();
    if (!text) return text;

    // Nếu đã có đủ lựa chọn trắc nghiệm dạng A., B., C. hoặc A), B)... thì giữ nguyên
    const hasChoices = /[A-D][\.\)\:]\s*\S/i.test(text);
    if (hasChoices) return text;

    // Nếu không có range hoặc không chạy trong browser
    if (!range || !range.commonAncestorContainer) return text;

    try {
      let node = range.commonAncestorContainer;
      if (node.nodeType === 3) node = node.parentElement;
      if (!node) return text;

      const container = node.closest
        ? node.closest('.question, .quiz-question, .exam-question, tr, li, [class*="question"], [id*="question"], div, section, article')
        : null;

      if (container && (typeof document === 'undefined' || container !== document.body)) {
        const parentText = String(container.innerText || container.textContent || '').trim();
        if (/[A-D][\.\)\:]\s*\S/i.test(parentText) && parentText.length > text.length) {
          return `${text}\n\n[Ngữ cảnh xung quanh câu hỏi]:\n${parentText}`;
        }
      }
    } catch (_) {}

    return text;
  }

  /* ------------------------------------------------------------------
   * Floating Card: Hiển thị đáp án trong Closed Shadow DOM
   * ------------------------------------------------------------------ */
  function showSolverCard({ title = 'AI Quick Solver', initialStatus = 'Đang phân tích câu hỏi...', extendedThinking = false, onToggleExtendedThinking = null }) {
    closeSolverCard();

    const root = ensureShadowRoot();
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const panel = document.createElement('div');
    activePanel = panel;

    Object.assign(panel.style, {
      position: 'fixed',
      top: '75px',
      right: '25px',
      width: '360px',
      maxHeight: '480px',
      backgroundColor: isDark ? '#1e293b' : '#ffffff',
      color: isDark ? '#f8fafc' : '#0f172a',
      border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      borderRadius: '12px',
      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.25), 0 8px 10px -6px rgba(0, 0, 0, 0.2)',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '14px',
      overflow: 'hidden',
      userSelect: 'text',
      animation: 'nptFadeIn 0.15s ease-out',
    });

    // 1. Header kéo thả
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '10px 14px',
      backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
      borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      cursor: 'move',
      userSelect: 'none',
    });

    const headerTitle = document.createElement('span');
    headerTitle.textContent = title;
    headerTitle.style.fontWeight = '600';
    headerTitle.style.fontSize = '13px';
    headerTitle.style.color = isDark ? '#38bdf8' : '#0284c7';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Đóng (Esc)';
    Object.assign(closeBtn.style, {
      background: 'none',
      border: 'none',
      color: isDark ? '#94a3b8' : '#64748b',
      cursor: 'pointer',
      fontSize: '14px',
      padding: '0 4px',
      lineHeight: '1',
    });
    closeBtn.addEventListener('click', closeSolverCard);

    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Kéo thả Panel
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn) return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = initialLeft + 'px';
      panel.style.top = initialTop + 'px';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      panel.style.left = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + deltaX)) + 'px';
      panel.style.top = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + deltaY)) + 'px';
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // 2. Nội dung Body
    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '14px',
      overflowY: 'auto',
      flex: '1',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      lineHeight: '1.5',
    });

    const statusEl = document.createElement('div');
    statusEl.innerHTML = `<span style="display:inline-block; animation:nptPulse 1.2s infinite">⏳</span> ${initialStatus}`;
    statusEl.style.color = isDark ? '#94a3b8' : '#64748b';
    statusEl.style.fontSize = '13px';
    body.appendChild(statusEl);

    panel.appendChild(body);

    // 3. Footer (Sao chép & Chế độ Giải sâu)
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '8px 14px',
      borderTop: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '8px',
      backgroundColor: isDark ? '#111827' : '#f8fafc',
    });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Sao chép';
    copyBtn.title = 'Copy đáp án vào clipboard';
    Object.assign(copyBtn.style, {
      padding: '6px 12px',
      border: `1px solid ${isDark ? '#475569' : '#cbd5e1'}`,
      backgroundColor: isDark ? '#1e293b' : '#ffffff',
      color: isDark ? '#f1f5f9' : '#1e293b',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: '500',
    });

    let currentAnswerText = '';
    copyBtn.addEventListener('click', async () => {
      if (!currentAnswerText) return;
      try {
        await navigator.clipboard.writeText(currentAnswerText);
        copyBtn.textContent = '✔ Đã chép!';
        setTimeout(() => { copyBtn.textContent = '📋 Sao chép'; }, 1800);
      } catch (_) {
        showToast('Không thể sao chép vào clipboard');
      }
    });

    // Toggle Giải toán sâu (Gemini 3.8 Extended)
    const toggleContainer = document.createElement('label');
    Object.assign(toggleContainer.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      fontSize: '11px',
      color: isDark ? '#94a3b8' : '#64748b',
      cursor: 'pointer',
      userSelect: 'none',
    });
    const toggleCheckbox = document.createElement('input');
    toggleCheckbox.type = 'checkbox';
    toggleCheckbox.checked = !!extendedThinking;
    toggleCheckbox.style.cursor = 'pointer';
    const toggleText = document.createElement('span');
    toggleText.textContent = '🧠 Giải sâu (3.8)';
    toggleContainer.appendChild(toggleCheckbox);
    toggleContainer.appendChild(toggleText);

    if (typeof onToggleExtendedThinking === 'function') {
      toggleCheckbox.addEventListener('change', () => {
        onToggleExtendedThinking(toggleCheckbox.checked);
      });
    }

    const hint = document.createElement('span');
    hint.textContent = 'Esc';
    hint.style.fontSize = '11px';
    hint.style.color = isDark ? '#64748b' : '#94a3b8';

    footer.appendChild(copyBtn);
    footer.appendChild(toggleContainer);
    footer.appendChild(hint);
    panel.appendChild(footer);

    root.appendChild(panel);

    return {
      setStatus: (msg) => {
        body.innerHTML = '';
        const sEl = document.createElement('div');
        sEl.innerHTML = `<span style="display:inline-block; animation:nptPulse 1.2s infinite">⏳</span> ${msg}`;
        sEl.style.color = isDark ? '#94a3b8' : '#64748b';
        sEl.style.fontSize = '13px';
        body.appendChild(sEl);
      },
      setResult: ({ answer, providerLabel }) => {
        currentAnswerText = cleanMathToPlainText(answer);
        body.innerHTML = '';

        if (providerLabel) {
          headerTitle.textContent = `${title} (${providerLabel})`;
        }

        const lines = answer.split('\n');
        const firstLine = (lines[0] || '').trim();
        const explanation = lines.slice(1).join('\n').trim();

        // Khung đáp án nổi bật
        const answerBox = document.createElement('div');
        Object.assign(answerBox.style, {
          backgroundColor: isDark ? '#064e3b' : '#ecfdf5',
          border: `1px solid ${isDark ? '#059669' : '#a7f3d0'}`,
          color: isDark ? '#6ee7b7' : '#065f46',
          padding: '10px 14px',
          borderRadius: '8px',
          fontWeight: '600',
          fontSize: '15px',
        });
        answerBox.innerHTML = formatMarkdown(firstLine);
        body.appendChild(answerBox);

        if (explanation) {
          const expBox = document.createElement('div');
          expBox.style.fontSize = '13px';
          expBox.style.color = isDark ? '#cbd5e1' : '#334155';
          expBox.innerHTML = formatMarkdown(explanation);
          body.appendChild(expBox);
        }
      },
      setError: (errorMessage) => {
        body.innerHTML = '';
        const errBox = document.createElement('div');
        Object.assign(errBox.style, {
          backgroundColor: isDark ? '#7f1d1d' : '#fef2f2',
          border: `1px solid ${isDark ? '#991b1b' : '#fecaca'}`,
          color: isDark ? '#fca5a5' : '#991b1b',
          padding: '10px 12px',
          borderRadius: '8px',
          fontSize: '13px',
        });
        errBox.textContent = `Lỗi: ${errorMessage}`;
        body.appendChild(errBox);
      }
    };
  }

  function closeSolverCard() {
    if (activePanel) {
      try { activePanel.remove(); } catch (_) {}
      activePanel = null;
    }
  }

  /* ------------------------------------------------------------------
   * Giải câu hỏi dạng Text (bôi đen)
   * ------------------------------------------------------------------ */
  async function solveTextQuestion(questionText, opts = {}) {
    const text = String(questionText || '').trim();
    if (!text) {
      showToast('💡 Bôi đen câu hỏi rồi bấm Alt+Q (hoặc bấm Alt+Shift+Q để quét ảnh)');
      return;
    }

    if (!isExtensionContextAlive()) {
      showToast(CONTEXT_DEAD_MESSAGE, 5000);
      return;
    }

    const isExtended = opts.extendedThinking === true;

    const card = opts.existingCard || showSolverCard({
      title: 'AI Quick Solver',
      initialStatus: isExtended ? 'AI đang suy luận chuyên sâu (Gemini 3.8 Extended)...' : 'Đang giải câu hỏi...',
      extendedThinking: isExtended,
      onToggleExtendedThinking: (checked) => {
        card.setStatus(checked ? 'AI đang suy luận chuyên sâu (Gemini 3.8 Extended)...' : 'Đang giải câu hỏi...');
        solveTextQuestion(text, { extendedThinking: checked, existingCard: card });
      },
    });

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'qaSolveQuestion',
        payload: {
          text,
          extendedThinking: isExtended,
          thinkingLevel: 'high',
        }
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || 'Không nhận được phản hồi từ AI');
      }

      card.setResult({
        answer: response.answer,
        providerLabel: response.providerLabel,
      });
    } catch (err) {
      card.setError(friendlyError(err));
    }
  }

  /* ------------------------------------------------------------------
   * Giải câu hỏi dạng Ảnh màn hình (OCR Vision - Alt+Shift+Q)
   * Đặt hoàn toàn trong Closed Shadow DOM
   * ------------------------------------------------------------------ */
  function startCropSolver() {
    if (!isExtensionContextAlive()) {
      showToast(CONTEXT_DEAD_MESSAGE, 5000);
      return;
    }

    closeCropOverlay();
    const root = ensureShadowRoot();

    activeCropOverlay = document.createElement('div');
    Object.assign(activeCropOverlay.style, {
      position: 'fixed',
      top: '0', left: '0', width: '100vw', height: '100vh',
      zIndex: '2147483647',
      cursor: 'crosshair',
      backgroundColor: 'rgba(0, 0, 0, 0.35)',
      userSelect: 'none',
    });

    const selectionBox = document.createElement('div');
    Object.assign(selectionBox.style, {
      position: 'absolute',
      border: '2px dashed #10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.15)',
      display: 'none',
      pointerEvents: 'none',
    });
    activeCropOverlay.appendChild(selectionBox);

    const guideHeader = document.createElement('div');
    guideHeader.textContent = '💡 Khoanh vùng câu hỏi để AI giải ngay (Esc để thoát)';
    Object.assign(guideHeader.style, {
      position: 'absolute',
      top: '20px', left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: '#0f172a',
      color: '#ffffff',
      padding: '8px 18px',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: '500',
      fontFamily: 'sans-serif',
      boxShadow: '0 4px 6px -1px rgba(0,0,0,0.3)',
    });
    activeCropOverlay.appendChild(guideHeader);

    let isSelecting = false;
    let startX = 0;
    let startY = 0;

    activeCropOverlay.addEventListener('mousedown', (e) => {
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selectionBox.style.display = 'block';
      selectionBox.style.left = startX + 'px';
      selectionBox.style.top = startY + 'px';
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    });

    activeCropOverlay.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;
      const curX = e.clientX;
      const curY = e.clientY;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      selectionBox.style.left = x + 'px';
      selectionBox.style.top = y + 'px';
      selectionBox.style.width = w + 'px';
      selectionBox.style.height = h + 'px';
    });

    activeCropOverlay.addEventListener('mouseup', async (e) => {
      if (!isSelecting) return;
      isSelecting = false;

      const curX = e.clientX;
      const curY = e.clientY;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      if (w < 15 || h < 15) {
        closeCropOverlay();
        return;
      }

      guideHeader.textContent = 'Đang chụp và đọc hình ảnh...';
      activeCropOverlay.style.opacity = '0';

      try {
        await new Promise(r => setTimeout(r, 120));
        const capture = await chrome.runtime.sendMessage({ type: 'ocrTakeScreenshot' });
        if (!capture || !capture.ok) {
          throw new Error(capture?.error || 'Không chụp được màn hình');
        }

        const croppedDataUrl = await cropImage(capture.dataUrl, { x, y, width: w, height: h });
        closeCropOverlay();

        const requestCrop = async (ext) => {
          const response = await chrome.runtime.sendMessage({
            type: 'qaSolveQuestion',
            payload: {
              imageBase64: croppedDataUrl,
              mimeType: 'image/jpeg',
              extendedThinking: ext,
              thinkingLevel: 'high',
            }
          });
          if (!response || !response.ok) {
            throw new Error(response?.error || 'Không nhận được phản hồi từ AI');
          }
          return response;
        };

        const card = showSolverCard({
          title: 'AI Quick Solver (Vision)',
          initialStatus: 'AI đang phân tích câu hỏi trong hình ảnh...',
          extendedThinking: false,
          onToggleExtendedThinking: async (checked) => {
            try {
              card.setStatus(checked ? 'AI đang suy luận chuyên sâu qua ảnh (Gemini 3.8 Extended)...' : 'AI đang phân tích câu hỏi trong hình ảnh...');
              const resp = await requestCrop(checked);
              card.setResult({
                answer: resp.answer,
                providerLabel: resp.providerLabel,
              });
            } catch (err) {
              card.setError(friendlyError(err));
            }
          },
        });

        const initialResp = await requestCrop(false);
        card.setResult({
          answer: initialResp.answer,
          providerLabel: initialResp.providerLabel,
        });
      } catch (err) {
        closeCropOverlay();
        showToast(friendlyError(err), 5000);
      }
    });

    root.appendChild(activeCropOverlay);
  }

  function closeCropOverlay() {
    if (activeCropOverlay) {
      try { activeCropOverlay.remove(); } catch (_) {}
      activeCropOverlay = null;
    }
  }

  /* ------------------------------------------------------------------
   * Mini Button Tooltip (Nằm trong Shadow DOM)
   * ------------------------------------------------------------------ */
  function removeMiniTrigger() {
    if (miniTriggerBtn) {
      try { miniTriggerBtn.remove(); } catch (_) {}
      miniTriggerBtn = null;
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('mouseup', (e) => {
    // Nếu extension đã reload thì bỏ qua
    if (!isExtensionContextAlive()) {
      removeMiniTrigger();
      return;
    }

    // Nếu click vào Shadow DOM thì không xóa
    if (shadowHost && shadowHost.contains(e.target)) return;

    setTimeout(() => {
      if (!isExtensionContextAlive()) {
        removeMiniTrigger();
        return;
      }

      const selection = window.getSelection();
      let text = extractSmartTextFromSelection(selection);
      if (text && selection.rangeCount > 0) {
        text = expandSelectionIfIncomplete(selection.getRangeAt(0), text);
      }

      // Chỉ hiện khi bôi đen chuỗi đủ dài (> 10 ký tự)
      if (text && text.length > 10 && selection.rangeCount > 0) {
        removeMiniTrigger();

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;

        const root = ensureShadowRoot();
        const btn = document.createElement('button');
        miniTriggerBtn = btn;
        btn.innerHTML = '💡 <strong>Giải nhanh</strong> (Alt+Q)';
        btn.title = 'Nhờ AI giải câu hỏi này (Alt+Q)';

        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        Object.assign(btn.style, {
          position: 'fixed',
          top: Math.max(10, rect.top - 36) + 'px',
          left: Math.max(10, Math.min(window.innerWidth - 180, rect.left)) + 'px',
          backgroundColor: isDark ? '#0f172a' : '#ffffff',
          color: isDark ? '#38bdf8' : '#0284c7',
          border: `1px solid ${isDark ? '#38bdf8' : '#0284c7'}`,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          borderRadius: '20px',
          padding: '4px 12px',
          fontSize: '12px',
          cursor: 'pointer',
          zIndex: '2147483646',
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          userSelect: 'none',
          animation: 'nptFadeIn 0.12s ease-out',
        });

        btn.addEventListener('mousedown', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          removeMiniTrigger();
          solveTextQuestion(text);
        });

        root.appendChild(btn);
      } else {
        removeMiniTrigger();
      }
    }, 15);
  });
  }

  /* ------------------------------------------------------------------
   * Lắng nghe phím tắt ở Capture Phase (Chặn trang web log phím)
   * ------------------------------------------------------------------ */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', (e) => {
    // Phím Escape: đóng mọi panel/overlay và triệt tiêu event
    if (e.key === 'Escape') {
      let handled = false;
      if (activeCropOverlay) {
        closeCropOverlay();
        handled = true;
      }
      if (activePanel) {
        closeSolverCard();
        handled = true;
      }
      if (miniTriggerBtn) {
        removeMiniTrigger();
        handled = true;
      }
      if (handled) {
        // Ngăn trang web thi bắt được sự kiện Esc
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }

    // Phím Alt + Q hoặc Alt + Shift + Q
    if (e.altKey && (e.key === 'q' || e.key === 'Q')) {
      // Ngăn chặn trang web thi phát hiện tổ hợp phím này
      e.preventDefault();
      e.stopImmediatePropagation();
      removeMiniTrigger();

      if (!isExtensionContextAlive()) {
        showToast(CONTEXT_DEAD_MESSAGE, 5000);
        return;
      }

      if (e.shiftKey) {
        // Alt + Shift + Q: Khoanh vùng giải ảnh
        startCropSolver();
      } else {
        // Alt + Q: Bôi đen giải chữ
        const selection = window.getSelection();
        let selected = extractSmartTextFromSelection(selection);
        if (selected && selection.rangeCount > 0) {
          selected = expandSelectionIfIncomplete(selection.getRangeAt(0), selected);
        }
        if (selected) {
          solveTextQuestion(selected);
        } else {
          showToast('💡 Bôi đen câu hỏi rồi bấm Alt+Q (hoặc bấm Alt+Shift+Q để quét ảnh)');
        }
      }
    }
  }, true); // true = capture phase (bắt trước khi tới trang web)
  }

  const api = {
    LATEX_SYMBOLS,
    renderLatexSnippet,
    cleanMathToPlainText,
    formatMarkdown,
    extractSmartTextFromSelection,
    expandSelectionIfIncomplete,
    compressAndResizeCanvas,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_QA_SOLVER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
