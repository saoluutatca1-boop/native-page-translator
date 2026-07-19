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
    assert.equal(cfg.providers.gemini.model, 'gemini-2.5-flash');
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

  console.log('Tất cả test providers.js đều PASS ✔');
}

run().catch(error => {
  console.error('TEST FAIL:', error);
  process.exit(1);
});
