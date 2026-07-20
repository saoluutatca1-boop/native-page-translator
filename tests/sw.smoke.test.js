/* Smoke test: giả lập môi trường service worker của Chrome trong node.
 * Mục tiêu: bắt lỗi khởi động background.js + kiểm tra luồng message chính.
 * Chạy: node tests/sw.smoke.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* ---------- Stub chrome.* ---------- */
const storageData = new Map();
const messageListeners = [];
const installedListeners = [];
const contextMenuListeners = [];
const createdMenus = [];
const sentTabMessages = [];

const chromeStub = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return Object.fromEntries(storageData);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (storageData.has(key)) out[key] = storageData.get(key);
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storageData.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storageData.delete(key);
      },
    },
    onChanged: { addListener() {} },
  },
  permissions: {
    async contains() { return true; },
    async request() { return true; },
  },
  runtime: {
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    onInstalled: { addListener(fn) { installedListeners.push(fn); } },
    onStartup: { addListener() {} },
    async openOptionsPage() {},
  },
  contextMenus: {
    create(menu) { createdMenus.push(menu); },
    removeAll(cb) { createdMenus.length = 0; if (cb) cb(); },
    onClicked: { addListener(fn) { contextMenuListeners.push(fn); } },
  },
  webNavigation: { async getAllFrames() { return null; } },
  tabs: {
    async sendMessage(tabId, message) { sentTabMessages.push({ tabId, message }); },
  },
};

/* ---------- Stub fetch: trả dữ liệu giả theo từng host ---------- */
const fetchCalls = [];
async function fetchStub(url, options = {}) {
  fetchCalls.push({ url: String(url), options });
  const u = String(url);

  // Ảnh giả để test dịch ảnh: trả ArrayBuffer nhỏ + content-type PNG.
  if (u.endsWith('.png')) {
    return {
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'image/png']]),
      async arrayBuffer() { return new Uint8Array([137, 80, 78, 71]).buffer; },
      async text() { return ''; },
    };
  }

  let body = '{}';
  let status = 200;
  if (u.includes('/v2/usage')) {
    // DeepL /v2/usage: quota của key (check trước nhánh deepl.com).
    body = JSON.stringify({ character_count: 12345, character_limit: 500000 });
  } else if (u.includes('deepl.com')) {
    // DeepL batch: trả mảng translations cùng độ dài với mảng text gửi lên.
    let count = 1;
    try {
      const parsed = JSON.parse(options.body || '{}');
      if (Array.isArray(parsed.text)) count = parsed.text.length;
    } catch (_) { /* giữ count = 1 */ }
    const sample = ['hello from deepl', 'goodbye from deepl'];
    body = JSON.stringify({
      translations: Array.from({ length: count }, (_, i) => ({ text: sample[i] || `text ${i}` })),
    });
  } else if (u.includes('translate.googleapis.com') || u.includes('translate.google.com')) {
    body = JSON.stringify([[['xin chào', 'hello', null, null, 1]], null, 'vi']);
  } else if (u.includes('generativelanguage')) {
    // Request vision (có part inline_data) -> trả mảng OCR dạng fence ```json.
    let isVision = false;
    try {
      const parsed = JSON.parse(options.body || '{}');
      isVision = Boolean(parsed.contents?.[0]?.parts?.some(part => part.inline_data));
    } catch (_) { /* giữ isVision = false */ }
    const textPart = {
      text: isVision
        ? '```json\n[{"original":"Xin chào","translated":"Hello"}]\n```'
        : 'hello from gemini',
    };
    body = JSON.stringify({ candidates: [{ content: { parts: [textPart] } }] });
  }

  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body; },
    headers: new Map(),
  };
}

/* ---------- Dựng sandbox giống service worker ---------- */
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  AbortController,
  btoa,
  fetch: fetchStub,
  chrome: chromeStub,
  module: undefined,
};
sandbox.globalThis = sandbox;
sandbox.importScripts = (...files) => {
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
};

vm.createContext(sandbox);

