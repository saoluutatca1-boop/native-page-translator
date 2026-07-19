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
  webNavigation: { async getAllFrames() { return null; } },
  tabs: { async sendMessage() {} },
};

/* ---------- Stub fetch: trả dữ liệu giả theo từng host ---------- */
const fetchCalls = [];
async function fetchStub(url, options = {}) {
  fetchCalls.push({ url: String(url), options });
  const u = String(url);

  let body = '{}';
  let status = 200;
  if (u.includes('deepl.com')) {
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
    body = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }] });
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

  console.log('SW smoke test PASS ✔ (background khởi động OK, seed key OK, nativeTranslate OK, providerTranslate OK, proxyFetch OK)');
}

main().catch(error => {
  console.error('SMOKE FAIL:', error);
  process.exit(1);
});
