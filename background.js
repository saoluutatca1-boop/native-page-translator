importScripts('providers.js');

const {
  CONFIG_STORAGE_KEY,
  PROVIDER_DEFS,
  normalizeConfig,
  usableProviders,
  providerKind,
  providerLabelOf,
  maskKey,
  deeplUsageEndpoint,
  normalizePageOptions,
  translateWithRotation,
  translateBatchWithRotation,
  summarizeWithRotation,
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

// Registry các providerTranslate đang chạy: requestId -> AbortController (NPT-007).
const inflightRequests = new Map();

// Không đưa bất kỳ mảnh credential nào (kể cả dạng mask [abc…wxyz]) về content script.
function sanitizeProviderError(error) {
  return String(error?.message || error || 'Provider lỗi')
    .replace(/\[[^\]]*…[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Chỉ extension page (popup/options) mới được gọi một số lệnh quản trị (NPT-017).
function isExtensionPageSender(sender) {
  return typeof sender?.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

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
  // Custom endpoint chỉ cho HTTPS: HTTP làm lộ Bearer key + nội dung dạng plaintext.
  // Ngoại lệ loopback (self-host/dev nội bộ).
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error('Custom endpoint chỉ chấp nhận HTTPS (trừ localhost)');
  }
  return url;
}

/* ------------------------------------------------------------------
 * Đọc cấu hình multi-provider. Nếu chưa có (lần cài đầu / sau update):
 *  - seed key DeepL mặc định
 *  - migrate cài đặt API đơn lẻ của bản cũ (v4.0) sang provider openai
 * ------------------------------------------------------------------ */
/* Config được đọc lại từ storage + normalize cho MỖI message (mỗi batch dịch,
 * mỗi lần hỏi trạng thái). Giữ trong bộ nhớ service worker và chỉ bỏ khi
 * storage thực sự đổi — listener onChanged bên dưới lo việc đó. */
let configCache = null;

async function ensureConfig() {
  if (configCache) return configCache;

  const values = await chrome.storage.local.get([CONFIG_STORAGE_KEY, ...Object.values(LEGACY_KEYS)]);
  if (values[CONFIG_STORAGE_KEY]) {
    configCache = normalizeConfig(values[CONFIG_STORAGE_KEY]);
    return configCache;
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
  /* Xoá hẳn cấu hình v4.0 sau khi đã migrate. Trước đây chúng nằm lại trong
   * storage vĩnh viễn — trong đó 'tm-native-en-openai-key' là Bearer key THÔ.
   * Một bản sao credential không ai đọc tới là bản sao chỉ chực rò rỉ: nó đã
   * lọt vào file "Xuất cài đặt" đúng cái file mà UI hứa là không kèm API key. */
  await chrome.storage.local.remove(Object.values(LEGACY_KEYS)).catch(() => {});
  configCache = config;
  return config;
}

async function isRemoteAllowed(url) {
  if (BUILTIN_ORIGINS.has(url.origin)) return true;

  /* Mỗi slot OpenAI-compatible có endpoint riêng, nên whitelist là origin của
   * TẤT CẢ slot đang cấu hình — không còn mỗi một url duy nhất. Origin nào có
   * url hỏng thì bỏ qua chứ không chặn luôn các slot còn lại. */
  const config = await ensureConfig();
  const origins = new Set();
  for (const [id, provider] of Object.entries(config.providers)) {
    if (providerKind(id) !== 'openai') continue;
    try {
      origins.add(normalizeEndpoint(provider?.url).origin);
    } catch (_) { /* endpoint hỏng -> không tính vào whitelist */ }
  }

  if (!origins.has(url.origin)) return false;
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

  // Abort từ bên ngoài (content timeout/navigation gửi cancelProviderTranslate) —
  // chỉ dùng nội bộ, message từ content không chèn được signal (JSON clone).
  const externalSignal = payload?.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

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

    // Đọc response theo chunk có cap — endpoint lạ có thể stream payload khổng lồ
    // nhằm DoS service worker nếu buffer toàn bộ bằng response.text().
    let responseText = '';
    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_RESPONSE_TEXT_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`Phản hồi quá lớn (>${Math.round(MAX_RESPONSE_TEXT_BYTES / 1048576)}MB)`);
        }
        responseText += decoder.decode(value, { stream: true });
      }
      responseText += decoder.decode();
    } else {
      responseText = await response.text();
    }
    return {
      ok: true,
      status: response.status,
      responseText,
      // Provider nói rõ phải chờ bao lâu khi 429/503 — providers.js dùng con số
      // này làm cooldown thay vì đoán bừa.
      retryAfter: response.headers.get('retry-after') || '',
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
// signal: AbortSignal nội bộ để hủy request khi content timeout (NPT-007).
async function providerFetchText(request, signal) {
  const response = await rawFetch({
    method: request.method || 'POST',
    url: request.url,
    headers: request.headers,
    data: request.body,
    timeout: 60000,
    signal,
  });
  if (!response.ok && response.networkError) {
    return { status: 0, bodyText: '', networkError: response.networkError };
  }
  return {
    status: response.status,
    bodyText: response.responseText,
    retryAfterMs: globalThis.NPT_PROVIDERS.parseRetryAfter(response.retryAfter),
  };
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

/* ------------------------------------------------------------------
 * Cache bản dịch dùng chung cho MỌI tab và sống qua cả lần service worker bị
 * dọn. Content script chỉ có cache trong bộ nhớ của từng tab nên mở lại trang,
 * mở tab thứ hai cùng site, hay reload đều phải trả tiền dịch lại từ đầu.
 *
 * RIÊNG TƯ — nói cho đúng: khoá là HASH của đoạn gốc, nhưng GIÁ TRỊ là bản
 * dịch NGUYÊN VĂN. Bản dịch chính là nội dung trang ở ngôn ngữ khác, nên đây
 * thực chất là lưu phần chữ đọc được của trang xuống đĩa. Vì vậy:
 *   - Mô tả trong Cài đặt/README phải nói rõ điều này, không được nói "không
 *     lưu nội dung trang".
 *   - Tab ẩn danh KHÔNG bao giờ được ghi vào cache (xem isCacheableSender):
 *     nội dung phiên ẩn danh không được phép sống lâu hơn phiên đó.
 * Ghi xuống storage có debounce (tránh ghi 400KB liên tục giữa lúc đang dịch),
 * LRU theo số entry. Tắt hẳn bằng setting 'tm-translation-cache' = false.
 * ------------------------------------------------------------------ */
const TRANSLATION_CACHE_KEY = 'tm-translation-cache-v1';
const TRANSLATION_CACHE_ENABLED_KEY = 'tm-translation-cache';
const TRANSLATION_CACHE_MAX = 3000;
const TRANSLATION_CACHE_FLUSH_MS = 5000;
// Đủ nhiều entry mới thì ghi ngay, không chờ debounce — service worker có thể
// bị dọn trước khi timer chạy, mất sạch phần vừa dịch.
const TRANSLATION_CACHE_FLUSH_AT = 60;

const translationCache = new Map();
let translationCacheEnabled = true;
let translationCacheLoaded = null;
let translationCacheDirty = 0;
let translationCacheTimer = null;

/* Hai vòng FNV-1a với hằng số nhân khác nhau + độ dài → khoá ~64 bit.
 * Đủ thưa cho vài nghìn entry và không phục hồi được văn bản gốc. */
function hashText(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length.toString(36)}`;
}

async function ensureTranslationCache() {
  if (!translationCacheLoaded) {
    translationCacheLoaded = (async () => {
      const values = await chrome.storage.local
        .get([TRANSLATION_CACHE_KEY, TRANSLATION_CACHE_ENABLED_KEY])
        .catch(() => ({}));
      translationCacheEnabled = values[TRANSLATION_CACHE_ENABLED_KEY] !== false;
      const stored = values[TRANSLATION_CACHE_KEY];
      if (stored && typeof stored === 'object') {
        for (const [key, value] of Object.entries(stored)) {
          if (typeof value === 'string') translationCache.set(key, value);
        }
      }
    })();
  }
  await translationCacheLoaded;
}

async function flushTranslationCache() {
  clearTimeout(translationCacheTimer);
  translationCacheTimer = null;
  if (!translationCacheDirty) return;
  translationCacheDirty = 0;
  await chrome.storage.local
    .set({ [TRANSLATION_CACHE_KEY]: Object.fromEntries(translationCache) })
    .catch(() => { /* quota đầy / storage lỗi: cache vẫn dùng được trong bộ nhớ */ });
}

function translationCacheSet(key, value) {
  if (translationCache.has(key)) translationCache.delete(key); // đưa lên cuối (LRU)
  else if (translationCache.size >= TRANSLATION_CACHE_MAX) {
    translationCache.delete(translationCache.keys().next().value);
  }
  translationCache.set(key, value);
  translationCacheDirty++;
  if (translationCacheDirty >= TRANSLATION_CACHE_FLUSH_AT) {
    flushTranslationCache();
    return;
  }
  if (!translationCacheTimer) {
    translationCacheTimer = setTimeout(flushTranslationCache, TRANSLATION_CACHE_FLUSH_MS);
  }
}

function translationCacheGet(key) {
  const value = translationCache.get(key);
  if (value === undefined) return undefined;
  translationCache.delete(key);
  translationCache.set(key, value); // refresh LRU
  return value;
}

/* Tiền tố khoá: mọi thứ làm ĐỔI kết quả dịch phải nằm trong đây, nếu không
 * đổi văn phong/provider xong vẫn nhận lại bản dịch cũ.
 * pageContext (v4.4) được TÁCH khỏi phần hash: title/description đổi theo từng
 * trang nên hash cả object sẽ chia cache theo từng URL (mất hit giữa các trang
 * cùng site). Chỉ giữ `host` ở dạng rõ — cô lập ngữ cảnh giữa các site ("feed"
 * trên MXH khác "feed" trên web thú cưng) nhưng vẫn share cache trong 1 site. */
function translationCachePrefix(config, sourceLanguage, targetLanguage, pageOptions) {
  const providerId = config?.preferred || '';
  const model = config?.providers?.[providerId]?.model || '';
  const { pageContext, ...styleOptions } = pageOptions || {};
  const contextHost = typeof pageContext?.host === 'string' ? pageContext.host : '';
  return `${providerId}|${model}|${sourceLanguage || 'auto'}|${targetLanguage}|${hashText(JSON.stringify(styleOptions))}|${contextHost}|`;
}

/* Tab ẩn danh: extension chạy ở chế độ spanning nên dùng CHUNG service worker
 * và CHUNG chrome.storage.local với phiên thường. Không chặn ở đây thì chữ đọc
 * được của trang xem ẩn danh sẽ nằm lại trên đĩa sau khi đóng cửa sổ. */
function isCacheableSender(sender) {
  return sender?.tab?.incognito !== true;
}

async function clearTranslationCache() {
  await ensureTranslationCache();
  translationCache.clear();
  translationCacheDirty = 0;
  clearTimeout(translationCacheTimer);
  translationCacheTimer = null;
  await chrome.storage.local.remove(TRANSLATION_CACHE_KEY).catch(() => {});
  return { ok: true };
}

// Giới hạn an toàn cho dịch batch (dịch cả trang).
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_CHARS = 20000;
// Cap đọc response text (providers) — chống stream payload khổng lồ DoS worker.
const MAX_RESPONSE_TEXT_BYTES = 4 * 1024 * 1024;
// Giới hạn tóm tắt trang: text quá dài bị cắt bớt trước khi gửi LLM.
const MAX_SUMMARY_CHARS = 16000;

// Tóm tắt nội dung trang thành bullet (chỉ LLM: gemini/openai — DeepL bị loại ở tầng providers).
async function summarizePage(payload) {
  const text = String(payload?.text || '').trim();
  if (!text) throw new Error('payload.text phải là chuỗi không rỗng');

  const targetLanguage = String(payload?.targetLanguage || '').toLowerCase();
  if (!['vi', 'en'].includes(targetLanguage)) {
    throw new Error("targetLanguage chỉ hỗ trợ 'vi' hoặc 'en'");
  }

  let maxBullets = Number(payload?.maxBullets);
  if (!Number.isFinite(maxBullets)) maxBullets = 8;
  maxBullets = Math.min(15, Math.max(3, Math.round(maxBullets)));

  const config = await ensureConfig();
  const result = await summarizeWithRotation({
    config,
    text: text.slice(0, MAX_SUMMARY_CHARS),
    targetLanguage,
    maxBullets,
    keyState,
    fetchText: providerFetchText,
  });

  return { ok: true, text: result.text, provider: result.provider, providerLabel: result.providerLabel };
}

/* ------------------------------------------------------------------
 * Tải PDF (binary -> base64) cho trình xem/dịch PDF của extension.
 * Chỉ http/https, cần host permission của origin, cap 25MB, timeout 60s.
 * Thiếu quyền -> trả { ok:false, error:'NO_PERMISSION', needsPermission:true }
 * (KHÔNG throw) để caller xin quyền bằng user gesture phía mình.
 * ------------------------------------------------------------------ */
const PDF_MAX_BYTES = 25 * 1024 * 1024; // 25MB

async function fetchPdf(payload) {
  let url;
  try {
    url = new URL(String(payload?.url || ''));
  } catch (_) {
    throw new Error('payload.url không hợp lệ');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Chỉ hỗ trợ URL http/https');
  }

  const allowed = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!allowed) {
    return { ok: false, error: 'NO_PERMISSION', needsPermission: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Không tải được PDF (HTTP ${response.status})`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim() || 'application/pdf';

    // Đọc theo chunk và abort NGAY khi vượt 25MB — không buffer toàn bộ rồi mới kiểm tra.
    const reader = response.body?.getReader?.();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > PDF_MAX_BYTES) throw new Error('PDF quá lớn (tối đa 25MB)');
      return { ok: true, base64: arrayBufferToBase64(buffer), contentType };
    }
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > PDF_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('PDF quá lớn (tối đa 25MB)');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, base64: arrayBufferToBase64(merged.buffer), contentType };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Tải PDF quá chậm (timeout 60s)');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function providerTranslate(payload, sender) {
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
  await ensureTranslationCache();

  // Văn phong dịch trang (v4.2): style/dialect/mode/grammar/proper-nouns.
  // normalizePageOptions ép giá trị rác về default; DeepL tự bỏ qua ở tầng providers.
  const pageOptions = normalizePageOptions(payload?.pageOptions);

  /* Lọc trước những đoạn đã dịch ở lần trước (tab khác, phiên trước, reload):
   * chỉ phần chưa có mới đi tới provider. Trang tin/diễn đàn lặp lại rất nhiều
   * chuỗi giống nhau nên tỉ lệ trúng thường rất cao. */
  const useCache = translationCacheEnabled && isCacheableSender(sender);
  const prefix = translationCachePrefix(config, payload?.sourceLanguage, targetLanguage, pageOptions);
  const translations = new Array(list.length);
  const missIndexes = [];
  const missTexts = [];
  for (let index = 0; index < list.length; index++) {
    const hit = useCache ? translationCacheGet(prefix + hashText(list[index])) : undefined;
    if (typeof hit === 'string') {
      translations[index] = hit;
    } else {
      missIndexes.push(index);
      missTexts.push(list[index]);
    }
  }

  if (!missTexts.length) {
    return { ok: true, translations, provider: 'cache', providerLabel: 'Cache', cached: list.length };
  }

  // Đăng ký AbortController theo requestId: content gửi 'cancelProviderTranslate'
  // khi timeout phía nó hết hạn → request trả phí không chạy tiếp ngầm (NPT-007).
  const requestId = String(payload?.requestId || '');
  const controller = new AbortController();
  if (requestId) inflightRequests.set(requestId, controller);

  try {
    const result = await translateBatchWithRotation({
      config,
      texts: missTexts,
      sourceLanguage: payload?.sourceLanguage,
      targetLanguage,
      pageOptions,
      keyState,
      fetchText: (request) => providerFetchText(request, controller.signal),
    });

    for (let index = 0; index < missIndexes.length; index++) {
      const translated = result.translations[index];
      translations[missIndexes[index]] = translated;
      if (useCache && typeof translated === 'string' && translated) {
        translationCacheSet(prefix + hashText(missTexts[index]), translated);
      }
    }

    return {
      ok: true,
      translations,
      provider: result.provider,
      providerLabel: result.providerLabel,
      cached: list.length - missTexts.length,
    };
  } finally {
    if (requestId) inflightRequests.delete(requestId);
  }
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
          label: providerLabelOf(id, provider),
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

