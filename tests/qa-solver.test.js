/* Test cho tính năng AI Quick Solver trong providers.js — chạy: node tests/qa-solver.test.js */
'use strict';

const assert = require('node:assert/strict');
const P = require('../providers.js');

function fakeFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetchText: async (request) => {
      calls.push(request);
      for (const handler of handlers) {
        const result = handler(request, calls.length);
        if (result) return result;
      }
      throw new Error(`fakeFetch: không có handler cho ${request.url}`);
    },
  };
}

const noSleep = async () => {};

async function run() {
  console.log('Testing QA Solver in providers.js...');

  // 1. Kiểm tra buildQaRequest cho Gemini với Text câu hỏi
  {
    assert.equal(typeof P.buildQaRequest, 'function', 'P.buildQaRequest phải là function');
    const req = P.buildQaRequest({
      providerId: 'gemini',
      providerConfig: { model: 'gemini-2.5-flash' },
      apiKey: 'test-gemini-key',
      text: '1 + 1 bằng mấy?\nA. 1\nB. 2\nC. 3\nD. 4',
    });

    assert.match(req.url, /generativelanguage\.googleapis\.com/);
    assert.equal(req.headers['x-goog-api-key'], 'test-gemini-key');
    const body = JSON.parse(req.body);
    assert.equal(body.generationConfig.temperature, 0.1, 'Temperature phải là 0.1 để độ chính xác cao nhất');
    assert.match(body.systemInstruction.parts[0].text, /ACCURACY/);
    assert.equal(body.contents[0].parts[0].text, '1 + 1 bằng mấy?\nA. 1\nB. 2\nC. 3\nD. 4');
    assert.deepEqual(body.tools, [{ google_search: {} }], 'Mặc định phải có tool google_search cho Gemini');

    // Test khi tắt googleSearch
    const reqNoSearch = P.buildQaRequest({
      providerId: 'gemini',
      providerConfig: { model: 'gemini-2.5-flash', googleSearch: false },
      apiKey: 'test-gemini-key',
      text: '1 + 1 = ?',
    });
    const bodyNoSearch = JSON.parse(reqNoSearch.body);
    assert.equal(bodyNoSearch.tools, undefined, 'Khi googleSearch: false thì không được có tools');
  }

  // 2. Kiểm tra buildQaRequest cho Gemini với Image (Vision)
  {
    const req = P.buildQaRequest({
      providerId: 'gemini',
      providerConfig: { model: 'gemini-2.5-flash' },
      apiKey: 'test-gemini-key',
      imageBase64: 'base64sampledata',
      mimeType: 'image/png',
    });

    const body = JSON.parse(req.body);
    assert.equal(body.contents[0].parts.length, 2);
    assert.equal(body.contents[0].parts[1].inline_data.data, 'base64sampledata');
    assert.equal(body.generationConfig.temperature, 0.1);
  }

  // 3. solveQuestionWithRotation thành công với text
  {
    assert.equal(typeof P.solveQuestionWithRotation, 'function', 'P.solveQuestionWithRotation phải là function');
    const config = P.normalizeConfig({
      preferred: 'gemini',
      providers: {
        gemini: { enabled: true, keys: [{ key: 'gm-key-1' }], model: 'gemini-2.5-flash' },
      },
    });

    const keyState = P.createKeyState();
    const fake = fakeFetch([
      () => ({
        status: 200,
        bodyText: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: '**Đáp án: B**\nGiải thích: 1 cộng 1 bằng 2 theo phép tính số học cơ bản.' }
                ]
              }
            }
          ]
        })
      })
    ]);

    const result = await P.solveQuestionWithRotation({
      config,
      text: '1 + 1 = ?\nA. 1\nB. 2\nC. 3',
      fetchText: fake.fetchText,
      keyState,
      now: Date.now,
      sleep: noSleep,
    });

    assert.equal(result.answer, '**Đáp án: B**\nGiải thích: 1 cộng 1 bằng 2 theo phép tính số học cơ bản.');
    assert.equal(result.provider, 'gemini');
  }

  // 4. Kiểm tra buildQaInstructions có quy tắc định dạng toán học và ký hiệu khoa học
  {
    const instructions = P.buildQaInstructions();
    assert.match(instructions, /Mathematical and scientific formatting/, 'Instructions phải có hướng dẫn định dạng toán học');
    assert.match(instructions, /Unicode/, 'Instructions phải khuyến khích dùng Unicode toán học');
  }

  // 5. Kiểm tra qa-solver.js math rendering và clean plain text
  {
    const Q = require('../qa-solver.js');
    assert.equal(typeof Q.renderLatexSnippet, 'function');
    assert.equal(typeof Q.cleanMathToPlainText, 'function');
    assert.equal(typeof Q.formatMarkdown, 'function');

    // Test renderLatexSnippet
    assert.equal(Q.renderLatexSnippet('\\lambda'), 'λ');
    assert.equal(Q.renderLatexSnippet('\\le'), '≤');
    assert.equal(Q.renderLatexSnippet('\\mathbb{N}'), 'ℕ');
    assert.equal(Q.renderLatexSnippet('\\ell'), 'ℓ');
    assert.equal(Q.renderLatexSnippet('\\dots'), '…');
    assert.match(Q.renderLatexSnippet('\\ell^2(\\mathbb{N})'), /ℓ<sup>2<\/sup>\(ℕ\)/);

    // Test cleanMathToPlainText (cho chức năng copy vào clipboard)
    const rawAnswer = 'Đáp án: B. $T$ có vectơ riêng ứng với mọi $\\lambda$ mà $|\\lambda| < 1$.\nToán tử $T$ trên không gian $\\ell^2(\\mathbb{N})$ với phổ $|\\lambda| \\le 1$.';
    const plainText = Q.cleanMathToPlainText(rawAnswer);
    assert.match(plainText, /Đáp án: B\. T có vectơ riêng ứng với mọi λ mà \|λ\| < 1\./);
    assert.match(plainText, /Toán tử T trên không gian ℓ²\(ℕ\) với phổ \|λ\| ≤ 1\./);
    assert.ok(!plainText.includes('$'), 'Plain text không được chứa ký tự $');
    assert.ok(!plainText.includes('\\lambda'), 'Plain text không được chứa \\lambda thô');

    // Test formatMarkdown cho giao diện UI
    const html = Q.formatMarkdown('**Đáp án: B**\nToán tử $T$ trên không gian $\\ell^2(\\mathbb{N})$ thỏa mãn $|\\lambda| < 1$.');
    assert.match(html, /<strong>Đáp án: B<\/strong>/);
    assert.match(html, /<br>/);
    assert.match(html, /npt-math-inline/);
    assert.match(html, /&lt; 1/); // HTML escape ký tự <
    assert.ok(!html.includes('$\\lambda$'), 'HTML không được chứa dấu $ thô');
  }

  // 6. Kiểm tra compressAndResizeCanvas
  {
    const Q = require('../qa-solver.js');
    assert.equal(typeof Q.compressAndResizeCanvas, 'function', 'compressAndResizeCanvas phải là function');

    const mockCtx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: '',
      drawImage: (img, sx, sy, sw, sh) => {},
    };
    const createdCanvas = {
      width: 0,
      height: 0,
      getContext: () => mockCtx,
      toDataURL: (type, q) => `data:${type};base64,mockjpegdata_${createdCanvas.width}x${createdCanvas.height}_q${q}`,
    };

    const origCreateElement = global.document?.createElement;
    if (!global.document) global.document = {};
    global.document.createElement = (tag) => {
      if (tag === 'canvas') return createdCanvas;
      return {};
    };

    try {
      const largeCanvas = {
        width: 3200,
        height: 1600,
        toDataURL: () => 'data:image/png;base64,orig',
      };
      const result = Q.compressAndResizeCanvas(largeCanvas, 1600, 0.85);
      assert.match(result, /^data:image\/jpeg/);
      assert.equal(createdCanvas.width, 1600);
      assert.equal(createdCanvas.height, 800);
    } finally {
      if (origCreateElement) {
        global.document.createElement = origCreateElement;
      } else {
        delete global.document;
      }
    }
  }

  // 7. Kiểm tra formatMarkdown bảo vệ snake_case và chống double-escaping
  {
    const Q = require('../qa-solver.js');
    const input = 'Biến `user_id` và token_count thỏa mãn $x < 5$ và $y > 10$.';
    const html = Q.formatMarkdown(input);
    assert.ok(html.includes('token_count'), 'token_count không được bị chuyển thành token<sub>count</sub>');
    assert.ok(!html.includes('&amp;lt;'), 'Không được double escape ký tự <');
    assert.ok(html.includes('&lt; 5'), 'Ký tự < phải được escape thành &lt;');
    assert.ok(html.includes('&gt; 10'), 'Ký tự > phải được escape thành &gt;');
  }

  // 8. Kiểm tra expandSelectionIfIncomplete
  {
    const Q = require('../qa-solver.js');
    assert.equal(typeof Q.expandSelectionIfIncomplete, 'function', 'expandSelectionIfIncomplete phải là function');

    // Trường hợp đã có đáp án đầy đủ -> giữ nguyên
    const fullText = 'Câu 1: 1+1=?\nA. 1\nB. 2\nC. 3\nD. 4';
    assert.equal(Q.expandSelectionIfIncomplete(null, fullText), fullText);

    // Trường hợp thiếu đáp án và có parent element
    const mockContainer = {
      innerText: 'Câu hỏi: Đâu là khẳng định đúng?\nA. Trái đất hình tròn\nB. Trái đất hình vuông',
    };
    const mockRange = {
      commonAncestorContainer: {
        nodeType: 1,
        closest: (sel) => mockContainer,
      },
    };
    const incompleteText = 'Câu hỏi: Đâu là khẳng định đúng?';
    const expanded = Q.expandSelectionIfIncomplete(mockRange, incompleteText);
    assert.match(expanded, /A\. Trái đất hình tròn/);
  }

  // 9. Kiểm tra Fallback tự động khi gặp 429 Rate Limit do cạn quota Search Grounding
  {
    const config = P.normalizeConfig({
      preferred: 'gemini',
      providers: {
        gemini: { enabled: true, keys: [{ key: 'gm-key-grounding-429' }], googleSearch: true },
      },
    });

    const keyState = P.createKeyState();
    let requestCount = 0;
    const fake = {
      fetchText: async (request) => {
        requestCount++;
        const body = JSON.parse(request.body);
        if (requestCount === 1) {
          // Lần đầu có tools google_search -> giả lập cạn quota Search Queries (HTTP 429 RESOURCE_EXHAUSTED)
          assert.ok(body.tools, 'Request đầu tiên phải có tools google_search');
          return {
            status: 429,
            bodyText: JSON.stringify({
              error: {
                code: 429,
                message: "Quota exceeded for quota metric 'Grounding Search Queries' and limit 'Grounding Search Queries per minute'",
                status: "RESOURCE_EXHAUSTED",
              }
            }),
          };
        }
        // Lần 2 fallback không có tools google_search -> thành công trả kết quả
        assert.equal(body.tools, undefined, 'Request fallback không được có tools');
        return {
          status: 200,
          bodyText: JSON.stringify({
            candidates: [
              { content: { parts: [{ text: '**Đáp án: A**\nGiải thích: Phép tính cơ bản.' }] } }
            ]
          }),
        };
      }
    };

    const result = await P.solveQuestionWithRotation({
      config,
      text: '2 + 2 = ?\nA. 4\nB. 5',
      fetchText: fake.fetchText,
      keyState,
      now: Date.now,
      sleep: noSleep,
    });

    assert.equal(requestCount, 2, 'Phải có 2 request: request đầu bị 429 và request thứ 2 fallback thành công');
    assert.equal(result.answer, '**Đáp án: A**\nGiải thích: Phép tính cơ bản.');
    assert.ok(keyState.searchCooldownUntil > Date.now(), 'keyState phải lưu thời điểm tạm dừng search');

    // Test tiếp câu thứ 2: vì đang trong searchCooldownUntil nên request không được gắn tools ngay từ đầu
    let secondReqBody;
    await P.solveQuestionWithRotation({
      config,
      text: '3 + 3 = ?\nA. 6\nB. 7',
      fetchText: async (req) => {
        secondReqBody = JSON.parse(req.body);
        return {
          status: 200,
          bodyText: JSON.stringify({
            candidates: [{ content: { parts: [{ text: '**Đáp án: A**' }] } }]
          }),
        };
      },
      keyState,
      now: Date.now,
      sleep: noSleep,
    });
    assert.equal(secondReqBody.tools, undefined, 'Câu tiếp theo trong thời gian cooldown không được gắn tools');
  }

  // 10. Kiểm tra Fallback khi Gemini 3.8 Extended Thinking bị 429 Rate Limit -> chuyển sang Gemini 3.5 Flash Lite
  {
    const config = P.normalizeConfig({
      preferred: 'gemini',
      providers: {
        gemini: { enabled: true, keys: [{ key: 'gm-key-thinking-429' }], googleSearch: false },
      },
    });

    const keyState = P.createKeyState();
    let callCount = 0;
    const fake = {
      fetchText: async (request) => {
        callCount++;
        if (callCount === 1) {
          // Lần đầu là gemini-3.8-flash có thinkingConfig -> giả lập 429 TPM
          assert.match(request.url, /gemini-3\.8-flash/);
          return {
            status: 429,
            bodyText: JSON.stringify({
              error: { code: 429, message: "Resource has been exhausted (TPM limit exceeded)" }
            }),
          };
        }
        // Lần 2 fallback sang gemini-3.5-flash-lite không có extendedThinking
        assert.match(request.url, /gemini-3\.5-flash-lite/);
        const body = JSON.parse(request.body);
        assert.equal(body.generationConfig.thinkingConfig, undefined);
        return {
          status: 200,
          bodyText: JSON.stringify({
            candidates: [{ content: { parts: [{ text: '**Đáp án: C**' }] } }]
          }),
        };
      }
    };

    const result = await P.solveQuestionWithRotation({
      config,
      text: 'Tích phân phức tạp...\nA. 1\nB. 2\nC. 3',
      extendedThinking: true,
      fetchText: fake.fetchText,
      keyState,
      now: Date.now,
      sleep: noSleep,
    });

    assert.equal(callCount, 2, 'Phải fallback từ 3.8-flash sang 3.5-flash-lite');
    assert.equal(result.answer, '**Đáp án: C**');
  }

  // 11. Kiểm tra friendlyError hiển thị thông điệp rõ ràng khi gặp 429
  {
    const Q = require('../qa-solver.js');
    const err429 = new Error('Gemini: bị giới hạn tốc độ (HTTP 429)');
    const msg = Q.friendlyError(err429);
    assert.match(msg, /Rate Limit 429/, 'Phải cảnh báo rõ lỗi Rate Limit 429');
    assert.match(msg, /thêm 1-2 API key Gemini phụ/, 'Phải gợi ý thêm key phụ');
  }

  console.log('Tất cả test qa-solver.test.js đều PASS ✔');
}

run().catch((err) => {
  console.error('Test thất bại:', err);
  process.exit(1);
});
