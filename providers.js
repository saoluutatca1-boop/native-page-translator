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
      keyPlaceholder: 'Key chuẩn bắt đầu bằng AIza... (key dạng AQ. bị Google giới hạn)',
      needsModel: true,
      needsUrl: false,
      defaultModel: 'gemini-3.1-flash-lite',
      suggestedModels: [
        'gemini-3.1-flash-lite',
        'gemini-3.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
      ],
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
   * Ngôn ngữ đích của dịch trang: chỉ VI/EN.
   *  - deepl:       mã target_lang của DeepL
   *  - englishName: tên tiếng Anh đưa vào prompt LLM
   * ------------------------------------------------------------------ */
  const BATCH_TARGET = {
    vi: { deepl: 'VI', englishName: 'Vietnamese' },
    en: { deepl: 'EN-US', englishName: 'English' },
  };

  function findBatchTarget(code) {
    return BATCH_TARGET[String(code || '').toLowerCase()] || null;
  }

  // Tắt mọi bộ lọc an toàn của Gemini: dịch chat có slang/tục không bị chặn.
  const GEMINI_SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  ];

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

  // Endpoint GET /v2/usage (xem quota) của DeepL: cùng host free/pro với /v2/translate.
  function deeplUsageEndpoint(key) {
    return PROVIDER_DEFS.deepl.endpointFor(key).replace(/\/v2\/translate$/, '/v2/usage');
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
      'Default to standard contractions (I\'m, don\'t, gonna, wanna) in informal text and complete, polished sentences in formal text — unless the tone register below overrides this.',
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
        'Register: CASUAL — you are a real person in your early 20s texting a friend, NOT an author writing prose.',
        'HARD RULE: never write apostrophes in contractions. Always write im, dont, doesnt, didnt, cant, wont, isnt, arent, couldnt, shouldnt, wouldnt, thats, its, hes, shes, youre, theyre, yall — with NO apostrophe. This overrides the base rule about standard contractions.',
        'Use real texting shorthand when it fits: idk, rn, tbh, ngl, fr, bc, cuz, lol, lmao, btw, omg, pls, thx, msg, tmr, tn, wyd, brb, gtg, ong, fs, smh, nvm. Do not force it into every line.',
        'Prefer casual word forms over formal ones: gonna, wanna, gotta, kinda, sorta, lemme, gimme, dunno, aight.',
        'Lowercase is the default vibe; CAPS only for emphasis. Minimal punctuation — no semicolons, no em dashes, and drop the final period like real chats.',
        'Keep it short like a real text. Fragments are fine; never pad or complete into polished sentences.',
        'Match the emoji/slang energy of the source. If the Vietnamese is playful or uses wordplay, the English must play back with equivalent English slang or wordplay — never translate jokes literally.',
        'Examples — "anh ơi tối nay đi chơi hong" -> "hey u free tn?" | "em đang làm gì đó" -> "wyd" | "đùa thôi đừng giận nha" -> "jk jk dont be mad lol" | "tôi không biết nữa, chắc để mai" -> "idk tbh maybe tmr" | "đợi tôi tí, tôi đang ăn cơm" -> "gimme a sec im eating"',
      ],
    };

    return [...base, ...(overlays[tone] || overlays.natural)].join('\n');
  }

  function buildPrompt(source, context) {
    return context ? `${context}\n\nVietnamese source:\n${source}` : source;
  }

  /* ------------------------------------------------------------------
   * Lớp 2 của tone casual: hậu xử lý cơ học. Model (hoặc DeepL) lỡ giữ
   * văn chuẩn thì vẫn bị ép về kiểu nhắn tin: bỏ apostrophe trong các
   * cụm co thông dụng. Chỉ áp dụng cho tone 'casual', chỉ đường single
   * (input helper) — KHÔNG áp cho dịch trang/batch.
   * ------------------------------------------------------------------ */
  const CASUAL_REWRITES = [
    [/\bI'm\b/g, 'im'],
    [/\bI am\b/g, 'im'],
    [/\bdon't\b/gi, 'dont'],
    [/\bdoesn't\b/gi, 'doesnt'],
    [/\bdidn't\b/gi, 'didnt'],
    [/\bcan't\b/gi, 'cant'],
    [/\bcannot\b/gi, 'cant'],
    [/\bwon't\b/gi, 'wont'],
    [/\bisn't\b/gi, 'isnt'],
    [/\baren't\b/gi, 'arent'],
    [/\bcouldn't\b/gi, 'couldnt'],
    [/\bshouldn't\b/gi, 'shouldnt'],
    [/\bwouldn't\b/gi, 'wouldnt'],
    [/\bthat's\b/gi, 'thats'],
    [/\bit's\b/gi, 'its'],
    [/\bhe's\b/gi, 'hes'],
    [/\bshe's\b/gi, 'shes'],
    [/\byou're\b/gi, 'youre'],
    [/\bthey're\b/gi, 'theyre'],
    [/\by'all\b/gi, 'yall'],
    [/\bcould've\b/gi, 'couldve'],
    [/\bshould've\b/gi, 'shouldve'],
    [/\bwould've\b/gi, 'wouldve'],
    // Để cuối: đại từ "I" đứng riêng -> "i" (kiểu nhắn tin). Chạy sau các
    // quy tắc trên nên "I'm" đã thành "im" từ trước, không bị tác động.
    [/\bI\b/g, 'i'],
  ];

  function humanizeCasual(text) {
    let out = String(text ?? '');
    for (const [pattern, replacement] of CASUAL_REWRITES) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * Dựng request theo từng provider.
   * Trả về { url, method, headers, body } — body là chuỗi JSON.
   * ------------------------------------------------------------------ */
  // Resolve url/model/format/headers cho OpenAI-compatible (dùng chung single + batch).
  function resolveOpenAIRequest(providerConfig, apiKey) {
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
    return { url, model, format, headers };
  }

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
      // Dịch thuật không cần suy luận: tắt thinking để tiết kiệm token.
      // Chỉ gửi cho dòng 2.5 (đã kiểm chứng field hợp lệ); dòng 3.x mặc định
      // Flash-Lite đã tối thiểu thinking nên không cần gửi.
      const generationConfig = { temperature: 0.3 };
      if (/2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
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
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (providerId === 'openai') {
      const { url, model, format, headers } = resolveOpenAIRequest(providerConfig, apiKey);

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
  // Phân loại lỗi theo HTTP status (dùng chung single + batch). 2xx -> null.
  function classifyHttpError({ providerId, status, bodyText }) {
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

    return null;
  }

  function classifyResponse({ providerId, openaiFormat, status, bodyText }) {
    const def = PROVIDER_DEFS[providerId];
    const httpError = classifyHttpError({ providerId, status, bodyText });
    if (httpError) return httpError;

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
   * Dịch BATCH (dịch cả trang): tự nhiên, trôi chảy như ngườ bản xứ viết
   * nhưng giữ nguyên format/placeholder. KHÔNG dùng buildNativeInstructions
   * (prompt đó là rewrite VI->EN của input helper, không dành cho dịch trang).
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------
   * Tuỳ chọn văn phong dịch trang (page style). Chỉ có tác dụng qua
   * provider LLM (gemini/openai) — DeepL là engine dịch thuần, bỏ qua.
   * instruction: chuỗi tiếng Anh chèn thẳng vào system instruction.
   * ------------------------------------------------------------------ */
  const PAGE_STYLES = {
    natural:      { label: 'Tự nhiên',             instruction: '' }, // base đã đủ
    casual:       { label: 'Trò chuyện thân mật',  instruction: 'Register: casual chat between friends — relaxed, warm, natural contractions and texting shorthand where it fits (idk, rn, tbh, ngl, lol, gonna, wanna...). Never stiff or formal.' },
    'work-email': { label: 'Email công việc',      instruction: 'Register: professional work email — courteous, polished, concise. Proper greetings/closings if present. No slang, no text-speak, grammatically impeccable.' },
    'game-chat':  { label: 'Chat game',            instruction: 'Register: in-game / gamer chat — keep game titles, item names, and gaming terms untranslated; match the trash-talk/hype energy; gaming slang welcome (gg, wp, noob, camping, buff, nerf...).' },
    genz:         { label: 'Văn phong Gen Z',      instruction: 'Register: Gen Z internet voice — current slang where it fits (fr, no cap, lowkey, highkey, bet, slay, sus, vibe...), playful and punchy, never corporate. Do not force slang into every line.' },
    formal:       { label: 'Lịch sự, trang trọng', instruction: 'Register: formal and respectful — polite, complete sentences, honorific-aware. For Vietnamese output use appropriate kính ngữ (anh/chị/quý/cậu...); no slang.' },
  };

  // Dialect chỉ áp khi đích là English (dịch ra VI thì vô nghĩa).
  const PAGE_DIALECTS = {
    us: { label: 'Tiếng Anh Mỹ',  instruction: 'Use American English spelling, vocabulary and idioms (color, organize, apartment...).' },
    uk: { label: 'Tiếng Anh Anh', instruction: 'Use British English spelling, vocabulary and idioms (colour, organise, flat, cheers...).' },
  };

  const PAGE_MODE_LITERAL_INSTRUCTION = 'Stay close to the source wording and sentence structure — prioritize fidelity over flow.';
  const PAGE_GRAMMAR_FIX_INSTRUCTION = 'The output must be grammatically flawless in the target language — silently fix any grammar, spelling, or punctuation issue. Never output broken grammar.';
  const PAGE_KEEP_PROPER_NOUNS_INSTRUCTION = 'Keep proper nouns (people, brands, places, products, usernames) unchanged — never translate or transliterate names.';

  const DEFAULT_PAGE_OPTIONS = {
    style: 'natural',
    dialect: 'us',
    mode: 'natural',
    grammarFix: false,
    keepProperNouns: true,
  };

  // Sanitize pageOptions từ caller: giá trị lạ/sai kiểu -> về default.
  function normalizePageOptions(raw) {
    return {
      style: PAGE_STYLES[raw?.style] ? raw.style : DEFAULT_PAGE_OPTIONS.style,
      dialect: PAGE_DIALECTS[raw?.dialect] ? raw.dialect : DEFAULT_PAGE_OPTIONS.dialect,
      mode: raw?.mode === 'literal' || raw?.mode === 'natural' ? raw.mode : DEFAULT_PAGE_OPTIONS.mode,
      grammarFix: typeof raw?.grammarFix === 'boolean' ? raw.grammarFix : DEFAULT_PAGE_OPTIONS.grammarFix,
      keepProperNouns: typeof raw?.keepProperNouns === 'boolean' ? raw.keepProperNouns : DEFAULT_PAGE_OPTIONS.keepProperNouns,
    };
  }

  // Thứ tự lines: 4 base -> style -> dialect (chỉ target English) -> literal
  // -> grammarFix -> properNouns -> line chốt idiomatic (khi có rule bổ sung).
  function buildBatchInstructions(sourceLanguage, targetName, pageOptions) {
    const opts = normalizePageOptions(pageOptions);
    const src = sourceLanguage && sourceLanguage !== 'auto'
      ? sourceLanguage
      : 'the detected source language';
    const lines = [
      `Translate each array element from ${src} to ${targetName}. Return ONLY a JSON array of strings, same order and length. No commentary.`,
      'Translate naturally and fluently, the way a native speaker would actually write — never word-for-word — while keeping the exact meaning of each element.',
      'Preserve formatting, line breaks, placeholders ({name}, %s, $1...), emojis, proper names, URLs, and code exactly as they appear.',
      'If an element is already in the target language or cannot be translated, return it unchanged.',
    ];

    const extras = [];
    if (opts.style !== 'natural') extras.push(PAGE_STYLES[opts.style].instruction);
    if (targetName === 'English') extras.push(PAGE_DIALECTS[opts.dialect].instruction);
    if (opts.mode === 'literal') extras.push(PAGE_MODE_LITERAL_INSTRUCTION);
    if (opts.grammarFix) extras.push(PAGE_GRAMMAR_FIX_INSTRUCTION);
    if (opts.keepProperNouns) extras.push(PAGE_KEEP_PROPER_NOUNS_INSTRUCTION);
    if (extras.length) {
      extras.push(`Apply every style rule above idiomatically in ${targetName} — express the register the way a native ${targetName} speaker would, not literally.`);
    }

    return [...lines, ...extras].join('\n');
  }

  function buildBatchRequest({ providerId, providerConfig, apiKey, texts, sourceLanguage, targetLanguage, pageOptions }) {
    // Ngôn ngữ đích chỉ hỗ trợ VI/EN.
    const target = findBatchTarget(targetLanguage);
    if (!target) throw new Error('Ngôn ngữ đích không hỗ trợ');

    if (providerId === 'deepl') {
      // DeepL hỗ trợ mảng text trong 1 request duy nhất.
      return {
        url: PROVIDER_DEFS.deepl.endpointFor(apiKey),
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${apiKey}`,
        },
        body: JSON.stringify({
          text: texts,
          target_lang: target.deepl,
        }),
      };
    }

    // pageOptions chỉ áp cho LLM (gemini/openai); nhánh deepl ở trên đã return sớm.
    const instructions = buildBatchInstructions(sourceLanguage, target.englishName, pageOptions);
    const prompt = JSON.stringify(texts);

    if (providerId === 'gemini') {
      const model = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const generationConfig = { temperature: 0.3 };
      if (/2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
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
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (providerId === 'openai') {
      const { url, model, format, headers } = resolveOpenAIRequest(providerConfig, apiKey);

      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 4000, store: false };
      } else if (format === 'chat') {
        payload = {
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt },
          ],
          stream: false,
        };
      } else {
        // libre/generic không có schema batch JSON rõ ràng -> bỏ qua provider này.
        throw new Error(`${PROVIDER_DEFS.openai.label}: format "${format}" không hỗ trợ dịch batch`);
      }

      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  // Parse khoan dung mảng JSON từ text model trả về (strip fence, cắt [ ... ]).
  function parseJsonArrayText(raw) {
    let text = String(raw || '').trim();
    if (!text) return null;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  // Nhánh classify cho batch: lỗi HTTP dùng chung classifyHttpError,
  // body 2xx phải parse ra mảng bản dịch CÙNG ĐỘ DÀI với texts gửi đi.
  function classifyBatchResponse({ providerId, openaiFormat, status, bodyText, expectedLength }) {
    const def = PROVIDER_DEFS[providerId];
    const httpError = classifyHttpError({ providerId, status, bodyText });
    if (httpError) return httpError;

    let data;
    try {
      data = JSON.parse(bodyText || '{}');
    } catch (_) {
      // LỖI PARSE (không phải HTTP): caller được retry 1 lần trên cùng key.
      return { kind: 'providerFailed', parseFailure: true, message: `${def.label}: phản hồi không phải JSON` };
    }

    let translations = null;
    if (providerId === 'deepl') {
      if (Array.isArray(data?.translations)) {
        translations = data.translations.map(item => String(item?.text ?? ''));
      }
    } else {
      let text = '';
      if (providerId === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        text = parts.map(part => part?.text || '').join('').trim();
      } else {
        text = extractOpenAIText(data, openaiFormat || 'chat');
      }
      const parsed = parseJsonArrayText(text);
      if (parsed) {
        translations = parsed.map(item => (typeof item === 'string' ? item : String(item ?? '')));
      }
    }

    if (!translations) {
      // LỖI PARSE mảng JSON của LLM: caller được retry 1 lần trên cùng key.
      return { kind: 'providerFailed', parseFailure: true, message: `${def.label}: không parse được mảng bản dịch` };
    }
    if (translations.length !== expectedLength) {
      return {
        kind: 'providerFailed',
        message: `${def.label}: số bản dịch (${translations.length}) không khớp số đoạn gửi (${expectedLength})`,
      };
    }

    return { kind: 'ok', translations };
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

  // Vòng lặp rotation dùng chung. attempt({providerId, providerConfig, apiKey})
  // phải trả về { verdict } (verdict từ classifyResponse/classifyBatchResponse);
  // attempt throw = không dựng/gửi được request -> sang provider khác.
  async function withKeyRotation({ config, keyState, now, sleep, attempt }) {
    const state = keyState || createKeyState();
    const currentTime = now || (() => Date.now());
    const wait = sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));

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

        let verdict;
        try {
          ({ verdict } = await attempt({ providerId, providerConfig, apiKey: entry.key }));
        } catch (error) {
          errors.push(`${PROVIDER_DEFS[providerId].label}: ${error?.message || error}`);
          break; // Không dựng được request -> sang provider khác.
        }

        if (verdict.kind === 'ok') {
          state.pointers.set(providerId, keyPool.length > 1 ? (index + 1) % keyPool.length : 0);
          return {
            verdict,
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

  async function translateWithRotation({ config, source, context, fetchText, keyState, now, sleep }) {
    const text = String(source || '').trim();
    if (!text) throw new Error('Không có nội dung cần dịch');

    const outcome = await withKeyRotation({
      config,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, apiKey }) => {
        const request = buildRequest({
          providerId,
          providerConfig,
          apiKey,
          source: text,
          context,
          tone: config.tone,
        });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
        });
        return { verdict };
      },
    });

    const finalText = config.tone === 'casual'
      ? humanizeCasual(outcome.verdict.text)
      : outcome.verdict.text;

    return {
      text: finalText,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
  }

  // Dịch batch (dịch cả trang): translations cùng độ dài/thứ tự với texts.
  // pageOptions (style/dialect/mode...) được truyền tiếp vào buildBatchRequest.
  async function translateBatchWithRotation({ config, texts, sourceLanguage, targetLanguage, fetchText, keyState, now, sleep, pageOptions }) {
    const list = Array.isArray(texts) ? texts.map(item => String(item ?? '')) : [];
    if (!list.length) throw new Error('Không có nội dung cần dịch');
    if (!findBatchTarget(targetLanguage)) throw new Error('Ngôn ngữ đích không hỗ trợ');

    const outcome = await withKeyRotation({
      config,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, apiKey }) => {
        const request = buildBatchRequest({
          providerId,
          providerConfig,
          apiKey,
          texts: list,
          sourceLanguage,
          targetLanguage,
          pageOptions,
        });
        // LLM thỉnh thoảng trả mảng JSON hỏng: retry TỐI ĐA 1 lần trên cùng key
        // (chỉ với lỗi parse, không phải lỗi HTTP) rồi mới chuyển provider.
        // Cờ retriedParse đặt lại mỗi attempt nên không retry vòng vô hạn.
        let retriedParse = false;
        for (;;) {
          const response = await fetchText(request);
          const verdict = classifyBatchResponse({
            providerId,
            openaiFormat: request?.openaiFormat,
            status: response.status,
            bodyText: response.bodyText,
            expectedLength: list.length,
          });
          if (verdict.kind === 'providerFailed' && verdict.parseFailure && !retriedParse) {
            retriedParse = true;
            continue;
          }
          return { verdict };
        }
      },
    });

    return {
      translations: outcome.verdict.translations,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
    };
  }

  /* ------------------------------------------------------------------
   * Dịch ảnh (OCR + dịch) qua Gemini vision. CHỈ gemini hỗ trợ ảnh —
   * deepl/openai bị bỏ qua dù đang enabled.
   * ------------------------------------------------------------------ */
  const VISION_TARGET = { vi: 'Vietnamese', en: 'English' };

  // Dựng request Gemini kèm ảnh inline base64 (part inline_data, snake_case
  // theo chuẩn REST v1beta của Google).
  function buildVisionRequest({ providerConfig, apiKey, mimeType, imageBase64, targetLanguage }) {
    const targetName = VISION_TARGET[String(targetLanguage || '').toLowerCase()];
    if (!targetName) throw new Error('Ngôn ngữ đích không hỗ trợ');

    const model = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
    const instructions = `You are an OCR + translation engine. Transcribe every visible text line in the image in reading order, then translate each line into ${targetName} naturally. Return ONLY a JSON array [{"box":[ymin,xmin,ymax,xmax],"original":"...","translated":"..."}]. "box" is the bounding box of that text line in the image: 4 integers normalized to the 0-1000 range, in ymin,xmin,ymax,xmax order. If no text found return [].`;
    const prompt = `Transcribe the text in this image with per-line bounding boxes and translate it into ${targetName}.`;

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
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: String(mimeType || 'image/png'), data: String(imageBase64 || '') } },
          ],
        }],
        generationConfig: { temperature: 0.2 },
        safetySettings: GEMINI_SAFETY_SETTINGS,
      }),
    };
  }

  // Parse mảng [{original, translated, box?}] từ text Gemini trả về (tái dùng
  // parseJsonArrayText: strip fence ```json, cắt [ đầu ] cuối). Lỗi -> throw.
  // box = [ymin,xmin,ymax,xmax] chuẩn hóa 0-1000; thiếu/sai -> null (không vẽ đè dòng đó).
  function parseVisionLines(raw) {
    const parsed = parseJsonArrayText(raw);
    if (!parsed) throw new Error('Gemini: không parse được mảng OCR từ ảnh');
    return parsed
      .filter(item => item && typeof item.original === 'string' && typeof item.translated === 'string')
      .map(item => ({
        original: item.original.trim(),
        translated: item.translated.trim(),
        box: Array.isArray(item.box) && item.box.length === 4 && item.box.every(n => Number.isFinite(Number(n)))
          ? item.box.map(Number)
          : null,
      }))
      .filter(item => item.original || item.translated);
  }

  // Rotation key giống translateBatchWithRotation nhưng ép config chỉ còn gemini.
  async function translateVisionWithRotation({ config, mimeType, imageBase64, targetLanguage, fetchText, keyState, now, sleep }) {
    if (!imageBase64) throw new Error('Không có dữ liệu ảnh');
    const target = String(targetLanguage || 'vi').toLowerCase();
    if (!VISION_TARGET[target]) throw new Error('Ngôn ngữ đích không hỗ trợ');

    const gemini = config?.providers?.gemini;
    if (!gemini?.enabled || !gemini.keys?.length) {
      throw new Error('IMAGE_NEEDS_GEMINI');
    }
    const geminiOnlyConfig = {
      ...config,
      preferred: 'gemini',
      providers: { gemini },
    };

    const outcome = await withKeyRotation({
      config: geminiOnlyConfig,
      keyState,
      now,
      sleep,
      attempt: async ({ providerConfig, apiKey }) => {
        const request = buildVisionRequest({ providerConfig, apiKey, mimeType, imageBase64, targetLanguage: target });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId: 'gemini',
          status: response.status,
          bodyText: response.bodyText,
        });
        return { verdict };
      },
    });

    return {
      lines: parseVisionLines(outcome.verdict.text),
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
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
    deeplUsageEndpoint,
    buildNativeInstructions,
    humanizeCasual,
    buildRequest,
    classifyResponse,
    PAGE_STYLES,
    PAGE_DIALECTS,
    normalizePageOptions,
    buildBatchInstructions,
    buildBatchRequest,
    classifyBatchResponse,
    translateWithRotation,
    translateBatchWithRotation,
    buildVisionRequest,
    parseVisionLines,
    translateVisionWithRotation,
    createKeyState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_PROVIDERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