async function main() {
  // 1. background.js phải load không lỗi (đây là chỗ Brave sẽ chết nếu SW hỏng)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  assert.ok(messageListeners.length > 0, 'onMessage listener chưa được đăng ký');
  assert.ok(installedListeners.length > 0, 'onInstalled listener chưa được đăng ký');

  // 2. onInstalled: seed config + key DeepL mặc định
  await installedListeners[0]({ reason: 'install' });
  // onInstalled listener không await, chờ 1 tick
  await new Promise(resolve => setTimeout(resolve, 50));
  const cfg = storageData.get('tm-multi-provider-config');
  assert.ok(cfg, 'config chưa được seed vào storage');
  assert.equal(cfg.providers.deepl.keys[0].key, '16986bbc-76d3-4d7a-b1f6-58512e011ffc:fx');
  assert.equal(cfg.tone, 'natural');

  // Helper bắn message như content/popup
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout')), 3000);
      messageListeners[0](message, { tab: { id: 1 } }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  // 3. getProviderStatus
  const status = await sendMessage({ type: 'getProviderStatus' });
  assert.equal(status.ok, true);
  assert.equal(status.configured, true);
  assert.deepEqual(Array.from(status.active), ['deepl']);
  assert.equal(status.providers.deepl.keyCount, 1);

  // 4. nativeTranslate -> đi qua DeepL (fetch stub)
  const translated = await sendMessage({
    type: 'nativeTranslate',
    payload: { source: 'xin chào bạn', context: '' },
  });
  assert.equal(translated.ok, true, JSON.stringify(translated));
  assert.equal(translated.text, 'hello from deepl');
  assert.equal(translated.provider, 'deepl');

  // 5. providerTranslate -> batch qua DeepL, translations cùng thứ tự
  const batch = await sendMessage({
    type: 'providerTranslate',
    payload: { texts: ['xin chào', 'tạm biệt'], targetLanguage: 'en' },
  });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  assert.deepEqual(Array.from(batch.translations), ['hello from deepl', 'goodbye from deepl']);
  assert.equal(batch.provider, 'deepl');
  assert.equal(batch.providerLabel, 'DeepL');

  // 5b. providerTranslate payload không hợp lệ -> ok:false
  const badBatch = await sendMessage({
    type: 'providerTranslate',
    payload: { texts: [], targetLanguage: 'en' },
  });
  assert.equal(badBatch.ok, false);
  assert.match(badBatch.error, /texts/);

  // 5c. providerTranslate đích 'vi': DeepL nhận target_lang VI
  const viBatch = await sendMessage({
    type: 'providerTranslate',
    payload: { texts: ['hello'], targetLanguage: 'vi' },
  });
  assert.equal(viBatch.ok, true, JSON.stringify(viBatch));
  const viCall = fetchCalls.filter(c => c.url.includes('deepl.com')).pop();
  assert.equal(JSON.parse(viCall.options.body).target_lang, 'VI');

  // 5d. targetLanguage ngoài vi/en -> ok:false
  const badLang = await sendMessage({
    type: 'providerTranslate',
    payload: { texts: ['x'], targetLanguage: 'zh' },
  });
  assert.equal(badLang.ok, false);
  assert.match(badLang.error, /chỉ hỗ trợ/);

  // 6. proxyFetch tới endpoint Google free (đường dịch cả trang)
  const proxied = await sendMessage({
    type: 'proxyFetch',
    payload: {
      method: 'GET',
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=xin%20chao',
      timeout: 5000,
    },
  });
  assert.equal(proxied.ok, true, JSON.stringify(proxied));
  assert.equal(proxied.status, 200);
  assert.match(proxied.responseText, /xin chào/);

  // 7. proxyFetch tới domain lạ phải bị chặn
  const blocked = await sendMessage({
    type: 'proxyFetch',
    payload: { method: 'GET', url: 'https://evil.example.com/api', timeout: 5000 },
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.networkError, /chưa được cấp quyền/);

  // 8. Dịch ảnh qua context menu: fetch ảnh -> gemini vision -> sendMessage kết quả
  {
    // onInstalled (mục 2) phải tạo menu chuột phải
    assert.ok(createdMenus.some(menu => menu.id === 'npt-translate-image'), 'chưa tạo context menu dịch ảnh');
    assert.equal(createdMenus.find(menu => menu.id === 'npt-translate-image').title, 'Dịch ảnh này (Gemini)');
    assert.ok(contextMenuListeners.length > 0, 'chưa đăng ký contextMenus.onClicked');

    // Config seed chỉ có deepl -> bật gemini có key để dịch ảnh được
    const cfg = storageData.get('tm-multi-provider-config');
    cfg.providers.gemini.enabled = true;
    cfg.providers.gemini.keys = [{ key: 'gemini-key-1', label: 'gm' }];
    await chromeStub.storage.local.set({ 'tm-multi-provider-config': cfg });

    contextMenuListeners[0](
      { menuItemId: 'npt-translate-image', srcUrl: 'https://example.com/meme.png' },
      { id: 7 },
    );

    // Handler chạy async (fire-and-forget): poll chờ message kết quả
    let resultMsg = null;
    for (let i = 0; i < 50 && !resultMsg; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      resultMsg = sentTabMessages.find(entry => entry.message.type === 'imageTranslateResult');
    }
    const startMsg = sentTabMessages.find(entry => entry.message.type === 'imageTranslateStart');
    assert.ok(startMsg, 'thiếu imageTranslateStart');
    assert.equal(startMsg.tabId, 7);
    assert.equal(startMsg.message.srcUrl, 'https://example.com/meme.png');
    assert.ok(resultMsg, 'thiếu imageTranslateResult');
    assert.equal(resultMsg.tabId, 7);
    assert.equal(resultMsg.message.ok, true, JSON.stringify(resultMsg.message));
    // lines được tạo trong vm sandbox (realm khác) -> so sánh qua JSON round-trip.
    assert.deepEqual(
      JSON.parse(JSON.stringify(resultMsg.message.lines)),
      [{ original: 'Xin chào', translated: 'Hello', box: null }],
    );

    // Request vision gửi đi: inline_data đúng mime + prompt đích mặc định Vietnamese
    const visionCall = fetchCalls.filter(c => c.url.includes('generativelanguage')).pop();
    const visionBody = JSON.parse(visionCall.options.body);
    assert.ok(visionBody.contents[0].parts.some(part => part.inline_data?.mime_type === 'image/png'));
    assert.ok(visionBody.contents[0].parts.some(part => part.inline_data?.data));
    assert.match(visionBody.systemInstruction.parts[0].text, /Vietnamese/);
  }

  // 9. deeplUsage -> quota của key DeepL seed sẵn
  {
    const usage = await sendMessage({ type: 'deeplUsage' });
    assert.equal(usage.ok, true, JSON.stringify(usage));
    assert.equal(usage.usages.length, 1);
    assert.equal(usage.usages[0].count, 12345);
    assert.equal(usage.usages[0].limit, 500000);
    assert.equal(usage.usages[0].free, true); // key seed đuôi :fx
    assert.match(usage.usages[0].keyMasked, /^.{3}….{4}$/); // dạng mask, không lộ key

    // Request phải đi host free, GET kèm auth header của key đó
    const usageCall = fetchCalls.filter(c => c.url.includes('/v2/usage')).pop();
    assert.ok(usageCall.url.startsWith('https://api-free.deepl.com/'));
    assert.equal(usageCall.options.method, 'GET');
    assert.equal(usageCall.options.headers.Authorization, 'DeepL-Auth-Key 16986bbc-76d3-4d7a-b1f6-58512e011ffc:fx');
  }

  console.log('SW smoke test PASS ✔ (background khởi động OK, seed key OK, nativeTranslate OK, providerTranslate OK, proxyFetch OK, dịch ảnh OK, deeplUsage OK)');
}

main().catch(error => {
  console.error('SMOKE FAIL:', error);
  process.exit(1);
});