// Menu chuột phải mở PDF bằng trình xem/dịch của extension.
const PDF_MENU_ID = 'npt-pdf-translate';
const PDF_URL_PATTERNS = ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*'];

function registerImageContextMenu() {
  // removeAll trước để tránh lỗi trùng id khi tạo lại.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: 'Dịch ảnh này (Gemini)',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: PDF_MENU_ID,
      title: 'Dịch PDF bằng Native Translator',
      contexts: ['page', 'link'],
      documentUrlPatterns: PDF_URL_PATTERNS,
      targetUrlPatterns: PDF_URL_PATTERNS,
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

    // Đọc theo chunk và abort NGAY khi vượt 8MB — không buffer toàn bộ rồi mới kiểm tra.
    const reader = response.body?.getReader?.();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > IMAGE_MAX_BYTES) throw new Error('Ảnh quá lớn (tối đa 8MB)');
      return { mimeType, imageBase64: arrayBufferToBase64(buffer) };
    }
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Ảnh quá lớn (tối đa 8MB)');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { mimeType, imageBase64: arrayBufferToBase64(merged.buffer) };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Tải ảnh quá chậm (timeout 30s)');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Cache trong bộ nhớ các origin đã được cấp quyền fetch ảnh — khỏi gọi
// permissions.request (no-op) lặp lại mỗi lần dịch ảnh cùng domain.
const grantedImageOrigins = new Set();

