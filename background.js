importScripts('providers.js');

const {
  CONFIG_STORAGE_KEY,
  PROVIDER_DEFS,
  normalizeConfig,
  usableProviders,
  maskKey,
  deeplUsageEndpoint,
  normalizePageOptions,
  translateWithRotation,
  translateBatchWithRotation,
  translateVisionWithRotation,
  createKeyState,
} = globalThis.NPT_PROVIDERS;

const BUILTIN_ORIGINS = new Set([
  'https://translate.googleapis.com',
  'https://translate.google.com',
  'https://api.mymemory.translated.net',
  'https://api.openai.com',
  'https://generativelanguage.googleapis.com',
  'https://api-free.deepl.com',
  'https://api.deepl.com',
]);

// Key DeepL Free được seed sẵn khi cài extension. Nằm trong chrome.storage.local
// nên gỡ extension là mất hoàn toàn — xoá được trong trang Cài đặt.
const DEFAULT_DEEPL_KEY = '16986bbc-76d3-4d7a-b1f6-58512e011ffc:fx';

// Trạng thái cooldown/con trỏ xoay vòng key, sống trong bộ nhớ service worker.
const keyState = createKeyState();

const LEGACY_KEYS = {
  apiUrl: 'tm-native-en-api-url',
  apiKey: 'tm-native-en-openai-key',
  model: 'tm-native-en-openai-model',
  apiFormat: 'tm-native-en-api-format',
};

function normalizeEndpoint(value) {
  const fallback = PROVIDER_DEFS.openai.defaultUrl;
  const raw = String(value || fallback).trim();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API URL phải dùng http hoặc https');
  }
  return url;
}

/* ------------------------------------------------------------------
 * Đọc cấu hình multi-provider. Nếu chưa có (lần cài đầu / sau update):
 *  - seed key DeepL mặc định
 *  - migrate cài đặt API đơn lẻ của bản cũ (v4.0) sang provider openai
 * ------------------------------------------------------------------ */
async function ensureConfig() {
  const values = await chrome.storage.local.get([CONFIG_STORAGE_KEY, ...Object.values(LEGACY_KEYS)]);
  if (values[CONFIG_STORAGE_KEY]) {
    return normalizeConfig(values[CONFIG_STORAGE_KEY]);
  }

  const config = normalizeConfig({
    preferred: 'deepl',
    providers: {
      deepl: {
        enabled: true,
        keys: [{ key: DEFAULT_DEEPL_KEY, label: 'DeepL Free (mặc định)' }],
      },
    },
  });

  const legacyKey = String(values[LEGACY_KEYS.apiKey] || '').trim();
  const legacyUrl = String(values[LEGACY_KEYS.apiUrl] || '').trim();
  const legacyModel = String(values[LEGACY_KEYS.model] || '').trim();
  const legacyFormat = String(values[LEGACY_KEYS.apiFormat] || '').trim();

  if (legacyKey || legacyUrl) {
    const openai = config.providers.openai;
    openai.enabled = true;
    if (legacyUrl) openai.url = legacyUrl;
    if (legacyModel) openai.model = legacyModel;
    if (legacyFormat) openai.format = legacyFormat;
    if (legacyKey) openai.keys = [{ key: legacyKey, label: 'Key từ bản cũ' }];
  }

  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: config });
  return config;
}

async function isRemoteAllowed(url) {
  if (BUILTIN_ORIGINS.has(url.origin)) return true;

  const config = await ensureConfig();
  let configured;
  try {
    configured = normalizeEndpoint(config.providers.openai?.url);
  } catch (_) {
    return false;
  }

  if (configured.origin !== url.origin) return false;
  return chrome.permissions.contains({ origins: [`${url.origin}/*`] });
}

