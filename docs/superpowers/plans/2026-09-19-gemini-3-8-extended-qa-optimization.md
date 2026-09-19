# Gemini 3.8 Flash & Extended Thinking Q&A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng cấp hệ thống giải đề Q&A với mô hình mới nhất Gemini 3.8 Flash & Gemini 3.5 Flash-Lite, bổ sung chế độ "Giải toán sâu" (Extended Thinking với `thinkingLevel: 'high'`), tối ưu nén ảnh crop JPEG/1600px và mở rộng vùng chọn thông minh.

**Architecture:** 
- `providers.js`: Cập nhật cấu hình Gemini 3, hỗ trợ `thinkingConfig: { thinkingLevel: 'high' }`, `temperature: 1.0` khi bật `extendedThinking`.
- `crop-overlay.js`: Thêm `compressAndResizeCanvas` giới hạn max 1600px và nén JPEG 85% để tối ưu hóa payload.
- `qa-solver.js`: Cung cấp hàm `expandSelectionIfIncomplete` tự động mở rộng vùng chọn nếu thiếu các lựa chọn A/B/C/D, thiết kế lại `formatMarkdown` với Tokenized LaTeX Replacement để chống double-escape và tránh biến `snake_case` thành subscript; thêm toggle UI "🧠 Giải toán sâu".
- `options.html` / `options.js`: Cập nhật danh sách model Gemini 3 và thiết lập mặc định.

**Tech Stack:** Vanilla JavaScript (ES2022+ / Chrome Extension MV3), Jest test suite.

## Global Constraints
- Target platform: Chrome Extension Manifest V3.
- No external runtime dependencies (keep extension lightweight and stealthy).
- All UI remains enclosed in Closed Shadow DOM.
- Backward compatibility with existing providers (OpenAI, DeepL, Claude, etc.).

---

### Task 1: Update Gemini 3 Series & Extended Thinking in `providers.js`

**Files:**
- Modify: `providers.js`
- Test: `tests/providers.test.js`

**Interfaces:**
- Consumes: `buildQaRequest({ providerId, providerConfig, apiKey, text, imageBase64, mimeType, extendedThinking, thinkingLevel })`
- Produces: Gemini REST payload with `generationConfig: { thinkingConfig: { thinkingLevel: 'high' }, temperature: 1.0 }` when `extendedThinking: true`.

- [ ] **Step 1: Write the failing tests for Gemini 3 and extended thinking**

Add tests to `tests/providers.test.js`:
```javascript
test('buildQaRequest configures gemini-3.8-flash and thinkingLevel: high when extendedThinking is true', () => {
  const req = Providers.buildQaRequest({
    providerId: 'gemini',
    providerConfig: { model: 'gemini-3.5-flash-lite' },
    apiKey: 'AIzaSyFakeKey',
    text: 'Giải phương trình x^2 + 5x + 6 = 0',
    extendedThinking: true
  });
  const body = JSON.parse(req.body);
  expect(req.url).toContain('gemini-3.8-flash');
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
  expect(body.generationConfig.temperature).toBe(1.0);
});

test('buildQaRequest uses normal thinking and default temperature when extendedThinking is false', () => {
  const req = Providers.buildQaRequest({
    providerId: 'gemini',
    providerConfig: { model: 'gemini-3.5-flash-lite' },
    apiKey: 'AIzaSyFakeKey',
    text: 'Thủ đô của Pháp là gì?',
    extendedThinking: false
  });
  const body = JSON.parse(req.body);
  expect(req.url).toContain('gemini-3.5-flash-lite');
  expect(body.generationConfig.thinkingConfig).toBeUndefined();
  expect(body.generationConfig.temperature).toBe(0.1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/providers.test.js -t "extendedThinking"`
Expected: FAIL (extendedThinking not yet implemented)

- [ ] **Step 3: Implement Gemini 3 updates in `providers.js`**

In `providers.js`:
- Update `PROVIDER_DEFS.gemini`:
  `defaultModel: 'gemini-3.5-flash-lite'`
  `suggestedModels: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash']`
