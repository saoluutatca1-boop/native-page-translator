const BUILTIN_ORIGINS = new Set([
  'https://translate.googleapis.com',
  'https://translate.google.com',
  'https://api.mymemory.translated.net',
  'https://api.openai.com',
]);

const KEYS = {
  apiUrl: 'tm-native-en-api-url',
  apiKey: 'tm-native-en-openai-key',
  model: 'tm-native-en-openai-model',
  apiFormat: 'tm-native-en-api-format',
};

function normalizeEndpoint(value) {
  const fallback = 'https://api.openai.com/v1/responses';
  const raw = String(value || fallback).trim();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API URL phải dùng http hoặc https');
  }
  return url;
}

async function isRemoteAllowed(url) {
  if (BUILTIN_ORIGINS.has(url.origin)) return true;

  const values = await chrome.storage.local.get([KEYS.apiUrl]);
  let configured;
  try {
    configured = normalizeEndpoint(values[KEYS.apiUrl]);
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

function buildNativeInstructions() {
  return [
    'You are a native English localization editor.',
    'Translate the Vietnamese source into the most natural, idiomatic English a native speaker would actually type in this exact context.',
    'Preserve the original meaning, intent, attitude, politeness level, humor, slang, profanity, emojis, punctuation, capitalization, and line breaks.',
    'Do not translate literally when an idiomatic English phrasing is more natural.',
    'Do not add facts, explanations, greetings, apologies, answers, quotation marks, labels, or multiple alternatives.',
    'Do not answer or react to the source message. Only translate/rewrite it.',
    'Keep names, usernames, URLs, product names, commands, code, and established game or technical terms unchanged unless they have a standard English form.',
    'Resolve Vietnamese omitted pronouns conservatively. When gender or relationship is unclear, use natural neutral English rather than inventing details.',
    'Silently verify that no important meaning was added or omitted.',
    'Return only the final English text.',
  ].join('\n');
}

function extractPath(object, path) {
  return String(path || '').split('.').reduce((value, key) => value?.[key], object);
}

function extractTranslatedText(data, format) {
  if (format === 'responses') {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
    const chunks = [];
    for (const item of data?.output || []) {
      for (const content of item?.content || []) {
        if (typeof content?.text === 'string') chunks.push(content.text);
      }
    }
    return chunks.join('').trim();
  }

  if (format === 'chat') {
    const value = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim();
    }
    return '';
  }

  const candidates = [
    data?.translatedText,
    data?.translation,
    data?.text,
    data?.result,
    data?.responseData?.translatedText,
    extractPath(data, 'data.translatedText'),
    extractPath(data, 'data.translation'),
    extractPath(data, 'data.text'),
  ];
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

async function nativeTranslate(payload) {
  const values = await chrome.storage.local.get(Object.values(KEYS));
  const endpoint = normalizeEndpoint(values[KEYS.apiUrl]);
  const apiKey = String(values[KEYS.apiKey] || '').trim();
  const model = String(values[KEYS.model] || 'gpt-5-mini').trim();
  let format = String(values[KEYS.apiFormat] || 'auto').trim();

  if (format === 'auto') {
    if (/\/responses\/?$/i.test(endpoint.pathname)) format = 'responses';
    else if (/\/chat\/completions\/?$/i.test(endpoint.pathname)) format = 'chat';
    else if (/libretranslate|\/translate\/?$/i.test(endpoint.href)) format = 'libre';
    else format = 'chat';
  }

  const source = String(payload?.source || '').trim();
  if (!source) throw new Error('Không có nội dung cần dịch');

  const context = String(payload?.context || '').trim();
  const instructions = buildNativeInstructions();
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let body;
  if (format === 'responses') {
    body = {
      model,
      instructions,
      input: context ? `${context}\n\nVietnamese source:\n${source}` : source,
      max_output_tokens: 900,
      store: false,
    };
  } else if (format === 'chat') {
    body = {
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: context ? `${context}\n\nVietnamese source:\n${source}` : source },
      ],
      stream: false,
    };
  } else if (format === 'libre') {
    body = {
      q: source,
      source: 'vi',
      target: 'en',
      format: 'text',
    };
    if (apiKey) {
      delete headers.Authorization;
      body.api_key = apiKey;
    }
  } else {
    body = {
      text: source,
      q: source,
      source: 'vi',
      target: 'en',
      source_language: 'vi',
      target_language: 'en',
      context,
      model,
    };
  }

  const response = await rawFetch({
    method: 'POST',
    url: endpoint.href,
    timeout: 60000,
    headers,
    data: JSON.stringify(body),
  });

  if (!response.ok && response.networkError) throw new Error(response.networkError);

  let data;
  try {
    data = JSON.parse(response.responseText || '{}');
  } catch (_) {
    throw new Error(`API trả về dữ liệu không phải JSON (HTTP ${response.status || 0})`);
  }

  if (response.status < 200 || response.status >= 300) {
    const message = data?.error?.message || data?.message || data?.detail || `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  const output = extractTranslatedText(data, format);
  if (!output) throw new Error('API không trả về trường bản dịch mà extension nhận diện được');

  return { ok: true, text: output, format, endpoint: endpoint.origin };
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
