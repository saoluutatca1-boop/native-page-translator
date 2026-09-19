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

  console.log('Tất cả test qa-solver.test.js đều PASS ✔');
}

run().catch((err) => {
  console.error('Test thất bại:', err);
  process.exit(1);
});