- Update `buildQaRequest`:
```javascript
  function buildQaRequest({ providerId, providerConfig, apiKey, text, imageBase64, mimeType, extendedThinking, thinkingLevel }) {
    const kind = providerKind(providerId);
    if (kind === 'deepl') throw new Error('QA_REQUIRES_LLM');
    if (imageBase64 && kind !== 'gemini') {
      throw new Error('IMAGE_NEEDS_GEMINI');
    }

    const instructions = buildQaInstructions();
    const prompt = String(text || '').trim() || (imageBase64 ? 'Hãy phân tích kỹ hình ảnh câu hỏi dưới đây và đưa ra đáp án chính xác nhất kèm giải thích ngắn.' : '');

    if (kind === 'gemini') {
      const isExtended = extendedThinking === true || providerConfig?.extendedThinking === true;
      let rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      if (isExtended && !rawModel.includes('3.8')) {
        rawModel = 'gemini-3.8-flash';
      }
      const model = rawModel.replace(/^models\//i, '');
      const parts = [{ text: prompt }];
      if (imageBase64) {
        parts.push({
          inline_data: {
            mime_type: String(mimeType || 'image/jpeg'),
            data: String(imageBase64 || '')
          }
        });
      }

      const generationConfig = isExtended
        ? {
            temperature: 1.0,
            thinkingConfig: {
              thinkingLevel: String(thinkingLevel || 'high').toLowerCase()
            }
          }
        : {
            temperature: 0.1
          };

      const bodyPayload = {
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
        safetySettings: GEMINI_SAFETY_SETTINGS,
      };

      if (providerConfig?.googleSearch !== false) {
        bodyPayload.tools = [{ google_search: {} }];
      }

      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify(bodyPayload),
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/providers.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit changes**

```bash
git add providers.js tests/providers.test.js
git commit -m "feat(providers): support Gemini 3.8 Flash and extended thinking mode"
```

---

### Task 2: Crop Overlay Image Compression & Resizing

**Files:**
- Modify: `crop-overlay.js`
- Test: `tests/crop-overlay.test.js`

**Interfaces:**
- Consumes: Canvas object from user crop selection.
- Produces: `compressAndResizeCanvas(sourceCanvas, maxDim = 1600, quality = 0.85)` returning `{ dataUrl, mimeType: 'image/jpeg' }`.

- [ ] **Step 1: Write the failing test for `compressAndResizeCanvas`**

Create or add to `tests/crop-overlay.test.js`:
```javascript
const { compressAndResizeCanvas } = require('../crop-overlay');