async function seedGrantedImageOrigins() {
  const all = await chrome.permissions.getAll().catch(() => null);
  for (const pattern of all?.origins || []) {
    try { grantedImageOrigins.add(new URL(pattern).origin); } catch (_) { /* pattern lạ */ }
  }
}

async function handleImageTranslate(info, tab) {
  const srcUrl = String(info?.srcUrl || '');
  const tabId = tab?.id;
  if (!srcUrl || !Number.isInteger(tabId)) return;

  // Content script có thể không có trên trang (chrome://...) -> nuốt lỗi gửi.
  // Gửi kèm frameId: kết quả OCR (kể cả ảnh base64) chỉ về đúng frame đã khởi tạo,
  // không lọt sang top frame/cross-origin iframe khác.
  const frameOptions = Number.isInteger(info?.frameId) ? { frameId: info.frameId } : undefined;
  const send = (message) => chrome.tabs.sendMessage(tabId, message, frameOptions).catch(() => {});

  // permissions.request CHỈ chạy được trong user gesture: phải là await ĐẦU TIÊN
  // của handler (contextMenus.onClicked là gesture). Bất kỳ await nào đứng trước
  // nó (sendMessage, permissions.contains...) đều làm mất gesture → lỗi
  // "This function must be called during a user gesture".
  let imageOrigin = null;
  try { imageOrigin = new URL(srcUrl).origin; } catch (_) { imageOrigin = null; }
  if (imageOrigin && imageOrigin.startsWith('http') && !grantedImageOrigins.has(imageOrigin)) {
    // Quyền đã có sẵn thì request() trả true ngay, không hiện prompt.
    const allowed = await chrome.permissions.request({ origins: [`${imageOrigin}/*`] });
    if (!allowed) {
      await send({ type: 'imageTranslateResult', srcUrl, ok: false, error: 'Chưa được cấp quyền truy cập ảnh' });
      return;
    }
    grantedImageOrigins.add(imageOrigin);
  }

  await send({ type: 'imageTranslateStart', srcUrl });

  try {
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

    await send({ type: 'imageTranslateResult', srcUrl, ok: true, lines: result.lines, mimeType, imageBase64 });
  } catch (error) {
    let friendly = error?.message || String(error);
    if (friendly.includes('IMAGE_NEEDS_GEMINI')) {
      friendly = 'Dịch ảnh cần API key Gemini (bật trong Cài đặt)';
    }
    await send({ type: 'imageTranslateResult', srcUrl, ok: false, error: friendly });
  }
}