async function rawFetch(payload) {
  const url = new URL(payload?.url || '');
  if (!(await isRemoteAllowed(url))) {
    throw new Error(`Extension chưa được cấp quyền truy cập ${url.origin}`);
  }

  const method = String(payload?.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error('Blocked HTTP method');

  const controller = new AbortController();
  const timeout = Math.max(1000, Math.min(Number(payload?.timeout) || 30000, 70000));
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url.href, {
      method,
      headers: payload?.headers || {},
      body: method === 'GET' ? undefined : payload?.data ?? undefined,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    });

    const responseText = await response.text();
    return {
      ok: true,
      status: response.status,
      responseText,
      responseHeaders: [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n'),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      responseText: '',
      networkError: error?.name === 'AbortError' ? 'Request timed out' : (error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Adapter fetchText dùng chung cho translateWithRotation/translateBatchWithRotation.
async function providerFetchText(request) {
  const response = await rawFetch({
    method: request.method || 'POST',
    url: request.url,
    headers: request.headers,
    data: request.body,
    timeout: 60000,
  });
  if (!response.ok && response.networkError) {
    return { status: 0, bodyText: '', networkError: response.networkError };
  }
  return { status: response.status, bodyText: response.responseText };
}

async function nativeTranslate(payload) {
  const config = await ensureConfig();

  const result = await translateWithRotation({
    config,
    source: payload?.source,
    context: String(payload?.context || '').trim(),
    keyState,
    fetchText: providerFetchText,
  });

  return { ok: true, text: result.text, provider: result.provider, providerLabel: result.providerLabel };
}

// Giới hạn an toàn cho dịch batch (dịch cả trang).
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_CHARS = 20000;

async function providerTranslate(payload) {
  const texts = payload?.texts;
  if (!Array.isArray(texts) || !texts.length) {
    throw new Error('payload.texts phải là mảng chuỗi không rỗng');
  }
  if (texts.length > MAX_BATCH_ITEMS) {
    throw new Error(`Tối đa ${MAX_BATCH_ITEMS} đoạn mỗi lần dịch`);
  }
  const list = texts.map(item => String(item ?? ''));
  const totalChars = list.reduce((sum, item) => sum + item.length, 0);
  if (totalChars > MAX_BATCH_CHARS) {
    throw new Error(`Tối đa ${MAX_BATCH_CHARS} ký tự mỗi lần dịch`);
  }

  const targetLanguage = String(payload?.targetLanguage || '').toLowerCase();
  if (!['vi', 'en'].includes(targetLanguage)) {
    throw new Error("targetLanguage chỉ hỗ trợ 'vi' hoặc 'en'");
  }

  const config = await ensureConfig();
  const result = await translateBatchWithRotation({
    config,
    texts: list,
    sourceLanguage: payload?.sourceLanguage,
    targetLanguage,
    // Văn phong dịch trang (v4.2): style/dialect/mode/grammar/proper-nouns.
    // normalizePageOptions ép giá trị rác về default; DeepL tự bỏ qua ở tầng providers.
    pageOptions: normalizePageOptions(payload?.pageOptions),
    keyState,
    fetchText: providerFetchText,
  });

  return {
    ok: true,
    translations: result.translations,
    provider: result.provider,
    providerLabel: result.providerLabel,
  };
}

async function providerStatus() {
  const config = await ensureConfig();
  const active = usableProviders(config);
  return {
    ok: true,
    configured: active.length > 0,
    preferred: config.preferred,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, provider]) => [
        id,
        {
          enabled: Boolean(provider.enabled),
          keyCount: provider.keys.length,
          label: PROVIDER_DEFS[id]?.label || id,
        },
      ]),
    ),
    active,
  };
}

/* ------------------------------------------------------------------
 * Mức dùng quota của TỪNG key DeepL đang cấu hình (GET /v2/usage).
 * Key lỗi không chặn các key khác: phần tử đó trả { keyMasked, error }.
 * ------------------------------------------------------------------ */
async function deeplUsage() {
  const config = await ensureConfig();
  const keys = config.providers.deepl?.keys || [];
  const usages = await Promise.all(keys.map(async (entry) => {
    const keyMasked = maskKey(entry.key);
    const response = await rawFetch({
      method: 'GET',
      url: deeplUsageEndpoint(entry.key),
      headers: { Authorization: `DeepL-Auth-Key ${entry.key}` },
      timeout: 15000,
    });
    if (!response.ok || response.status < 200 || response.status >= 300) {
      return { keyMasked, error: `HTTP ${response.status || 0}` };
    }
    let data;
    try {
      data = JSON.parse(response.responseText || '{}');
    } catch (_) {
      return { keyMasked, error: 'Phản hồi không phải JSON' };
    }
    return {
      keyMasked,
      count: Number(data.character_count) || 0,
      limit: Number(data.character_limit) || 0,
      free: /:fx\s*$/i.test(entry.key),
    };
  }));
  return { ok: true, usages };
}