describe('compressAndResizeCanvas', () => {
  test('downscales large canvas exceeding maxDim and outputs jpeg', () => {
    const mockContext = {
      drawImage: jest.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high'
    };
    const mockResizedCanvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => mockContext),
      toDataURL: jest.fn((type, q) => `data:${type};base64,mockjpegdata`)
    };
    global.document.createElement = jest.fn(() => mockResizedCanvas);

    const largeCanvas = { width: 3200, height: 1800, toDataURL: jest.fn() };
    const result = compressAndResizeCanvas(largeCanvas, 1600, 0.85);

    expect(result.mimeType).toBe('image/jpeg');
    expect(mockResizedCanvas.width).toBe(1600);
    expect(mockResizedCanvas.height).toBe(900);
    expect(mockResizedCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx jest tests/crop-overlay.test.js`
Expected: FAIL (compressAndResizeCanvas not defined)

- [ ] **Step 3: Implement `compressAndResizeCanvas` in `crop-overlay.js`**

Implement `compressAndResizeCanvas` and use it when creating screenshot payload in `crop-overlay.js`:
```javascript
  function compressAndResizeCanvas(sourceCanvas, maxDim = 1600, quality = 0.85) {
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (!sw || !sh) {
      return {
        dataUrl: sourceCanvas.toDataURL('image/jpeg', quality),
        mimeType: 'image/jpeg'
      };
    }

    let targetW = sw;
    let targetH = sh;
    const maxSide = Math.max(sw, sh);
    if (maxSide > maxDim) {
      const scale = maxDim / maxSide;
      targetW = Math.round(sw * scale);
      targetH = Math.round(sh * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
    }
    return {
      dataUrl: canvas.toDataURL('image/jpeg', quality),
      mimeType: 'image/jpeg'
    };
  }
```
Export for Node/Jest environment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/crop-overlay.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add crop-overlay.js tests/crop-overlay.test.js
git commit -m "feat(crop): add canvas resizing and JPEG compression"
```

---

### Task 3: Smart Selection Expansion & Tokenized Math Parser in `qa-solver.js`

**Files:**
- Modify: `qa-solver.js`
- Test: `tests/qa-solver.test.js`

**Interfaces:**
- `expandSelectionIfIncomplete(range, text)`: Appends missing options A/B/C/D from surrounding question parent container.
- `formatMarkdown(raw)`: Tokenizes `$ ... $` and `$$ ... $$` to avoid double-escaping, preserves `_` in `snake_case` words, converts math formulas to clean HTML.
- UI Toggle `🧠 Giải toán sâu`: Triggers solver with `extendedThinking: true`.

- [ ] **Step 1: Write failing tests for `expandSelectionIfIncomplete` and enhanced `formatMarkdown`**

In `tests/qa-solver.test.js`:
```javascript
test('formatMarkdown preserves snake_case variables and renders math without double escaping', () => {
  const input = 'Biến user_id thỏa mãn $x < 5$.';
  const html = formatMarkdown(input);
  expect(html).toContain('user_id');
  expect(html).not.toContain('user<sub>id</sub>');
  expect(html).not.toContain('&amp;lt;');
  expect(html).toContain('&lt;');
});

test('expandSelectionIfIncomplete attaches missing choices from parent container', () => {
  const container = document.createElement('div');
  container.className = 'quiz-question';
  container.innerHTML = '<p id="q">Chọn phát biểu đúng:</p><div class="choices">A. Đúng<br>B. Sai</div>';
  document.body.appendChild(container);

  const range = document.createRange();
  range.selectNodeContents(container.querySelector('#q'));
  const expanded = expandSelectionIfIncomplete(range, 'Chọn phát biểu đúng:');
  expect(expanded).toContain('A. Đúng');
  expect(expanded).toContain('B. Sai');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/qa-solver.test.js -t "preserves snake_case"`
Expected: FAIL

- [ ] **Step 3: Implement improvements in `qa-solver.js`**

1. Update `formatMarkdown`:
   - Replace math expressions with `%%MATH_TOKEN_n%%`.
   - Escape HTML on text segments (`&`, `<`, `>`).
   - Format bold `**text**` and preserve `snake_case` identifiers `([a-zA-Z0-9]+_[a-zA-Z0-9_]+)`.
   - Restore math tokens processed by `renderLatexSnippet`.
2. Implement `expandSelectionIfIncomplete(range, originalText)`.
3. Add UI toggle checkbox for `🧠 Giải toán sâu (Gemini 3.8 Extended)` on the QA Card. When toggled, reload answer with `extendedThinking: true`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/qa-solver.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit changes**

```bash
git add qa-solver.js tests/qa-solver.test.js
git commit -m "feat(qa): smart selection expansion, tokenized math formatting and extended thinking UI toggle"
```

---

### Task 4: Update Options Page for Gemini 3 & Preferences

**Files:**
- Modify: `options.html`
- Modify: `options.js`

- [ ] **Step 1: Update Gemini model list in `options.html` and default configuration in `options.js`**
- Show `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.5-flash`. Remove 2.0 / 2.5.
- Add checkbox for "Mặc định bật Giải toán sâu (Gemini 3.8 Extended Thinking)".

- [ ] **Step 2: Test options page load and save in Jest**
Run: `npx jest tests/options.test.js`

- [ ] **Step 3: Commit changes**

```bash
git add options.html options.js
git commit -m "feat(options): update Gemini 3 models and default extended thinking preference"
```

---

### Task 5: Full Regression Testing & Verification

- [ ] **Step 1: Run complete test suite across all 21+ test files**

Run: `npm test`
Expected: All test suites PASS without errors.

- [ ] **Step 2: Verification before completion**

Inspect diff and verify all constraints are satisfied.