// Click menu PDF: mở pdf-viewer.html kèm ?src=<url pdf>. Kiểm tra lại đuôi .pdf
// bằng regex phòng trường hợp documentUrlPatterns/targetUrlPatterns không khớp.
function handlePdfMenuClick(info) {
  const pdfUrl = String(info?.linkUrl || info?.pageUrl || '');
  if (!/\.pdf(\?|#|$)/i.test(pdfUrl)) return;
  chrome.tabs.create({
    url: chrome.runtime.getURL('pdf-viewer.html') + '?src=' + encodeURIComponent(pdfUrl),
  });
}

/* ------------------------------------------------------------------
 * Phím tắt dịch trang. Trước đây content script tự nghe keydown, nên phím
 * cố định cứng, đụng phím tắt của trang, và không đổi được ở
 * chrome://extensions/shortcuts. Giờ khai báo trong manifest "commands".
 * ------------------------------------------------------------------ */
const COMMAND_LANGUAGE = {
  'translate-vi': 'vi',
  'translate-en': 'en',
  'translate-original': 'original',
};

chrome.commands.onCommand.addListener(async (command) => {
  const language = COMMAND_LANGUAGE[command];
  if (!language) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) return;
  await broadcastToFrames(tab.id, { type: 'setPageLanguage', language }).catch(() => {});
});

/* ------------------------------------------------------------------
 * Badge trên icon: cho biết tab hiện tại đang xem bản dịch nào. Không có nó
 * thì phải mở popup (hoặc soi FAB) mới biết trang đang ở trạng thái gì.
 * ------------------------------------------------------------------ */
const BADGE_COLOR = '#4f46e5';

async function setPageBadge(tabId, language) {
  if (!Number.isInteger(tabId)) return;
  const active = language === 'vi' || language === 'en';
  try {
    await chrome.action.setBadgeText({ tabId, text: active ? language.toUpperCase() : '' });
    if (active) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
      await chrome.action.setTitle({ tabId, title: `Native Translator — đang hiển thị bản ${language.toUpperCase()}` });
    } else {
      await chrome.action.setTitle({ tabId, title: 'Native Translator' });
    }
  } catch (_) {
    // Tab đã đóng giữa chừng — bỏ qua.
  }
}