async function broadcastToFrames(tabId, message) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames?.length) {
    return chrome.tabs.sendMessage(tabId, message).then(() => ({ ok: true }));
  }

  const results = await Promise.allSettled(frames.map(frame =>
    chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId })
  ));
  return { ok: results.some(result => result.status === 'fulfilled') };
}

/* ------------------------------------------------------------------
 * Dịch ảnh: menu chuột phải trên ảnh -> OCR + dịch qua Gemini vision.
 * Fetch ảnh cần host permission của origin chứa ảnh — context menu click
 * là user gesture nên chrome.permissions.request gọi được ngay tại đây.
 * ------------------------------------------------------------------ */
const IMAGE_MENU_ID = 'npt-translate-image';
const IMAGE_TARGET_KEY = 'tm-image-target';
const IMAGE_MAX_BYTES = 8 * 1024 * 1024; // ~8MB

function registerImageContextMenu() {
  // removeAll trước để tránh lỗi trùng id khi tạo lại.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: 'Dịch ảnh này (Gemini)',
      contexts: ['image'],
    });
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000; // tránh tràn stack khi spread mảng lớn
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Tải ảnh -> { mimeType, imageBase64 }. Timeout 30s, tối đa ~8MB.
async function fetchImageAsBase64(srcUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(srcUrl, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Không tải được ảnh (HTTP ${response.status})`);
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim() || 'image/png';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > IMAGE_MAX_BYTES) throw new Error('Ảnh quá lớn (tối đa 8MB)');
    return { mimeType, imageBase64: arrayBufferToBase64(buffer) };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Tải ảnh quá chậm (timeout 30s)');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function handleImageTranslate(info, tab) {
  const srcUrl = String(info?.srcUrl || '');
  const tabId = tab?.id;
  if (!srcUrl || !Number.isInteger(tabId)) return;

  // Content script có thể không có trên trang (chrome://...) -> nuốt lỗi gửi.
  const send = (message) => chrome.tabs.sendMessage(tabId, message).catch(() => {});
  await send({ type: 'imageTranslateStart', srcUrl });

  try {
    const origin = new URL(srcUrl).origin;
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!granted) {
      const allowed = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!allowed) throw new Error('Chưa được cấp quyền truy cập ảnh');
    }

    const { mimeType, imageBase64 } = await fetchImageAsBase64(srcUrl);

    const values = await chrome.storage.local.get([IMAGE_TARGET_KEY]);
    const stored = String(values[IMAGE_TARGET_KEY] || '').toLowerCase();
    const targetLanguage = ['vi', 'en'].includes(stored) ? stored : 'vi';

    const config = await ensureConfig();
    const result = await translateVisionWithRotation({
      config,
      mimeType,
      imageBase64,
      targetLanguage,
      keyState,
      fetchText: providerFetchText,
    });

    await send({ type: 'imageTranslateResult', srcUrl, ok: true, lines: result.lines });
  } catch (error) {
    let friendly = error?.message || String(error);
    if (friendly.includes('IMAGE_NEEDS_GEMINI')) {
      friendly = 'Dịch ảnh cần API key Gemini (bật trong Cài đặt)';
    }
    await send({ type: 'imageTranslateResult', srcUrl, ok: false, error: friendly });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info?.menuItemId !== IMAGE_MENU_ID) return;
  handleImageTranslate(info, tab).catch(error =>
    console.warn('[Native Page Translator] Dịch ảnh thất bại:', error));
});

chrome.runtime.onInstalled.addListener(() => {
  ensureConfig().catch(error => console.warn('[Native Page Translator] Seed config failed:', error));
  registerImageContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureConfig().catch(() => {});
  registerImageContextMenu();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'proxyFetch') {
    rawFetch(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, status: 0, responseText: '', networkError: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'nativeTranslate') {
    nativeTranslate(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'providerTranslate') {
    providerTranslate(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'getProviderStatus') {
    providerStatus().then(sendResponse).catch(error => {
      sendResponse({ ok: false, configured: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'deeplUsage') {
    deeplUsage().then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'openOptions') {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'broadcastPageLanguage') {
    const tabId = sender.tab?.id ?? message.tabId;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: 'No active tab' });
      return false;
    }
    broadcastToFrames(tabId, { type: 'setPageLanguage', language: message.language })
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});
