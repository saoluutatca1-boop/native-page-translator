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
      [{ original: 'a', translated: 'b', box: null }],
    );
    assert.deepEqual(
      P.parseVisionLines('```json\n[{"original":"x","translated":"y"}]\n```'),
      [{ original: 'x', translated: 'y', box: null }],
    );
    // Rác trước/sau mảng + phần tử thiếu field bị lọc bỏ
    assert.deepEqual(
      P.parseVisionLines('Kết quả đây: [{"original":"1","translated":"2"}, {"junk":true}, 5, null] xong nhé'),
      [{ original: '1', translated: '2', box: null }],
    );
    // Ảnh không có chữ -> mảng rỗng hợp lệ
    assert.deepEqual(P.parseVisionLines('[]'), []);
    // Không có mảng JSON nào -> throw
    assert.throws(() => P.parseVisionLines('không có mảng nào'), /không parse được/);
  }

  // 28b. parseVisionLines: box [ymin,xmin,ymax,xmax] hợp lệ được giữ, box rác -> null
  {
    assert.deepEqual(
      P.parseVisionLines('[{"box":[10,20,30,40],"original":"a","translated":"b"}]'),
      [{ original: 'a', translated: 'b', box: [10, 20, 30, 40] }],
    );
    assert.deepEqual(
      P.parseVisionLines('[{"box":[1,2,3],"original":"a","translated":"b"}]'),
      [{ original: 'a', translated: 'b', box: null }],
    );
    assert.deepEqual(
      P.parseVisionLines('[{"box":["x",20,30,40],"original":"a","translated":"b"}]'),
      [{ original: 'a', translated: 'b', box: null }],
    );
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
    assert.deepEqual(result.lines, [{ original: 'Xin chào', translated: 'Hello', box: null }]);
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

  // 32. Prompt casual v2: có HARD RULE cấm apostrophe + shorthand idk + few-shot
  {
    const prompt = P.buildNativeInstructions('casual');
    assert.match(prompt, /HARD RULE/);
    assert.match(prompt, /\bim\b.*\bdont\b.*\bcant\b/);
    assert.match(prompt, /\bidk\b/);
    assert.match(prompt, /gimme a sec im eating/);
    // natural không được có HARD RULE
    assert.doesNotMatch(P.buildNativeInstructions('natural'), /HARD RULE/);
  }

  // 33. humanizeCasual: bỏ apostrophe đúng chỗ, không đụng từ thường
  {
    assert.equal(P.humanizeCasual("I'm not sure"), 'im not sure');
    assert.equal(P.humanizeCasual("Don't worry, it's fine"), 'dont worry, its fine');
    assert.equal(P.humanizeCasual("That's cool, I can't come"), 'thats cool, i cant come');
    assert.equal(P.humanizeCasual("We were there"), 'We were there'); // we're/were: không đụng
    assert.equal(P.humanizeCasual("I could've done it"), 'i couldve done it');
    assert.equal(P.humanizeCasual("y'all ready?"), 'yall ready?');
    assert.equal(P.humanizeCasual(''), '');
  }

  // 34. Tone casual: output LLM bị humanize cơ học; tone natural giữ nguyên
  {
    const cfgCasual = P.normalizeConfig({
      tone: 'casual',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    cfgCasual.preferred = 'gemini';
    const { fetchText } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: "I'm not sure, don't worry about it." }] } }] }) }),
    ]);
    const casualResult = await P.translateWithRotation({
      config: cfgCasual, source: 'tôi không chắc nữa, đừng lo', context: '',
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(casualResult.text, 'im not sure, dont worry about it.');

    const cfgNatural = P.normalizeConfig({
      tone: 'natural',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    cfgNatural.preferred = 'gemini';
    const { fetchText: fetchText2 } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: "I'm not sure." }] } }] }) }),
    ]);
    const naturalResult = await P.translateWithRotation({
      config: cfgNatural, source: 'tôi không chắc', context: '',
      fetchText: fetchText2, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(naturalResult.text, "I'm not sure.");
  }

  // 35. normalizePageOptions: default khi null/undefined; giữ giá trị hợp lệ; ép rác về default
  {
    const def = {
      style: 'natural', dialect: 'us', mode: 'natural',
      grammarFix: false, keepProperNouns: true,
      customPrompt: '', glossaryText: '', docMode: false,
    };
    assert.deepEqual(P.normalizePageOptions(null), def);
    assert.deepEqual(P.normalizePageOptions(undefined), def);
    assert.deepEqual(P.normalizePageOptions({}), def);
    // Giá trị hợp lệ được giữ nguyên
    assert.deepEqual(
      P.normalizePageOptions({
        style: 'genz', dialect: 'uk', mode: 'literal', grammarFix: true, keepProperNouns: false,
        customPrompt: 'dịch kiểu lính thủy đánh bộ', glossaryText: '- server => máy chủ', docMode: true,
      }),
      {
        style: 'genz', dialect: 'uk', mode: 'literal', grammarFix: true, keepProperNouns: false,
        customPrompt: 'dịch kiểu lính thủy đánh bộ', glossaryText: '- server => máy chủ', docMode: true,
      },
    );
    // Từng field rác (sai enum / sai kiểu) -> về default của field đó
    assert.deepEqual(
      P.normalizePageOptions({
        style: 'hacker', dialect: 'mars', mode: 'yolo', grammarFix: 'yes', keepProperNouns: 1,
        customPrompt: 42, glossaryText: null, docMode: 'yes',
      }),
      def,
    );
    // String được trim; customPrompt quá 2000 ký tự / glossaryText quá 8000 ký tự bị cắt
    assert.equal(P.normalizePageOptions({ customPrompt: '  hello  ' }).customPrompt, 'hello');
    assert.equal(P.normalizePageOptions({ customPrompt: 'x'.repeat(3000) }).customPrompt.length, 2000);
    assert.equal(P.normalizePageOptions({ glossaryText: 'y'.repeat(9000) }).glossaryText.length, 8000);
  }

  // 36. PAGE_STYLES / PAGE_DIALECTS: export đúng nguyên văn label + instruction theo contract
  {
    assert.equal(P.PAGE_STYLES.natural.label, 'Tự nhiên');
    assert.equal(P.PAGE_STYLES.natural.instruction, '');
    assert.equal(P.PAGE_STYLES.casual.label, 'Trò chuyện thân mật');
    assert.equal(P.PAGE_STYLES.casual.instruction, 'Register: casual chat between friends — relaxed, warm, natural contractions and texting shorthand where it fits (idk, rn, tbh, ngl, lol, gonna, wanna...). Never stiff or formal.');
    assert.equal(P.PAGE_STYLES['work-email'].label, 'Email công việc');
    assert.equal(P.PAGE_STYLES['work-email'].instruction, 'Register: professional work email — courteous, polished, concise. Proper greetings/closings if present. No slang, no text-speak, grammatically impeccable.');
    assert.equal(P.PAGE_STYLES['game-chat'].label, 'Chat game');
    assert.equal(P.PAGE_STYLES['game-chat'].instruction, 'Register: in-game / gamer chat — keep game titles, item names, and gaming terms untranslated; match the trash-talk/hype energy; gaming slang welcome (gg, wp, noob, camping, buff, nerf...).');
    assert.equal(P.PAGE_STYLES.genz.label, 'Văn phong Gen Z');
    assert.equal(P.PAGE_STYLES.genz.instruction, 'Register: Gen Z internet voice — current slang where it fits (fr, no cap, lowkey, highkey, bet, slay, sus, vibe...), playful and punchy, never corporate. Do not force slang into every line.');
    assert.equal(P.PAGE_STYLES.formal.label, 'Lịch sự, trang trọng');
    assert.equal(P.PAGE_STYLES.formal.instruction, 'Register: formal and respectful — polite, complete sentences, honorific-aware. For Vietnamese output use appropriate kính ngữ (anh/chị/quý/cậu...); no slang.');
    assert.equal(P.PAGE_DIALECTS.us.label, 'Tiếng Anh Mỹ');
    assert.equal(P.PAGE_DIALECTS.us.instruction, 'Use American English spelling, vocabulary and idioms (color, organize, apartment...).');
    assert.equal(P.PAGE_DIALECTS.uk.label, 'Tiếng Anh Anh');
    assert.equal(P.PAGE_DIALECTS.uk.instruction, 'Use British English spelling, vocabulary and idioms (colour, organise, flat, cheers...).');
  }

  // 37. buildBatchInstructions mặc định (không pageOptions): có proper-nouns, không lẫn style/dialect
  {
    const vi = P.buildBatchInstructions('auto', 'Vietnamese');
    assert.match(vi, /Keep proper nouns/); // keepProperNouns mặc định true
    assert.doesNotMatch(vi, /casual|British|American/); // target VI: không style, không dialect
    // 4 line base giữ nguyên nội dung
    assert.match(vi, /Return ONLY a JSON array of strings, same order and length/);
    assert.match(vi, /never word-for-word/);
    const en = P.buildBatchInstructions('auto', 'English');
    assert.match(en, /American English/); // target EN: dialect us luôn có
  }

  // 38. Mỗi style -> instruction tương ứng xuất hiện trong output
  {
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese', { style: 'casual' }), /Register: casual chat between friends/);
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese', { style: 'work-email' }), /Register: professional work email/);
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese', { style: 'game-chat' }), /Register: in-game \/ gamer chat/);
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese', { style: 'genz' }), /Register: Gen Z internet voice/);
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese', { style: 'formal' }), /Register: formal and respectful/);
  }

  // 39. Dialect uk: target English -> có "British"; target Vietnamese -> không dialect line nào
  {
    const en = P.buildBatchInstructions('auto', 'English', { dialect: 'uk' });
    assert.match(en, /British English/);
    assert.doesNotMatch(en, /American English/);
    const vi = P.buildBatchInstructions('auto', 'Vietnamese', { dialect: 'uk' });
    assert.doesNotMatch(vi, /British|American/);
  }

  // 40. mode literal -> line fidelity; grammarFix -> line flawless
  {
    assert.match(
      P.buildBatchInstructions('auto', 'Vietnamese', { mode: 'literal' }),
      /prioritize fidelity over flow/,
    );
    assert.match(
      P.buildBatchInstructions('auto', 'Vietnamese', { grammarFix: true }),
      /grammatically flawless/,
    );
  }

  // 41. Line chốt "idiomatically" chỉ xuất hiện khi có ít nhất 1 rule bổ sung
  {
    // Mặc định keepProperNouns=true -> có rule bổ sung -> có line chốt
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese'), /idiomatically in Vietnamese/);
    // Tắt hết rule bổ sung + target không phải English -> không có line chốt
    const bare = P.buildBatchInstructions('auto', 'Vietnamese', { keepProperNouns: false });
    assert.doesNotMatch(bare, /idiomatically/);
  }

  // 42. buildBatchRequest: gemini + openai chat nhận pageOptions; openai libre vẫn throw
  {
    const gem = P.buildBatchRequest({
      providerId: 'gemini', providerConfig: { model: 'gemini-2.5-flash' }, apiKey: 'g',
      texts: ['xin chào'], targetLanguage: 'en',
      pageOptions: { style: 'genz' },
    });
    assert.match(JSON.parse(gem.body).systemInstruction.parts[0].text, /Gen Z/);

    const chat = P.buildBatchRequest({
      providerId: 'openai',
      providerConfig: { url: 'https://api.openai.com/v1/chat/completions', format: 'chat' },
      apiKey: 'k', texts: ['xin chào'], targetLanguage: 'en',
      pageOptions: { style: 'casual' },
    });
    assert.match(JSON.parse(chat.body).messages[0].content, /casual chat between friends/);

    const responses = P.buildBatchRequest({
      providerId: 'openai',
      providerConfig: { url: 'https://api.openai.com/v1/responses', format: 'responses' },
      apiKey: 'k', texts: ['xin chào'], targetLanguage: 'en',
      pageOptions: { style: 'formal' },
    });
    assert.match(JSON.parse(responses.body).instructions, /formal and respectful/);

    assert.throws(
      () => P.buildBatchRequest({
        providerId: 'openai',
        providerConfig: { url: 'https://libretranslate.local/translate', format: 'libre' },
        apiKey: '', texts: ['x'], targetLanguage: 'en',
        pageOptions: { style: 'genz' },
      }),
      /không hỗ trợ dịch batch/,
    );
  }

  // 43. buildBatchRequest deepl: pageOptions bị bỏ qua, body JSON không đổi
  {
    const base = P.buildBatchRequest({
      providerId: 'deepl', providerConfig: {}, apiKey: 'abc:fx',
      texts: ['xin chào'], targetLanguage: 'en',
    });
    const styled = P.buildBatchRequest({
      providerId: 'deepl', providerConfig: {}, apiKey: 'abc:fx',
      texts: ['xin chào'], targetLanguage: 'en',
      pageOptions: { style: 'formal', dialect: 'uk', mode: 'literal', grammarFix: true },
    });
    assert.equal(styled.body, base.body);
    assert.equal(styled.url, base.url);
  }

  // 44. translateBatchWithRotation truyền pageOptions xuống request (gemini 1 key)
  {
    const cfg = P.normalizeConfig({
      preferred: 'gemini',
      providers: { gemini: { enabled: true, keys: [{ key: 'g' }], model: 'gemini-2.5-flash' } },
    });
    const { fetchText, calls } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: '["hello"]' }] } }] }) }),
    ]);
    const result = await P.translateBatchWithRotation({
      config: cfg, texts: ['xin chào'], targetLanguage: 'en',
      pageOptions: { style: 'formal', dialect: 'uk' },
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.deepEqual(result.translations, ['hello']);
    const instructions = JSON.parse(calls[0].body).systemInstruction.parts[0].text;
    assert.match(instructions, /formal/);
    assert.match(instructions, /British/);
  }

  // 45. buildBatchInstructions: docMode/glossaryText/customPrompt xuất hiện đúng block, đúng thứ tự
  {
    const out = P.buildBatchInstructions('auto', 'Vietnamese', {
      docMode: true,
      glossaryText: '- server => máy chủ\n- deploy => triển khai',
      customPrompt: 'Dịch ngắn gọn như thông báo nội bộ',
    });
    assert.match(out, /technical documentation: keep all code, inline code, commands, file paths and identifiers unchanged; translate only prose\./);
    assert.match(out, /Always apply this terminology glossary \(highest priority for these terms\):\n- server => máy chủ\n- deploy => triển khai/);
    assert.match(out, /Additional user instructions \(override the rules above if conflicting\):\nDịch ngắn gọn như thông báo nội bộ/);
    // Thứ tự: docMode -> glossary -> customPrompt (đứng cuối cùng)
    const iDoc = out.indexOf('technical documentation');
    const iGloss = out.indexOf('terminology glossary');
    const iCustom = out.indexOf('Additional user instructions');
    assert.ok(iDoc !== -1 && iDoc < iGloss && iGloss < iCustom);

    // Không truyền 3 field -> không có block nào
    const bare = P.buildBatchInstructions('auto', 'Vietnamese');
    assert.doesNotMatch(bare, /technical documentation/);
    assert.doesNotMatch(bare, /terminology glossary/);
    assert.doesNotMatch(bare, /Additional user instructions/);

    // Chỉ docMode
    assert.match(P.buildBatchInstructions('auto', 'Vietnamese', { docMode: true }), /translate only prose/);
    // customPrompt/glossary rỗng sau trim -> bỏ qua
    const blank = P.buildBatchInstructions('auto', 'Vietnamese', { customPrompt: '   ', glossaryText: '  ' });
    assert.doesNotMatch(blank, /terminology glossary|Additional user instructions/);
  }

  // 46. buildSummaryRequest: prompt yêu cầu bullet + ngôn ngữ đích (gemini + openai)
  {
    const gem = P.buildSummaryRequest({
      providerId: 'gemini', providerConfig: { model: 'gemini-2.5-flash' }, apiKey: 'gkey',
      text: 'Nội dung trang cần tóm tắt', targetLanguage: 'vi', maxBullets: 5,
    });
    assert.match(gem.url, /v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(gem.headers['x-goog-api-key'], 'gkey');
    const gemBody = JSON.parse(gem.body);
    const gemIns = gemBody.systemInstruction.parts[0].text;
    assert.match(gemIns, /at most 5 bullet points/);
    assert.match(gemIns, /starting with '- '/);
    assert.match(gemIns, /ENTIRE summary in Vietnamese/);
    assert.match(gemIns, /plain text only/);
    assert.equal(gemBody.contents[0].parts[0].text, 'Nội dung trang cần tóm tắt');

    const chat = P.buildSummaryRequest({
      providerId: 'openai',
      providerConfig: { url: 'https://api.openai.com/v1/chat/completions', format: 'chat' },
      apiKey: 'sk-test', text: 'page content', targetLanguage: 'en', maxBullets: 10,
    });
    assert.equal(chat.openaiFormat, 'chat');
    assert.equal(chat.headers.Authorization, 'Bearer sk-test');
    const chatBody = JSON.parse(chat.body);
    assert.match(chatBody.messages[0].content, /at most 10 bullet points/);
    assert.match(chatBody.messages[0].content, /ENTIRE summary in English/);
    assert.equal(chatBody.messages[1].content, 'page content');

    // maxBullets mặc định 8, cap 3..15
    const def = P.buildSummaryRequest({ providerId: 'gemini', providerConfig: {}, apiKey: 'g', text: 'x', targetLanguage: 'vi' });
    assert.match(JSON.parse(def.body).systemInstruction.parts[0].text, /at most 8 bullet/);
    const high = P.buildSummaryRequest({ providerId: 'gemini', providerConfig: {}, apiKey: 'g', text: 'x', targetLanguage: 'vi', maxBullets: 99 });
    assert.match(JSON.parse(high.body).systemInstruction.parts[0].text, /at most 15 bullet/);

    // DeepL / ngôn ngữ lạ -> từ chối
    assert.throws(
      () => P.buildSummaryRequest({ providerId: 'deepl', providerConfig: {}, apiKey: 'd:fx', text: 'x', targetLanguage: 'vi' }),
      /SUMMARIZE_REQUIRES_LLM/,
    );
    assert.throws(
      () => P.buildSummaryRequest({ providerId: 'gemini', providerConfig: {}, apiKey: 'g', text: 'x', targetLanguage: 'zh' }),
      /Ngôn ngữ đích không hỗ trợ/,
    );
  }

  // 47. summarizeWithRotation: plain text bullet, bỏ qua DeepL dù enabled
  {
    const { fetchText, calls } = fakeFetch([
      (req) => (req.url.includes('generativelanguage')
        ? { status: 200, bodyText: JSON.stringify({ candidates: [{ content: { parts: [{ text: '- điểm 1\n- điểm 2' }] } }] }) }
        : null),
    ]);
    const result = await P.summarizeWithRotation({
      config: BASE_CONFIG, text: 'Nội dung dài cần tóm tắt', targetLanguage: 'vi', maxBullets: 5,
      fetchText, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result.text, '- điểm 1\n- điểm 2');
    assert.equal(result.provider, 'gemini');
    assert.equal(result.providerLabel, 'Google AI Studio (Gemini)');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('generativelanguage')); // deepl không bị gọi

    // OpenAI cũng summarize được khi gemini không khả dụng
    const cfgOpenai = P.normalizeConfig({
      preferred: 'openai',
      providers: {
        deepl: { enabled: true, keys: [{ key: 'd:fx' }] },
        openai: { enabled: true, keys: [{ key: 'sk' }], url: 'https://api.openai.com/v1/chat/completions', format: 'chat' },
      },
    });
    const { fetchText: fetchText2, calls: calls2 } = fakeFetch([
      () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: '- point 1\n- point 2' } }] }) }),
    ]);
    const result2 = await P.summarizeWithRotation({
      config: cfgOpenai, text: 'long page', targetLanguage: 'en',
      fetchText: fetchText2, keyState: P.createKeyState(), sleep: noSleep,
    });
    assert.equal(result2.provider, 'openai');
    assert.equal(result2.text, '- point 1\n- point 2');
    assert.equal(calls2.length, 1);

    // Ngôn ngữ lạ / text rỗng -> từ chối
    await assert.rejects(
      P.summarizeWithRotation({
        config: BASE_CONFIG, text: 'x', targetLanguage: 'zh',
        fetchText, keyState: P.createKeyState(), sleep: noSleep,
      }),
      /Ngôn ngữ đích không hỗ trợ/,
    );
    await assert.rejects(
      P.summarizeWithRotation({
        config: BASE_CONFIG, text: '   ', targetLanguage: 'vi',
        fetchText, keyState: P.createKeyState(), sleep: noSleep,
      }),
      /Không có nội dung/,
    );
  }

  // 48. Chỉ có DeepL key -> SUMMARIZE_REQUIRES_LLM (không gọi fetch nào)
  {
    const cfg = P.normalizeConfig({ providers: { deepl: { enabled: true, keys: [{ key: 'd:fx' }] } } });
    const { fetchText, calls } = fakeFetch([() => ({ status: 200, bodyText: '{}' })]);
    await assert.rejects(
      P.summarizeWithRotation({
        config: cfg, text: 'nội dung', targetLanguage: 'vi',
        fetchText, keyState: P.createKeyState(), sleep: noSleep,
      }),
      /SUMMARIZE_REQUIRES_LLM/,
    );
    assert.equal(calls.length, 0);
  }

  console.log('Tất cả test providers.js đều PASS ✔');
}

run().catch(error => {
  console.error('TEST FAIL:', error);
  process.exit(1);
});
