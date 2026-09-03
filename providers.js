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
   * Nhiều endpoint OpenAI-compatible chạy song song.
   *
   * PROVIDER_DEFS chỉ mô tả BA KIỂU provider (deepl / gemini / openai), còn
   * kiểu openai được phép có nhiều bản: 'openai' là slot đầu, các slot sau
   * mang id 'openai-2', 'openai-3'... mỗi slot có url/model/format/key riêng
   * nên Groq + OpenRouter + API tự host cùng nằm trong một vòng xoay key.
   * Mọi chỗ dựng request làm việc theo KIỂU (providerKind); chỉ UI và thông
   * báo lỗi mới cần id/tên cụ thể của từng slot.
   * ------------------------------------------------------------------ */
  const CUSTOM_PROVIDER_RE = /^openai-(\d+)$/;
  const MAX_CUSTOM_PROVIDERS = 20;

  function isCustomProvider(id) {
    return CUSTOM_PROVIDER_RE.test(String(id || ''));
  }

  function providerKind(id) {
    return isCustomProvider(id) ? 'openai' : String(id || '');
  }

  function providerDefOf(id) {
    return PROVIDER_DEFS[providerKind(id)] || null;
  }

  // Tên hiển thị: mọi slot OpenAI-compatible đều đặt tên được (Groq, OpenRouter…);
  // chưa đặt thì slot đầu giữ nhãn mặc định, các slot sau đánh số.
  function providerLabelOf(id, providerConfig) {
    const name = String(providerConfig?.name || '').trim();
    if (name) return name;
    const custom = CUSTOM_PROVIDER_RE.exec(String(id || ''));
    if (custom) return `API tùy chỉnh ${custom[1]}`;
    return providerDefOf(id)?.label || String(id || '');
  }

  // Thứ tự hiển thị: ba provider dựng sẵn, rồi tới các slot tùy chỉnh theo số.
  function customProviderIds(source) {
    return Object.keys(source?.providers || {})
      .filter(isCustomProvider)
      .sort((a, b) => Number(CUSTOM_PROVIDER_RE.exec(a)[1]) - Number(CUSTOM_PROVIDER_RE.exec(b)[1]))
      .slice(0, MAX_CUSTOM_PROVIDERS);
  }

  function providerIdsOf(config) {
    return [...PROVIDER_ORDER, ...customProviderIds(config)];
  }

  // Id còn trống cho slot tùy chỉnh mới ('' nếu đã kịch trần).
  function nextCustomProviderId(config) {
    const used = new Set(Object.keys(config?.providers || {}));
    for (let index = 2; index <= MAX_CUSTOM_PROVIDERS + 1; index++) {
      const id = `openai-${index}`;
      if (!used.has(id)) return id;
    }
    return '';
  }

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

  // Cấu hình generation cho Gemini: temperature thấp (0.1) cho dịch thuật chuẩn xác.
  // Thinking chỉ bật/tắt đúng cú pháp theo từng thế hệ model để tránh lỗi HTTP 400 INVALID_ARGUMENT:
  // - Dòng 3.x (Gemini 3): dùng thinkingLevel: 'low' (dòng 3 không hỗ trợ thinkingBudget).
  // - Dòng 2.5: dùng thinkingBudget: 0 để tắt reasoning.
  // - Dòng 1.5, 2.0 hoặc model khác: không gửi thinkingConfig (Google API sẽ từ chối nếu gửi).
  function buildGeminiGenerationConfig(model, temperature = 0.1) {
    const config = { temperature };
    const m = String(model || '').toLowerCase();
    if (/3\./.test(m) || /gemini-3/.test(m)) {
      config.thinkingConfig = { thinkingLevel: 'low' };
    } else if (/2\.5/.test(m)) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }
    return config;
  }


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
    const def = providerDefOf(id);
    return {
      enabled: false,
      keys: [],
      // Chỉ kiểu OpenAI-compatible mới cần tên riêng: có nhiều slot cùng kiểu.
      ...(def.needsUrl ? { name: '' } : {}),
      ...(def.needsModel ? { model: def.defaultModel } : {}),
      ...(def.needsUrl ? { url: def.defaultUrl, format: 'auto' } : {}),
    };
  }

  const TONES = ['natural', 'professional', 'casual'];

  /* ------------------------------------------------------------------
   * Nhập key theo lô.
   *
   * Ngưởi dùng thường có cả chục key và dán một lượt, từ đủ kiểu nguồn:
   * mỗi dòng một key, ngăn bằng dấu phẩy, mảng JSON copy từ code, danh
   * sách có số thứ tự, dòng .env kiểu GEMINI_API_KEY=..., kèm chú thích
   * trong ngoặc. Ô nhập cũ lấy NGUYÊN chuỗi làm MỘT key nên dán nhiều key
   * là hỏng sạch — thêm được đúng một "key" rác rồi provider từ chối hết.
   * parseKeysInput() bóc mọi dạng đó ra danh sách key sạch, đã lọc trùng.
   * ------------------------------------------------------------------ */

  const MIN_KEY_LENGTH = 6;
  // Ký tự có thể có trong API key thật: chữ, số và - _ . : + / = ~
  const KEY_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+/=~-]*$/;
  // Chữ hay bị dán kèm quanh key — chắc chắn không phải key.
  const KEY_NOISE = new Set([
    'key', 'keys', 'api', 'apikey', 'api-key', 'api_key', 'token', 'secret',
    'null', 'undefined', 'none', 'true', 'false', 'your-api-key', 'your_api_key',
  ]);
  // Nhãn lấy từ dòng .env (GEMINI_API_KEY=...) chỉ là tên biến — không đáng lưu.
  const LABEL_NOISE_RE = /^[A-Z0-9_]+$|\b(?:api|key|token|secret)\b/i;

  // Bóc dấu nháy / ngoặc / cú pháp JSON bọc ngoài và dấu câu cuối mẩu.
  function stripKeyWrappers(token) {
    let value = String(token || '').trim();
    for (let round = 0; round < 5; round++) {
      const before = value;
      value = value
        .replace(/^[\s"'`<([{«‹]+/, '')
        .replace(/[\s"'`>)\]}»›,;]+$/, '')
        .trim();
      if (value === before) break;
    }
    return value;
  }

  // Nhận key rộng tay: chỉ loại những mẩu chắc chắn không phải key.
  function looksLikeKey(value) {
    const key = String(value || '');
    if (key.length < MIN_KEY_LENGTH) return false;
    if (KEY_NOISE.has(key.toLowerCase())) return false;
    if (key.includes('://')) return false;                   // URL dán kèm
    if (/^\d+$/.test(key) && key.length < 12) return false;  // số thứ tự / quota
    return KEY_CHARS_RE.test(key);
  }

  /* Phần đứng trước dấu "=" hoặc ":" chỉ được coi là NHÃN khi nó trông như
   * nhãn thật: có khoảng trắng ("acc 2"), là tên biến .env (GEMINI_API_KEY),
   * hoặc là một từ ngắn ("acc", "key3"). Key DeepL "uuid:fx" hay key base64
   * có "=" ở giữa vì vậy không bị cắt mất đầu. */
  function looksLikeKeyLabel(name) {
    if (/\s/.test(name)) return true;
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return true;
    return /^[A-Za-z]{1,12}\d{0,3}$/.test(name);
  }

  function keyTokensOf(text) {
    return String(text).split(/[\s,;|]+/).map(stripKeyWrappers).filter(Boolean);
  }

  // Tiền tố key quen mặt của các provider phổ biến.
  const KEY_PREFIX_RE = /AIza|AQ\.|sk-|gsk_|xai-|hf_|ya29\./g;
  // Một key thật ngắn nhất trong các dạng dưới đây vẫn dài hơn con số này.
  const MIN_RUN_PIECE = 24;

  /* Dán nhiều key vào ô MỘT dòng (bản cũ) là mất hết newline: các key bị nối
   * liền thành một chuỗi dài, không còn dấu phân tách nào. Nếu thấy đuôi ":fx"
   * của DeepL lặp lại hoặc tiền tố key lặp lại thì cắt lại đúng chỗ. Chỉ làm
   * khi chuỗi dài gấp đôi một key bình thường và MỌI mảnh cắt ra đều đủ dài —
   * để không bao giờ xé một key thật thành hai. */
  function splitRunTogetherKeys(token) {
    if (token.length < 2 * MIN_RUN_PIECE + 12) return [token];

    const fxParts = token.split(/(?<=:fx)/i);
    if (fxParts.length > 1 && fxParts.every(part => part.length >= MIN_RUN_PIECE)) return fxParts;

    const marks = [...token.matchAll(KEY_PREFIX_RE)].map(match => match.index);
    if (marks.length < 2) return [token];
    const pieces = marks.map((start, index) => token.slice(start, marks[index + 1]));
    if (marks[0] > 0) pieces.unshift(token.slice(0, marks[0]));
    return pieces.every(piece => piece.length >= MIN_RUN_PIECE) ? pieces : [token];
  }

  // Bóc nhãn (nếu có) và các mẩu key của MỘT dòng.
  function splitKeyLine(line) {
    let text = String(line);
    let label = '';

    // Đầu dòng kiểu danh sách: "1. key", "2) key", "- key", "• key".
    text = text.replace(/^\s*(?:[-*•+>]+|\(?\d{1,3}[.)])\s+/, '');

    // Chú thích cuối dòng: "key # acc 2", "key // acc 2".
    const comment = /(?:^|\s)(?:#|\/\/)\s*([^\s#][^#]{0,59})$/.exec(text);
    if (comment) {
      label = comment[1].trim();
      text = text.slice(0, comment.index);
    }

    // Nhãn trong ngoặc cuối dòng: "key (tài khoản 2)".
    const paren = /\(([^()]{1,60})\)\s*$/.exec(text);
    if (paren) {
      label = label || paren[1].trim();
      text = text.slice(0, paren.index);
    }

    let tokens = keyTokensOf(text);

    /* Nhãn đứng trước: "acc 2 = key", "GEMINI_API_KEY: key". Chỉ nhận khi
     * phần sau đủ dài, bắt đầu như một key thật ("https://..." không bị hiểu
     * là nhãn "https" + key) và cách hiểu đó KHÔNG làm mất key nào. */
    const prefixed = /^\s*([A-Za-z][\w .-]{0,31}?)\s*[=:]\s*(\S.*)$/.exec(text);
    const rest = prefixed ? stripKeyWrappers(prefixed[2]) : '';
    if (rest.length >= 12 && /^[A-Za-z0-9]/.test(rest) && looksLikeKeyLabel(prefixed[1].trim())) {
      const restTokens = keyTokensOf(prefixed[2]);
      if (restTokens.filter(looksLikeKey).length >= tokens.filter(looksLikeKey).length) {
        const name = prefixed[1].trim();
        if (!label && !LABEL_NOISE_RE.test(name)) label = name;
        tokens = restTokens;
      }
    }

    return { label: label.slice(0, 40), tokens };
  }

  /* Bóc key từ một chuỗi dán tự do. Trả về:
   *   entries    : [{ key, label }] theo đúng thứ tự dán, đã lọc trùng
   *   duplicates : số mẩu trùng (trùng nhau trong input hoặc trùng options.existing)
   *   invalid    : các mẩu không nhận ra được — để UI báo lại cho người dùng
   */
  function parseKeysInput(input, options = {}) {
    const existing = Array.isArray(options.existing) ? options.existing : [];
    const seen = new Set(existing
      .map(entry => String((typeof entry === 'string' ? entry : entry?.key) || '').trim())
      .filter(Boolean));

    const entries = [];
    const invalid = [];
    let duplicates = 0;

    const text = String(input || '')
      // Ký tự vô hình dán kèm từ web (ZWSP, BOM, soft hyphen) — xoá hẳn, nếu
      // đổi thành khoảng trắng thì một key thật lại bị xé làm hai mẩu rác.
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/[\u00a0\u2000-\u200a\u202f\u3000]/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"');

    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      const line = rawLine.trim();
      if (!line || /^(?:#|\/\/)/.test(line)) continue; // dòng trống / dòng chú thích

      const { label, tokens } = splitKeyLine(line);
      const found = [];
      for (const token of tokens.flatMap(splitRunTogetherKeys)) {
        if (!looksLikeKey(token)) {
          invalid.push(token.length > 28 ? `${token.slice(0, 28)}…` : token);
          continue;
        }
        if (seen.has(token)) {
          duplicates++;
          continue;
        }
        seen.add(token);
        found.push(token);
      }
      // Nhãn chỉ có nghĩa khi dòng đó cho đúng một key.
      for (const key of found) entries.push({ key, label: found.length === 1 ? label : '' });
    }

    return { entries, duplicates, invalid };
  }

  /* Đoán key thuộc KIỂU provider nào, để dán một mớ key trộn lẫn của nhiều
   * nhà cung cấp là tự chia về đúng thẻ. Chỉ trả lời khi chắc chắn — key lạ
   * (API tự host, proxy) trả '' và được giữ nguyên ở chỗ người dùng đang dán.
   *   AIza… / AQ.…            -> gemini
   *   uuid hoặc uuid:fx       -> deepl
   *   sk-… gsk_… xai-… hf_…   -> openai (OpenAI, OpenRouter, Groq, xAI, HF)
   */
  function detectProviderForKey(key) {
    const value = String(key || '').trim();
    if (!value) return '';
    if (/^AIza[\w-]{10,}$/.test(value) || /^AQ\./.test(value)) return 'gemini';
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?::[a-z]{2})?$/i.test(value)) return 'deepl';
    if (/^(?:sk|gsk|xai|hf|or|pk)[-_]/i.test(value)) return 'openai';
    return '';
  }

  /* Cảnh báo mềm khi key trông sai định dạng của provider: KHÔNG chặn lưu
   * (API tự host / proxy có thể dùng key kiểu khác), chỉ nhắc để người dùng
   * biết trước vì sao key đó sẽ bị từ chối. */
  function keyFormatWarning(providerId, key) {
    const value = String(key || '');
    if (providerKind(providerId) === 'gemini' && !value.startsWith('AIza')) {
      return 'Key Gemini chuẩn bắt đầu bằng "AIza". Key dạng "AQ." là key bị Google giới hạn — Gemini API sẽ từ chối. Hãy tạo key "AIza" bằng project/tài khoản Google khác, hoặc tạo trong Google Cloud Console.';
    }
    return '';
  }

  // Chấp nhận cả entry dạng chuỗi ("key") lẫn { key, label }; bỏ rỗng và trùng.
  function normalizeKeyList(list) {
    const seen = new Set();
    const entries = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const isText = typeof entry === 'string';
      const key = String((isText ? entry : entry?.key) || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, label: String((isText ? '' : entry?.label) || '').trim() });
    }
    return entries;
  }

  function normalizeConfig(raw) {
    // Ba provider dựng sẵn luôn có mặt; slot tùy chỉnh lấy theo đúng những id
    // đang nằm trong config (người dùng thêm/xoá bao nhiêu cũng được).
    const ids = [...PROVIDER_ORDER, ...customProviderIds(raw)];
    const config = {
      preferred: ids.includes(raw?.preferred) ? raw.preferred : PROVIDER_ORDER[0],
      tone: TONES.includes(raw?.tone) ? raw.tone : 'natural',
      providers: {},
    };
    for (const id of ids) {
      const base = emptyProviderConfig(id);
      const incoming = raw?.providers?.[id] || {};
      // keys có thể là mảng {key,label}, mảng chuỗi, hoặc (config nhập tay/
      // import) cả một chuỗi nhiều key — bóc hết về danh sách chuẩn.
      const keys = typeof incoming.keys === 'string'
        ? parseKeysInput(incoming.keys).entries
        : incoming.keys;
      config.providers[id] = {
        ...base,
        ...incoming,
        enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : base.enabled,
        keys: normalizeKeyList(keys),
        ...(base.name !== undefined ? { name: String(incoming.name || '').trim().slice(0, 40) } : {}),
      };
    }
    return config;
  }

  function orderedProviderIds(config) {
    const all = providerIdsOf(config);
    const rest = all.filter(id => id !== config.preferred);
    return all.includes(config.preferred) ? [config.preferred, ...rest] : rest;
  }

  function usableProviders(config) {
    return orderedProviderIds(config).filter(id => {
      const provider = config.providers[id];
      if (!provider?.enabled) return false;
      // OpenAI-compatible cho phép không cần key (API free tự host).
      if (providerKind(id) === 'openai') return true;
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
    const kind = providerKind(providerId);
    const instructions = buildNativeInstructions(tone);
    const prompt = buildPrompt(source, context);

    if (kind === 'deepl') {
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

    if (kind === 'gemini') {
      const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const model = rawModel.replace(/^models\//i, '');
      const generationConfig = buildGeminiGenerationConfig(model, 0.1);
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (kind === 'openai') {
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
  // Status đáng thử lại NGAY trên cùng key: nghẽn tạm thời phía provider, không
  // phải lỗi key. Trước đây tất cả rơi vào 'providerFailed' nên một cú 503 chớp
  // nhoáng của Gemini là mất luôn provider cho request đó.
  const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
  const MAX_TRANSIENT_RETRIES = 2;
  const TRANSIENT_BACKOFF_MS = 800;
  const MAX_RETRY_AFTER_MS = 30 * 60 * 1000;

  // Retry-After: giây hoặc HTTP-date. Trả về ms, null nếu không đọc được.
  function parseRetryAfter(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return null;
    return Math.max(0, Math.min(when - Date.now(), MAX_RETRY_AFTER_MS));
  }

  // Phân loại lỗi theo HTTP status (dùng chung single + batch). 2xx -> null.
  function classifyHttpError({ providerId, providerLabel, status, bodyText, retryAfterMs }) {
    const def = { label: providerLabel || providerLabelOf(providerId) };

    if (status === 0) {
      return { kind: 'providerFailed', message: `${def.label}: lỗi mạng/timeout` };
    }

    if (status === 401 || status === 403) {
      return { kind: 'keyFailed', message: `${def.label}: key bị từ chối (HTTP ${status})`, cooldownMs: 30 * 60 * 1000 };
    }

    // DeepL 456 = cạn quota của cả CHU KỲ THANH TOÁN (thường là hết tháng).
    // Cooldown 2 phút như 429 nghĩa là cứ 2 phút lại đốt một request chắc chắn
    // hỏng cho tới hết tháng.
    if (status === 456) {
      return {
        kind: 'keyFailed',
        message: `${def.label}: đã dùng hết quota của chu kỳ (HTTP 456)`,
        cooldownMs: 6 * 60 * 60 * 1000,
      };
    }

    if (status === 429) {
      // Provider nói rõ chờ bao lâu thì nghe theo; không có header mới đoán 2 phút.
      const hinted = Number(retryAfterMs) > 0 ? Math.min(Number(retryAfterMs), MAX_RETRY_AFTER_MS) : 0;
      const cooldownMs = hinted ? Math.max(5000, hinted) : 2 * 60 * 1000;
      return { kind: 'keyFailed', message: `${def.label}: bị giới hạn tốc độ (HTTP 429)`, cooldownMs };
    }

    if (TRANSIENT_STATUSES.has(status)) {
      return {
        kind: 'retry',
        message: `${def.label}: provider tạm lỗi (HTTP ${status})`,
        retryDelayMs: retryAfterMs || 0,
      };
    }

    if (status === 400 || status === 404 || status === 422) {
      let detail = '';
      try {
        const data = JSON.parse(bodyText || '{}');
        const violations = Array.isArray(data?.error?.details)
          ? data.error.details
              .flatMap(d => d?.fieldViolations || [])
              .filter(v => v?.description || v?.field)
              .map(v => `${v.field ? v.field + ': ' : ''}${v.description || ''}`.trim())
              .filter(Boolean)
              .join('; ')
          : '';
        detail = violations || data?.error?.message || data?.message || data?.detail || '';
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

  function classifyResponse({ providerId, providerLabel, openaiFormat, status, bodyText, retryAfterMs }) {
    const kind = providerKind(providerId);
    const def = { label: providerLabel || providerLabelOf(providerId) };
    const httpError = classifyHttpError({ providerId, providerLabel: def.label, status, bodyText, retryAfterMs });
    if (httpError) return httpError;

    let data;
    try {
      data = JSON.parse(bodyText || '{}');
    } catch (_) {
      return { kind: 'providerFailed', message: `${def.label}: phản hồi không phải JSON` };
    }

    let text = '';
    if (kind === 'deepl') {
      text = String(data?.translations?.[0]?.text || '').trim();
    } else if (kind === 'gemini') {
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
    customPrompt: '',
    glossaryText: '',
    docMode: false,
  };

  // Giới hạn độ dài field tự do: chặn prompt injection quá dài / lạm dụng token.
  const MAX_CUSTOM_PROMPT_CHARS = 2000;
  const MAX_GLOSSARY_CHARS = 8000;
  // Ngữ cảnh trang (v4.4): cap từng field để prompt không phình theo meta lạ.
  const MAX_PAGE_CONTEXT_CHARS = { host: 100, title: 150, siteName: 100, description: 300 };

  // pageContext { host, title, siteName, description } -> chuỗi 1 dòng cho prompt;
  // null nếu caller không gửi / toàn ký tự rỗng / sai kiểu.
  function normalizePageContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const ctx = {
      host: clip(raw.host, MAX_PAGE_CONTEXT_CHARS.host),
      title: clip(raw.title, MAX_PAGE_CONTEXT_CHARS.title),
      siteName: clip(raw.siteName, MAX_PAGE_CONTEXT_CHARS.siteName),
      description: clip(raw.description, MAX_PAGE_CONTEXT_CHARS.description),
    };
    if (!ctx.host && !ctx.title && !ctx.siteName && !ctx.description) return null;
    return ctx;
  }

  // Sanitize pageOptions từ caller: giá trị lạ/sai kiểu -> về default.
  function normalizePageOptions(raw) {
    return {
      style: PAGE_STYLES[raw?.style] ? raw.style : DEFAULT_PAGE_OPTIONS.style,
      dialect: PAGE_DIALECTS[raw?.dialect] ? raw.dialect : DEFAULT_PAGE_OPTIONS.dialect,
      mode: raw?.mode === 'literal' || raw?.mode === 'natural' ? raw.mode : DEFAULT_PAGE_OPTIONS.mode,
      grammarFix: typeof raw?.grammarFix === 'boolean' ? raw.grammarFix : DEFAULT_PAGE_OPTIONS.grammarFix,
      keepProperNouns: typeof raw?.keepProperNouns === 'boolean' ? raw.keepProperNouns : DEFAULT_PAGE_OPTIONS.keepProperNouns,
      customPrompt: typeof raw?.customPrompt === 'string'
        ? raw.customPrompt.trim().slice(0, MAX_CUSTOM_PROMPT_CHARS)
        : DEFAULT_PAGE_OPTIONS.customPrompt,
      glossaryText: typeof raw?.glossaryText === 'string'
        ? raw.glossaryText.trim().slice(0, MAX_GLOSSARY_CHARS)
        : DEFAULT_PAGE_OPTIONS.glossaryText,
      docMode: typeof raw?.docMode === 'boolean' ? raw.docMode : DEFAULT_PAGE_OPTIONS.docMode,
      pageContext: normalizePageContext(raw?.pageContext),
    };
  }

  // Thứ tự lines: 4 base -> style -> dialect (chỉ target English) -> literal
  // -> grammarFix -> properNouns -> line chốt idiomatic (khi có rule bổ sung)
  // -> pageContext (ngữ cảnh trang, v4.4) -> docMode -> glossary
  // -> customPrompt (ưu tiên cao nhất, đứng cuối).
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

    const finalLines = [...lines, ...extras];
    // Ngữ cảnh trang (v4.4): giúp model chọn nghĩa đúng lĩnh vực cho từ đa nghĩa —
    // "feed" trên MXH là "bảng tin", trên web thú cưng là "cho ăn/thức ăn".
    if (opts.pageContext) {
      const ctx = opts.pageContext;
      const parts = [];
      if (ctx.host) parts.push(`website: ${ctx.host}`);
      if (ctx.siteName) parts.push(`site name: "${ctx.siteName}"`);
      if (ctx.title) parts.push(`page title: "${ctx.title}"`);
      if (ctx.description) parts.push(`page description: "${ctx.description}"`);
      finalLines.push(
        `Page context — ${parts.join('; ')}.`,
        'Use the page context to pick domain-appropriate meanings for ambiguous words (e.g. "feed" means "bảng tin" on a social network but "cho ăn/thức ăn" on a pet site; "post" can be "bài đăng" or "cột/bưu kiện"; "like" can be "thích" or "như/giống"). When the context does not clarify a word, fall back to its most common meaning.',
      );
    }
    // Tài liệu kỹ thuật: giữ nguyên code/lệnh/path, chỉ dịch văn xuôi.
    if (opts.docMode) {
      finalLines.push('This page is technical documentation: keep all code, inline code, commands, file paths and identifiers unchanged; translate only prose.');
    }
    // Glossary thuật ngữ của user: ưu tiên cao hơn cách dịch mặc định.
    if (opts.glossaryText) {
      finalLines.push(`Always apply this terminology glossary (highest priority for these terms):\n${opts.glossaryText}`);
    }
    // Chỉ dẫn tự do của user: đứng cuối, được phép ghi đè rule phía trên.
    if (opts.customPrompt) {
      finalLines.push(`Additional user instructions (override the rules above if conflicting):\n${opts.customPrompt}`);
    }

    return finalLines.join('\n');
  }

  function buildBatchRequest({ providerId, providerConfig, apiKey, texts, sourceLanguage, targetLanguage, pageOptions }) {
    const kind = providerKind(providerId);
    // Ngôn ngữ đích chỉ hỗ trợ VI/EN.
    const target = findBatchTarget(targetLanguage);
    if (!target) throw new Error('Ngôn ngữ đích không hỗ trợ');

    if (kind === 'deepl') {
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

    if (kind === 'gemini') {
      const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const model = rawModel.replace(/^models\//i, '');
      const generationConfig = buildGeminiGenerationConfig(model, 0.1);
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (kind === 'openai') {
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
  function classifyBatchResponse({ providerId, providerLabel, openaiFormat, status, bodyText, expectedLength, retryAfterMs }) {
    const kind = providerKind(providerId);
    const def = { label: providerLabel || providerLabelOf(providerId) };
    const httpError = classifyHttpError({ providerId, providerLabel: def.label, status, bodyText, retryAfterMs });
    if (httpError) return httpError;

    let data;
    try {
      data = JSON.parse(bodyText || '{}');
    } catch (_) {
      // LỖI PARSE (không phải HTTP): caller được retry 1 lần trên cùng key.
      return { kind: 'providerFailed', parseFailure: true, message: `${def.label}: phản hồi không phải JSON` };
    }

    let translations = null;
    if (kind === 'deepl') {
      if (Array.isArray(data?.translations)) {
        translations = data.translations.map(item => String(item?.text ?? ''));
      }
    } else {
      let text = '';
      if (kind === 'gemini') {
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
    return { cooldowns: new Map(), pointers: new Map(), nextDispatchTime: 0 };
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
      // Nhiều slot tùy chỉnh cùng kiểu 'openai' -> lỗi phải gọi đúng tên slot.
      const providerLabel = providerLabelOf(providerId, providerConfig);
      // OpenAI-compatible không bắt buộc key: cho phép 1 lượt không key.
      const keyPool = providerConfig.keys.length ? providerConfig.keys : [{ key: '', label: '' }];

      const startIndex = state.pointers.get(providerId) || 0;
      for (let offset = 0; offset < keyPool.length; offset++) {
        const index = (startIndex + offset) % keyPool.length;
        const entry = keyPool[index];
        const cdKey = cooldownKey(providerId, entry.key);
        const cooldownUntil = state.cooldowns.get(cdKey) || 0;
        if (cooldownUntil > currentTime()) continue;

        // Reserve NGAY khi chọn key (trước await): các caller song song đọc pointer
        // sau thởi điểm này sẽ lấy key kế tiếp — tránh dồn request vào 1 key.
        if (keyPool.length > 1) state.pointers.set(providerId, (index + 1) % keyPool.length);

        // Micro-staggering (30ms): trì hoãn 30ms giữa các dispatches song song / xoay key
        // để tránh HTTP burst spikes gây ra lỗi 429.
        const STAGGER_MS = 30;
        const nowTime = currentTime();
        const scheduledTime = Math.max(nowTime, state.nextDispatchTime || 0);
        state.nextDispatchTime = scheduledTime + STAGGER_MS;
        const delayMs = scheduledTime - nowTime;
        if (delayMs > 0) {
          await wait(delayMs);
        }

        /* Nghẽn tạm thời phía provider (5xx/408/425) thì thử lại NGAY trên cùng
         * key với backoff, tôn trọng Retry-After nếu có. Hết lượt mới hạ xuống
         * keyFailed với cooldown ngắn để rotation sang key khác. */
        let verdict;
        let buildFailed = false;
        for (let transientAttempt = 0; ; transientAttempt++) {
          try {
            ({ verdict } = await attempt({ providerId, providerConfig, providerLabel, apiKey: entry.key }));
          } catch (error) {
            errors.push(`${providerLabel}: ${error?.message || error}`);
            buildFailed = true;
            break;
          }
          if (verdict.kind !== 'retry' || transientAttempt >= MAX_TRANSIENT_RETRIES) break;
          await wait(verdict.retryDelayMs || TRANSIENT_BACKOFF_MS * (transientAttempt + 1));
        }
        if (buildFailed) break; // Không dựng được request -> sang provider khác.
        if (verdict.kind === 'retry') {
          verdict = { kind: 'keyFailed', message: verdict.message, cooldownMs: 15000 };
        }

        if (verdict.kind === 'ok') {
          state.pointers.set(providerId, keyPool.length > 1 ? (index + 1) % keyPool.length : 0);
          return {
            verdict,
            provider: providerId,
            providerLabel,
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
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
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
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
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
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
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
            providerLabel,
            openaiFormat: request?.openaiFormat,
            status: response.status,
            bodyText: response.bodyText,
            retryAfterMs: response.retryAfterMs,
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
   * Tóm tắt trang (summarize): LLM trả plain text bullet, KHÔNG phải JSON.
   * CHỈ gemini/openai — DeepL là engine dịch thuần, không tóm tắt tự do.
   * ------------------------------------------------------------------ */
  const SUMMARY_TARGET = { vi: 'Vietnamese', en: 'English' };

  function clampSummaryBullets(maxBullets) {
    const value = Number(maxBullets);
    if (!Number.isFinite(value)) return 8;
    return Math.min(15, Math.max(3, Math.round(value)));
  }

  function buildSummaryInstructions(targetName, maxBullets) {
    return [
      `Summarize the given page content into at most ${maxBullets} bullet points.`,
      "Each bullet must be exactly one line starting with '- '.",
      `Write the ENTIRE summary in ${targetName} — every single bullet, no exceptions.`,
      'Return plain text only: no JSON, no headings, no intro or closing commentary.',
    ].join('\n');
  }

  // Dựng request tóm tắt theo provider (pattern giống buildBatchRequest).
  function buildSummaryRequest({ providerId, providerConfig, apiKey, text, targetLanguage, maxBullets }) {
    const targetName = SUMMARY_TARGET[String(targetLanguage || '').toLowerCase()];
    if (!targetName) throw new Error('Ngôn ngữ đích không hỗ trợ');
    const kind = providerKind(providerId);
    if (kind === 'deepl') throw new Error('SUMMARIZE_REQUIRES_LLM');

    const instructions = buildSummaryInstructions(targetName, clampSummaryBullets(maxBullets));
    const prompt = String(text || '');

    if (kind === 'gemini') {
      const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
      const model = rawModel.replace(/^models\//i, '');
      const generationConfig = buildGeminiGenerationConfig(model, 0.1);
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-goog-api-key': String(apiKey || '').trim(),
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      };
    }

    if (kind === 'openai') {
      const { url, model, format, headers } = resolveOpenAIRequest(providerConfig, apiKey);

      let payload;
      if (format === 'responses') {
        payload = { model, instructions, input: prompt, max_output_tokens: 2000, store: false };
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
        // libre/generic là engine dịch thuần, không tóm tắt tự do được.
        throw new Error(`${PROVIDER_DEFS.openai.label}: format "${format}" không hỗ trợ tóm tắt`);
      }

      return { url, method: 'POST', headers, body: JSON.stringify(payload), openaiFormat: format };
    }

    throw new Error(`Provider không hỗ trợ: ${providerId}`);
  }

  // Tóm tắt qua rotation key: ép config chỉ còn provider LLM (bỏ DeepL).
  // Chỉ có DeepL key -> throw 'SUMMARIZE_REQUIRES_LLM' để UI báo rõ.
  async function summarizeWithRotation({ config, text, targetLanguage, maxBullets, fetchText, keyState, now, sleep }) {
    const content = String(text || '').trim();
    if (!content) throw new Error('Không có nội dung cần tóm tắt');
    const target = String(targetLanguage || '').toLowerCase();
    if (!SUMMARY_TARGET[target]) throw new Error('Ngôn ngữ đích không hỗ trợ');

    // Mọi provider LLM đang bật (Gemini + tất cả slot OpenAI-compatible).
    const llmProviders = {};
    for (const id of providerIdsOf(config)) {
      if (providerKind(id) === 'deepl') continue;
      const provider = config?.providers?.[id];
      if (provider?.enabled) llmProviders[id] = provider;
    }
    const llmIds = Object.keys(llmProviders);
    if (!llmIds.length) throw new Error('SUMMARIZE_REQUIRES_LLM');
    const llmConfig = {
      ...config,
      // preferred 'deepl' không còn trong providers -> về LLM đầu tiên khả dụng.
      preferred: llmProviders[config?.preferred] ? config.preferred : llmIds[0],
      providers: llmProviders,
    };

    const outcome = await withKeyRotation({
      config: llmConfig,
      keyState,
      now,
      sleep,
      attempt: async ({ providerId, providerConfig, providerLabel, apiKey }) => {
        const request = buildSummaryRequest({
          providerId,
          providerConfig,
          apiKey,
          text: content,
          targetLanguage: target,
          maxBullets,
        });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId,
          providerLabel,
          openaiFormat: request?.openaiFormat,
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });
        return { verdict };
      },
    });

    // Response là plain text bullet — giữ nguyên, chỉ trim.
    return {
      text: String(outcome.verdict.text || '').trim(),
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

    const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
    const model = rawModel.replace(/^models\//i, '');
    const instructions = `You are an OCR + translation engine. Transcribe every visible text line in the image in reading order, then translate each line into ${targetName} naturally. Return ONLY a JSON array [{"box":[ymin,xmin,ymax,xmax],"original":"...","translated":"..."}]. "box" is the bounding box of that text line in the image: 4 integers normalized to the 0-1000 range, in ymin,xmin,ymax,xmax order. If no text found return [].`;
    const prompt = `Transcribe the text in this image with per-line bounding boxes and translate it into ${targetName}.`;

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-goog-api-key': String(apiKey || '').trim(),
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

  // Dựng request OCR thuần bằng Gemini vision (không dịch).
  function buildOcrVisionRequest({ providerConfig, apiKey, mimeType, imageBase64 }) {
    const rawModel = String(providerConfig?.model || PROVIDER_DEFS.gemini.defaultModel).trim();
    const model = rawModel.replace(/^models\//i, '');
    const instructions = `You are an accurate OCR engine. Transcribe all visible text in this image accurately and in natural reading order. Preserve original line breaks, punctuation, numbers, and exact Vietnamese diacritics. Do not translate, explain, or add commentary. Return ONLY the transcribed text.`;
    const prompt = `Transcribe all text visible in this image accurately.`;

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-goog-api-key': String(apiKey || '').trim(),
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
        generationConfig: { temperature: 0.1 },
        safetySettings: GEMINI_SAFETY_SETTINGS,
      }),
    };
  }

  // Parse text từ phản hồi OCR của Gemini: hỗ trợ cả plain text lẫn JSON format.
  function parseOcrVisionText(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';

    // Nếu Gemini trả về JSON array [{text}] hoặc ["line1", "line2"]
    const parsed = parseJsonArrayText(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .map(item => (typeof item === 'string' ? item : item?.text || item?.original || ''))
        .filter(Boolean)
        .join('\n');
    }

    // Gọt bỏ code block markdown nếu model có bọc ```...```
    const unfenced = trimmed.replace(/^```(?:text|json)?\s*\n?|\n?```$/gi, '').trim();
    return unfenced;
  }

  // Parse dòng OCR phục vụ tương thích cũ.
  function parseOcrVisionLines(raw) {
    const text = parseOcrVisionText(raw);
    if (!text) return [];
    return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ text: line }));
  }

  // OCR thuần (không dịch) qua rotation key. Ép config chỉ còn gemini.
  async function ocrVisionWithRotation({ config, mimeType, imageBase64, fetchText, keyState, now, sleep }) {
    if (!imageBase64) throw new Error('Không có dữ liệu ảnh');

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
        const request = buildOcrVisionRequest({ providerConfig, apiKey, mimeType, imageBase64 });
        const response = await fetchText(request);
        const verdict = classifyResponse({
          providerId: 'gemini',
          status: response.status,
          bodyText: response.bodyText,
          retryAfterMs: response.retryAfterMs,
        });
        return { verdict };
      },
    });

    const rawText = outcome.verdict?.text || '';
    const parsedText = parseOcrVisionText(rawText);
    const lines = parseOcrVisionLines(rawText);

    return {
      text: parsedText,
      lines,
      provider: outcome.provider,
      providerLabel: outcome.providerLabel,
      keyMasked: outcome.keyMasked,
    };
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
          retryAfterMs: response.retryAfterMs,
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
    normalizeKeyList,
    parseKeysInput,
    detectProviderForKey,
    keyFormatWarning,
    emptyProviderConfig,
    isCustomProvider,
    providerKind,
    providerDefOf,
    providerLabelOf,
    providerIdsOf,
    nextCustomProviderId,
    MAX_CUSTOM_PROVIDERS,
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
    buildSummaryRequest,
    summarizeWithRotation,
    buildVisionRequest,
    parseVisionLines,
    translateVisionWithRotation,
    buildOcrVisionRequest,
    parseOcrVisionText,
    parseOcrVisionLines,
    ocrVisionWithRotation,
    createKeyState,
    parseRetryAfter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_PROVIDERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
