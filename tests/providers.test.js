/* Test thuần node cho providers.js — chạy: node tests/providers.test.js */
'use strict';

const assert = require('node:assert/strict');
const P = require('../providers.js');

const BASE_CONFIG = P.normalizeConfig({
  preferred: 'deepl',
  providers: {
    deepl: {
      enabled: true,
      keys: [
        { key: 'key-free-1:fx', label: 'free 1' },
        { key: 'key-free-2:fx', label: 'free 2' },
      ],
    },
    gemini: { enabled: true, keys: [{ key: 'gemini-key-1', label: 'gm' }], model: 'gemini-2.5-flash' },
    openai: { enabled: false, keys: [], url: 'https://api.openai.com/v1/chat/completions' },
  },
});

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
  // 1. normalizeConfig: điền mặc định, lọc key rỗng
  {
    const cfg = P.normalizeConfig({ providers: { deepl: { enabled: true, keys: [{ key: ' a:fx ' }, { key: '' }] } } });
    assert.equal(cfg.preferred, 'deepl');
    assert.equal(cfg.providers.deepl.keys.length, 1);
    assert.equal(cfg.providers.deepl.keys[0].key, 'a:fx');
    assert.equal(cfg.providers.gemini.model, 'gemini-3.1-flash-lite');
    assert.equal(cfg.providers.openai.enabled, false);
  }

  // 2. buildRequest DeepL: key :fx -> endpoint free, header auth đúng
  {
    const req = P.buildRequest({
      providerId: 'deepl', providerConfig: {}, apiKey: 'abc:fx',
      source: 'xin chào', context: '',
    });
    assert.equal(req.url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(req.headers.Authorization, 'DeepL-Auth-Key abc:fx');
    const body = JSON.parse(req.body);
    assert.deepEqual(body.text, ['xin chào']);
    assert.equal(body.target_lang, 'EN-US');

    const pro = P.buildRequest({ providerId: 'deepl', providerConfig: {}, apiKey: 'abc-pro', source: 'x', context: '' });
    assert.equal(pro.url, 'https://api.deepl.com/v2/translate');
  }

  // 3. buildRequest Gemini: URL chứa model, header x-goog-api-key
  {
    const req = P.buildRequest({
      providerId: 'gemini', providerConfig: { model: 'gemini-2.5-flash' }, apiKey: 'gkey',
      source: 'xin chào', context: 'ctx',
    });
    assert.match(req.url, /v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(req.headers['x-goog-api-key'], 'gkey');
    const body = JSON.parse(req.body);
    assert.ok(body.systemInstruction.parts[0].text.includes('native English'));
    assert.match(body.contents[0].parts[0].text, /ctx[\s\S]*xin chào/);
    // Dòng 2.5 phải tắt thinking để tiết kiệm token
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);

    // Dòng 3.x không gửi thinkingConfig
    const req3 = P.buildRequest({
      providerId: 'gemini', providerConfig: { model: 'gemini-3.1-flash-lite' }, apiKey: 'gkey',
      source: 'x', context: '',
    });
    assert.equal(JSON.parse(req3.body).generationConfig.thinkingConfig, undefined);
  }

  // 4. buildRequest OpenAI chat: Bearer + messages
  {
    const req = P.buildRequest({
      providerId: 'openai',
      providerConfig: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', format: 'auto' },
      apiKey: 'sk-test', source: 'xin chào', context: '',
    });
    assert.equal(req.openaiFormat, 'chat');
    assert.equal(req.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(req.body);
    assert.equal(body.messages[1].content, 'xin chào');
  }

  // 5. classifyResponse: parse OK từng provider + phân loại lỗi
  {
    assert.equal(
      P.classifyResponse({ providerId: 'deepl', status: 200, bodyText: JSON.stringify({ translations: [{ text: 'hello' }] }) }).text,
      'hello',
    );
    assert.equal(
      P.classifyResponse({ providerId: 'gemini', status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi ' }] } }] }) }).text,
      'hi',
    );
    assert.equal(
      P.classifyResponse({ providerId: 'openai', openaiFormat: 'chat', status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: 'yo' } }] }) }).text,
      'yo',
    );
    assert.equal(P.classifyResponse({ providerId: 'deepl', status: 403, bodyText: '{}' }).kind, 'keyFailed');
    assert.equal(P.classifyResponse({ providerId: 'deepl', status: 456, bodyText: '{}' }).kind, 'keyFailed');
    assert.equal(P.classifyResponse({ providerId: 'gemini', status: 429, bodyText: '{}' }).kind, 'keyFailed');
    assert.equal(P.classifyResponse({ providerId: 'gemini', status: 400, bodyText: '{"error":{"message":"bad model"}}' }).kind, 'providerFailed');
    assert.equal(P.classifyResponse({ providerId: 'deepl', status: 0, bodyText: '' }).kind, 'providerFailed');
  }

  // 6. Không provider nào -> NO_API_KEY
  {
    const cfg = P.normalizeConfig({});
    await assert.rejects(
      P.translateWithRotation({ config: cfg, source: 'x', context: '', fetchText: async () => ({ status: 200, bodyText: '{}' }), sleep: noSleep }),
      /NO_API_KEY/,
    );
  }

  // 7. Key 1 bị 403 -> tự xoay sang key 2 thành công
  {
    const { fetchText, calls } = fakeFetch([
      (req) => (req.headers.Authorization === 'DeepL-Auth-Key key-free-1:fx' ? { status: 403, bodyText: '{}' } : null),
      () => ({ status: 200, bodyText: JSON.stringify({ translations: [{ text: 'rotated ok' }] }) }),
    ]);
    const result = await P.translateWithRotation({
      config: BASE_CONFIG, source: 'xin chào', context: '', fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.text, 'rotated ok');
    assert.equal(result.provider, 'deepl');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.Authorization, 'DeepL-Auth-Key key-free-2:fx');
  }

  // 8. Cả 2 key DeepL hết quota (456) -> fallback sang Gemini
  {
    const { fetchText, calls } = fakeFetch([
      (req) => (req.url.includes('deepl.com') ? { status: 456, bodyText: '{}' } : null),
      (req) => (req.url.includes('generativelanguage')
        ? { status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini ok' }] } }] }) }
        : null),
    ]);
    const result = await P.translateWithRotation({
      config: BASE_CONFIG, source: 'xin chào', context: '', fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.text, 'gemini ok');
    assert.equal(result.provider, 'gemini');
    assert.equal(calls.filter(c => c.url.includes('deepl.com')).length, 2);
  }

  // 9. Key bị cooldown thì lần gọi sau bỏ qua luôn
  {
    const state = P.createKeyState();
    const first = fakeFetch([() => ({ status: 403, bodyText: '{}' })]);
    await assert.rejects(P.translateWithRotation({
      config: P.normalizeConfig({ providers: { deepl: { enabled: true, keys: [{ key: 'only:fx' }] } } }),
      source: 'x', context: '', fetchText: first.fetchText, keyState: state, sleep: noSleep,
    }));
    assert.equal(first.calls.length, 1);

    const second = fakeFetch([() => ({ status: 200, bodyText: '{}' })]);
    await assert.rejects(P.translateWithRotation({
      config: P.normalizeConfig({ providers: { deepl: { enabled: true, keys: [{ key: 'only:fx' }] } } }),
      source: 'x', context: '', fetchText: second.fetchText, keyState: state, sleep: noSleep,
    }));
    assert.equal(second.calls.length, 0); // Không gọi lại key đang cooldown
  }

  // 10. Tất cả provider lỗi -> throw kèm thông điệp tổng hợp
  {
    const { fetchText } = fakeFetch([
      (req) => (req.url.includes('deepl.com') ? { status: 500, bodyText: '{}' } : null),
      () => ({ status: 200, bodyText: 'not json' }),
    ]);
    await assert.rejects(
      P.translateWithRotation({
        config: BASE_CONFIG, source: 'x', context: '', fetchText, keyState: P.createKeyState(), sleep: noSleep,
      }),
      /DeepL[\s\S]*Gemini/,
    );
  }

  // 11. OpenAI không key vẫn dùng được (API free tự host)
  {
    const cfg = P.normalizeConfig({
      preferred: 'openai',
      providers: { openai: { enabled: true, keys: [], url: 'https://libretranslate.local/translate', format: 'auto' } },
    });
    const { fetchText, calls } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ translatedText: 'libre ok' }) }),
    ]);
    const result = await P.translateWithRotation({
      config: cfg, source: 'xin chào', context: '', fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.text, 'libre ok');
    assert.equal(calls[0].headers.Authorization, undefined);
  }

  // 12. normalizeConfig: tone mặc định 'natural', tone lạ bị gạt bỏ
  {
    assert.equal(P.normalizeConfig({}).tone, 'natural');
    assert.equal(P.normalizeConfig({ tone: 'casual' }).tone, 'casual');
    assert.equal(P.normalizeConfig({ tone: 'hacker' }).tone, 'natural');
  }

  // 13. Prompt thay đổi theo tone
  {
    const pro = P.buildRequest({
      providerId: 'gemini', providerConfig: {}, apiKey: 'k', source: 'x', context: '', tone: 'professional',
    });
    assert.match(JSON.parse(pro.body).systemInstruction.parts[0].text, /Register: PROFESSIONAL/);

    const cas = P.buildRequest({
      providerId: 'gemini', providerConfig: {}, apiKey: 'k', source: 'x', context: '', tone: 'casual',
    });
    assert.match(JSON.parse(cas.body).systemInstruction.parts[0].text, /Register: CASUAL/);

    const nat = P.buildRequest({
      providerId: 'openai',
      providerConfig: { url: 'https://api.openai.com/v1/chat/completions', format: 'chat' },
      apiKey: 'k', source: 'x', context: '', tone: 'natural',
    });
    assert.doesNotMatch(JSON.parse(nat.body).messages[0].content, /Register: (PROFESSIONAL|CASUAL)/);
    assert.match(JSON.parse(nat.body).messages[0].content, /Vietnamese pronouns and particles/);
  }

  // 14. translateWithRotation truyền tone từ config xuống request
  {
    const cfg = P.normalizeConfig({
      tone: 'casual',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    cfg.preferred = 'gemini';
    const { fetchText, calls } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }),
    ]);
    await P.translateWithRotation({
      config: cfg, source: 'ê đi chơi hong', context: '', fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.match(JSON.parse(calls[0].body).systemInstruction.parts[0].text, /Register: CASUAL/);
  }

  // 15. Casual: hướng dẫn bỏ apostrophe kiểu texter + có few-shot
  {
    const casual = P.buildNativeInstructions('casual');
    assert.match(casual, /Register: CASUAL/);
    assert.match(casual, /dont/i); // bỏ apostrophe: im, dont, cant...
    assert.match(casual, /\bim\b/);
    assert.match(casual, /gonna|wanna/);
    assert.match(casual, /anh ơi tối nay đi chơi hong/); // few-shot
    assert.match(casual, /wyd/); // few-shot
    // Base vẫn giữ quy tắc contractions chuẩn cho các tone khác
    const natural = P.buildNativeInstructions('natural');
    assert.match(natural, /contractions/);
    assert.doesNotMatch(natural, /Register: CASUAL/);
  }

  // 16. Batch DeepL: 1 request duy nhất, đọc translations theo thứ tự
  {
    const { fetchText, calls } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ translations: [{ text: 'a' }, { text: 'b' }] }) }),
    ]);
    const result = await P.translateBatchWithRotation({
      config: BASE_CONFIG, texts: ['xin chào', 'tạm biệt'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.deepEqual(result.translations, ['a', 'b']);
    assert.equal(result.provider, 'deepl');
    assert.equal(result.providerLabel, 'DeepL');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.text, ['xin chào', 'tạm biệt']);
    assert.equal(body.target_lang, 'EN-US');
  }

  // 17. Batch Gemini: parse JSON array kèm fence ```json
  {
    const cfg = P.normalizeConfig({
      preferred: 'gemini',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    const fenced = '```json\n["hello","goodbye"]\n```';
    const { fetchText, calls } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: fenced }] } }] }) }),
    ]);
    const result = await P.translateBatchWithRotation({
      config: cfg, texts: ['xin chào', 'tạm biệt'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.deepEqual(result.translations, ['hello', 'goodbye']);
    assert.equal(result.provider, 'gemini');
    const body = JSON.parse(calls[0].body);
    assert.match(body.systemInstruction.parts[0].text, /JSON array of strings, same order and length/);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), ['xin chào', 'tạm biệt']);
  }

  // 18. Batch mismatch length -> providerFailed, fallback provider tiếp theo
  {
    const { fetchText, calls } = fakeFetch([
      (req) => (req.url.includes('deepl.com')
        ? { status: 200, bodyText: JSON.stringify({ translations: [{ text: 'chỉ có 1' }] }) }
        : null),
      (req) => (req.url.includes('generativelanguage')
        ? { status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: '["hello","bye"]' }] } }] }) }
        : null),
    ]);
    const result = await P.translateBatchWithRotation({
      config: BASE_CONFIG, texts: ['xin chào', 'tạm biệt'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.provider, 'gemini');
    assert.deepEqual(result.translations, ['hello', 'bye']);
    assert.equal(calls[0].url.includes('deepl.com'), true);
  }

  // 19. Rotation batch: key DeepL đầu 403 -> key sau thành công
  {
    const { fetchText, calls } = fakeFetch([
      (req) => (req.headers.Authorization === 'DeepL-Auth-Key key-free-1:fx' ? { status: 403, bodyText: '{}' } : null),
      () => ({ status: 200, bodyText: JSON.stringify({ translations: [{ text: 'x1' }, { text: 'x2' }] }) }),
    ]);
    const result = await P.translateBatchWithRotation({
      config: BASE_CONFIG, texts: ['một', 'hai'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.deepEqual(result.translations, ['x1', 'x2']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.Authorization, 'DeepL-Auth-Key key-free-2:fx');
  }

  // 20. Batch không provider nào -> NO_API_KEY
  {
    const cfg = P.normalizeConfig({});
    await assert.rejects(
      P.translateBatchWithRotation({
        config: cfg, texts: ['x'], targetLanguage: 'en',
        fetchText: async () => ({ status: 200, bodyText: '{}' }), sleep: noSleep,
      }),
      /NO_API_KEY/,
    );
  }

  // 21. buildBatchRequest: map đích vi/en đúng mã DeepL, code lạ bị từ chối
  {
    const reqVi = P.buildBatchRequest({
      providerId: 'deepl', providerConfig: {}, apiKey: 'abc:fx',
      texts: ['hello'], targetLanguage: 'vi',
    });
    assert.equal(JSON.parse(reqVi.body).target_lang, 'VI');

    const reqEn = P.buildBatchRequest({
      providerId: 'deepl', providerConfig: {}, apiKey: 'abc:fx',
      texts: ['xin chào'], targetLanguage: 'en',
    });
    assert.equal(JSON.parse(reqEn.body).target_lang, 'EN-US');

    // Code lạ -> ném lỗi không hỗ trợ
    assert.throws(
      () => P.buildBatchRequest({ providerId: 'deepl', providerConfig: {}, apiKey: 'k', texts: ['x'], targetLanguage: 'zh' }),
      /Ngôn ngữ đích không hỗ trợ/,
    );
    await assert.rejects(
      P.translateBatchWithRotation({
        config: BASE_CONFIG, texts: ['x'], targetLanguage: 'zh',
        fetchText: async () => ({ status: 200, bodyText: '{}' }), keyState: P.createKeyState(), sleep: noSleep,
      }),
      /Ngôn ngữ đích không hỗ trợ/,
    );
  }

  // 22. Prompt batch dùng tên tiếng Anh của đích + Gemini batch có safetySettings
  {
    const req = P.buildBatchRequest({
      providerId: 'gemini', providerConfig: { model: 'gemini-2.5-flash' }, apiKey: 'g',
      texts: ['xin chào'], targetLanguage: 'en',
    });
    const body = JSON.parse(req.body);
    assert.match(body.systemInstruction.parts[0].text, /English/);
    assert.match(body.systemInstruction.parts[0].text, /native speaker/); // dịch tự nhiên, không word-for-word
    assert.equal(body.safetySettings.length, 4);
    assert.ok(body.safetySettings.every(s => s.threshold === 'BLOCK_NONE'));
  }

  // 23. Gemini single (buildRequest) cũng có safetySettings BLOCK_NONE đủ 4 category
  {
    const req = P.buildRequest({
      providerId: 'gemini', providerConfig: { model: 'gemini-2.5-flash' }, apiKey: 'g',
      source: 'xin chào', context: '',
    });
    const body = JSON.parse(req.body);
    assert.deepEqual(
      body.safetySettings.map(s => s.category).sort(),
      ['HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT'],
    );
    assert.ok(body.safetySettings.every(s => s.threshold === 'BLOCK_NONE'));
  }

  // 24. Lỗi parse mảng JSON: retry đúng 1 lần trên cùng key rồi mới fallback provider
  {
    const cfg = P.normalizeConfig({
      preferred: 'gemini',
      providers: {
        gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' },
        deepl: { enabled: true, keys: [{ key: 'd:fx' }] },
      },
    });
    const { fetchText, calls } = fakeFetch([
      (req) => (req.url.includes('generativelanguage')
        ? { status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'không phải JSON array' }] } }] }) }
        : null),
      (req) => (req.url.includes('deepl.com')
        ? { status: 200, bodyText: JSON.stringify({ translations: [{ text: 'f1' }, { text: 'f2' }] }) }
        : null),
    ]);
    const result = await P.translateBatchWithRotation({
      config: cfg, texts: ['một', 'hai'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.provider, 'deepl');
    assert.deepEqual(result.translations, ['f1', 'f2']);
    // 1 lần gốc + đúng 1 lần retry trên cùng key gemini
    assert.equal(calls.filter(c => c.url.includes('generativelanguage')).length, 2);
  }

  // 25. Retry parse thành công ngay trên cùng key (không cần đổi provider)
  {
    const cfg = P.normalizeConfig({
      preferred: 'gemini',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    let n = 0;
    const { fetchText, calls } = fakeFetch([
      () => (++n === 1
        ? { status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'oops' }] } }] }) }
        : { status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: '["ok1","ok2"]' }] } }] }) }),
    ]);
    const result = await P.translateBatchWithRotation({
      config: cfg, texts: ['một', 'hai'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.provider, 'gemini');
    assert.deepEqual(result.translations, ['ok1', 'ok2']);
    assert.equal(calls.length, 2);
  }

  // 26. Lỗi HTTP (không phải parse) KHÔNG được retry trên cùng key
  {
    const cfg = P.normalizeConfig({
      preferred: 'gemini',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    const { fetchText, calls } = fakeFetch([
      () => ({ status: 400, bodyText: '{"error":{"message":"bad"}}' }),
    ]);
    await assert.rejects(P.translateBatchWithRotation({
      config: cfg, texts: ['một'], targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    }));
    assert.equal(calls.length, 1); // providerFailed do HTTP -> sang provider khác ngay, không retry
  }

  // 27. buildVisionRequest: inline_data đúng chuẩn + prompt nhắc đúng ngôn ngữ đích
  {
    const req = P.buildVisionRequest({
      providerConfig: { model: 'gemini-2.5-flash' }, apiKey: 'gkey',
      mimeType: 'image/png', imageBase64: 'QUJD', targetLanguage: 'vi',
    });
    assert.match(req.url, /v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(req.headers['x-goog-api-key'], 'gkey');
    const body = JSON.parse(req.body);
    assert.equal(body.contents[0].role, 'user');
    const inline = body.contents[0].parts.find(part => part.inline_data);
    assert.deepEqual(inline.inline_data, { mime_type: 'image/png', data: 'QUJD' });
    assert.match(body.systemInstruction.parts[0].text, /Vietnamese/);
    assert.match(body.systemInstruction.parts[0].text, /OCR \+ translation engine/);
    assert.match(body.contents[0].parts[0].text, /Vietnamese/);
    assert.equal(body.generationConfig.temperature, 0.2);
    assert.equal(body.safetySettings.length, 4);
    assert.ok(body.safetySettings.every(s => s.threshold === 'BLOCK_NONE'));

    // Đích 'en' -> prompt phải nhắc English, không còn Vietnamese
    const reqEn = P.buildVisionRequest({
      providerConfig: {}, apiKey: 'g', mimeType: 'image/jpeg', imageBase64: 'QQ==', targetLanguage: 'en',
    });
    const bodyEn = JSON.parse(reqEn.body);
    assert.match(bodyEn.systemInstruction.parts[0].text, /English/);
    assert.doesNotMatch(bodyEn.systemInstruction.parts[0].text, /Vietnamese/);

    // Ngôn ngữ lạ -> từ chối
    assert.throws(
      () => P.buildVisionRequest({ providerConfig: {}, apiKey: 'g', mimeType: 'image/png', imageBase64: 'QQ==', targetLanguage: 'zh' }),
      /Ngôn ngữ đích không hỗ trợ/,
    );
  }

  // 28. parseVisionLines: JSON sạch / fence ```json / rác thừa / phần tử hỏng
  {
    assert.deepEqual(
      P.parseVisionLines('[{"original":"a","translated":"b"}]'),
      [{ original: 'a', translated: 'b' }],
    );
    assert.deepEqual(
      P.parseVisionLines('```json\n[{"original":"x","translated":"y"}]\n```'),
      [{ original: 'x', translated: 'y' }],
    );
    // Rác trước/sau mảng + phần tử thiếu field bị lọc bỏ
    assert.deepEqual(
      P.parseVisionLines('Kết quả đây: [{"original":"1","translated":"2"}, {"junk":true}, 5, null] xong nhé'),
      [{ original: '1', translated: '2' }],
    );
    // Ảnh không có chữ -> mảng rỗng hợp lệ
    assert.deepEqual(P.parseVisionLines('[]'), []);
    // Không có mảng JSON nào -> throw
    assert.throws(() => P.parseVisionLines('không có mảng nào'), /không parse được/);
  }

  // 29. translateVisionWithRotation: bỏ qua deepl dù enabled, chỉ chạy gemini
  {
    const visionPart = { text: '[{"original":"Xin chào","translated":"Hello"}]' };
    const geminiVisionBody = JSON.stringify({
      candidates: [{ content: { parts: [visionPart] } }],
    });
    const { fetchText, calls } = fakeFetch([
      (req) => (req.url.includes('generativelanguage') ? { status: 200, bodyText: geminiVisionBody } : null),
    ]);
    const result = await P.translateVisionWithRotation({
      config: BASE_CONFIG, mimeType: 'image/png', imageBase64: 'QUJD', targetLanguage: 'en',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.provider, 'gemini');
    assert.deepEqual(result.lines, [{ original: 'Xin chào', translated: 'Hello' }]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('generativelanguage')); // deepl không bị gọi
    assert.ok(JSON.parse(calls[0].body).contents[0].parts.some(part => part.inline_data));
  }

  // 30. Config có deepl mà không có key gemini -> IMAGE_NEEDS_GEMINI
  {
    const cfg = P.normalizeConfig({ providers: { deepl: { enabled: true, keys: [{ key: 'd:fx' }] } } });
    await assert.rejects(
      P.translateVisionWithRotation({
        config: cfg, mimeType: 'image/png', imageBase64: 'QUJD', targetLanguage: 'vi',
        fetchText: async () => ({ status: 200, bodyText: '{}' }), keyState: P.createKeyState(), sleep: noSleep,
      }),
      /IMAGE_NEEDS_GEMINI/,
    );
  }

  // 31. deeplUsageEndpoint: key :fx -> host free /v2/usage, key pro -> host pro
  {
    assert.equal(P.deeplUsageEndpoint('abc:fx'), 'https://api-free.deepl.com/v2/usage');
    assert.equal(P.deeplUsageEndpoint('abc-pro'), 'https://api.deepl.com/v2/usage');
  }

  console.log('Tất cả test providers.js đều PASS ✔');
}

run().catch(error => {
  console.error('TEST FAIL:', error);
  process.exit(1);
});
