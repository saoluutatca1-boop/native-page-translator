/* ========================================================================
 * NPT Providers — định nghĩa các nhà cung cấp dịch thuật + xoay vòng API key.
 * File này là JS thuần (không dùng chrome.*) nên chạy được trong:
 *   - service worker (background.js qua importScripts)
 *   - trang options/popup (thẻ <script>)
 *   - node (để chạy test)
 * ====================================================================== */
(function attachProviders(global) {
  'use strict';

  const CONFIG_STORAGE_KEY = 'tm-multi-provider-config';
  const PROVIDER_ORDER = ['deepl', 'gemini', 'openai'];

  const PROVIDER_DEFS = {
    deepl: {
      id: 'deepl',
      label: 'DeepL',
      keyPlaceholder: 'VD: xxxxxxxx-xxxx:fx (free) hoặc key Pro',
      needsModel: false,
      needsUrl: false,
      site: 'https://www.deepl.com/pro-api',
      endpointFor(key) {
        // Key free của DeepL kết thúc bằng ":fx".
        return /:fx\s*$/i.test(String(key || ''))
          ? 'https://api-free.deepl.com/v2/translate'
          : 'https://api.deepl.com/v2/translate';
      },
    },
    gemini: {
      id: 'gemini',
      label: 'Google AI Studio (Gemini)',
      keyPlaceholder: 'Key lấy tại aistudio.google.com/apikey',
      needsModel: true,
      needsUrl: false,
      defaultModel: 'gemini-2.5-flash',
      site: 'https://aistudio.google.com/apikey',
    },
    openai: {
      id: 'openai',
      label: 'OpenAI-compatible (tùy chỉnh)',
      keyPlaceholder: 'Key nếu API yêu cầu (có thể để trống với API free)',
      needsModel: true,
      needsUrl: true,
      defaultModel: 'gpt-4o-mini',
      defaultUrl: 'https://api.openai.com/v1/chat/completions',
    },
  };

  /* ------------------------------------------------------------------
   * Cấu hình lưu trong chrome.storage.local (xóa extension là mất hết).
   * {
   *   preferred: 'deepl',
   *   providers: {
   *     deepl:  { enabled: true,  keys: [{ key, label }] },
   *     gemini: { enabled: true,  keys: [], model },
   *     openai: { enabled: false, keys: [], model, url, format },
   *   }
   * }
   * ------------------------------------------------------------------ */

  function emptyProviderConfig(id) {
    const def = PROVIDER_DEFS[id];
    return {
      enabled: false,
      keys: [],
      ...(def.needsModel ? { model: def.defaultModel } : {}),
      ...(def.needsUrl ? { url: def.defaultUrl, format: 'auto' } : {}),
    };
  }

  const TONES = ['natural', 'professional', 'casual'];

  function normalizeConfig(raw) {
    const config = {
      preferred: PROVIDER_ORDER.includes(raw?.preferred) ? raw.preferred : PROVIDER_ORDER[0],
      tone: TONES.includes(raw?.tone) ? raw.tone : 'natural',
      providers: {},
    };
    for (const id of PROVIDER_ORDER) {
      const base = emptyProviderConfig(id);
      const incoming = raw?.providers?.[id] || {};
      const keys = Array.isArray(incoming.keys) ? incoming.keys : [];
      config.providers[id] = {
        ...base,
        ...incoming,
        enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : base.enabled,
        keys: keys
          .map(entry => ({
            key: String(entry?.key || '').trim(),
            label: String(entry?.label || '').trim(),
          }))
          .filter(entry => entry.key),
      };
    }
    return config;
  }

  function orderedProviderIds(config) {
    const rest = PROVIDER_ORDER.filter(id => id !== config.preferred);
    return [config.preferred, ...rest];
  }

  function usableProviders(config) {
    return orderedProviderIds(config).filter(id => {
      const provider = config.providers[id];
      if (!provider?.enabled) return false;
      // OpenAI-compatible cho phép không cần key (API free tự host).
      if (id === 'openai') return true;
      return provider.keys.length > 0;
    });
  }

  function maskKey(key) {
    const value = String(key || '');
    if (value.length <= 6) return '••••';
    return `${value.slice(0, 3)}…${value.slice(-4)}`;
  }

  /* ------------------------------------------------------------------
   * Prompt dịch kiểu bản địa. Ba phong cách:
   *  - natural:      bám giọng văn gốc, tự nhiên như ngưởi bản xứ viết
   *  - professional: email, LinkedIn, chat công việc — lịch sự, rõ ràng
   *  - casual:       chat bạn bè, mạng xã hội — thoải mái, đủ thân mật
   * ------------------------------------------------------------------ */
  function buildNativeInstructions(tone = 'natural') {
    const base = [
      'You are a bilingual Vietnamese-English localization editor who writes like a true native English speaker in each specific context (chat, email, social post, review, comment, forum reply).',
      'Rewrite the Vietnamese source as the most natural, idiomatic English a native speaker would actually type in this exact situation.',
      'Mirror the author\'s voice: match their formality, energy, age vibe, humor, attitude, and politeness level. Do not flatten personality.',
      'Preserve emojis, punctuation style, capitalization habits, line breaks, @mentions, #hashtags, URLs, product names, code, commands, and established game/tech terms.',
      'Handle Vietnamese pronouns and particles (anh/chị/em/cậu/tớ/mình/tao/mày/ơi/nhé/đấy/nha/ạ...) as natural English social tone — never transliterate or explain them. Drop particles the way natives would, keep the warmth or attitude they carry.',
      'Translate idioms and slang into equivalent English idioms and slang — never literally. If the source is playful or teasing, the English must land the same way.',
      'Use contractions (I\'m, don\'t, gonna, wanna) in informal text; use complete, polished sentences in formal text.',
      'If the source is a fragment, keep it a fragment. Do not complete, answer, explain, or react to the message.',
      'When gender or relationship is unclear, choose natural neutral English rather than inventing details.',
      'Do not add quotation marks, labels, notes, alternatives, or any wrapper. Return only the final English text.',
    ];

    const overlays = {
      natural: [
        'Default register: whatever the source sounds like — that is exactly how the English should sound.',
      ],
      professional: [
        'Register: PROFESSIONAL. Write like a competent, courteous professional: work email, LinkedIn, business chat.',
        'Polished and concise but still warm — never stiff, robotic, or overly formal. No slang, no text-speak, correct grammar throughout.',
      ],
      casual: [
        'Register: CASUAL. Write like texting a friend or posting on social media.',
        'Short, relaxed, conversational. Contractions and common slang are welcome; if the source is lowercase and playful, the English may match that vibe.',
      ],
    };

    return [...base, ...(overlays[tone] || overlays.natural)].join('\n');
  }

  function buildPrompt(source, context) {
    return context ? `${context}\n\nVietnamese source:\n${source}` : source;
  }

  /* ------------------------------------------------------------------
   * Dựng request theo từng provider.
   * Trả về { url, method, headers, body } — body là chuỗi JSON.
   * ------------------------------------------------------------------ */
  function buildRequest({ providerId, providerConfig, apiKey, source, context, tone }) {
    const instructions = buildNativeInstructions(tone);
    const prompt = buildPrompt(source, context);

    if (providerId === 'deepl') {
      return {
        url: PROVIDER_DEFS.deepl.endpointFor(apiKey),
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${apiKey}`,
        },
        body: JSON.stringify({
          text: [source],
          target_lang: 'EN-US',
        }),
      };
    }

    if (providerId === 'gemini') {
      const model = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      };
    }

    if (providerId === 'openai') {
      const url = String(providerConfig?.url || PROVIDER_DEFS.openai.defaultUrl).trim();
      const model = String(providerConfig?.model || PROVIDER_DEFS.openai.defaultModel).trim();
      let format = String(providerConfig?.format || 'auto').trim();
      let pathname = '';
      try { pathname = new URL(url).pathname; } catch (_) { pathname = ''; }

      if (format === 'auto') {
        if (/\/responses\/?$/i.test(pathname)) format = 'responses';
        else if (/libretranslate|\/translate\/?$/i.test(url)) format = 'libre';
        else format = 'chat';
      }

      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 900, store: false };
      } else if (format === 'libre') {
        payload = { q: source, source: 'vi', target: 'en', format: 'text' };
        if (apiKey) {
          delete headers.Authorization;
          payload.api_key = apiKey;
        }
      } else if (format === 'generic') {
        payload = {
          text: source, q: source, source: 'vi', target: 'en',
          source_language: 'vi', target_language: 'en', context, model,
        };
      } else {
        payload = {
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt },
          ],
          stream: false,
        };
      }

      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  function extractPath(object, path) {
    return String(path || '').split('.').reduce((value, key) => value?.[key], object);
  }

  function extractOpenAIText(data, format) {
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
        return value.map(part => (typeof part === 'string' ? part : part?.text || '')).join('').trim();
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

  /* ------------------------------------------------------------------
   * Phân loại kết quả HTTP:
   *  - ok:               có bản dịch
   *  - keyFailed:        key hỏng/hết quota -> thử key khác
   *  - providerFailed:   provider chết/request sai -> thử provider khác
   * ------------------------------------------------------------------ */
  function classifyResponse({ providerId, openaiFormat, status, bodyText }) {
    const def = PROVIDER_DEFS[providerId];

    if (status === 0) {
      return { kind: 'providerFailed', message: `${def.label}: lỗi mạng/timeout` };
    }

    if (status === 401 || status === 403) {
      return { kind: 'keyFailed', message: `${def.label}: key bị từ chối (HTTP ${status})`, cooldownMs: 30 * 60 * 1000 };
    }

    if (status === 429 || status === 456) {
      return { kind: 'keyFailed', message: `${def.label}: hết quota hoặc bị giới hạn (HTTP ${status})`, cooldownMs: 2 * 60 * 1000 };
    }

    if (status === 400 || status === 404 || status === 422) {
      let detail = '';
      try {
        const data = JSON.parse(bodyText || '{}');
        detail = data?.error?.message || data?.message || data?.detail || '';
      } catch (_) { /* bỏ qua */ }
      return {
        kind: 'providerFailed',
        message: `${def.label}: ${String(detail || `HTTP ${status}`).slice(0, 160)}`,
      };
    }

    if (status < 200 || status >= 300) {
      return { kind: 'providerFailed', message: `${def.label}: HTTP ${status}` };
    }

    let data;
    try {
      data = JSON.parse(bodyText || '{}');
    } catch (_) {
      return { kind: 'providerFailed', message: `${def.label}: phản hồi không phải JSON` };
    }

    let text = '';
    if (providerId === 'deepl') {
      text = String(data?.translations?.[0]?.text || '').trim();
    } else if (providerId === 'gemini') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      text = parts.map(part => part?.text || '').join('').trim();
    } else {
      text = extractOpenAIText(data, openaiFormat || 'chat');
    }

    if (!text) {
      return { kind: 'providerFailed', message: `${def.label}: không nhận diện được trường bản dịch` };
    }

    return { kind: 'ok', text };
  }

  /* ------------------------------------------------------------------
   * Xoay vòng key: với mỗi provider (theo thứ tự ưu tiên), thử lần lượt
   * các key chưa bị cooldown. fetchText là hàm inject:
   *   async fetchText({ url, method, headers, body }) -> { status, bodyText }
   * keyState do caller giữ (sống trong bộ nhớ service worker):
   *   { cooldowns: Map("providerId\x00key" -> timestamp), pointers: Map(providerId -> số) }
   * ------------------------------------------------------------------ */
  function createKeyState() {
    return { cooldowns: new Map(), pointers: new Map() };
  }

  function cooldownKey(providerId, key) {
    return `${providerId}${key}`;
  }

  async function translateWithRotation({ config, source, context, fetchText, keyState, now, sleep }) {
    const state = keyState || createKeyState();
    const currentTime = now || (() => Date.now());
    const wait = sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));

    const text = String(source || '').trim();
    if (!text) throw new Error('Không có nội dung cần dịch');

    const providerIds = usableProviders(config);
    if (!providerIds.length) {
      throw new Error('NO_API_KEY');
    }

    const errors = [];

    for (const providerId of providerIds) {
      const providerConfig = config.providers[providerId];
      // OpenAI-compatible không bắt buộc key: cho phép 1 lượt không key.
      const keyPool = providerConfig.keys.length ? providerConfig.keys : [{ key: '', label: '' }];

      const startIndex = state.pointers.get(providerId) || 0;
      for (let offset = 0; offset < keyPool.length; offset++) {
        const index = (startIndex + offset) % keyPool.length;
        const entry = keyPool[index];
        const cdKey = cooldownKey(providerId, entry.key);
        const cooldownUntil = state.cooldowns.get(cdKey) || 0;
        if (cooldownUntil > currentTime()) continue;

        let request;
        let response;
        try {
          request = buildRequest({
            providerId,
            providerConfig,
            apiKey: entry.key,
            source: text,
            context,
            tone: config.tone,
          });
          response = await fetchText(request);
        } catch (error) {
          errors.push(`${PROVIDER_DEFS[providerId].label}: ${error?.message || error}`);
          break; // Không dựng được request -> sang provider khác.
        }

        const verdict = classifyResponse({
          providerId,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
        });

        if (verdict.kind === 'ok') {
          state.pointers.set(providerId, keyPool.length > 1 ? (index + 1) % keyPool.length : 0);
          return {
            text: verdict.text,
            provider: providerId,
            providerLabel: PROVIDER_DEFS[providerId].label,
            keyMasked: entry.key ? maskKey(entry.key) : '',
          };
        }

        errors.push(entry.key ? `${verdict.message} [${maskKey(entry.key)}]` : verdict.message);

        if (verdict.kind === 'keyFailed') {
          state.cooldowns.set(cdKey, currentTime() + (verdict.cooldownMs || 60000));
          continue; // Key tiếp theo của cùng provider.
        }

        break; // providerFailed -> sang provider khác.
      }

      // Tránh bắn request dồn dập khi đổi provider.
      await wait(120);
    }

    throw new Error(errors.length ? errors.join(' · ') : 'Tất cả provider đều thất bại');
  }

  const api = {
    CONFIG_STORAGE_KEY,
    PROVIDER_ORDER,
    PROVIDER_DEFS,
    TONES,
    normalizeConfig,
    orderedProviderIds,
    usableProviders,
    maskKey,
    buildNativeInstructions,
    buildRequest,
    classifyResponse,
    translateWithRotation,
    createKeyState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_PROVIDERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