/* Badge theo tab sống qua cả lần điều hướng. Trang mới chưa dịch mà vẫn thấy
 * "VI" là sai — xoá khi top frame commit, content script sẽ báo lại nếu trang
 * mới tự dịch theo preference đã lưu. */
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  setPageBadge(details.tabId, 'original');
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info?.menuItemId === PDF_MENU_ID) {
    handlePdfMenuClick(info);
    return;
  }
  if (info?.menuItemId !== IMAGE_MENU_ID) return;
  handleImageTranslate(info, tab).catch(error =>
    console.warn('[Native Page Translator] Dịch ảnh thất bại:', error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // Options/popup vừa lưu key hoặc đổi provider → bỏ config đang nhớ.
  if (Object.hasOwn(changes, CONFIG_STORAGE_KEY)) configCache = null;

  // Tắt cache trong Cài đặt → dừng đọc/ghi ngay và xoá luôn phần đã lưu.
  const cacheToggle = changes[TRANSLATION_CACHE_ENABLED_KEY];
  if (cacheToggle) {
    translationCacheEnabled = cacheToggle.newValue !== false;
    if (!translationCacheEnabled) clearTranslationCache().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureConfig().catch(error => console.warn('[Native Page Translator] Seed config failed:', error));
  registerImageContextMenu();
  seedGrantedImageOrigins().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureConfig().catch(() => {});
  registerImageContextMenu();
  seedGrantedImageOrigins().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Chỉ phục vụ message nội bộ từ chính extension (content script/popup/options).
  // Không khai báo externally_connectable nên lớp này là phòng thủ thứ hai.
  if (sender.id !== chrome.runtime.id) return false;

  if (message?.type === 'proxyFetch') {
    rawFetch(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, status: 0, responseText: '', networkError: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'nativeTranslate') {
    nativeTranslate(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: sanitizeProviderError(error) });
    });
    return true;
  }

  if (message?.type === 'providerTranslate') {
    providerTranslate(message.payload, sender).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: sanitizeProviderError(error) });
    });
    return true;
  }

  if (message?.type === 'summarizePage') {
    summarizePage(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: sanitizeProviderError(error) });
    });
    return true;
  }

  if (message?.type === 'fetchPdf') {
    fetchPdf(message.payload).then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  // Content timeout → hủy request trả phí đang chạy ngầm (NPT-007).
  if (message?.type === 'cancelProviderTranslate') {
    const requestId = String(message.requestId || '');
    inflightRequests.get(requestId)?.abort();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'translationCacheStats') {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: 'Chỉ trang extension mới dùng lệnh này' });
      return false;
    }
    ensureTranslationCache()
      .then(() => sendResponse({ ok: true, entries: translationCache.size, enabled: translationCacheEnabled }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'clearTranslationCache') {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: 'Chỉ trang extension mới dùng lệnh này' });
      return false;
    }
    clearTranslationCache()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'getProviderStatus') {
    providerStatus().then(sendResponse).catch(error => {
      sendResponse({ ok: false, configured: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'deeplUsage') {
    // Quota/key metadata: chỉ extension page mới được đọc (NPT-017).
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: 'Chỉ trang extension mới dùng lệnh này' });
      return false;
    }
    deeplUsage().then(sendResponse).catch(error => {
      sendResponse({ ok: false, error: sanitizeProviderError(error) });
    });
    return true;
  }

  if (message?.type === 'openOptions') {
    // Mở trang cài đặt: chỉ extension page được gọi (NPT-017).
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: 'Chỉ trang extension mới dùng lệnh này' });
      return false;
    }
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(error => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  // Top frame báo trạng thái mới → cập nhật badge cho đúng tab đó.
  if (message?.type === 'pageLanguageChanged') {
    setPageBadge(sender.tab?.id, message.language);
    sendResponse({ ok: true });
    return false;
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
