(async () => {
  'use strict';

  if (globalThis.__NPT_EXTENSION_V4_LOADED__) return;
  globalThis.__NPT_EXTENSION_V4_LOADED__ = true;

  if (!document.documentElement) {
    await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (document.documentElement) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
  }

  /* Chỉ đọc đúng các key content script cần — TUYỆT ĐỐI không get(null) kéo cả
   * config chứa API key ('tm-multi-provider-config') vào bộ nhớ của mọi trang
   * (nguyên tắc đặc quyền tối thiểu; key API chỉ ở background). */
  const STORAGE_WHITELIST = [
    'tm-site-blacklist',
    'tm-page-use-provider',
    'tm-page-free-fallback',
    'tm-page-display-mode',
    'tm-page-style',
    'tm-page-dialect',
    'tm-page-translate-mode',
    'tm-page-grammar-fix',
    'tm-page-skip-code',
    'tm-page-skip-usernames',
    'tm-page-keep-proper-nouns',
    'tm-page-dynamic-translate',
    'tm-page-lazy-translate',
    'tm-selection-translate',
    'tm-input-helper-enabled',
    'tm-input-helper-offset',
    'tm-native-en-fallback-quick',
    'tm-native-en-use-context',
    'tm-native-en-default-mode',
    'tm-fab-position',
    'tm-prompt-templates',
    'tm-active-template',
    'tm-glossary',
    'tm-doc-mode',
    'tm-tts-enabled',
    'tm-tts-rate',
    `tm-page-translator-language:${location.hostname}`,
  ];
  const storageCache = await chrome.storage.local.get(STORAGE_WHITELIST);

  function GM_getValue(key, defaultValue) {
    return Object.prototype.hasOwnProperty.call(storageCache, key) ? storageCache[key] : defaultValue;
  }

  function GM_setValue(key, value) {
    storageCache[key] = value;
    chrome.storage.local.set({ [key]: value }).catch(error => {
      console.warn('[Native Page Translator] Storage write failed:', error);
    });
  }

  // Chỉ cho thay đổi thuộc whitelist chảy vào cache — config/API key đổi bên
  // background/options không bao giờ lọt vào content script.
  function isAllowedStorageKey(key) {
    return STORAGE_WHITELIST.includes(key) || key.startsWith('tm-page-translator-language:');
  }

  /* Mọi cache dẫn xuất từ settings (style signature, snapshot quét DOM, selector
   * skip...) đăng ký hàm huỷ ở đây. Settings đổi → tất cả invalidate cùng lúc,
   * không nơi nào đọc trúng giá trị cũ. */
  const settingsInvalidators = [];
  function onSettingsChanged(callback) {
    settingsInvalidators.push(callback);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let touched = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!isAllowedStorageKey(key)) continue;
      touched = true;
      if ('newValue' in change) storageCache[key] = change.newValue;
      else delete storageCache[key];
    }
    if (touched) {
      for (const invalidate of settingsInvalidators) invalidate();
    }
  });

  /* Tuỳ chọn mở rộng (prompt template / glossary / doc mode) — dùng chung cho
   * readPageOptions (core, gửi lên background) và currentPageOptions (trang,
   * làm style signature) để 2 nơi luôn đồng bộ. Kết quả detect doc mode ở
   * 'auto' được memo theo URL để khỏi quét DOM mỗi lần đọc options. */
  let docDetectCacheUrl = null;
  let docDetectCacheResult = false;
  function isDocModePage() {
    if (docDetectCacheUrl !== location.href) {
      docDetectCacheUrl = location.href;
      docDetectCacheResult = Boolean(
        globalThis.NPT_DOC_DETECT?.isDocumentationPage(location.href, document).isDoc,
      );
    }
    return docDetectCacheResult;
  }

  function readExtendedPageOptions() {
    let customPrompt = '';
    const activeTemplateId = GM_getValue('tm-active-template', '');
    if (activeTemplateId) {
      const templates = GM_getValue('tm-prompt-templates', []);
      if (Array.isArray(templates)) {
        const template = templates.find(item => item && item.id === activeTemplateId);
        if (template && typeof template.prompt === 'string') customPrompt = template.prompt;
      }
    }

    const glossary = GM_getValue('tm-glossary', []);
    const glossaryText = globalThis.NPT_GLOSSARY
      ? globalThis.NPT_GLOSSARY.toPromptText(Array.isArray(glossary) ? glossary : [])
      : '';

    const docModeSetting = GM_getValue('tm-doc-mode', 'auto');
    let docMode = false;
    if (docModeSetting === 'on') docMode = true;
    else if (docModeSetting !== 'off') docMode = isDocModePage();

    return { customPrompt, glossaryText, docMode };
  }

  // about:blank/srcdoc có hostname rỗng → kế thừa origin của chuỗi ancestor (NPT-008):
  // blacklist của parent áp luôn cho frame special URL.
  function effectiveHostname() {
    if (location.hostname) return location.hostname;
    try {
      const ancestors = location.ancestorOrigins;
      if (ancestors?.length) return new URL(ancestors[ancestors.length - 1]).hostname;
    } catch (_) { /* bỏ qua */ }
    return '';
  }

  // Site trong blacklist ('tm-site-blacklist' = mảng domain) → tắt mọi tính năng.
  // Khớp khi hostname === domain hoặc hostname kết thúc bằng '.domain'.
  function isSiteBlacklisted() {
    const list = GM_getValue('tm-site-blacklist', []);
    if (!Array.isArray(list)) return false;
    const hostname = effectiveHostname().toLowerCase();
    if (!hostname) return false;
    return list.some(entry => {
      const domain = String(entry || '').trim().toLowerCase();
      if (!domain) return false;
      return hostname === domain || hostname.endsWith(`.${domain}`);
    });
  }

  // Extension vừa reload/update thì content script trong tab cũ bị mồ côi —
  // mọi lệnh gọi background đều lỗi "Extension context invalidated".
  const CONTEXT_DEAD_MESSAGE = 'Extension vừa cập nhật — tải lại trang này (F5) để dùng tiếp';

  function isExtensionContextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function isContextInvalidated(error) {
    return /Extension context invalidated/i.test(String(error?.message || error || ''));
  }

  function friendlyError(error) {
    return isContextInvalidated(error) ? CONTEXT_DEAD_MESSAGE : (error?.message || String(error));
  }

  function GM_xmlhttpRequest(options) {
    let aborted = false;
    const payload = {
      method: options.method || 'GET',
      url: options.url,
      headers: options.headers || {},
      data: options.data ?? null,
      timeout: options.timeout || 30000,
    };

    chrome.runtime.sendMessage({ type: 'proxyFetch', payload }).then(response => {
      if (timeoutId) clearTimeout(timeoutId);
      if (aborted) return;
      if (!response?.ok && response?.networkError) {
        options.onerror?.({ error: response.networkError });
        return;
      }
      options.onload?.({
        status: response?.status || 0,
        responseText: response?.responseText || '',
        responseHeaders: response?.responseHeaders || '',
      });
    }).catch(error => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!aborted) options.onerror?.({ error: friendlyError(error) });
    });

    const timeoutId = options.timeout ? setTimeout(() => {
      if (!aborted) {
        aborted = true;
        options.ontimeout?.();
      }
    }, options.timeout + 250) : null;

    return {
      abort() {
        aborted = true;
        if (timeoutId) clearTimeout(timeoutId);
      },
    };
  }

  /* Băm chuỗi ngắn gọn (hai vòng FNV-1a + độ dài ≈ 64 bit) — dùng làm muối cache
   * thay cho việc nhét nguyên JSON options vào từng khoá. */
  function hashString(value) {
    const text = String(value);
    let h1 = 0x811c9dc5;
    let h2 = 0xc2b2ae35;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length.toString(36)}`;
  }

  // position:fixed bị "bẻ" thành tương đối với ancestor khi html/body có transform/filter/perspective.
  function hasTransformedRoot() {
    try {
      for (const element of [document.documentElement, document.body]) {
        if (!element) continue;
        const style = getComputedStyle(element);
        if (style.transform !== 'none' || style.filter !== 'none' || style.perspective !== 'none') return true;
      }
    } catch (_) {
      // Không đọc được style (trang đặc biệt) → coi như không transform.
    }
    return false;
  }

  const TRANSLATION_CORE = (() => {
    const cache = new Map();
    const providerCooldown = new Map();
    // Module font đặc biệt (fancy-text.js nạp trước content.js trong manifest).
    const FANCY = globalThis.NPT_FANCY || null;

    // LRU đơn giản theo số entry (NPT-018): Map giữ thứ tự chèn, đầy thì xoá cũ nhất —
    // SPA sống lâu không bị phình bộ nhớ vô hạn.
    const CACHE_MAX_ENTRIES = 5000;
    function cacheSet(key, value) {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, value);
    }

    // Tuỳ chọn style trang (contract tm-page-*). Hàm này nằm TRƯỚC page IIFE nên tự đọc
    // GM_getValue trực tiếp — duplicate nhỏ defaults ở đây là cố ý.
    const PAGE_OPTION_DEFAULTS = {
      style: 'natural',
      dialect: 'us',
      mode: 'natural',
      grammarFix: false,
      keepProperNouns: true,
    };
    const PAGE_STYLE_VALUES = new Set(['natural', 'casual', 'work-email', 'game-chat', 'genz', 'formal']);
    const PAGE_DIALECT_VALUES = new Set(['us', 'uk']);
    const PAGE_MODE_VALUES = new Set(['natural', 'literal']);

    // Sanitize nhẹ: style/dialect/mode sai → về default; boolean chỉ tắt khi === false.
    function computePageOptions() {
      const style = GM_getValue('tm-page-style', PAGE_OPTION_DEFAULTS.style);
      const dialect = GM_getValue('tm-page-dialect', PAGE_OPTION_DEFAULTS.dialect);
      const mode = GM_getValue('tm-page-translate-mode', PAGE_OPTION_DEFAULTS.mode);
      return {
        style: PAGE_STYLE_VALUES.has(style) ? style : PAGE_OPTION_DEFAULTS.style,
        dialect: PAGE_DIALECT_VALUES.has(dialect) ? dialect : PAGE_OPTION_DEFAULTS.dialect,
        mode: PAGE_MODE_VALUES.has(mode) ? mode : PAGE_OPTION_DEFAULTS.mode,
        grammarFix: GM_getValue('tm-page-grammar-fix', PAGE_OPTION_DEFAULTS.grammarFix) !== false,
        keepProperNouns: GM_getValue('tm-page-keep-proper-nouns', PAGE_OPTION_DEFAULTS.keepProperNouns) !== false,
        ...readExtendedPageOptions(),
      };
    }

    /* readPageOptions/styleCacheSalt bị gọi cho MỌI lần translate + mọi batch.
     * Bên trong có toPromptText(glossary) (dựng lại cả chuỗi glossary) và
     * JSON.stringify — trang lớn nghĩa là hàng trăm lần dựng chuỗi giống hệt
     * nhau. Memo hoá theo (settings, URL): settings đổi → invalidate qua
     * onSettingsChanged, URL đổi (SPA) → docMode có thể khác nên so lại href. */
    let pageOptionsCache = null;
    let pageOptionsCacheUrl = '';
    let styleSaltCache = '';

    function invalidatePageOptionsCache() {
      pageOptionsCache = null;
      styleSaltCache = '';
    }
    onSettingsChanged(invalidatePageOptionsCache);

    function readPageOptions() {
      if (!pageOptionsCache || pageOptionsCacheUrl !== location.href) {
        pageOptionsCacheUrl = location.href;
        pageOptionsCache = computePageOptions();
        /* Muối cache là BĂM của options, không phải JSON đầy đủ. JSON đó chứa
         * cả glossary (tới 8000 ký tự) lẫn custom prompt (2000) — nhét nguyên
         * vào khoá cache nghĩa là mỗi entry cõng thêm ~10KB, 5000 entry thành
         * hàng chục MB chuỗi chỉ để phân biệt style. */
        styleSaltCache = hashString(JSON.stringify(pageOptionsCache));
      }
      return pageOptionsCache;
    }

    // Muối cache theo style signature: đổi style → cache key khác → tự miss, khỏi clear cache.
    function styleCacheSalt() {
      readPageOptions();
      return styleSaltCache;
    }

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function preserveWhitespace(original, translated) {
      const leading = String(original).match(/^\s*/u)?.[0] || '';
      const trailing = String(original).match(/\s*$/u)?.[0] || '';
      return `${leading}${String(translated).trim()}${trailing}`;
    }

    function decodeEntities(value) {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = String(value || '');
      return textarea.value;
    }

    function request(options) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          ...options,
          onload(response) {
            resolve(response);
          },
          ontimeout() {
            reject(new Error(`${options.provider || 'API'} phản hồi quá lâu`));
          },
          onerror(event) {
            reject(new Error(event?.error || `Không kết nối được ${options.provider || 'API'}`));
          },
        });
      });
    }

    async function requestWithRetry(factory, provider) {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        const cooldownUntil = providerCooldown.get(provider) || 0;
        if (cooldownUntil > Date.now()) await sleep(cooldownUntil - Date.now());

        try {
          const response = await factory();
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            providerCooldown.set(provider, Date.now() + 650);
            await sleep(650);
            continue;
          }
          return response;
        } catch (error) {
          lastError = error;
          if (attempt === 0) await sleep(350);
        }
      }
      throw lastError || new Error(`${provider} thất bại`);
    }

    function parseGoogle(response, provider) {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${provider}: HTTP ${response.status}`);
      }
      let data;
      try {
        data = JSON.parse(response.responseText || 'null');
      } catch (_) {
        throw new Error(`${provider}: phản hồi không phải JSON`);
      }
      const output = Array.isArray(data?.[0])
        ? data[0].map(part => part?.[0] ?? '').join('')
        : '';
      if (!output) throw new Error(`${provider}: không có nội dung dịch`);
      return output;
    }

    async function googleTranslate(origin, text, sourceLanguage, targetLanguage) {
      const provider = origin.includes('googleapis') ? 'Google API' : 'Google Web';
      const url = new URL(`${origin}/translate_a/single`);
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', sourceLanguage || 'auto');
      url.searchParams.set('tl', targetLanguage);
      url.searchParams.set('dt', 't');

      const useGet = text.length <= 1300;
      if (useGet) url.searchParams.set('q', text);

      const response = await requestWithRetry(() => request({
        method: useGet ? 'GET' : 'POST',
        url: url.toString(),
        data: useGet ? null : `q=${encodeURIComponent(text)}`,
        timeout: 22000,
        provider,
        headers: useGet ? {
          Accept: 'application/json,text/plain,*/*',
        } : {
          Accept: 'application/json,text/plain,*/*',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
      }), provider);

      return parseGoogle(response, provider);
    }

    async function myMemoryTranslate(text, sourceLanguage, targetLanguage) {
      const provider = 'MyMemory';
      const source = !sourceLanguage || sourceLanguage === 'auto'
        ? (targetLanguage === 'vi' ? 'en' : 'vi')
        : sourceLanguage;
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', text);
      url.searchParams.set('langpair', `${source}|${targetLanguage}`);

      const response = await requestWithRetry(() => request({
        method: 'GET',
        url: url.toString(),
        timeout: 24000,
        provider,
        headers: { Accept: 'application/json,text/plain,*/*' },
      }), provider);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${provider}: HTTP ${response.status}`);
      }

      let data;
      try {
        data = JSON.parse(response.responseText || '{}');
      } catch (_) {
        throw new Error(`${provider}: phản hồi không phải JSON`);
      }

      const output = data?.responseData?.translatedText;
      if (typeof output !== 'string' || !output.trim()) {
        throw new Error(`${provider}: không có nội dung dịch`);
      }
      return decodeEntities(output);
    }

    // Gọi API riêng của user (DeepL/Gemini) qua background. Trả về:
    //   - mảng bản dịch cùng thứ tự texts: THÀNH CÔNG
    //   - null: đã gọi nhưng THẤT BẠI (caller quyết định fallback theo consent NPT-006)
    //   - undefined: không gọi (setting tắt/skipProvider) — fallback free là đường chính
    // usePageOptions=true (CHỈ dịch trang) mới kèm văn phong pageOptions; dịch bôi đen
    // và Quick EN của input helper truyền false để giữ prompt gốc như v4.1.
    let providerRequestSeq = 0;
    async function providerTranslateViaBackground(texts, sourceLanguage, targetLanguage, usePageOptions, skipProvider) {
      if (skipProvider) return undefined;
      if (!GM_getValue('tm-page-use-provider', true)) return undefined;
      if (!Array.isArray(texts) || !texts.length) return undefined;

      // requestId để hủy request phía background khi timeout (NPT-007) — timeout
      // phía content mà không hủy thì request trả phí vẫn chạy ngầm + fallback chồng lên.
      const requestId = `${Date.now()}-${++providerRequestSeq}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const response = await new Promise(resolve => {
          const timer = setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'cancelProviderTranslate', requestId }).catch(() => {});
            resolve(null);
          }, 65000);
          chrome.runtime.sendMessage({
            type: 'providerTranslate',
            payload: {
              texts,
              targetLanguage,
              sourceLanguage,
              requestId,
              ...(usePageOptions ? { pageOptions: readPageOptions() } : {}),
            },
          }).then(result => {
            clearTimeout(timer);
            resolve(result);
          }).catch(() => {
            clearTimeout(timer);
            resolve(null);
          });
        });

        const translations = response?.ok ? response.translations : null;
        if (!Array.isArray(translations) || translations.length !== texts.length) return null;
        if (!translations.every(item => typeof item === 'string' && item.trim())) return null;
        return translations;
      } catch (_) {
        return null;
      }
    }

    // NPT-006: provider riêng THẤT BẠI (null) mà user tắt fallback miễn phí → dừng,
    // không âm thầm đổi bên nhận dữ liệu sang Google/MyMemory.
    function assertFreeFallbackAllowed(providerResult) {
      if (providerResult === null && GM_getValue('tm-page-free-fallback', true) === false) {
        throw new Error('Provider riêng lỗi và bạn đã tắt fallback miễn phí (bật lại trong Cài đặt)');
      }
    }

    async function translateRaw(text, sourceLanguage, targetLanguage, usePageOptions, skipProvider) {
      // Ưu tiên API riêng của user; undefined (không gọi) thì xuống endpoint miễn phí.
      const providerTranslations = await providerTranslateViaBackground([text], sourceLanguage, targetLanguage, usePageOptions, skipProvider);
      if (providerTranslations) return providerTranslations[0].trim();
      assertFreeFallbackAllowed(providerTranslations);

      const errors = [];
      const providers = [
        () => googleTranslate('https://translate.googleapis.com', text, sourceLanguage, targetLanguage),
        () => googleTranslate('https://translate.google.com', text, sourceLanguage, targetLanguage),
      ];

      if (text.length <= 450) {
        providers.push(() => myMemoryTranslate(text, sourceLanguage, targetLanguage));
      }

      for (const provider of providers) {
        try {
          return await provider();
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }

      throw new Error(`Dịch miễn phí lỗi: ${errors.join(' · ')}`);
    }

    function splitLongText(text, limit = 2600) {
      const value = String(text || '');
      if (value.length <= limit) return [value];

      const chunks = [];
      let remaining = value;
      while (remaining.length > limit) {
        let cut = Math.max(
          remaining.lastIndexOf('\n', limit),
          remaining.lastIndexOf('. ', limit),
          remaining.lastIndexOf('! ', limit),
          remaining.lastIndexOf('? ', limit),
          remaining.lastIndexOf(' ', limit),
        );
        if (cut < Math.floor(limit * 0.55)) cut = limit;
        chunks.push(remaining.slice(0, cut + (remaining[cut] === ' ' ? 1 : 0)));
        remaining = remaining.slice(cut + (remaining[cut] === ' ' ? 1 : 0));
      }
      if (remaining) chunks.push(remaining);
      return chunks;
    }

    async function translate(text, sourceLanguage, targetLanguage, usePageOptions, skipProvider) {
      const original = String(text ?? '');
      const trimmed = original.trim();
      if (!trimmed) return original;

      // Font đặc biệt (𝕕𝕠𝕦𝕓𝕝𝕖-𝕤𝕥𝕣𝕦𝕔𝕜, 𝓈𝒸𝓇𝒾𝓅𝓉, ᴛɪɴʏ...): chuẩn hóa về
      // ASCII để engine dịch hiểu, dịch xong gán lại style vào kết quả.
      const styledFancy = FANCY ? FANCY.normalizeStyledText(trimmed) : null;
      const sourceText = styledFancy ? styledFancy.text : trimmed;

      // Không salt khi không dùng pageOptions → namespace cache tách biệt 2 chế độ.
      const salt = usePageOptions ? styleCacheSalt() : '';
      const key = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${sourceText}\u0000${salt}`;
      if (cache.has(key)) {
        const cached = cache.get(key);
        return preserveWhitespace(original, styledFancy ? FANCY.applyStyleToText(cached, styledFancy.style) : cached);
      }

      const chunks = splitLongText(sourceText);
      const translated = [];
      for (const chunk of chunks) {
        const chunkKey = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${chunk}\u0000${salt}`;
        let output = cache.get(chunkKey);
        if (!output) {
          output = await translateRaw(chunk, sourceLanguage || 'auto', targetLanguage, usePageOptions, skipProvider);
          cacheSet(chunkKey, output);
        }
        translated.push(output);
      }

      const output = translated.join('');
      cacheSet(key, output);
      return preserveWhitespace(original, styledFancy ? FANCY.applyStyleToText(output, styledFancy.style) : output);
    }

    /* Trần batch phụ thuộc đường đi:
     *  - Provider riêng (DeepL/Gemini/OpenAI): background chấp nhận tới 64 đoạn
     *    / 20000 ký tự mỗi request. Bản cũ luôn gom 2800/28 nên một trang dài
     *    tốn gấp nhiều lần số round-trip cần thiết — và với LLM là gấp bấy nhiêu
     *    lần token system instruction bị gửi lặp.
     *  - Fallback miễn phí: nhồi cả batch vào MỘT chuỗi kèm token phân đoạn rồi
     *    đẩy qua query string → bắt buộc giữ nhỏ. */
    const FREE_BATCH_LIMITS = { maxChars: 2800, maxItems: 28 };
    const PROVIDER_BATCH_LIMITS = { maxChars: 15000, maxItems: 48 };

    function providerPathEnabled() {
      return GM_getValue('tm-page-use-provider', true) !== false;
    }

    function makeBatches(items, limits = FREE_BATCH_LIMITS) {
      const batches = [];
      let current = [];
      let size = 0;
      for (const item of items) {
        const addition = item.text.length + 50;
        if (current.length && (current.length >= limits.maxItems || size + addition > limits.maxChars)) {
          batches.push(current);
          current = [];
          size = 0;
        }
        current.push(item);
        size += addition;
      }
      if (current.length) batches.push(current);
      return batches;
    }

    async function translateBundle(batch, sourceLanguage, targetLanguage, usePageOptions) {
      const salt = usePageOptions ? styleCacheSalt() : '';
      if (batch.length === 1) {
        return [{ index: batch[0].index, text: await translate(batch[0].text, sourceLanguage, targetLanguage, usePageOptions) }];
      }

      // Ưu tiên API riêng của user — 1 message cho cả batch, không cần token __NPT.
      const providerTranslations = await providerTranslateViaBackground(
        batch.map(item => item.text),
        sourceLanguage || 'auto',
        targetLanguage,
        usePageOptions,
      );
      if (providerTranslations) {
        return batch.map((item, index) => {
          const translated = providerTranslations[index].trim();
          const key = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${item.text.trim()}\u0000${salt}`;
          cacheSet(key, translated);
          return { index: item.index, text: preserveWhitespace(item.text, translated) };
        });
      }

      assertFreeFallbackAllowed(providerTranslations);

      /* Batch gom theo trần provider vượt xa giới hạn đường miễn phí → cắt nhỏ
       * lại trước khi fallback, không đẩy nguyên khối 15k ký tự qua Google. */
      if (batch.length > FREE_BATCH_LIMITS.maxItems
        || batch.reduce((sum, item) => sum + item.text.length, 0) > FREE_BATCH_LIMITS.maxChars) {
        const results = [];
        for (const part of makeBatches(batch, FREE_BATCH_LIMITS)) {
          results.push(...await translateBundleFree(part, sourceLanguage, targetLanguage, usePageOptions, salt));
        }
        return results;
      }

      return translateBundleFree(batch, sourceLanguage, targetLanguage, usePageOptions, salt);
    }

    // Đường miễn phí: gói batch thành 1 chuỗi có token phân đoạn; hỏng thì dịch lẻ.
    // Provider riêng đã thất bại trước khi tới đây nên luôn skipProvider.
    async function translateBundleFree(batch, sourceLanguage, targetLanguage, usePageOptions, salt) {
      if (batch.length === 1) {
        return [{ index: batch[0].index, text: await translate(batch[0].text, sourceLanguage, targetLanguage, usePageOptions, true) }];
      }

      const seed = Math.random().toString(36).slice(2, 8).toUpperCase();
      const tokens = batch.map((_, index) => `__NPT_${seed}_${index}__`);
      const bundled = batch.map((item, index) => `${tokens[index]}\n${item.text}`).join('\n');

      try {
        // Provider riêng vừa thất bại cho batch này → skipProvider (không re-enter
        // nhiều lần tốn request trả phí, NPT-007); chỉ xuống chuỗi miễn phí.
        const output = await translateRaw(bundled, sourceLanguage || 'auto', targetLanguage, usePageOptions, true);
        const positions = tokens.map(token => output.indexOf(token));
        const valid = positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
        if (!valid) throw new Error('API làm mất dấu phân đoạn');

        return batch.map((item, index) => {
          const start = positions[index] + tokens[index].length;
          const end = index + 1 < batch.length ? positions[index + 1] : output.length;
          const translated = output.slice(start, end).replace(/^\s+|\s+$/g, '');
          if (!translated) throw new Error('Một phân đoạn dịch bị rỗng');
          const key = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${item.text.trim()}\u0000${salt}`;
          cacheSet(key, translated);
          return { index: item.index, text: preserveWhitespace(item.text, translated) };
        });
      } catch (_) {
        const results = [];
        for (const item of batch) {
          try {
            results.push({ index: item.index, text: await translate(item.text, sourceLanguage, targetLanguage, usePageOptions, true) });
          } catch (error) {
            results.push({ index: item.index, error });
          }
        }
        return results;
      }
    }

    // Google free chỉ detect 1 ngôn ngữ nguồn cho cả request, nên trang lẫn
    // Anh/Trung/Nhật/Hàn phải gom batch theo nhóm chữ thì mới dịch hết.
    function detectScriptClass(text) {
      if (/[぀-ヿ]/.test(text)) return 'ja';   // Hiragana/Katakana
      if (/[가-힯]/.test(text)) return 'ko';   // Hangul
      if (/[一-鿿]/.test(text)) return 'zh';   // Hán tự (không kana)
      return 'other';
    }

    async function translateMany(texts, sourceLanguage, targetLanguage, usePageOptions) {
      // Font đặc biệt: chuẩn hóa từng đoạn về ASCII trước khi gom batch, nhớ
      // style để gán lại vào kết quả (whitespace rìa giữ nguyên cho preserveWhitespace).
      const items = texts.map((text, index) => {
        const raw = String(text ?? '');
        const styled = FANCY ? FANCY.normalizeStyledText(raw.trim()) : null;
        if (!styled) return { index, text: raw, styled: null };
        const lead = raw.match(/^\s*/u)?.[0] || '';
        const trail = raw.match(/\s*$/u)?.[0] || '';
        return { index, text: `${lead}${styled.text}${trail}`, styled };
      });
      const results = new Array(items.length);

      /* Tra cache TRƯỚC khi gom batch. Bản cũ chỉ tra cache trong translate()
       * — tức chỉ khi batch còn đúng 1 phần tử — nên mọi lần dịch lại (đổi
       * display mode, quay về gốc rồi dịch tiếp, SPA render lại cùng nội dung,
       * footer/menu lặp trên nhiều trang) đều gửi lại toàn bộ cho API. */
      const salt = usePageOptions ? styleCacheSalt() : '';
      const pending = [];
      for (const item of items) {
        const trimmed = item.text.trim();
        const hit = trimmed ? cache.get(`${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${trimmed}\u0000${salt}`) : null;
        if (typeof hit === 'string') results[item.index] = { index: item.index, text: preserveWhitespace(item.text, hit) };
        else pending.push(item);
      }

      const byScript = new Map();
      for (const item of pending) {
        const cls = detectScriptClass(item.text);
        if (!byScript.has(cls)) byScript.set(cls, []);
        byScript.get(cls).push(item);
      }
      // Provider riêng đang bật → gom batch sát trần background (ít round-trip hơn hẳn).
      const batchLimits = providerPathEnabled() ? PROVIDER_BATCH_LIMITS : FREE_BATCH_LIMITS;
      const batches = [];
      for (const group of byScript.values()) batches.push(...makeBatches(group, batchLimits));
      let cursor = 0;

      async function worker() {
        while (cursor < batches.length) {
          const batch = batches[cursor++];
          let translated;
          try {
            translated = await translateBundle(batch, sourceLanguage, targetLanguage, usePageOptions);
          } catch (error) {
            translated = batch.map(item => ({ index: item.index, error }));
          }
          for (const result of translated) results[result.index] = result;
        }
      }

      await Promise.all(Array.from({ length: Math.min(3, Math.max(1, batches.length)) }, worker));
      // Gán lại style font đặc biệt vào kết quả dịch (đoạn nào nguồn là font đặc biệt).
      if (FANCY) {
        for (const item of items) {
          const result = results[item.index];
          if (item.styled && result?.text) {
            result.text = FANCY.applyStyleToText(result.text, item.styled.style);
          }
        }
      }
      return results;
    }

    return { translate, translateMany };
  })();


(() => {
  'use strict';

  const IS_TOP_FRAME = window === window.top;

  /* Icon của panel trên trang lấy từ icons.js (manifest nạp trước content.js),
   * nên nút nổi ngoài trang và popup/Cài đặt dùng đúng một bộ nét. */
  const ICON = globalThis.NPT_ICONS;
  const NPT_PANEL_ICONS = {
    undo: ICON.svg('revert', { size: 12 }),
    globe: ICON.svg('globe', { size: 14 }),
    translate: ICON.svg('translate', { size: 14 }),
    copy: ICON.svg('copy', { size: 12 }),
    close: ICON.svg('close', { size: 11 }),
    image: ICON.svg('image', { size: 14 }),
    speak: ICON.svg('volume', { size: 13 }),
  };
  const NPT_SELECTION_FAB_LABEL = `${NPT_PANEL_ICONS.translate}<span>Dịch</span>`;
  const NPT_SELECTION_COPY_LABEL = `${NPT_PANEL_ICONS.copy}<span>Sao chép</span>`;
  const NPT_SELECTION_COPIED_LABEL = `${NPT_PANEL_ICONS.copy}<span>Đã sao chép</span>`;

  /* ------------------------------------------------------------------
   * Style dùng chung cho MỌI shadow root của extension (FAB, toast, panel ảnh,
   * panel dịch đoạn, panel tóm tắt, nút ✨ EN). Sáu panel đó vốn mỗi cái tự chép
   * lại công thức "liquid glass" bằng màu cứng, nên:
   *   - Không panel nào theo được dark mode: trên trang tối, giữa đêm, vẫn loé
   *     lên một tấm kính trắng.
   *   - Không nút nào có vòng focus (tất cả đều `all: unset`) → dùng bàn phím
   *     là mất dấu hoàn toàn.
   *   - Không surface nào tôn trọng prefers-reduced-motion.
   * Ba màu nền/chữ giờ là biến trên :host, block này đổi giá trị theo theme.
   * ------------------------------------------------------------------ */
  const NPT_SHARED_SHADOW_CSS = `
    :host {
      --npt-surface: 255,255,255;
      --npt-surface-2: 244,245,249;
      --npt-ink: 23,24,28;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --npt-surface: 52,56,66;
        --npt-surface-2: 30,32,39;
        --npt-ink: 236,238,243;
      }
    }
    :where(button, [tabindex], a):focus-visible {
      outline: 2px solid #6366f1;
      outline-offset: 2px;
      border-radius: 8px;
    }
    @media (prefers-reduced-motion: reduce) {
      :host *, :host *::before, :host *::after {
        animation-duration: .001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .001ms !important;
      }
    }
  `;

  function applySharedShadowStyle(root) {
    if (!root) return root;
    const style = document.createElement('style');
    style.textContent = NPT_SHARED_SHADOW_CSS;
    root.appendChild(style);
    return root;
  }

  /* Khối "nút ✨ EN" là một IIFE riêng phía dưới file, không thấy được hàm này
   * -> shadow root của nó ném ReferenceError và nút không bao giờ dựng xong.
   * Treo lên global để cả hai khối dùng chung đúng một bản style. */
  globalThis.NPT_SHADOW_STYLE = { css: NPT_SHARED_SHADOW_CSS, apply: applySharedShadowStyle };

  function getExtensionShadowRoot(element) {
    if (!(element instanceof Element)) return null;
    try {
      return element.shadowRoot || chrome.dom?.openOrClosedShadowRoot?.(element) || null;
    } catch (_) {
      return element.shadowRoot || null;
    }
  }

  function enumerateScanRoots(root) {
    const roots = [];
    const queue = [root];
    const visited = new WeakSet();

    while (queue.length) {
      const current = queue.shift();
      if (!current || (typeof current === 'object' && visited.has(current))) continue;
      if (typeof current === 'object') visited.add(current);
      roots.push(current);

      let elements = [];
      if (current.nodeType === Node.ELEMENT_NODE) {
        elements = [current, ...current.querySelectorAll('*')];
      } else if (typeof current.querySelectorAll === 'function') {
        elements = [...current.querySelectorAll('*')];
      }

      for (const element of elements) {
        const shadow = getExtensionShadowRoot(element);
        if (shadow && !visited.has(shadow)) queue.push(shadow);
      }
    }

    return roots;
  }

  const CONFIG = {
    maxRequestChars: 3500,
    mutationDebounceMs: 220,
    minimumTextLength: 2,
    storageKey: 'tm-page-translator-language',
  };

  // Defaults cho các tuỳ chọn trang (contract tm-page-*) — đọc qua pageSetting.
  const PAGE_SETTINGS_DEFAULTS = {
    'tm-page-display-mode': 'replace',
    'tm-page-style': 'natural',
    'tm-page-dialect': 'us',
    'tm-page-translate-mode': 'natural',
    'tm-page-grammar-fix': false,
    'tm-page-skip-code': true,
    'tm-page-skip-usernames': true,
    'tm-page-keep-proper-nouns': true,
    'tm-page-dynamic-translate': true,
    'tm-page-lazy-translate': true,
  };

  function pageSetting(key) {
    return GM_getValue(key, PAGE_SETTINGS_DEFAULTS[key]);
  }

  // Tuỳ chọn style ảnh hưởng kết quả dịch — gửi kèm payload providerTranslate
  // (TRANSLATION_CORE cũng tự đọc, giữ 2 hàm này đồng bộ với readPageOptions bên core).
  function currentPageOptions() {
    return {
      style: pageSetting('tm-page-style'),
      dialect: pageSetting('tm-page-dialect'),
      mode: pageSetting('tm-page-translate-mode'),
      grammarFix: pageSetting('tm-page-grammar-fix') !== false,
      keepProperNouns: pageSetting('tm-page-keep-proper-nouns') !== false,
      ...readExtendedPageOptions(),
    };
  }

  /* Chữ ký style: đổi 1 trong các tuỳ chọn → bản dịch cache trong records hết
   * hiệu lực (xét theo record.sig), phải dịch lại. Memo hoá như bên core: hàm
   * này chạy trong vòng lặp rerenderDisplayMode trên MỌI record. */
  let styleSignatureCache = '';
  let styleSignatureUrl = '';
  onSettingsChanged(() => { styleSignatureCache = ''; });

  function pageStyleSignature() {
    if (!styleSignatureCache || styleSignatureUrl !== location.href) {
      styleSignatureUrl = location.href;
      styleSignatureCache = hashString(JSON.stringify(currentPageOptions()));
    }
    return styleSignatureCache;
  }

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CANVAS', 'SVG', 'MATH',
  ]);

  // Heuristic bỏ qua khối code theo class phổ biến (hljs, prism, monaco...) —
  // chỉ áp dụng khi tm-page-skip-code bật; có thể bổ sung selector theo site.
  const SKIP_CODE_CLASS_SELECTOR = '.hljs, .prettyprint, .prism, .code-block, .codeblock, .highlight-source, .monaco-editor, .CodeMirror';
  // Heuristic nhận diện username/nickname theo class/id — chỉ áp dụng khi
  // tm-page-skip-usernames bật; heuristic, có thể bổ sung selector theo site.
  const SKIP_USERNAME_SELECTOR = '[class*="username" i], [class*="user-name" i], [class*="nickname" i], [class*="screen-name" i], [id*="username" i]';
  // Handle đứng một mình: @ten_dung (Twitter/Instagram...), u/abc hoặc user/abc (Reddit/Discord).
  const USERNAME_HANDLE_PATTERNS = [
    /^@[\w.\-]{1,32}$/u,
    /^(?:u|user)\/[\w\-]{2,20}$/i,
  ];

  const TRANSLATABLE_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

  const textRecords = new Map();
  const attributeRecords = new Map();

  const expectedTextChanges = new WeakMap();
  const expectedAttributeChanges = new WeakMap();

  let currentLanguage = 'original';
  let generation = 0;
  let mutationTimer = null;
  const pendingDynamicRoots = new Set();
  const bilingualPairs = new Map(); // text node -> span bản dịch song ngữ
  let bilingualStyleInjected = false;
  let lazyObserver = null;
  const lazyPending = new Map(); // Element -> Text[] chờ cuộn tới để dịch
  let toolbarHost = null;
  let statusElement = null;
  let fabElement = null;
  let fabLangElement = null;
  let fabMenu = null;
  let buttons = {};

  function isToolbarNode(node) {
    return Boolean(toolbarHost && (node === toolbarHost || toolbarHost.contains(node)));
  }

  /* Snapshot settings ảnh hưởng vòng quét DOM + selector skip đã ghép sẵn.
   * isElementSkipped/isUsefulText chạy hàng chục nghìn lần mỗi lần dịch trang,
   * nên đọc storage + nối chuỗi selector ở đây đúng 1 lần thay vì mỗi node. */
  const SKIP_BASE_SELECTOR = '[contenteditable="true"],[data-tm-no-translate],code,pre,kbd,samp,[translate="no"],.notranslate';
  let scanConfigCache = null;

  /* Kết quả skip của một element không đổi trong cùng một lượt quét (và giữa
   * các lượt nếu settings không đổi). WeakMap + epoch: settings đổi thì epoch
   * tăng, toàn bộ entry cũ tự hết hạn mà không phải duyệt lại. */
  const skipCache = new WeakMap();
  let skipCacheEpoch = 0;

  onSettingsChanged(() => {
    scanConfigCache = null;
    skipCacheEpoch++;
  });

  function scanConfig() {
    if (!scanConfigCache) {
      const skipCode = pageSetting('tm-page-skip-code') !== false;
      const skipUsernames = pageSetting('tm-page-skip-usernames') !== false;
      let selector = SKIP_BASE_SELECTOR;
      if (skipCode) selector += `,${SKIP_CODE_CLASS_SELECTOR}`;
      if (skipUsernames) selector += `,${SKIP_USERNAME_SELECTOR}`;
      scanConfigCache = { skipCode, skipUsernames, selector };
    }
    return scanConfigCache;
  }

  // Skip "nông": chỉ xét bản thân element (dùng trong TreeWalker, nơi mọi tổ
  // tiên đã bị FILTER_REJECT loại từ trước nên không cần leo cây lần nữa).
  function isElementSkippedSelf(element) {
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    return element.matches(scanConfig().selector);
  }

  // Skip "sâu": xét cả tổ tiên — dùng cho scan root / node rời từ MutationObserver.
  function isElementSkipped(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    const cached = skipCache.get(element);
    if (cached && cached.epoch === skipCacheEpoch) return cached.skipped;

    let skipped = true;
    if (isToolbarNode(element)) skipped = true;
    else if (SKIP_TAGS.has(element.tagName)) skipped = true;
    else if (element.isContentEditable) skipped = true;
    // 1 lần closest() với selector đã ghép, thay cho 5 lần closest() rời.
    else skipped = Boolean(element.closest(scanConfig().selector));

    skipCache.set(element, { epoch: skipCacheEpoch, skipped });
    return skipped;
  }

  const URL_ONLY_TEXT = /^(https?:\/\/|www\.)\S+$/i;

  function isUsefulText(value) {
    const text = String(value ?? '').trim();
    if (text.length < CONFIG.minimumTextLength) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (URL_ONLY_TEXT.test(text)) return false;
    // Handle đứng một mình (@nick, u/abc) — không phải câu cần dịch.
    if (scanConfig().skipUsernames && USERNAME_HANDLE_PATTERNS.some(pattern => pattern.test(text))) return false;
    return true;
  }

  function preserveOuterWhitespace(original, translated) {
    const leading = original.match(/^\s*/u)?.[0] ?? '';
    const trailing = original.match(/\s*$/u)?.[0] ?? '';
    return `${leading}${translated.trim()}${trailing}`;
  }

  function splitLongText(text, limit = CONFIG.maxRequestChars) {
    if (text.length <= limit) return [text];

    const pieces = text.split(/(?<=[.!?。！？])\s+|\n+/u);
    const chunks = [];
    let current = '';

    for (const piece of pieces) {
      if (!piece) continue;

      if (piece.length > limit) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        for (let i = 0; i < piece.length; i += limit) {
          chunks.push(piece.slice(i, i + limit));
        }
        continue;
      }

      const candidate = current ? `${current} ${piece}` : piece;
      if (candidate.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  function requestTranslation(text, targetLanguage) {
    // Dịch trang: bật pageOptions (văn phong/dialect/grammar...) theo cài đặt hiện hành.
    return TRANSLATION_CORE.translate(text, 'auto', targetLanguage, true);
  }

  async function translateText(text, targetLanguage) {
    if (!String(text ?? '').trim() || targetLanguage === 'original') return text;
    return requestTranslation(text, targetLanguage);
  }

  /* ------------------------------------------------------------------
   * Quét DOM MỘT LƯỢT cho cả text node lẫn attribute.
   *
   * Bản cũ chạy 3 vòng riêng trên cùng một cây: enumerateScanRoots dùng
   * querySelectorAll('*') để tìm shadow root, collectTextNodes đi TreeWalker,
   * collectAttributeTargets lại querySelectorAll('*') lần nữa — và cả 3 gọi
   * enumerateScanRoots độc lập. Ở đây một TreeWalker SHOW_ELEMENT|SHOW_TEXT
   * làm hết: element bị skip trả FILTER_REJECT nên cả subtree bị cắt luôn
   * (bản cũ vẫn đi vào rồi mới lọc bằng closest() ở từng text node), shadow
   * root gặp trên đường được đẩy vào hàng đợi, attribute lấy ngay tại chỗ.
   * ------------------------------------------------------------------ */
  function collectTargets(root) {
    const textNodes = [];
    const attributeTargets = [];
    if (!root) return { textNodes, attributeTargets };

    if (root.nodeType === Node.TEXT_NODE) {
      const parent = root.parentElement;
      if (parent && !isElementSkipped(parent) && isUsefulText(root.data)) textNodes.push(root);
      return { textNodes, attributeTargets };
    }
    if (root.nodeType !== Node.ELEMENT_NODE && typeof root.querySelectorAll !== 'function') {
      return { textNodes, attributeTargets };
    }

    const collectAttributes = (element) => {
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value && isUsefulText(value)) attributeTargets.push({ element, attribute });
      }
    };

    const queue = [root];
    const visitedRoots = new WeakSet();

    while (queue.length) {
      const scanRoot = queue.shift();
      if (!scanRoot || visitedRoots.has(scanRoot)) continue;
      visitedRoots.add(scanRoot);

      // Root truyền vào có thể nằm sâu trong vùng bị chặn → phải xét cả tổ tiên.
      if (scanRoot.nodeType === Node.ELEMENT_NODE) {
        if (isElementSkipped(scanRoot)) continue;
        collectAttributes(scanRoot);
        const shadow = getExtensionShadowRoot(scanRoot);
        if (shadow) queue.push(shadow);
      }

      const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return isUsefulText(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
          // Cắt nguyên subtree bị chặn — tổ tiên đã lọc nên chỉ cần xét bản thân.
          return isElementSkippedSelf(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });

      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodes.push(node);
          continue;
        }
        collectAttributes(node);
        const shadow = getExtensionShadowRoot(node);
        if (shadow && !visitedRoots.has(shadow)) queue.push(shadow);
      }
    }

    return { textNodes, attributeTargets };
  }

  function getTextRecord(node) {
    let record = textRecords.get(node);
    if (!record) {
      // sig = style signature lúc dịch; lệch sig hiện tại → cache vô hiệu, dịch lại.
      record = { original: node.data, vi: null, en: null, sig: null };
      textRecords.set(node, record);
    }
    return record;
  }

  function getAttributeRecord(element, attribute) {
    let elementMap = attributeRecords.get(element);
    if (!elementMap) {
      elementMap = new Map();
      attributeRecords.set(element, elementMap);
    }

    let record = elementMap.get(attribute);
    if (!record) {
      record = {
        original: element.getAttribute(attribute) ?? '',
        vi: null,
        en: null,
        // sig giống textRecords: lệch style signature → dịch lại, không xài cache cũ.
        sig: null,
      };
      elementMap.set(attribute, record);
    }
    return record;
  }

  function safelySetText(node, value) {
    if (!node.isConnected || node.data === value) return;
    expectedTextChanges.set(node, value);
    node.data = value;
  }

  function safelySetAttribute(element, attribute, value) {
    if (!element.isConnected || element.getAttribute(attribute) === value) return;

    let expected = expectedAttributeChanges.get(element);
    if (!expected) {
      expected = new Map();
      expectedAttributeChanges.set(element, expected);
    }

    expected.set(attribute, value);
    element.setAttribute(attribute, value);
  }

  // Inject 1 lần CSS cho chế độ song ngữ.
  function ensureBilingualStyle() {
    if (bilingualStyleInjected) return;
    if (document.getElementById('npt-bilingual-style')) {
      bilingualStyleInjected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'npt-bilingual-style';
    style.dataset.tmNoTranslate = 'true';
    style.textContent = '.npt-bilingual-translation{display:block;opacity:.72;font-size:.93em;margin-top:2px}'
      + '.npt-bilingual-inline{display:inline;margin-left:4px;opacity:.72}';
    (document.head || document.documentElement).appendChild(style);
    bilingualStyleInjected = true;
  }

  // Chèn/cập nhật span bản dịch song ngữ (idempotent qua bilingualPairs).
  // data-tm-no-translate để MutationObserver không tự dịch bản dịch (loop).
  function upsertBilingualSpan(node, translated) {
    if (!node.isConnected) {
      const stale = bilingualPairs.get(node);
      if (stale) {
        stale.remove();
        bilingualPairs.delete(node);
      }
      return;
    }

    const existing = bilingualPairs.get(node);
    if (existing && existing.isConnected) {
      if (existing.textContent !== translated) existing.textContent = translated;
      return;
    }
    if (existing) bilingualPairs.delete(node);

    const parent = node.parentElement;
    if (!parent) return;

    ensureBilingualStyle();
    const span = document.createElement('span');
    span.className = 'npt-bilingual-translation';
    span.dataset.tmNoTranslate = 'true';
    span.textContent = translated;

    // Parent inline (a, strong, span...) → chèn SAU cả element để không phá dòng;
    // ngược lại chèn ngay sau text node (span hiển thị block bên dưới).
    let display = '';
    try {
      display = getComputedStyle(parent).display;
    } catch (_) {
      display = '';
    }
    if (display.startsWith('inline')) {
      span.classList.add('npt-bilingual-inline');
      parent.after(span);
    } else {
      node.after(span);
    }
    bilingualPairs.set(node, span);
  }

  // Áp bản dịch cho text node theo display-mode hiện tại:
  // 'replace' thay node.data như cũ; 'bilingual' giữ nguyên gốc + chèn span.
  function applyTextTranslation(node, translated, original) {
    if (!node.isConnected) return;

    if (pageSetting('tm-page-display-mode') !== 'bilingual') {
      const stale = bilingualPairs.get(node);
      if (stale) {
        stale.remove();
        bilingualPairs.delete(node);
      }
      safelySetText(node, translated);
      return;
    }

    // Node có thể đang giữ bản replace từ lần dịch trước → trả về bản gốc trước.
    if (typeof original === 'string' && node.data !== original) safelySetText(node, original);
    upsertBilingualSpan(node, translated);
  }

  /* Tiến trình dịch trang, đọc được từ popup (getPageState). Thanh status của
   * FAB nằm trong menu chuột phải — mặc định ẩn — nên trước đây một lượt dịch
   * trang dài không có bất kỳ phản hồi nào ở nơi ngưởi dùng đang nhìn. */
  const translationProgress = { busy: false, done: 0, total: 0, failed: 0 };

  function setProgress(done, total, failed) {
    translationProgress.done = done;
    translationProgress.total = total;
    translationProgress.failed = failed;
  }

  function setStatus(message, isError = false) {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.dataset.error = String(isError);
  }

  function updateActiveButton() {
    for (const [language, button] of Object.entries(buttons)) {
      button.dataset.active = String(language === currentLanguage);
    }
    // Badge nhỏ trên icon nổi: ngôn ngữ đang dịch (rỗng khi ở bản gốc).
    if (fabLangElement) {
      fabLangElement.textContent = currentLanguage === 'original' ? '' : currentLanguage.toUpperCase();
    }
    if (fabElement) fabElement.dataset.active = String(currentLanguage !== 'original');
  }

  function restoreOriginalContent() {
    // Gỡ toàn bộ span song ngữ (quét dư querySelectorAll cho chắc) rồi restore như cũ.
    for (const span of bilingualPairs.values()) span.remove();
    bilingualPairs.clear();
    for (const span of document.querySelectorAll('.npt-bilingual-translation[data-tm-no-translate="true"]')) span.remove();

    for (const [node, record] of textRecords) {
      if (!node.isConnected) {
        textRecords.delete(node);
        continue;
      }
      safelySetText(node, record.original);
    }

    for (const [element, records] of attributeRecords) {
      if (!element.isConnected) {
        attributeRecords.delete(element);
        continue;
      }
      for (const [attribute, record] of records) {
        safelySetAttribute(element, attribute, record.original);
      }
    }
  }

  async function translateTargets(textNodes, attributeTargets, language, runGeneration) {
    let completed = 0;
    let failed = 0;

    const jobs = [];
    for (const node of textNodes) {
      if (!node?.isConnected) continue;
      const record = getTextRecord(node);
      jobs.push({ kind: 'text', node, record, original: record.original });
    }
    for (const { element, attribute } of attributeTargets) {
      if (!element?.isConnected) continue;
      const record = getAttributeRecord(element, attribute);
      jobs.push({ kind: 'attribute', element, attribute, record, original: record.original });
    }

    const total = jobs.length;
    const updateProgress = () => {
      if (runGeneration !== generation || language !== currentLanguage) return;
      setProgress(completed, total, failed);
      setStatus(`Đang dịch ${completed}/${total}${failed ? ` · lỗi ${failed}` : ''}`);
    };

    // Cache trong record chỉ hợp lệ khi cùng style signature hiện tại (cả text lẫn
    // attribute record đều có field sig; sig cũ/khác → dịch lại).
    const activeSig = pageStyleSignature();
    const hasValidCache = record => {
      if (!record[language]) return false;
      if (!('sig' in record)) return true;
      return record.sig === activeSig;
    };

    const uniqueOriginals = [];
    const originalIndex = new Map();
    for (const job of jobs) {
      if (hasValidCache(job.record)) continue;
      if (!originalIndex.has(job.original)) {
        originalIndex.set(job.original, uniqueOriginals.length);
        uniqueOriginals.push(job.original);
      }
    }

    let translatedResults = [];
    if (uniqueOriginals.length) {
      translatedResults = await TRANSLATION_CORE.translateMany(uniqueOriginals, 'auto', language, true);
    }

    const resultByOriginal = new Map();
    for (let index = 0; index < uniqueOriginals.length; index++) {
      resultByOriginal.set(uniqueOriginals[index], translatedResults[index]);
    }

    for (const job of jobs) {
      if (runGeneration !== generation || language !== currentLanguage) break;
      try {
        if (!hasValidCache(job.record)) {
          const result = resultByOriginal.get(job.original);
          if (!result || result.error) throw result?.error || new Error('Không nhận được kết quả dịch');
          job.record[language] = result.text;
          if ('sig' in job.record) job.record.sig = activeSig;
        }

        // NPT-009: SPA đã đổi nội dung node trong lúc chờ dịch → bỏ kết quả cũ,
        // không ghi đè text mới; mutation observer sẽ xếp hàng dịch lại bản mới.
        if (job.record.original !== job.original) continue;

        if (job.kind === 'text') {
          if (job.node.isConnected) applyTextTranslation(job.node, job.record[language], job.record.original);
        } else if (job.element.isConnected) {
          safelySetAttribute(job.element, job.attribute, job.record[language]);
        }
      } catch (error) {
        failed++;
        console.warn('[Page Translator] Lỗi dịch:', error, job.original);
      } finally {
        completed++;
        if (completed % 10 === 0 || completed === total) updateProgress();
      }
    }

    return { completed, failed };
  }

  // Viewport-first: node nằm trong (hoặc sát) khung nhìn được dịch trước.
  function splitByViewport(textNodes) {
    const inView = [];
    const outView = [];
    // Nhiều text node dùng chung một parent (mỗi <p> thường có vài node). Nhớ
    // kết quả theo parent để không lặp getBoundingClientRect — mỗi lần gọi là
    // một forced layout, nhân với vài nghìn node thì thấy rõ khựng.
    const seen = new Map();
    const top = innerHeight * 1.5;
    const bottom = -innerHeight * 0.5;

    for (const node of textNodes) {
      const parent = node.parentElement;
      let visible = seen.get(parent);
      if (visible === undefined) {
        visible = false;
        if (parent) {
          try {
            const rect = parent.getBoundingClientRect();
            visible = rect.top < top && rect.bottom > bottom;
          } catch (_) {
            visible = false;
          }
        }
        seen.set(parent, visible);
      }
      (visible ? inView : outView).push(node);
    }
    return { inView, outView };
  }

  // 2 bucket nối nhau, giữ nguyên thứ tự DOM tương đối — KHÔNG sort toàn phần.
  function orderViewportFirst(textNodes) {
    const { inView, outView } = splitByViewport(textNodes);
    return inView.concat(outView);
  }

  // Lazy translate: hủy toàn bộ node đang chờ cuộn (đổi ngôn ngữ, về bản gốc, lazy tắt).
  function disconnectLazyObserver() {
    if (lazyObserver) lazyObserver.disconnect();
    lazyObserver = null;
    lazyPending.clear();
  }

  // Gắn IntersectionObserver lên parentElement của từng node ngoài viewport;
  // element vào khung nhìn → dịch nhóm node đó rồi unobserve.
  /* Một IntersectionObserver duy nhất cho cả phiên dịch. Bản cũ tạo observer
   * MỚI mỗi lần gọi rồi observe lại toàn bộ lazyPending — giờ dịch động cũng
   * đẩy node vào đây nên cách đó vừa lãng phí vừa bỏ rơi observer cũ.
   * Ngôn ngữ/generation đọc tại thời điểm intersect, không capture lúc đăng ký. */
  function ensureLazyObserver() {
    if (lazyObserver) return lazyObserver;
    lazyObserver = new IntersectionObserver(entries => {
      const ready = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazyObserver.unobserve(entry.target);
        const group = lazyPending.get(entry.target);
        lazyPending.delete(entry.target);
        if (group) ready.push(...group);
      }
      if (!ready.length) return;

      const language = currentLanguage;
      if (language === 'original') return;
      const runGeneration = generation;
      const alive = ready.filter(node => node.isConnected);
      if (!alive.length) return;

      translateTargets(alive, [], language, runGeneration).then(() => {
        if (language !== currentLanguage || runGeneration !== generation) return;
        if (!lazyPending.size) {
          setStatus(language === 'vi' ? 'Đã dịch sang tiếng Việt' : 'Translated to English');
        }
      });
    }, { rootMargin: '250px 0px' });
    return lazyObserver;
  }

  function observeLazyNodes(nodes, language, runGeneration) {
    // Trình duyệt không có IntersectionObserver → dịch thẳng, không lazy.
    if (typeof IntersectionObserver !== 'function') {
      translateTargets(nodes, [], language, runGeneration);
      return;
    }

    const fresh = [];
    for (const node of nodes) {
      if (!node.isConnected) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const group = lazyPending.get(parent);
      if (group) {
        group.push(node);
        continue;
      }
      lazyPending.set(parent, [node]);
      fresh.push(parent);
    }
    if (!fresh.length) return;

    const observer = ensureLazyObserver();
    for (const element of fresh) observer.observe(element);
  }

  /* Toast nổi tối giản trong page IIFE (showToast ở input-helper IIFE không
   * reachable từ đây): shadow DOM, glass style giống selection panel, tự ẩn sau 3s. */
  let pageToastHost = null;
  let pageToastShadow = null;
  let pageToastTimer = null;
  function showPageToast(message) {
    if (!pageToastHost) {
      pageToastHost = document.createElement('div');
      pageToastHost.id = 'tm-page-toast-host';
      pageToastHost.dataset.tmNoTranslate = 'true';
      pageToastShadow = pageToastHost.attachShadow({ mode: 'closed' });
      pageToastShadow.innerHTML = `
        <style>
          :host {
            all: initial;
            position: fixed;
            left: 50%;
            bottom: 24px;
            transform: translateX(-50%);
            z-index: 2147483647;
            pointer-events: none;
            font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
          }
          .toast {
            box-sizing: border-box;
            max-width: 70vw;
            padding: 8px 14px;
            border: 1px solid rgba(var(--npt-surface),.6);
            border-radius: 12px;
            background: linear-gradient(150deg, rgba(var(--npt-surface),.72), rgba(var(--npt-surface-2),.5));
            box-shadow: 0 12px 30px rgba(15,17,23,.22), inset 0 1px 0 rgba(var(--npt-surface),.95);
            color: rgba(var(--npt-ink),.88);
            backdrop-filter: blur(20px) saturate(1.7) brightness(1.1);
            font: 600 12.5px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
            text-align: center;
          }
          [hidden] { display: none !important; }
        </style>
        <div class="toast" data-tm-no-translate hidden></div>
      `;
      applySharedShadowStyle(pageToastShadow);
    }
    if (!pageToastHost.isConnected) document.documentElement.appendChild(pageToastHost);
    const toast = pageToastShadow.querySelector('.toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(pageToastTimer);
    pageToastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3000);
  }

  async function setLanguage(language, roots = [document.body]) {
    if (!['original', 'vi', 'en'].includes(language)) return;

    if (language !== 'original' && !isExtensionContextAlive()) {
      setStatus(CONTEXT_DEAD_MESSAGE, true);
      return;
    }

    // NPT-015: site nằm trong blacklist thì không cho bật dịch (kể cả bật sẵn trước đó).
    if (language !== 'original' && isSiteBlacklisted()) {
      setStatus('Site này đang nằm trong danh sách chặn dịch', true);
      return;
    }

    currentLanguage = language;
    const runGeneration = ++generation;
    disconnectLazyObserver();
    // Badge trên icon extension chỉ do top frame báo — iframe không có trạng thái riêng.
    if (IS_TOP_FRAME) {
      chrome.runtime.sendMessage({ type: 'pageLanguageChanged', language }).catch(() => {});
    }
    // Chỉ top frame persist ngôn ngữ (NPT-008): subframe không ghi preference độc
    // lập — tránh poisoning khi origin đó được truy cập trực tiếp sau này.
    if (IS_TOP_FRAME) GM_setValue(`${CONFIG.storageKey}:${location.hostname}`, language);
    updateActiveButton();

    if (language === 'original') {
      restoreOriginalContent();
      translationProgress.busy = false;
      setProgress(0, 0, 0);
      setStatus('Đang hiển thị bản gốc');
      return;
    }

    // Chế độ tài liệu đang áp dụng (tm-doc-mode 'on' hoặc 'auto' detect trúng) →
    // báo nhẹ để user biết code block được giữ nguyên.
    if (readExtendedPageOptions().docMode) {
      showPageToast('📄 Chế độ tài liệu: giữ nguyên code block');
    }

    // Shadow root xuất hiện lúc trang chưa dịch không được handleMutations
    // theo dõi (nó bỏ qua hoàn toàn khi ở bản gốc) → nhặt lại ngay trước khi quét.
    discoverAndObserveMutationRoots(document.documentElement);

    const uniqueTextNodes = new Set();
    const uniqueAttributeTargets = new Map();

    for (const root of roots) {
      const found = collectTargets(root);
      for (const node of found.textNodes) uniqueTextNodes.add(node);
      for (const target of found.attributeTargets) {
        let attributes = uniqueAttributeTargets.get(target.element);
        if (!attributes) {
          attributes = new Set();
          uniqueAttributeTargets.set(target.element, attributes);
        }
        attributes.add(target.attribute);
      }
    }

    const allTextNodes = [...uniqueTextNodes];
    // Lazy bật: chỉ dịch ngay bucket trong viewport, phần ngoài chờ cuộn tới.
    const lazyEnabled = pageSetting('tm-page-lazy-translate') !== false;
    let textNodes;
    let lazyNodes = [];
    if (lazyEnabled) {
      const buckets = splitByViewport(allTextNodes);
      textNodes = buckets.inView;
      lazyNodes = buckets.outView;
    } else {
      textNodes = orderViewportFirst(allTextNodes);
    }

    const attributeTargets = [];
    for (const [element, attributes] of uniqueAttributeTargets) {
      for (const attribute of attributes) attributeTargets.push({ element, attribute });
    }

    for (const node of allTextNodes) getTextRecord(node);
    for (const { element, attribute } of attributeTargets) getAttributeRecord(element, attribute);

    if (!allTextNodes.length && !attributeTargets.length) {
      setStatus(language === 'vi' ? 'Không tìm thấy chữ cần dịch' : 'No translatable text found');
      return;
    }

    const immediateTotal = textNodes.length + attributeTargets.length;
    translationProgress.busy = true;
    setProgress(0, immediateTotal, 0);
    setStatus(`Đang dịch 0/${immediateTotal}`);
    let result;
    try {
      result = await translateTargets(textNodes, attributeTargets, language, runGeneration);
    } finally {
      translationProgress.busy = false;
    }

    if (runGeneration !== generation || language !== currentLanguage) return;
    if (lazyNodes.length) observeLazyNodes(lazyNodes, language, runGeneration);
    setStatus(
      result.failed
        ? `Đã dịch · ${result.failed} mục lỗi`
        : lazyPending.size
          ? 'Đã dịch phần hiển thị · cuộn để dịch tiếp'
          : language === 'vi' ? 'Đã dịch sang tiếng Việt' : 'Translated to English',
      result.failed > 0,
    );
  }

  // NPT-010: budget dịch động theo cửa sổ trượt 60s — site bơm nội dung mới liên
  // tục (chuỗi duy nhất né cache) không thể cạn quota/tài nguyên của user.
  const DYNAMIC_BUDGET_CHARS = 150000;
  const DYNAMIC_WINDOW_MS = 60000;
  let dynamicWindowStart = 0;
  let dynamicWindowChars = 0;

  /* textRecords/attributeRecords phải duyệt được (restore, rerender) nên là Map
   * thường, tức node đã bị gỡ khỏi DOM vẫn bị giữ tham chiếu. Trước đây chỉ
   * restoreOriginalContent mới dọn — một SPA dịch suốt buổi thì không bao giờ
   * chạy tới đó. Quét dọn định kỳ khi map đã phình. */
  const RECORDS_PRUNE_THRESHOLD = 4000;

  function pruneDetachedRecords() {
    if (textRecords.size >= RECORDS_PRUNE_THRESHOLD) {
      for (const [node] of textRecords) {
        if (!node.isConnected) textRecords.delete(node);
      }
    }
    if (attributeRecords.size >= RECORDS_PRUNE_THRESHOLD) {
      for (const [element] of attributeRecords) {
        if (!element.isConnected) attributeRecords.delete(element);
      }
    }
    if (bilingualPairs.size >= RECORDS_PRUNE_THRESHOLD) {
      for (const [node, span] of bilingualPairs) {
        if (node.isConnected) continue;
        span.remove();
        bilingualPairs.delete(node);
      }
    }
    // Node chờ cuộn tới nhưng đã bị gỡ khỏi DOM thì không bao giờ intersect —
    // IntersectionObserver giữ chúng sống mãi trong lazyPending.
    for (const [element] of lazyPending) {
      if (element.isConnected) continue;
      lazyObserver?.unobserve(element);
      lazyPending.delete(element);
    }
  }

  function dynamicBudgetAllow(chars) {
    const now = Date.now();
    if (now - dynamicWindowStart > DYNAMIC_WINDOW_MS) {
      dynamicWindowStart = now;
      dynamicWindowChars = 0;
    }
    if (dynamicWindowChars + chars > DYNAMIC_BUDGET_CHARS) return false;
    dynamicWindowChars += chars;
    return true;
  }

  function queueDynamicTranslation(roots) {
    if (isSiteBlacklisted()) return; // NPT-015: site vừa bị chặn → không queue mới.
    // Trang chưa dịch (mặc định của mọi trang) thì không có gì để cập nhật —
    // vẫn nhồi node vào Set là giữ tham chiếu mạnh tới DOM đã bị gỡ, rò rỉ
    // vô hạn trên feed cuộn vô tận.
    if (currentLanguage === 'original') {
      pendingDynamicRoots.clear();
      return;
    }
    // Tắt tự dịch nội dung động (SPA/infinite feed) theo setting.
    if (pageSetting('tm-page-dynamic-translate') === false) return;
    for (const root of roots) pendingDynamicRoots.add(root);
    clearTimeout(mutationTimer);

    mutationTimer = setTimeout(async () => {
      // Bail giữa chừng (user vừa bấm "Gốc") phải dọn hàng đợi, không để lại
      // node mồ côi trong Set cho tới hết đời trang.
      if (currentLanguage === 'original' || !pendingDynamicRoots.size) {
        pendingDynamicRoots.clear();
        return;
      }

      pruneDetachedRecords();
      const rootsToTranslate = [...pendingDynamicRoots];
      pendingDynamicRoots.clear();
      const language = currentLanguage;
      const runGeneration = generation;

      const uniqueTextNodes = new Set();
      const uniqueAttributeTargets = new Map();

      for (const root of rootsToTranslate) {
        const found = collectTargets(root);
        for (const node of found.textNodes) uniqueTextNodes.add(node);
        for (const target of found.attributeTargets) {
          let attributes = uniqueAttributeTargets.get(target.element);
          if (!attributes) {
            attributes = new Set();
            uniqueAttributeTargets.set(target.element, attributes);
          }
          attributes.add(target.attribute);
        }
      }

      const textNodes = [...uniqueTextNodes];
      const attributeTargets = [];
      for (const [element, attributes] of uniqueAttributeTargets) {
        for (const attribute of attributes) attributeTargets.push({ element, attribute });
      }

      for (const node of textNodes) getTextRecord(node);
      for (const { element, attribute } of attributeTargets) getAttributeRecord(element, attribute);

      /* "Dịch lướt theo khung nhìn" trước đây chỉ áp dụng cho lần dịch ĐẦU.
       * Nội dung do infinite scroll / SPA bơm vào sau đó luôn được dịch hết,
       * kể cả phần nằm cách viewport vài màn hình — tức trên đúng loại trang
       * ngốn quota nhất thì tuỳ chọn tiết kiệm quota lại không có tác dụng. */
      let immediateNodes = textNodes;
      let deferredNodes = [];
      if (pageSetting('tm-page-lazy-translate') !== false && textNodes.length) {
        const buckets = splitByViewport(textNodes);
        immediateNodes = buckets.inView;
        deferredNodes = buckets.outView;
      }

      // NPT-010: vượt budget cửa sổ 60s thì dừng dịch động — không bơm request nền.
      const dynamicChars = immediateNodes.reduce((sum, node) => sum + String(node.data || '').length, 0);
      if ((immediateNodes.length || attributeTargets.length) && !dynamicBudgetAllow(dynamicChars)) {
        setStatus('Tạm dừng dịch động — quá nhiều nội dung mới, tự tiếp tục sau ít phút', true);
        return;
      }

      if (immediateNodes.length || attributeTargets.length) {
        await translateTargets(immediateNodes, attributeTargets, language, runGeneration);
        if (runGeneration === generation && language === currentLanguage) {
          setStatus(language === 'vi' ? 'Đã cập nhật phần nội dung mới' : 'New content translated');
        }
      }
      if (deferredNodes.length && runGeneration === generation && language === currentLanguage) {
        observeLazyNodes(deferredNodes, language, runGeneration);
      }
    }, CONFIG.mutationDebounceMs);
  }

  function handleMutations(mutations) {
    /* Trang chưa dịch = trạng thái mặc định của MỌI trang có extension. Bản cũ
     * vẫn dựng record cho từng characterData mutation (Map giữ tham chiếu mạnh
     * tới text node) và chạy discoverAndObserveMutationRoots — tức
     * querySelectorAll('*') — trên từng subtree vừa thêm. Trên feed cuộn vô tận
     * hay app chat, đó là CPU và bộ nhớ đốt liên tục cho việc không ai dùng.
     * Shadow root sinh ra trong lúc này được nhặt lại ở setLanguage. */
    if (currentLanguage === 'original') return;

    const addedRoots = new Set();

    for (const mutation of mutations) {
      if (isToolbarNode(mutation.target)) continue;

      if (mutation.type === 'characterData') {
        const node = mutation.target;
        // Text trong vùng data-tm-no-translate (toolbar, span song ngữ) → bỏ qua,
        // tránh tạo record rác / tự dịch chính bản dịch (loop).
        const parentElement = node.parentElement;
        if (parentElement && parentElement.closest('[data-tm-no-translate]')) continue;

        const expected = expectedTextChanges.get(node);

        if (expected === node.data) {
          expectedTextChanges.delete(node);
          continue;
        }

        const record = getTextRecord(node);
        record.original = node.data;
        record.vi = null;
        record.en = null;
        if (currentLanguage !== 'original' && isUsefulText(node.data)) addedRoots.add(node);
        continue;
      }

      if (mutation.type === 'attributes') {
        const element = mutation.target;
        const attribute = mutation.attributeName;
        const expectedMap = expectedAttributeChanges.get(element);
        const expected = expectedMap?.get(attribute);
        const currentValue = element.getAttribute(attribute) ?? '';

        if (expected === currentValue) {
          expectedMap.delete(attribute);
          if (!expectedMap.size) expectedAttributeChanges.delete(element);
          continue;
        }

        const record = getAttributeRecord(element, attribute);
        record.original = currentValue;
        record.vi = null;
        record.en = null;
        if (currentLanguage !== 'original' && isUsefulText(currentValue)) addedRoots.add(element);
        continue;
      }

      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (!isToolbarNode(node)) {
            addedRoots.add(node);
            discoverAndObserveMutationRoots(node);
          }
        }
      }
    }

    if (addedRoots.size) queueDynamicTranslation([...addedRoots]);
  }

  /* ===================== ICON NỔI (FAB) LIQUID GLASS =====================
   * - Click trái: bật/tắt dịch nhanh (bản gốc ↔ ngôn ngữ gần nhất, mặc định VI).
   * - Chuột phải: mở menu VI/EN/Gốc + trạng thái.
   * - Kéo thả: di chuyển tự do; vị trí lưu storage 'tm-fab-position'.
   * Menu/panel dùng chung recipe "liquid glass": nền trắng mờ + blur mạnh,
   * viền sáng, highlight bóng trên, chữ tối — nổi trên cả nền sáng lẫn tối. */
  const FAB_POSITION_KEY = 'tm-fab-position';

  function createToolbar() {
    toolbarHost = document.createElement('div');
    toolbarHost.id = 'tm-page-translator-host';
    toolbarHost.dataset.tmNoTranslate = 'true';
    document.documentElement.appendChild(toolbarHost);

    const shadow = toolbarHost.attachShadow({ mode: 'closed' });
    const wrapper = document.createElement('div');
    wrapper.className = 'stage';
    wrapper.innerHTML = `
      <button type="button" class="fab" title="Nhấp: dịch / tắt dịch · Chuột phải: menu · Kéo: di chuyển">${NPT_PANEL_ICONS.globe}<span class="fab-lang"></span></button>
      <div class="menu" hidden>
        <div class="buttons">
          <button type="button" data-language="vi" title="Dịch sang tiếng Việt">VI</button>
          <button type="button" data-language="en" title="Translate to English">EN</button>
          <button type="button" data-language="original" title="Khôi phục bản gốc">${NPT_PANEL_ICONS.undo}Gốc</button>
        </div>
        <div class="foot">
          <span class="brand-dot" aria-hidden="true"></span>
          <div class="status" aria-live="polite">Sẵn sàng</div>
        </div>
        <div class="hint">Nhấp icon: dịch / tắt dịch · Chuột phải: menu này · Kéo: di chuyển</div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483647;
        font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      }
      .stage { position: relative; }
      .fab {
        all: unset;
        box-sizing: border-box;
        width: 40px;
        height: 40px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        cursor: grab;
        border-radius: 14px;
        border: 1px solid rgba(var(--npt-surface),.6);
        background: linear-gradient(150deg, rgba(var(--npt-surface),.55), rgba(var(--npt-surface),.16));
        box-shadow: 0 8px 24px rgba(15,17,23,.18), inset 0 1px 0 rgba(var(--npt-surface),.9), inset 0 -8px 14px rgba(var(--npt-surface),.14);
        backdrop-filter: blur(20px) saturate(1.7) brightness(1.1);
        color: rgb(var(--npt-ink));
        touch-action: none;
        user-select: none;
        transition: transform .18s cubic-bezier(.34,1.45,.64,1), box-shadow .22s cubic-bezier(.32,.72,0,1);
      }
      .fab:hover {
        transform: scale(1.07);
        box-shadow: 0 12px 30px rgba(15,17,23,.22), inset 0 1px 0 rgba(var(--npt-surface),.95), inset 0 -8px 14px rgba(var(--npt-surface),.16);
      }
      .fab.dragging { cursor: grabbing; transform: scale(.97); transition: none; }
      .fab[data-active="true"] {
        box-shadow: 0 8px 24px rgba(15,17,23,.2), inset 0 1px 0 rgba(var(--npt-surface),.95), 0 0 0 2.5px rgba(var(--npt-surface),.4);
      }
      .fab svg { width: 16px; height: 16px; }
      .fab-lang {
        min-height: 9px;
        color: rgba(var(--npt-ink),.78);
        font: 800 8.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        letter-spacing: .07em;
      }
      .menu {
        position: absolute;
        right: 0;
        bottom: calc(100% + 10px);
        width: 202px;
        padding: 8px;
        border-radius: 18px;
        border: 1px solid rgba(var(--npt-surface),.6);
        background: linear-gradient(160deg, rgba(var(--npt-surface),.66), rgba(var(--npt-surface-2),.4));
        box-shadow: 0 18px 44px rgba(15,17,23,.24), inset 0 1px 0 rgba(var(--npt-surface),.95), inset 0 -10px 18px rgba(var(--npt-surface),.12);
        backdrop-filter: blur(24px) saturate(1.8) brightness(1.1);
        color: rgb(var(--npt-ink));
        transform-origin: bottom right;
        animation: npt-menu-in .26s cubic-bezier(.34,1.45,.64,1);
      }
      .menu[hidden] { display: none; }
      .stage[data-menu-side="below"] .menu { top: calc(100% + 10px); bottom: auto; transform-origin: top right; }
      .stage[data-menu-h="left"] .menu { left: 0; right: auto; transform-origin: bottom left; }
      .stage[data-menu-side="below"][data-menu-h="left"] .menu { transform-origin: top left; }
      @keyframes npt-menu-in {
        from { opacity: 0; transform: scale(.86) translateY(6px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .buttons {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 3px;
        padding: 3px;
        border: 1px solid rgba(var(--npt-surface),.55);
        border-radius: 12px;
        background: rgba(var(--npt-surface),.4);
      }
      .menu button {
        all: unset;
        box-sizing: border-box;
        cursor: pointer;
        text-align: center;
        padding: 6px 4px;
        border-radius: 9px;
        background: transparent;
        color: rgba(var(--npt-ink),.72);
        font: 650 11.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        letter-spacing: .02em;
        transition: background .18s cubic-bezier(.32,.72,0,1), color .18s, transform .14s cubic-bezier(.32,.72,0,1);
      }
      .menu button:hover { background: rgba(var(--npt-surface),.55); color: rgb(var(--npt-ink)); }
      .menu button:active { transform: scale(.95); }
      .menu button[data-active="true"] {
        background: rgb(var(--npt-ink));
        color: rgb(var(--npt-surface));
        box-shadow: 0 3px 10px rgba(15,17,23,.3);
      }
      .menu button[data-language="original"] svg { margin-right: 4px; vertical-align: -2px; }
      .foot { display: flex; align-items: center; gap: 6px; margin-top: 7px; padding: 0 2px; }
      .brand-dot {
        width: 5px;
        height: 5px;
        flex: none;
        border-radius: 50%;
        background: rgb(var(--npt-ink));
        opacity: .5;
      }
      .status {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        color: rgba(var(--npt-ink),.58);
        font: 500 10.5px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status[data-error="true"] { color: #b3402f; }
      .hint {
        margin-top: 6px;
        padding: 0 2px;
        color: rgba(var(--npt-ink),.4);
        font: 500 9.5px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      }
    `;

    shadow.append(style, wrapper);
    applySharedShadowStyle(shadow);
    fabElement = wrapper.querySelector('.fab');
    fabLangElement = wrapper.querySelector('.fab-lang');
    fabMenu = wrapper.querySelector('.menu');
    statusElement = wrapper.querySelector('.status');

    /* ----- Vị trí fab: mặc định góc phải-dưới, lưu storage khi user kéo ----- */
    function clampFabPos(x, y) {
      const size = fabElement?.offsetWidth || 40;
      return {
        x: Math.max(8, Math.min(x, innerWidth - size - 8)),
        y: Math.max(8, Math.min(y, innerHeight - size - 8)),
      };
    }

    function loadFabPos() {
      const saved = GM_getValue(FAB_POSITION_KEY, null);
      const x = Number(saved?.x);
      const y = Number(saved?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) return clampFabPos(x, y);
      return { x: innerWidth - 54, y: innerHeight - 54 };
    }

    let fabPos = loadFabPos();

    // fixed bị bẻ khi html/body có transform/filter/perspective → absolute + bù scroll.
    function renderFab() {
      const useAbsolute = hasTransformedRoot();
      toolbarHost.style.position = useAbsolute ? 'absolute' : 'fixed';
      toolbarHost.style.left = `${Math.round(fabPos.x + (useAbsolute ? window.scrollX : 0))}px`;
      toolbarHost.style.top = `${Math.round(fabPos.y + (useAbsolute ? window.scrollY : 0))}px`;
    }

    renderFab();
    window.addEventListener('resize', () => {
      fabPos = clampFabPos(fabPos.x, fabPos.y);
      renderFab();
    }, { passive: true });

    /* ----- Menu chuột phải ----- */
    const isMenuOpen = () => Boolean(fabMenu && !fabMenu.hidden);

    function setMenuOpen(open) {
      if (!fabMenu) return;
      if (open) {
        // Lật hướng menu theo vị trí fab: gần nóc → xổ xuống; sát trái → xổ sang phải.
        wrapper.dataset.menuSide = fabPos.y < 210 ? 'below' : 'above';
        wrapper.dataset.menuH = fabPos.x > innerWidth - 240 ? 'right' : 'left';
        fabMenu.hidden = false;
      } else {
        fabMenu.hidden = true;
      }
    }

    fabElement.addEventListener('contextmenu', event => {
      event.preventDefault();
      setMenuOpen(!isMenuOpen());
    });

    document.addEventListener('mousedown', event => {
      if (!isMenuOpen()) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (!path.includes(toolbarHost)) setMenuOpen(false);
    }, true);

    /* ----- Click trái: bật/tắt dịch nhanh ----- */
    function toggleQuickTranslate() {
      const saved = GM_getValue(`${CONFIG.storageKey}:${location.hostname}`, 'vi');
      const target = ['vi', 'en'].includes(saved) ? saved : 'vi';
      const next = currentLanguage === 'original' ? target : 'original';
      setLanguage(next);
      chrome.runtime.sendMessage({ type: 'broadcastPageLanguage', language: next }).catch(() => {});
    }

    /* ----- Kéo thả (ngưỡng 6px để phân biệt click vs kéo) ----- */
    let dragState = null;

    fabElement.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragState = { startX: event.clientX, startY: event.clientY, baseX: fabPos.x, baseY: fabPos.y, moved: false };
      try { fabElement.setPointerCapture(event.pointerId); } catch (_) { /* noop */ }
    });

    fabElement.addEventListener('pointermove', event => {
      if (!dragState) return;
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < 6) return;
      if (!dragState.moved) {
        dragState.moved = true;
        fabElement.classList.add('dragging');
        setMenuOpen(false);
      }
      fabPos = clampFabPos(dragState.baseX + dx, dragState.baseY + dy);
      renderFab();
    });

    const endDrag = event => {
      if (!dragState) return;
      const moved = dragState.moved;
      dragState = null;
      fabElement.classList.remove('dragging');
      if (moved) {
        GM_setValue(FAB_POSITION_KEY, { x: Math.round(fabPos.x), y: Math.round(fabPos.y) });
        return;
      }
      if (event.type === 'pointerup' && event.button === 0 && event.isTrusted) toggleQuickTranslate();
    };
    fabElement.addEventListener('pointerup', endDrag);
    fabElement.addEventListener('pointercancel', endDrag);

    for (const button of wrapper.querySelectorAll('button[data-language]')) {
      const language = button.dataset.language;
      buttons[language] = button;
      button.addEventListener('click', () => {
        setLanguage(language);
        chrome.runtime.sendMessage({ type: 'broadcastPageLanguage', language }).catch(() => {});
      });
    }

    updateActiveButton();
  }

  /* ===================== DỊCH ẢNH (OCR qua Gemini vision) =====================
   * Background gửi: imageTranslateStart {srcUrl} và
   * imageTranslateResult {srcUrl, ok, lines:[{original,translated}] | error}.
   * Panel shadow DOM neo cạnh <img> khớp srcUrl; không thấy ảnh thì hiện góc
   * phải-dưới màn hình. Message mới (kể cả ảnh khác) thay toàn bộ nội dung. */

  let imageHost = null;
  let imageRoot = null;
  let imagePanel = null;
  let imageBody = null;
  let imageCopyButton = null;
  let imageOverlayToggle = null;
  let imageLines = [];
  let imageErrorTimer = null;
  let imageCopyTimer = null;

  function findImageBySource(srcUrl) {
    if (!srcUrl) return null;
    for (const img of document.images) {
      // currentSrc/src luôn là URL tuyệt đối, khớp srcUrl từ contextMenus.
      if (img.currentSrc === srcUrl || img.src === srcUrl) return img;
    }
    return null;
  }

  /* ---------- Lớp dịch đè lên ảnh (canvas, vẽ từ base64 nên không dính taint) ----------
   * Mỗi dòng OCR có box [ymin,xmin,ymax,xmax] chuẩn hóa 0-1000:
   *   1. Lấy màu nền từ viền quanh box + màu chữ gốc trong box (trước khi tô).
   *   2. Làm mờ vùng chữ gốc (giảm "bóng ma"), phủ màu nền alpha cao.
   *   3. Vẽ chữ dịch: cỡ co theo chiều cao box (chữ nhỏ→nhỏ, lớn→lớn), wrap tối đa 3 dòng.
   * Overlay position:absolute bám theo rect của <img> (cập nhật khi scroll/resize),
   * pointer-events:none để không chắn context menu chuột phải của trang. */
  const OVERLAY_MAX_SIDE = 2048;
  let overlayHost = null;
  let overlayCanvas = null;
  let overlayCtx = null;
  let overlayData = null; // { srcUrl, lines, img, scale }
  let overlayDrawn = true;

  function removeImageOverlay() {
    overlayHost?.remove();
    overlayHost = null;
    overlayCanvas = null;
    overlayCtx = null;
    overlayData = null;
  }

  function loadImageElement(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  // Màu nền: trung bình các điểm mẫu trên dải viền quanh box (cách mép ~3px).
  function sampleBackground(ctx, x, y, w, h) {
    const cw = overlayCanvas.width;
    const ch = overlayCanvas.height;
    const d = 3;
    const step = 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const sample = (px, py) => {
      if (px < 0 || py < 0 || px >= cw || py >= ch) return;
      const data = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
      r += data[0]; g += data[1]; b += data[2]; n++;
    };
    for (let px = x; px < x + w; px += step) { sample(px, y - d); sample(px, y + h + d); }
    for (let py = y; py < y + h; py += step) { sample(x - d, py); sample(x + w + d, py); }
    if (!n) return { r: 255, g: 255, b: 255 };
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  // Màu chữ: trung bình các pixel trong box TƯƠNG PHẢN với màu nền (gọi TRƯỚC khi tô).
  function estimateTextColor(ctx, x, y, w, h, bg) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const data = ctx.getImageData(x, y, w, h).data;
    for (let i = 0; i < data.length; i += 8) {
      const dr = data[i] - bg.r;
      const dg = data[i + 1] - bg.g;
      const db = data[i + 2] - bg.b;
      if (dr * dr + dg * dg + db * db > 3600) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    if (!n) {
      const lum = (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255;
      return lum > 0.55 ? 'rgb(var(--npt-ink))' : 'rgb(var(--npt-surface))';
    }
    return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  }

  // Làm mờ vùng chữ gốc qua canvas phụ (blur 4px) để giảm bóng ma chữ cũ.
  function softenRegion(ctx, x, y, w, h) {
    const tmp = document.createElement('canvas');
    tmp.width = w + 8;
    tmp.height = h + 8;
    tmp.getContext('2d').drawImage(ctx.canvas, x - 4, y - 4, w + 8, h + 8, 0, 0, w + 8, h + 8);
    ctx.save();
    if ('filter' in ctx) ctx.filter = 'blur(4px)';
    ctx.drawImage(tmp, 4, 4, w, h, x, y, w, h);
    ctx.restore();
  }

  function wrapOverlayText(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (words.length <= 1) return [text];
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxW || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines.length > 3 ? [text] : lines;
  }

  // Chữ dịch: bắt đầu từ cỡ ~72% chiều cao box, giảm dần tới khi vừa khung.
  function drawFittedText(ctx, text, x, y, w, h, color) {
    const maxW = w * 0.94;
    const fontOf = size => `600 ${size}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
    let size = Math.max(6, Math.round(h * 0.72));
    let lines = [text];
    for (;;) {
      ctx.font = fontOf(size);
      const candidate = wrapOverlayText(ctx, text, maxW);
      const fitsWidth = candidate.length === 1 ? ctx.measureText(candidate[0]).width <= maxW : true;
      const fitsHeight = candidate.length * size * 1.16 <= h * 0.92;
      if (fitsWidth && fitsHeight) {
        lines = candidate;
        break;
      }
      if (size <= 6) break; // bó tay: vẽ 1 dòng cỡ tối thiểu, chấp nhận tràn nhẹ.
      size -= 1;
    }
    ctx.font = fontOf(size);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lineH = size * 1.16;
    const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((ln, index) => ctx.fillText(ln, x + w / 2, startY + index * lineH));
  }

  function paintOverlayLine(ctx, line) {
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    let x = (line.box[1] / 1000) * w;
    let y = (line.box[0] / 1000) * h;
    let bw = ((line.box[3] - line.box[1]) / 1000) * w;
    let bh = ((line.box[2] - line.box[0]) / 1000) * h;
    // Padding nhẹ để phủ kín mép chữ gốc.
    const padX = Math.max(2, bw * 0.06);
    const padY = Math.max(1, bh * 0.18);
    x = Math.max(0, x - padX);
    y = Math.max(0, y - padY);
    bw = Math.min(w - x, bw + padX * 2);
    bh = Math.min(h - y, bh + padY * 2);
    if (bw < 6 || bh < 5) return;

    const bg = sampleBackground(ctx, x, y, bw, bh);
    const fg = estimateTextColor(ctx, x, y, bw, bh, bg);
    softenRegion(ctx, x, y, bw, bh);
    ctx.fillStyle = `rgba(${bg.r},${bg.g},${bg.b},0.88)`;
    roundRectPath(ctx, x, y, bw, bh, Math.min(6, bh * 0.25));
    ctx.fill();
    drawFittedText(ctx, line.translated, x, y, bw, bh, fg);
  }

  function drawImageOverlay() {
    if (!overlayCtx || !overlayData) return;
    const { img, lines } = overlayData;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.drawImage(img, 0, 0, overlayCanvas.width, overlayCanvas.height);
    if (overlayDrawn) {
      for (const line of lines) paintOverlayLine(overlayCtx, line);
    }
  }

  // Overlay absolute bám rect của <img> (gọi lại khi scroll/resize).
  function positionImageOverlay() {
    if (!overlayHost || !overlayData) return;
    const target = findImageBySource(overlayData.srcUrl);
    if (!target) {
      overlayHost.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    overlayHost.style.display = 'block';
    overlayHost.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    overlayHost.style.top = `${Math.round(rect.top + window.scrollY)}px`;
    overlayHost.style.width = `${Math.round(rect.width)}px`;
    overlayHost.style.height = `${Math.round(rect.height)}px`;
  }

  window.addEventListener('scroll', () => { if (overlayHost) positionImageOverlay(); }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (overlayHost) positionImageOverlay(); }, { passive: true });

  async function renderImageOverlay(srcUrl, lines, mimeType, imageBase64) {
    removeImageOverlay();
    const target = findImageBySource(srcUrl);
    const drawable = Array.isArray(lines) ? lines.filter(line => line?.box && line.translated) : [];
    if (!target || !drawable.length || !imageBase64) return 0;

    const img = await loadImageElement(`data:${mimeType || 'image/png'};base64,${imageBase64}`);
    if (!img?.naturalWidth) return 0;

    // Cap độ phân giải canvas chống phình bộ nhớ; box theo tỷ lệ 0-1000 nên tự khớp.
    const scale = Math.min(1, OVERLAY_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));

    overlayHost = document.createElement('div');
    overlayHost.id = 'tm-image-overlay-host';
    overlayHost.dataset.tmNoTranslate = 'true';
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    overlayCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    overlayHost.appendChild(overlayCanvas);
    Object.assign(overlayHost.style, {
      position: 'absolute',
      zIndex: '2147483646',
      pointerEvents: 'none', // không chắn chuột phải/context menu của trang.
    });
    Object.assign(overlayCanvas.style, { width: '100%', height: '100%', display: 'block' });
    document.documentElement.appendChild(overlayHost);

    overlayCtx = overlayCanvas.getContext('2d');
    overlayData = { srcUrl, lines: drawable, img, scale };
    overlayDrawn = true;
    drawImageOverlay();
    positionImageOverlay();
    return drawable.length;
  }

  function createImageTranslatePanel() {
    if (imageHost) {
      // Trang tự dọn DOM lạ thì gắn lại host đã tạo.
      if (!imageHost.isConnected) document.documentElement.appendChild(imageHost);
      return;
    }

    imageHost = document.createElement('div');
    imageHost.id = 'tm-image-translate-host';
    imageHost.dataset.tmNoTranslate = 'true';
    document.documentElement.appendChild(imageHost);

    imageRoot = imageHost.attachShadow({ mode: 'closed' });
    imageRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        /* Liquid glass: nền trắng mờ + blur mạnh + highlight bóng trên, chữ tối. */
        .panel {
          position: fixed;
          left: 0;
          top: 0;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          min-width: 220px;
          max-width: 360px;
          max-height: 70vh;
          padding: 10px 11px 11px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 16px;
          background: linear-gradient(160deg, rgba(var(--npt-surface),.7), rgba(var(--npt-surface-2),.46));
          box-shadow: 0 18px 44px rgba(15,17,23,.24), inset 0 1px 0 rgba(var(--npt-surface),.95), inset 0 -10px 18px rgba(var(--npt-surface),.12);
          color: rgb(var(--npt-ink));
          backdrop-filter: blur(24px) saturate(1.8) brightness(1.1);
          opacity: 0;
          visibility: hidden;
          transform: translateY(4px) scale(.97);
          transition: opacity .22s cubic-bezier(.34,1.3,.64,1), transform .22s cubic-bezier(.34,1.3,.64,1), visibility .22s;
          pointer-events: auto;
        }
        .panel.visible { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
        .title {
          flex: 1;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          letter-spacing: .04em;
          color: rgba(var(--npt-ink),.8);
          font: 720 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .title svg { flex: none; color: rgba(var(--npt-ink),.55); }
        button {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 8px;
          border: 1px solid rgba(15,17,23,.08);
          background: rgba(var(--npt-surface),.4);
          color: rgba(var(--npt-ink),.8);
          font: 620 11px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .18s cubic-bezier(.32,.72,0,1);
        }
        button:hover { background: rgba(var(--npt-surface),.65); }
        button[hidden] { display: none; }
        .close { padding: 4px 6px; color: rgba(var(--npt-ink),.5); }
        .body { overflow-y: auto; overscroll-behavior: contain; }
        .loading {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 2px;
          color: rgba(var(--npt-ink),.7);
          font: 560 12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .spinner {
          width: 13px;
          height: 13px;
          flex: none;
          border: 2px solid rgba(15,17,23,.14);
          border-top-color: rgba(var(--npt-ink),.75);
          border-radius: 50%;
          animation: npt-image-spin .8s linear infinite;
        }
        @keyframes npt-image-spin { to { transform: rotate(360deg); } }
        .line { padding: 5px 0; border-top: 1px solid rgba(15,17,23,.07); }
        .line:first-child { border-top: 0; padding-top: 0; }
        .original {
          color: rgba(var(--npt-ink),.48);
          font: 500 11px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .translated {
          margin-top: 1px;
          color: rgba(var(--npt-ink),.94);
          font: 620 13px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .empty, .error {
          padding: 6px 2px;
          font: 560 12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .empty { color: rgba(var(--npt-ink),.55); }
        .error { color: #b3402f; }
      </style>
      <div class="panel" data-tm-no-translate>
        <div class="head" title="Kéo để di chuyển">
          <span class="title">${NPT_PANEL_ICONS.image}Dịch ảnh</span>
          <button type="button" class="overlay-toggle" hidden>Ẩn chữ đè</button>
          <button type="button" class="copy" hidden>Sao chép</button>
          <button type="button" class="close" title="Đóng">✕</button>
        </div>
        <div class="body"></div>
      </div>
    `;
    applySharedShadowStyle(imageRoot);

    imagePanel = imageRoot.querySelector('.panel');
    imageBody = imageRoot.querySelector('.body');
    imageCopyButton = imageRoot.querySelector('.copy');
    imageOverlayToggle = imageRoot.querySelector('.overlay-toggle');
    imageRoot.querySelector('.close').addEventListener('click', hideImageTranslatePanel);
    imageCopyButton.addEventListener('click', copyImageTranslations);

    // Bật/tắt lớp chữ dịch đè trên ảnh (ảnh gốc nguyên vẹn bên dưới).
    imageOverlayToggle.addEventListener('click', () => {
      overlayDrawn = !overlayDrawn;
      drawImageOverlay();
      imageOverlayToggle.textContent = overlayDrawn ? 'Ẩn chữ đè' : 'Hiện chữ đè';
    });

    // Kéo panel theo thanh tiêu đề (giống kéo cửa sổ).
    const head = imageRoot.querySelector('.head');
    head.style.cursor = 'move';
    head.style.touchAction = 'none';
    let panelDrag = null;
    head.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      panelDrag = {
        startX: event.clientX,
        startY: event.clientY,
        baseLeft: parseFloat(imagePanel.style.left) || 0,
        baseTop: parseFloat(imagePanel.style.top) || 0,
      };
      try { head.setPointerCapture(event.pointerId); } catch (_) { /* noop */ }
    });
    head.addEventListener('pointermove', event => {
      if (!panelDrag) return;
      const left = panelDrag.baseLeft + event.clientX - panelDrag.startX;
      const top = panelDrag.baseTop + event.clientY - panelDrag.startY;
      const maxLeft = innerWidth - (imagePanel.offsetWidth || 300) - 8;
      const maxTop = innerHeight - (imagePanel.offsetHeight || 140) - 8;
      imagePanel.style.left = `${Math.round(Math.max(8, Math.min(left, maxLeft)))}px`;
      imagePanel.style.top = `${Math.round(Math.max(8, Math.min(top, maxTop)))}px`;
    });
    const endPanelDrag = () => { panelDrag = null; };
    head.addEventListener('pointerup', endPanelDrag);
    head.addEventListener('pointercancel', endPanelDrag);
  }

  // Neo panel dưới-phải ảnh (canh phải theo mép ảnh); không có ảnh → góc phải-dưới.
  function positionImagePanel(srcUrl) {
    const panelWidth = imagePanel.offsetWidth || 300;
    const panelHeight = imagePanel.offsetHeight || 140;
    const image = findImageBySource(srcUrl);

    let left;
    let top;
    if (image) {
      const rect = image.getBoundingClientRect();
      left = rect.right - panelWidth;
      top = rect.bottom + 8;
    } else {
      left = innerWidth - panelWidth - 8;
      top = innerHeight - panelHeight - 8;
    }

    // Clamp trong viewport, margin 8px.
    left = Math.max(8, Math.min(left, innerWidth - panelWidth - 8));
    top = Math.max(8, Math.min(top, innerHeight - panelHeight - 8));
    imagePanel.style.left = `${Math.round(left)}px`;
    imagePanel.style.top = `${Math.round(top)}px`;
  }

  function showImageTranslateLoading(srcUrl) {
    createImageTranslatePanel();
    clearTimeout(imageErrorTimer);
    imageLines = [];
    imageCopyButton.hidden = true;
    imageOverlayToggle.hidden = true;
    removeImageOverlay(); // dịch ảnh mới → dọn overlay của ảnh trước

    const loading = document.createElement('div');
    loading.className = 'loading';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    loading.append(spinner, document.createTextNode('Đang đọc ảnh bằng Gemini…'));
    imageBody.replaceChildren(loading);

    positionImagePanel(srcUrl);
    imagePanel.classList.add('visible');
  }

  function showImageTranslateResult(srcUrl, lines, mimeType, imageBase64) {
    createImageTranslatePanel();
    clearTimeout(imageErrorTimer);
    imageLines = Array.isArray(lines) ? lines : [];
    imageCopyButton.hidden = !imageLines.length;
    imageOverlayToggle.hidden = true; // chỉ hiện khi vẽ đè lên ảnh thành công

    if (imageLines.length) {
      const fragment = document.createDocumentFragment();
      for (const line of imageLines) {
        const item = document.createElement('div');
        item.className = 'line';
        const original = document.createElement('div');
        original.className = 'original';
        original.textContent = line?.original || '';
        const translated = document.createElement('div');
        translated.className = 'translated';
        translated.textContent = line?.translated || '';
        item.append(original, translated);
        fragment.appendChild(item);
      }
      imageBody.replaceChildren(fragment);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Không thấy chữ trong ảnh';
      imageBody.replaceChildren(empty);
    }

    positionImagePanel(srcUrl);
    imagePanel.classList.add('visible');

    // Vẽ bản dịch đè lên ảnh gốc (dòng nào thiếu box thì chỉ hiện ở danh sách text).
    renderImageOverlay(srcUrl, imageLines, mimeType, imageBase64).then(count => {
      if (count && imageOverlayToggle) {
        overlayDrawn = true;
        imageOverlayToggle.textContent = 'Ẩn chữ đè';
        imageOverlayToggle.hidden = false;
      }
    }).catch(() => {});
  }

  function showImageTranslateError(srcUrl, error) {
    createImageTranslatePanel();
    imageLines = [];
    imageCopyButton.hidden = true;
    imageOverlayToggle.hidden = true;
    removeImageOverlay();

    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = error || 'Dịch ảnh thất bại';
    imageBody.replaceChildren(box);

    positionImagePanel(srcUrl);
    imagePanel.classList.add('visible');

    // Lỗi tự ẩn sau 6s.
    clearTimeout(imageErrorTimer);
    imageErrorTimer = setTimeout(hideImageTranslatePanel, 6000);
  }

  function hideImageTranslatePanel() {
    clearTimeout(imageErrorTimer);
    imagePanel?.classList.remove('visible');
    removeImageOverlay(); // đóng panel = dọn luôn lớp chữ đè trên ảnh
  }

  function copyImageTranslations() {
    const text = imageLines.map(line => line?.translated || '').filter(Boolean).join('\n');
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      imageCopyButton.textContent = 'Đã chép';
      clearTimeout(imageCopyTimer);
      imageCopyTimer = setTimeout(() => {
        if (imageCopyButton) imageCopyButton.textContent = 'Sao chép';
      }, 1500);
    }).catch(() => {
      // Clipboard bị chặn (mất focus / không có quyền) — bỏ qua.
    });
  }

  // Đóng panel khi click ra ngoài (composedPath xuyên qua shadow DOM).
  document.addEventListener('mousedown', event => {
    if (!imagePanel?.classList.contains('visible')) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!path.includes(imageHost)) hideImageTranslatePanel();
  }, true);

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'imageTranslateStart') {
      showImageTranslateLoading(message.srcUrl);
      return false;
    }
    if (message?.type === 'imageTranslateResult') {
      if (message.ok) showImageTranslateResult(message.srcUrl, message.lines, message.mimeType, message.imageBase64);
      else showImageTranslateError(message.srcUrl, message.error);
      return false;
    }
    return false;
  });

  /* Escape đóng MỌI panel nổi của extension. Trước đây chỉ panel dịch đoạn bôi
   * đen nghe Escape — panel ảnh, panel tóm tắt và menu FAB thì phải bấm đúng
   * nút ✕ bé xíu mới thoát được. */
  function installEscapeToClose() {
    window.addEventListener('keydown', event => {
      if (!event.isTrusted || event.key !== 'Escape') return;
      let closed = false;

      if (fabMenu && !fabMenu.hidden) {
        fabMenu.hidden = true;
        closed = true;
      }
      if (imagePanel && !imagePanel.hidden) {
        hideImageTranslatePanel();
        closed = true;
      }
      if (summaryPanel && !summaryPanel.hidden) {
        hideSummaryUI();
        closed = true;
      }
      if ((selectionButton && !selectionButton.hidden) || (selectionPanel && !selectionPanel.hidden)) {
        hideSelectionUI();
        closed = true;
      }
      // Chỉ nuốt phím khi thực sự đóng cái gì đó — trang vẫn dùng Escape bình thường.
      if (closed) event.stopPropagation();
    }, true);
  }

  /* Alt+V / Alt+E / Alt+O giờ khai báo trong manifest "commands": ngưởi dùng đổi
   * được phím tại chrome://extensions/shortcuts, và phím không còn giành giật
   * với phím tắt của chính trang web. Background bắt lệnh rồi gửi
   * setPageLanguage xuống đây — không cần listener keydown riêng nữa. */

  /* ===================== DỊCH ĐOẠN BÔI ĐEN =====================
   * Bôi đen 2..1000 ký tự (ngoài ô nhập, ngoài UI extension) → nút "Dịch" nổi
   * neo góc dưới-phải vùng chọn; bấm → panel mini: bản dịch + Sao chép + ✕.
   * Setting 'tm-selection-translate' = false → tắt hẳn tính năng. */

  const SELECTION_CONFIG = {
    storageKey: 'tm-selection-translate',
    minChars: 2,
    maxChars: 1000,
    scrollHideDelta: 120,
  };

  let selectionHost = null;
  let selectionButton = null;
  let selectionPanel = null;
  let selectionResult = null;
  let selectionCopyButton = null;
  let selectionSpeakButton = null;
  let selectionText = '';
  let selectionRect = null;
  let selectionScrollY = 0;
  let selectionBusy = false;
  let selectionCopyTimer = null;
  let selectionSpeakTimer = null;
  let selectionTargetLanguage = 'vi';

  // Reset nút 🔊 về trạng thái nghỉ khi TTS đọc xong / bị dừng.
  function pollSelectionSpeakState() {
    clearInterval(selectionSpeakTimer);
    selectionSpeakTimer = setInterval(() => {
      if (globalThis.NPT_TTS?.isSpeaking()) return;
      clearInterval(selectionSpeakTimer);
      if (selectionSpeakButton) selectionSpeakButton.textContent = '🔊';
    }, 400);
  }

  function toggleSelectionSpeak() {
    const tts = globalThis.NPT_TTS;
    if (!tts || !selectionSpeakButton) return;
    if (tts.isSpeaking()) {
      tts.stop();
      selectionSpeakButton.textContent = '🔊';
      return;
    }
    const text = selectionResult?.textContent || '';
    if (!text || selectionResult.dataset.error === 'true') return;
    const rate = Number(GM_getValue('tm-tts-rate', 1)) || 1;
    tts.speak(text, selectionTargetLanguage, rate);
    selectionSpeakButton.textContent = '⏹';
    pollSelectionSpeakState();
  }

  function ensureSelectionUI() {
    if (selectionHost) {
      // Trang tự dọn DOM lạ thì gắn lại host đã tạo.
      if (!selectionHost.isConnected) document.documentElement.appendChild(selectionHost);
      return;
    }

    selectionHost = document.createElement('div');
    selectionHost.id = 'tm-selection-translate-host';
    selectionHost.dataset.tmNoTranslate = 'true';
    document.documentElement.appendChild(selectionHost);

    const shadow = selectionHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        [hidden] { display: none !important; }
        /* Liquid glass: nền trắng mờ + blur mạnh + highlight bóng trên, chữ tối. */
        .fab {
          all: unset;
          position: fixed;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          padding: 6px 11px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 11px;
          background: linear-gradient(150deg, rgba(var(--npt-surface),.6), rgba(var(--npt-surface),.24));
          box-shadow: 0 8px 22px rgba(15,17,23,.16), inset 0 1px 0 rgba(var(--npt-surface),.9);
          color: rgb(var(--npt-ink));
          backdrop-filter: blur(20px) saturate(1.7) brightness(1.1);
          font: 650 11.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          letter-spacing: .02em;
          pointer-events: auto;
          transition: transform .16s cubic-bezier(.34,1.45,.64,1), box-shadow .2s cubic-bezier(.32,.72,0,1);
        }
        .fab:hover { transform: scale(1.05); box-shadow: 0 12px 28px rgba(15,17,23,.2), inset 0 1px 0 rgba(var(--npt-surface),.95); }
        .fab:active { transform: scale(.95); }
        .fab[data-busy="true"] { cursor: progress; color: rgba(var(--npt-ink),.5); }
        .panel {
          position: fixed;
          box-sizing: border-box;
          min-width: 180px;
          max-width: 320px;
          max-height: 40vh;
          overflow-y: auto;
          padding: 10px 11px 11px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 15px;
          background: linear-gradient(160deg, rgba(var(--npt-surface),.7), rgba(var(--npt-surface-2),.46));
          box-shadow: 0 18px 44px rgba(15,17,23,.24), inset 0 1px 0 rgba(var(--npt-surface),.95), inset 0 -10px 18px rgba(var(--npt-surface),.12);
          color: rgb(var(--npt-ink));
          backdrop-filter: blur(24px) saturate(1.8) brightness(1.1);
          pointer-events: auto;
        }
        .result {
          white-space: pre-wrap;
          word-break: break-word;
          color: rgba(var(--npt-ink),.9);
          font: 500 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .result[data-error="true"] { color: #b3402f; }
        .actions { display: flex; gap: 6px; margin-top: 8px; }
        .actions button {
          all: unset;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          padding: 5px 9px;
          border-radius: 8px;
          border: 1px solid rgba(15,17,23,.08);
          background: rgba(var(--npt-surface),.4);
          color: rgba(var(--npt-ink),.78);
          font: 620 11px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .18s cubic-bezier(.32,.72,0,1);
        }
        .actions button:hover { background: rgba(var(--npt-surface),.65); }
        .actions .close { margin-left: auto; padding: 5px 7px; color: rgba(var(--npt-ink),.5); }
      </style>
      <button type="button" class="fab" data-tm-no-translate title="Dịch đoạn đã chọn" hidden>${NPT_SELECTION_FAB_LABEL}</button>
      <div class="panel" data-tm-no-translate hidden>
        <div class="result"></div>
        <div class="actions">
          <button type="button" class="speak" title="Đọc bản dịch" hidden>🔊</button>
          <button type="button" class="copy">${NPT_SELECTION_COPY_LABEL}</button>
          <button type="button" class="close" title="Đóng">${NPT_PANEL_ICONS.close}</button>
        </div>
      </div>
    `;
    applySharedShadowStyle(shadow);

    selectionButton = shadow.querySelector('.fab');
    selectionPanel = shadow.querySelector('.panel');
    selectionResult = shadow.querySelector('.result');
    selectionCopyButton = shadow.querySelector('.copy');
    selectionSpeakButton = shadow.querySelector('.speak');

    // Giữ nguyên vùng bôi đen khi bấm vào nút/panel.
    shadow.addEventListener('mousedown', event => event.preventDefault());

    selectionButton.addEventListener('click', event => {
      if (!event.isTrusted) return; // chặn click giả từ JS trang
      translateSelection();
    });
    shadow.querySelector('.close').addEventListener('click', () => hideSelectionUI());
    selectionCopyButton.addEventListener('click', () => copySelectionResult());
    selectionSpeakButton.addEventListener('click', () => toggleSelectionSpeak());
  }

  // Neo element theo góc dưới-phải vùng chọn, clamp trong viewport 8px.
  function placeSelectionElement(element, width, height) {
    if (!selectionRect) return;
    // html/body có transform/filter/perspective làm fixed bị lệch → absolute + trừ scroll.
    const useAbsolute = hasTransformedRoot();
    const offsetX = useAbsolute ? window.scrollX : 0;
    const offsetY = useAbsolute ? window.scrollY : 0;

    let left = selectionRect.right + 6;
    let top = selectionRect.bottom + 6;
    left = Math.max(8, Math.min(left, innerWidth - width - 8));
    top = Math.max(8, Math.min(top, innerHeight - height - 8));

    const mode = useAbsolute ? 'absolute' : 'fixed';
    if (element.style.position !== mode) element.style.position = mode;
    element.style.left = `${Math.round(left + offsetX)}px`;
    element.style.top = `${Math.round(top + offsetY)}px`;
  }

  function hideSelectionUI() {
    /* Hàm này chạy ở MỌI mouseup/keyup có selection rỗng — tức gần như mọi cú
     * click trên trang, trong mọi frame. Không có gì đang hiện thì thoát ngay,
     * đừng chạm tới speechSynthesis.cancel() và clearInterval mỗi lần. */
    if ((!selectionButton || selectionButton.hidden)
      && (!selectionPanel || selectionPanel.hidden)
      && !selectionText && !selectionBusy) {
      return;
    }

    if (selectionButton) {
      selectionButton.hidden = true;
      selectionButton.dataset.busy = 'false';
      selectionButton.innerHTML = NPT_SELECTION_FAB_LABEL;
    }
    if (selectionPanel) selectionPanel.hidden = true;
    if (selectionSpeakButton) selectionSpeakButton.textContent = '🔊';
    clearInterval(selectionSpeakTimer);
    globalThis.NPT_TTS?.stop();
    selectionText = '';
    selectionRect = null;
    selectionBusy = false;
  }

  function updateSelectionFromEvent(event) {
    if (!GM_getValue(SELECTION_CONFIG.storageKey, true)) {
      hideSelectionUI();
      return;
    }

    // Click bên trong UI extension (toolbar/helper/panel ảnh/panel này) → giữ nguyên.
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    if (path.some(node => node instanceof Element && node.dataset?.tmNoTranslate)) return;

    const selection = window.getSelection();
    const text = String(selection?.toString() || '').trim();

    if (!selection || selection.isCollapsed ||
        text.length < SELECTION_CONFIG.minChars ||
        text.length > SELECTION_CONFIG.maxChars) {
      hideSelectionUI();
      return;
    }

    const anchor = selection.anchorNode;
    const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    if (!anchorElement) {
      hideSelectionUI();
      return;
    }

    // Không hiện nút khi bôi đen trong input/textarea/contenteditable.
    if (anchorElement.isContentEditable ||
        anchorElement.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
      hideSelectionUI();
      return;
    }

    // Không hiện nút khi bôi đen trong UI của chính extension.
    if (anchorElement.closest('[data-tm-no-translate]')) {
      hideSelectionUI();
      return;
    }

    let rect;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch (_) {
      hideSelectionUI();
      return;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideSelectionUI();
      return;
    }

    ensureSelectionUI();

    // Chọn vùng khác → ẩn panel kết quả cũ, chỉ hiện nút ở vị trí mới.
    if (text !== selectionText) {
      selectionPanel.hidden = true;
      selectionBusy = false;
      selectionButton.dataset.busy = 'false';
      selectionButton.innerHTML = NPT_SELECTION_FAB_LABEL;
    }

    selectionText = text;
    selectionRect = rect;
    selectionScrollY = window.scrollY;

    if (selectionPanel.hidden) {
      selectionButton.hidden = false;
      placeSelectionElement(selectionButton, selectionButton.offsetWidth || 48, selectionButton.offsetHeight || 26);
    }
  }

  async function translateSelection() {
    const text = selectionText;
    if (!text || selectionBusy) return;

    // Trang đang ở chế độ vi/en thì dịch theo ngôn ngữ đó, ngược lại mặc định VI.
    const target = ['vi', 'en'].includes(currentLanguage) ? currentLanguage : 'vi';
    selectionTargetLanguage = target;

    selectionBusy = true;
    selectionButton.dataset.busy = 'true';
    selectionButton.textContent = '…';

    try {
      const translated = await TRANSLATION_CORE.translate(text, 'auto', target);
      if (text !== selectionText || selectionButton.hidden) return; // vùng chọn đã đổi/đã ẩn
      showSelectionResult(String(translated ?? ''), false);
    } catch (error) {
      if (text !== selectionText || selectionButton.hidden) return;
      showSelectionResult(friendlyError(error), true);
    } finally {
      selectionBusy = false;
      if (selectionButton) {
        selectionButton.dataset.busy = 'false';
        selectionButton.innerHTML = NPT_SELECTION_FAB_LABEL;
      }
    }
  }

  function showSelectionResult(message, isError) {
    ensureSelectionUI();
    selectionResult.textContent = message;
    selectionResult.dataset.error = String(isError);
    selectionCopyButton.hidden = isError;
    // Nút đọc to chỉ hiện khi có kết quả hợp lệ và tm-tts-enabled đang bật.
    selectionSpeakButton.hidden = isError || GM_getValue('tm-tts-enabled', true) === false;
    selectionButton.hidden = true;
    selectionPanel.hidden = false;
    placeSelectionElement(selectionPanel, selectionPanel.offsetWidth || 220, selectionPanel.offsetHeight || 90);
  }

  function copySelectionResult() {
    const text = selectionResult?.textContent || '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      selectionCopyButton.innerHTML = NPT_SELECTION_COPIED_LABEL;
      clearTimeout(selectionCopyTimer);
      selectionCopyTimer = setTimeout(() => {
        selectionCopyButton.innerHTML = NPT_SELECTION_COPY_LABEL;
      }, 1500);
    }).catch(() => {
      // Clipboard bị chặn (mất focus / không có quyền) — bỏ qua.
    });
  }

  function initSelectionTranslator() {
    document.addEventListener('mouseup', updateSelectionFromEvent, true);
    document.addEventListener('keyup', event => {
      if (event.key === 'Escape') {
        hideSelectionUI();
        return;
      }
      updateSelectionFromEvent(event);
    }, true);

    // Click ra ngoài (composedPath xuyên qua shadow DOM) → ẩn nút/panel.
    document.addEventListener('mousedown', event => {
      if (!selectionHost) return;
      if (selectionButton.hidden && selectionPanel.hidden) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(selectionHost)) return;
      hideSelectionUI();
    }, true);

    // Vùng bôi đen bị collapse (click chỗ khác, phím di chuyển…) → ẩn.
    document.addEventListener('selectionchange', () => {
      if (!selectionHost) return;
      const selection = window.getSelection();
      if ((!selection || selection.isCollapsed) && !selectionBusy) hideSelectionUI();
    });

    // Scroll xa khỏi vị trí bôi đen → ẩn.
    window.addEventListener('scroll', () => {
      if (!selectionHost) return;
      if (selectionButton.hidden && selectionPanel.hidden) return;
      if (Math.abs(window.scrollY - selectionScrollY) > SELECTION_CONFIG.scrollHideDelta) {
        hideSelectionUI();
      }
    }, { passive: true, capture: true });
  }

  const observedMutationRoots = new WeakSet();
  const pageMutationObserver = new MutationObserver(handleMutations);

  function observeMutationRoot(root) {
    if (!root || observedMutationRoots.has(root)) return;
    try {
      pageMutationObserver.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRIBUTES,
      });
      observedMutationRoots.add(root);
    } catch (_) {
      // Some browser-owned roots cannot be observed.
    }
  }

  function discoverAndObserveMutationRoots(root) {
    for (const scanRoot of enumerateScanRoots(root)) {
      if (scanRoot === document || scanRoot === document.documentElement || scanRoot instanceof ShadowRoot) {
        observeMutationRoot(scanRoot);
      }
    }
  }

  function startObserver() {
    observeMutationRoot(document.documentElement);
    discoverAndObserveMutationRoots(document.documentElement);
  }

  // Đổi kiểu hiển thị (replace ↔ song ngữ): KHÔNG dịch lại — restore rồi áp lại
  // bản dịch đã cache trong records theo mode mới.
  function rerenderDisplayMode() {
    const language = currentLanguage;
    if (language === 'original') return;

    restoreOriginalContent();
    const activeSig = pageStyleSignature();
    for (const [node, record] of textRecords) {
      if (!node.isConnected) continue;
      if (record[language] && record.sig === activeSig) {
        applyTextTranslation(node, record[language], record.original);
      }
    }
    for (const [element, records] of attributeRecords) {
      if (!element.isConnected) continue;
      for (const [attribute, record] of records) {
        if (record[language]) safelySetAttribute(element, attribute, record[language]);
      }
    }
  }

  // Key thuộc style signature: đổi → dịch lại (sig cũ trong records tự vô hiệu).
  const STYLE_SIGNATURE_KEYS = new Set([
    'tm-page-style',
    'tm-page-dialect',
    'tm-page-translate-mode',
    'tm-page-grammar-fix',
    'tm-page-keep-proper-nouns',
  ]);
  // Key ảnh hưởng cách quét/xử lý: đổi → chạy lại setLanguage.
  const REPROCESS_SETTING_KEYS = new Set([
    'tm-page-skip-code',
    'tm-page-skip-usernames',
    'tm-page-lazy-translate',
    'tm-page-dynamic-translate',
  ]);

  // Debounce gom nhiều key đổi cùng lúc (trang Cài đặt lưu từng key một).
  let settingsChangeTimer = null;
  let pendingDisplayModeRerender = false;
  let pendingFullRetranslate = false;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    // NPT-015: vừa thêm site hiện tại vào blacklist → dừng phiên dịch đang chạy NGAY,
    // không chờ reload; request mới cũng bị queueDynamicTranslation/setLanguage chặn.
    if (Object.hasOwn(changes, 'tm-site-blacklist') && currentLanguage !== 'original' && isSiteBlacklisted()) {
      setLanguage('original').catch(() => {});
      return;
    }
    if (currentLanguage === 'original') return;

    let displayModeChanged = false;
    let retranslate = false;
    for (const key of Object.keys(changes)) {
      if (key === 'tm-page-display-mode') displayModeChanged = true;
      else if (STYLE_SIGNATURE_KEYS.has(key) || REPROCESS_SETTING_KEYS.has(key)) retranslate = true;
    }
    if (!displayModeChanged && !retranslate) return;

    pendingDisplayModeRerender = pendingDisplayModeRerender || displayModeChanged;
    pendingFullRetranslate = pendingFullRetranslate || retranslate;
    clearTimeout(settingsChangeTimer);
    settingsChangeTimer = setTimeout(() => {
      const shouldRetranslate = pendingFullRetranslate;
      const shouldRerender = pendingDisplayModeRerender;
      pendingFullRetranslate = false;
      pendingDisplayModeRerender = false;
      // Dịch lại đã bao gồm áp theo display-mode hiện tại.
      if (shouldRetranslate) {
        setLanguage(currentLanguage).catch(error =>
          console.warn('[Page Translator] Dịch lại theo cài đặt mới lỗi:', error));
      } else if (shouldRerender) rerenderDisplayMode();
    }, 250);
  });

  // Hook SPA: Discord/Reddit/Facebook đổi route không reload trang → debounce ~900ms
  // rồi quét dịch phần nội dung mới. Lưu ý isolated world: popstate luôn bắt được;
  // wrap pushState/replaceState chỉ tác dụng khi page gọi qua cùng history object.
  let spaHookInstalled = false;
  function installSpaNavigationHook() {
    if (spaHookInstalled) return;
    spaHookInstalled = true;

    let spaTimer = null;
    const onNavigate = () => {
      clearTimeout(spaTimer);
      spaTimer = setTimeout(() => {
        if (currentLanguage === 'original') return;
        if (pageSetting('tm-page-dynamic-translate') === false) return;
        queueDynamicTranslation([document.body]);
      }, 900);
    };

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      try {
        history[method] = function (...args) {
          const result = original.apply(this, args);
          onNavigate();
          return result;
        };
      } catch (_) {
        // Trang khoá history → chỉ dựa vào popstate.
      }
    }
    window.addEventListener('popstate', onNavigate);
  }

  function init() {
    if (!document.documentElement) return;
    if (isSiteBlacklisted()) return; // Site bị chặn: không toolbar, không auto-translate.
    if (IS_TOP_FRAME) createToolbar();
    initSelectionTranslator();
    installEscapeToClose();
    startObserver();
    installSpaNavigationHook();

    const savedLanguage = GM_getValue(`${CONFIG.storageKey}:${location.hostname}`, 'original');
    if (['vi', 'en'].includes(savedLanguage)) {
      /* Content script chạy ở document_start nên <body> CHƯA tồn tại. Gọi thẳng
       * setLanguage lúc này thì roots = [document.body] = [null]: không quét
       * được gì, báo "không tìm thấy chữ", rồi cả trang rơi xuống đường dịch
       * động — bỏ qua hoàn toàn lazy viewport nên dịch sạch cả trang dài và
       * tốn quota gấp nhiều lần. Chờ DOM sẵn sàng rồi mới dịch. */
      whenDomReady(() => setLanguage(savedLanguage));
    } else if (IS_TOP_FRAME) {
      setStatus('Sẵn sàng · Alt+V / Alt+E / Alt+O');
    }
  }

  function whenDomReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }
    callback();
  }

  /* ======================= TÓM TẮT TRANG (summarize) =======================
   * Popup gửi trực tiếp {type:'summarizePageStart', language} → content thu
   * thập text, gọi background {type:'summarizePage'} rồi render floating panel
   * (style bám selection panel: shadow DOM + liquid glass). */

  const SUMMARY_CONFIG = {
    minChars: 200,
    maxChars: 8000,
    maxBullets: 8,
  };

  let summaryHost = null;
  let summaryShadow = null;
  let summaryPanel = null;
  let summaryBody = null;
  let summarySpeakButton = null;
  let summaryCopyButton = null;
  let summarySpeakTimer = null;
  let summaryResultText = '';
  let summaryLanguage = 'vi';

  function ensureSummaryUI() {
    if (summaryHost) {
      if (!summaryHost.isConnected) document.documentElement.appendChild(summaryHost);
      return;
    }

    summaryHost = document.createElement('div');
    summaryHost.id = 'tm-summary-host';
    summaryHost.dataset.tmNoTranslate = 'true';
    document.documentElement.appendChild(summaryHost);

    summaryShadow = summaryHost.attachShadow({ mode: 'closed' });
    summaryShadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        [hidden] { display: none !important; }
        .panel {
          position: fixed;
          top: 16px;
          right: 16px;
          box-sizing: border-box;
          width: min(380px, calc(100vw - 32px));
          max-height: 70vh;
          overflow-y: auto;
          padding: 12px 13px 13px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 15px;
          background: linear-gradient(160deg, rgba(var(--npt-surface),.7), rgba(var(--npt-surface-2),.46));
          box-shadow: 0 18px 44px rgba(15,17,23,.24), inset 0 1px 0 rgba(var(--npt-surface),.95), inset 0 -10px 18px rgba(var(--npt-surface),.12);
          color: rgb(var(--npt-ink));
          backdrop-filter: blur(24px) saturate(1.8) brightness(1.1);
          pointer-events: auto;
        }
        .title {
          font: 700 12.5px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          letter-spacing: .02em;
          color: rgba(var(--npt-ink),.85);
          margin-bottom: 8px;
        }
        .body {
          white-space: pre-wrap;
          word-break: break-word;
          color: rgba(var(--npt-ink),.9);
          font: 500 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .body[data-error="true"] { color: #b3402f; }
        .body .bullet { padding-left: 14px; text-indent: -14px; margin: 4px 0; }
        .body .bullet::before { content: "• "; }
        .actions { display: flex; gap: 6px; margin-top: 10px; }
        .actions button {
          all: unset;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          padding: 5px 9px;
          border-radius: 8px;
          border: 1px solid rgba(15,17,23,.08);
          background: rgba(var(--npt-surface),.4);
          color: rgba(var(--npt-ink),.78);
          font: 620 11px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .18s cubic-bezier(.32,.72,0,1);
        }
        .actions button:hover { background: rgba(var(--npt-surface),.65); }
        .actions .close { margin-left: auto; padding: 5px 7px; color: rgba(var(--npt-ink),.5); }
      </style>
      <div class="panel" data-tm-no-translate hidden>
        <div class="title">Tóm tắt trang</div>
        <div class="body"></div>
        <div class="actions">
          <button type="button" class="speak" title="Đọc tóm tắt" hidden>🔊</button>
          <button type="button" class="copy" title="Sao chép tóm tắt" hidden>📋</button>
          <button type="button" class="close" title="Đóng">${NPT_PANEL_ICONS.close}</button>
        </div>
      </div>
    `;
    applySharedShadowStyle(summaryShadow);

    summaryPanel = summaryShadow.querySelector('.panel');
    summaryBody = summaryShadow.querySelector('.body');
    summarySpeakButton = summaryShadow.querySelector('.speak');
    summaryCopyButton = summaryShadow.querySelector('.copy');

    summaryShadow.querySelector('.close').addEventListener('click', () => hideSummaryUI());
    summarySpeakButton.addEventListener('click', () => toggleSummarySpeak());
    summaryCopyButton.addEventListener('click', () => copySummaryResult());
  }

  function hideSummaryUI() {
    if (summaryPanel) summaryPanel.hidden = true;
    if (summarySpeakButton) summarySpeakButton.textContent = '🔊';
    clearInterval(summarySpeakTimer);
    globalThis.NPT_TTS?.stop();
  }

  // Reset nút 🔊 khi đọc xong.
  function pollSummarySpeakState() {
    clearInterval(summarySpeakTimer);
    summarySpeakTimer = setInterval(() => {
      if (globalThis.NPT_TTS?.isSpeaking()) return;
      clearInterval(summarySpeakTimer);
      if (summarySpeakButton) summarySpeakButton.textContent = '🔊';
    }, 400);
  }

  function toggleSummarySpeak() {
    const tts = globalThis.NPT_TTS;
    if (!tts || !summaryResultText) return;
    if (tts.isSpeaking()) {
      tts.stop();
      summarySpeakButton.textContent = '🔊';
      return;
    }
    const rate = Number(GM_getValue('tm-tts-rate', 1)) || 1;
    tts.speak(summaryResultText, summaryLanguage, rate);
    summarySpeakButton.textContent = '⏹';
    pollSummarySpeakState();
  }

  function copySummaryResult() {
    if (!summaryResultText) return;
    navigator.clipboard.writeText(summaryResultText).then(() => {
      summaryCopyButton.textContent = '✓';
      setTimeout(() => {
        if (summaryCopyButton) summaryCopyButton.textContent = '📋';
      }, 1500);
    }).catch(() => {
      // Clipboard bị chặn — bỏ qua.
    });
  }

  function showSummaryLoading() {
    summaryResultText = '';
    summaryBody.dataset.error = 'false';
    summaryBody.textContent = 'Đang tóm tắt…';
    summarySpeakButton.hidden = true;
    summaryCopyButton.hidden = true;
    summaryPanel.hidden = false;
  }

  function showSummaryError(message) {
    summaryResultText = '';
    summaryBody.dataset.error = 'true';
    summaryBody.textContent = message;
    summarySpeakButton.hidden = true;
    summaryCopyButton.hidden = true;
    summaryPanel.hidden = false;
  }

  function renderSummaryResult(text, language) {
    summaryResultText = text;
    summaryLanguage = language;
    summaryBody.dataset.error = 'false';
    summaryBody.textContent = '';
    const bullets = text
      .split(/\r?\n/)
      .map(line => line.replace(/^\s*[-•*]\s+/, '').trim())
      .filter(Boolean);
    for (const bullet of bullets) {
      const item = document.createElement('div');
      item.className = 'bullet';
      item.textContent = bullet;
      summaryBody.appendChild(item);
    }
    if (!bullets.length) summaryBody.textContent = text;
    summarySpeakButton.hidden = GM_getValue('tm-tts-enabled', true) === false;
    summaryCopyButton.hidden = false;
    summaryPanel.hidden = false;
  }

  // Ưu tiên vùng nội dung chính; fallback toàn body. Trim + cap 8000 ký tự.
  function collectPageTextForSummary() {
    const container = document.querySelector('article')
      || document.querySelector('main')
      || document.querySelector('[role="main"]');
    const raw = String(container?.innerText || document.body?.innerText || '').trim();
    return raw.slice(0, SUMMARY_CONFIG.maxChars);
  }

  async function summarizePage(language) {
    const text = collectPageTextForSummary();
    if (text.length < SUMMARY_CONFIG.minChars) {
      showPageToast('Không đủ nội dung để tóm tắt');
      return;
    }

    ensureSummaryUI();
    showSummaryLoading();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'summarizePage',
        payload: { text, targetLanguage: language, maxBullets: SUMMARY_CONFIG.maxBullets },
      });
      if (!response?.ok) throw new Error(response?.error || 'Không tóm tắt được trang này');
      renderSummaryResult(String(response.text || ''), language);
    } catch (error) {
      showSummaryError(friendlyError(error));
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ping') {
      sendResponse({ ok: true, frame: location.href });
      return false;
    }
    if (message?.type === 'setPageLanguage' && ['original', 'vi', 'en'].includes(message.language)) {
      if (!isSiteBlacklisted()) setLanguage(message.language);
      sendResponse({ ok: true });
      return false;
    }
    // Popup gọi trực tiếp (chrome.tabs.sendMessage, không qua background).
    if (message?.type === 'summarizePageStart' && ['vi', 'en'].includes(message.language)) {
      if (IS_TOP_FRAME) summarizePage(message.language);
      sendResponse({ ok: true });
      return false;
    }
    /* Popup hỏi trạng thái THẬT của trang. Trước đây popup tự đoán theo lần bấm
     * gần nhất trong chính phiên popup đó — mở lại popup là mất, và trang tự
     * dịch theo preference đã lưu thì popup vẫn hiện "chưa dịch". */
    if (message?.type === 'getPageState') {
      sendResponse({
        ok: true,
        language: currentLanguage,
        hostname: effectiveHostname(),
        blacklisted: isSiteBlacklisted(),
        busy: translationProgress.busy,
        done: translationProgress.done,
        total: translationProgress.total,
        failed: translationProgress.failed,
        status: statusElement?.textContent || '',
      });
      return false;
    }
    return false;
  });

  init();
})();
/* ========================================================================
 * VIETNAMESE INPUT -> NATIVE ENGLISH
 * Nút ✨ EN xuất hiện cạnh input/textarea/contenteditable đang được focus.
 * - Native English: API riêng qua background (DeepL / Gemini / OpenAI-compatible,
 *   hỗ trợ nhiều key xoay vòng — cấu hình trong trang Cài đặt)
 * - Quick English: Google Translate không chính thức (không cần API key)
 * ====================================================================== */
(() => {
  'use strict';

  function getInputShadowRoot(element) {
    if (!(element instanceof Element)) return null;
    try {
      return element.shadowRoot || chrome.dom?.openOrClosedShadowRoot?.(element) || null;
    } catch (_) {
      return element.shadowRoot || null;
    }
  }

  const INPUT_CONFIG = {
    enabledStorage: 'tm-input-helper-enabled',
    offsetStorage: 'tm-input-helper-offset',
    fallbackQuickStorage: 'tm-native-en-fallback-quick',
    contextStorage: 'tm-native-en-use-context',
    defaultModeStorage: 'tm-native-en-default-mode',
    maxInputChars: 12000,
    maxContextChars: 800,
    repositionDelayMs: 20,
  };

  // Toggle bật/tắt hẳn nút ✨ EN cạnh ô nhập (popup/Cài đặt, mặc định bật).
  function helperEnabled() {
    return GM_getValue(INPUT_CONFIG.enabledStorage, true) !== false;
  }

  // Offset vị trí do user kéo nút ('tm-input-helper-offset' = {dx, dy}).
  function helperOffset() {
    const value = GM_getValue(INPUT_CONFIG.offsetStorage, null);
    const dx = Number(value?.dx);
    const dy = Number(value?.dy);
    return Number.isFinite(dx) && Number.isFinite(dy) ? { dx, dy } : { dx: 0, dy: 0 };
  }

  /* Khối này là IIFE riêng: mọi thứ dùng chung với phần dịch trang đều phải
   * lấy lại qua global (icon + style shadow), không thấy được biến cục bộ. */
  const ICON = globalThis.NPT_ICONS;
  const applySharedShadowStyle = root => globalThis.NPT_SHADOW_STYLE.apply(root);
  const NPT_INPUT_ICONS = {
    spark: ICON.svg('sparkles', { size: 12 }),
    sparkLarge: ICON.svg('sparkles', { size: 13 }),
    chevron: ICON.svg('chevron', { size: 10, strokeWidth: 2 }),
    bolt: ICON.svg('zap', { size: 13 }),
    chat: ICON.svg('book', { size: 13 }),
    gear: ICON.svg('gear', { size: 13 }),
    reset: ICON.svg('revert', { size: 13 }),
  };
  const NPT_MAIN_LABEL = `${NPT_INPUT_ICONS.spark}<span>EN</span>`;

  const UNSUPPORTED_INPUT_TYPES = new Set([
    'password', 'file', 'checkbox', 'radio', 'button', 'submit', 'reset',
    'image', 'color', 'range', 'date', 'datetime-local', 'month', 'time', 'week',
  ]);

  let activeEditable = null;
  let helperHost = null;
  let helperRoot = null;
  let helperPanel = null;
  let menuElement = null;
  let mainButton = null;
  let arrowButton = null;
  let helperStatus = null;
  let busy = false;
  let savedSnapshot = null;
  // Trạng thái kéo nút ✨ EN: đang kéo thì heartbeat không auto reposition,
  // vừa kéo xong thì chặn click ảo lên nút main/arrow.
  let helperDragging = false;
  let helperSuppressClick = false;
  // Cache vị trí đã ghi — chỉ ghi lại style khi trôi > 0.5px (chống jitter từ heartbeat).
  let lastHelperLeft = null;
  let lastHelperTop = null;
  let lastHelperPositionMode = null;

  function isSupportedEditable(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest('[data-tm-no-input-translate]')) return false;

    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }

    if (element instanceof HTMLInputElement) {
      const type = (element.type || 'text').toLowerCase();
      return !UNSUPPORTED_INPUT_TYPES.has(type) && !element.disabled && !element.readOnly;
    }

    const contentEditableAttr = element.getAttribute('contenteditable');
    return element.isContentEditable ||
      (contentEditableAttr !== null && contentEditableAttr !== 'false') ||
      element.getAttribute('role') === 'textbox';
  }

  function findEditable(start) {
    if (!(start instanceof Node)) return null;
    const element = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
    if (!(element instanceof Element)) return null;
    if (isSupportedEditable(element)) return element;

    const candidate = element.closest(
      'textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    );
    return isSupportedEditable(candidate) ? candidate : null;
  }

  function findEditableFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      const editable = findEditable(node);
      if (editable) return editable;
    }
    return findEditable(event.target);
  }

  function getDeepActiveEditable() {
    let active = document.activeElement;
    let safety = 0;

    while (active instanceof Element && safety++ < 16) {
      const root = getInputShadowRoot(active);
      const next = root?.activeElement;
      if (!(next instanceof Element) || next === active) break;
      active = next;
    }

    return findEditable(active);
  }

  function getFieldLabel(element) {
    const pieces = [];
    const aria = element.getAttribute('aria-label');
    const placeholder = element.getAttribute('placeholder');
    const name = element.getAttribute('name');

    if (aria) pieces.push(`aria-label: ${aria}`);
    if (placeholder) pieces.push(`placeholder: ${placeholder}`);
    if (name) pieces.push(`field name: ${name}`);

    if (element.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.innerText?.trim()) pieces.push(`label: ${label.innerText.trim()}`);
      } catch (_) {
        // Bỏ qua ID không hợp lệ với CSS selector.
      }
    }

    const wrappingLabel = element.closest('label');
    if (wrappingLabel?.innerText?.trim()) {
      pieces.push(`label: ${wrappingLabel.innerText.trim().slice(0, 250)}`);
    }

    return [...new Set(pieces)].join('\n');
  }

  function getNearbyContext(element) {
    const useContext = GM_getValue(INPUT_CONFIG.contextStorage, true);
    if (!useContext) return '';

    const container = element.closest(
      'form, [role="dialog"], [role="main"], main, article, section, [class*="composer"], [class*="message"]',
    ) || element.parentElement;

    if (!container) return '';

    let text = String(container.innerText || container.textContent || '').trim();
    const current = getEditablePlainText(element).trim();
    if (current) text = text.replace(current, '').trim();
    if (!text) return '';

    return text.slice(-INPUT_CONFIG.maxContextChars);
  }

  function getEditablePlainText(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value || '';
    }
    return element.innerText ?? element.textContent ?? '';
  }

  function selectionBelongsTo(element, selection) {
    if (!selection?.rangeCount) return false;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(parent && (parent === element || element.contains(parent)));
  }

  function captureSnapshot(element) {
    if (!isSupportedEditable(element)) throw new Error('Ô nhập liệu không còn khả dụng');

    const base = {
      element,
      hostname: location.hostname,
      pageTitle: document.title,
      fieldLabel: getFieldLabel(element),
      nearbyContext: getNearbyContext(element),
    };

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const start = Number.isInteger(element.selectionStart) ? element.selectionStart : 0;
      const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : start;
      const hasSelection = end > start;
      const text = hasSelection ? element.value.slice(start, end) : element.value;

      return {
        ...base,
        kind: 'value',
        hasSelection,
        start,
        end,
        originalValue: element.value,
        text,
      };
    }

    const selection = window.getSelection();
    const hasSelection = Boolean(
      selection && !selection.isCollapsed && selectionBelongsTo(element, selection),
    );
    const range = hasSelection ? selection.getRangeAt(0).cloneRange() : null;
    const text = hasSelection ? selection.toString() : getEditablePlainText(element);

    return {
      ...base,
      kind: 'contenteditable',
      hasSelection,
      range,
      text,
    };
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatchEditableEvents(element, insertedText) {
    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: insertedText,
      }));
    } catch (_) {
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertIntoContentEditable(snapshot, translatedText) {
    const element = snapshot.element;
    element.focus({ preventScroll: true });

    const selection = window.getSelection();
    selection.removeAllRanges();

    let range;
    if (snapshot.hasSelection && snapshot.range) {
      range = snapshot.range;
    } else {
      range = document.createRange();
      range.selectNodeContents(element);
    }
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, translatedText);
    } catch (_) {
      inserted = false;
    }

    if (!inserted) {
      range.deleteContents();
      const node = document.createTextNode(translatedText);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      dispatchEditableEvents(element, translatedText);
    }
  }

  function applyTranslation(snapshot, translatedText) {
    const element = snapshot.element;
    if (!element?.isConnected || !isSupportedEditable(element)) {
      throw new Error('Ô nhập liệu đã bị thay đổi hoặc đóng');
    }

    if (snapshot.kind === 'value') {
      let newValue;
      let cursor;
      const currentValue = element.value;

      if (snapshot.hasSelection) {
        newValue = `${currentValue.slice(0, snapshot.start)}${translatedText}${currentValue.slice(snapshot.end)}`;
        cursor = snapshot.start + translatedText.length;
      } else if (currentValue === snapshot.originalValue) {
        newValue = translatedText;
        cursor = translatedText.length;
      } else if (currentValue.startsWith(snapshot.originalValue)) {
        // User gõ THÊM phía sau trong lúc dịch → dịch phần cũ, giữ nguyên phần mới.
        const suffix = currentValue.slice(snapshot.originalValue.length);
        newValue = translatedText + suffix;
        cursor = newValue.length;
      } else {
        // Sửa/xoá ở giữa → hủy thay vì ghi đè mất chữ user vừa nhập.
        throw new Error('Bạn vừa sửa nội dung trong lúc dịch — đã hủy để không mất chữ');
      }

      setNativeValue(element, newValue);
      element.focus({ preventScroll: true });
      try {
        element.setSelectionRange(cursor, cursor);
      } catch (_) {
        // Một số input type không hỗ trợ selection range.
      }
      dispatchEditableEvents(element, translatedText);
      return;
    }

    // Contenteditable: user có thể đã gõ thêm trong lúc dịch — giữ phần gõ thêm
    // (nối sau bản dịch), sửa ở giữa thì hủy thay vì ghi đè mất chữ.
    let contentToInsert = translatedText;
    if (!snapshot.hasSelection) {
      const currentText = getEditablePlainText(element);
      if (currentText === snapshot.text) {
        // Không đổi: thay toàn bộ bằng bản dịch như cũ.
      } else if (currentText.startsWith(snapshot.text)) {
        contentToInsert = translatedText + currentText.slice(snapshot.text.length);
      } else {
        throw new Error('Bạn vừa sửa nội dung trong lúc dịch — đã hủy để không mất chữ');
      }
    }

    insertIntoContentEditable(snapshot, contentToInsert);
  }

  function googleTranslateToEnglish(text) {
    return TRANSLATION_CORE.translate(text, 'vi', 'en');
  }

  async function openAITranslateToNativeEnglish(snapshot) {
    const status = await chrome.runtime.sendMessage({ type: 'getProviderStatus' }).catch(() => null);
    if (!status?.configured) {
      throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });
    }

    // NPT-014: tắt "ngữ cảnh" = KHÔNG gửi hostname/page title/field label/nearby,
    // chỉ gửi đúng source text — consent khớp với hành vi thực tế.
    const contextParts = GM_getValue(INPUT_CONFIG.contextStorage, true) ? [
      `Website: ${snapshot.hostname}`,
      snapshot.pageTitle ? `Page title: ${snapshot.pageTitle}` : '',
      snapshot.fieldLabel ? `Field information:\n${snapshot.fieldLabel}` : '',
      snapshot.nearbyContext ? `Nearby context (for tone only):\n${snapshot.nearbyContext}` : '',
    ].filter(Boolean) : [];

    const response = await chrome.runtime.sendMessage({
      type: 'nativeTranslate',
      payload: {
        source: snapshot.text,
        context: contextParts.join('\n\n'),
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'API Native bị lỗi');
    if (!response.text) throw new Error('API không trả về bản dịch');
    return response.text;
  }

  function setHelperStatus(text, isError = false) {
    if (!helperStatus) return;
    helperStatus.textContent = text;
    helperStatus.dataset.error = String(isError);
  }

  function setBusy(value, label = '') {
    busy = value;
    if (mainButton) mainButton.disabled = value;
    if (arrowButton) arrowButton.disabled = value;
    if (mainButton) mainButton.innerHTML = value ? '…' : NPT_MAIN_LABEL;
    if (label) setHelperStatus(label);
  }

  function showToast(message, isError = false) {
    setHelperStatus(message, isError);
    helperPanel.classList.add('show-status');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      helperPanel?.classList.remove('show-status');
    }, isError ? 5000 : 2500);
  }

  async function runInputTranslation(mode) {
    if (busy || !activeEditable) return;

    if (!isExtensionContextAlive()) {
      showToast(CONTEXT_DEAD_MESSAGE, true);
      return;
    }

    let snapshot;
    try {
      snapshot = savedSnapshot || captureSnapshot(activeEditable);
      savedSnapshot = null;
    } catch (error) {
      showToast(error.message, true);
      return;
    }

    const source = String(snapshot.text || '').trim();
    if (!source) {
      showToast('Ô đang trống', true);
      return;
    }
    if (source.length > INPUT_CONFIG.maxInputChars) {
      showToast(`Đoạn chữ quá dài (tối đa ${INPUT_CONFIG.maxInputChars.toLocaleString()} ký tự)`, true);
      return;
    }

    closeMenu();
    setBusy(true, mode === 'native' ? 'Đang gọi API Native…' : 'Đang dịch miễn phí…');

    try {
      if (mode === 'native') {
        try {
          const translated = await openAITranslateToNativeEnglish(snapshot);
          applyTranslation(snapshot, translated);
          showToast('Đã viết lại bằng Native API');
          return;
        } catch (nativeError) {
          console.error('[Native EN Translator] Native API error:', nativeError);
          const fallbackEnabled = GM_getValue(INPUT_CONFIG.fallbackQuickStorage, true) !== false;
          if (!fallbackEnabled) throw nativeError;

          setHelperStatus('API lỗi · đang chuyển sang dịch miễn phí…', true);
          try {
            const fallback = await googleTranslateToEnglish(snapshot.text);
            applyTranslation(snapshot, fallback);
            const reason = nativeError?.code === 'NO_API_KEY' || nativeError?.message === 'NO_API_KEY'
              ? 'chưa cấu hình API'
              : friendlyError(nativeError).slice(0, 70);
            showToast(`Đã fallback miễn phí · ${reason}`);
            return;
          } catch (fallbackError) {
            throw new Error(`Native: ${friendlyError(nativeError)} · Free: ${friendlyError(fallbackError)}`);
          }
        }
      }

      const translated = await googleTranslateToEnglish(snapshot.text);
      applyTranslation(snapshot, translated);
      showToast('Đã dịch miễn phí sang tiếng Anh');
    } catch (error) {
      console.error('[Native EN Translator]', error);
      if (error?.code === 'NO_API_KEY' || error?.message === 'NO_API_KEY') {
        showToast('Chưa cấu hình API Native · mở ⚙ Cài đặt', true);
      } else {
        showToast(friendlyError(error).slice(0, 240), true);
      }
    } finally {
      setBusy(false);
      repositionHelper();
    }
  }

  function configureOpenAI() {
    chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    showToast('Đã mở trang cài đặt API');
    return false;
  }

  function toggleContextSetting() {
    const current = GM_getValue(INPUT_CONFIG.contextStorage, true);
    GM_setValue(INPUT_CONFIG.contextStorage, !current);
    updateMenuLabels();
    showToast(!current ? 'Đã bật gửi ngữ cảnh gần ô nhập' : 'Đã tắt gửi ngữ cảnh gần ô nhập');
  }

  function updateMenuLabels() {
    const contextItem = menuElement?.querySelector('[data-action="context"]');
    if (contextItem) {
      const enabled = GM_getValue(INPUT_CONFIG.contextStorage, true);
      // Giữ glyph trạng thái ✓/○ như cũ, chỉ bọc thêm icon + nhãn.
      contextItem.innerHTML = `${NPT_INPUT_ICONS.chat}<span class="item-text">${enabled ? '✓' : '○'} Dùng ngữ cảnh xung quanh</span>`;
    }
  }

  function openMenu() {
    if (!menuElement) return;
    savedSnapshot = activeEditable ? captureSnapshot(activeEditable) : null;
    updateMenuLabels();
    menuElement.hidden = false;
  }

  function closeMenu() {
    if (menuElement) menuElement.hidden = true;
  }

  function getBestEditableRect(element) {
    let rect = element.getBoundingClientRect();
    if (rect.width >= 20 && rect.height >= 12) return rect;

    let parent = element.parentElement;
    for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) {
      const candidate = parent.getBoundingClientRect();
      if (candidate.width >= 40 && candidate.height >= 20) return candidate;
    }
    return rect;
  }

  /* Scroll/resize/selectionchange bắn liên tục; repositionHelper thì đọc
   * getComputedStyle + tới 6 lần getBoundingClientRect + offsetWidth/Height —
   * toàn là forced layout. Gom về đúng 1 lần mỗi khung hình. */
  let repositionFrame = 0;

  function scheduleReposition() {
    if (repositionFrame) return;
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = 0;
      repositionHelper();
    });
  }

  function repositionHelper() {
    if (helperDragging) return; // Đang kéo tay — không auto reposition đè lên.
    if (!helperPanel || !activeEditable || !activeEditable.isConnected) {
      helperPanel?.classList.remove('visible');
      lastHelperLeft = null;
      lastHelperTop = null;
      closeMenu();
      return;
    }

    const rect = getBestEditableRect(activeEditable);
    if (rect.width < 20 || rect.height < 12 || rect.bottom < 0 || rect.top > innerHeight) {
      helperPanel.classList.remove('visible');
      lastHelperLeft = null;
      lastHelperTop = null;
      closeMenu();
      return;
    }

    // html/body có transform/filter/perspective làm fixed bị lệch → absolute + trừ scroll.
    const useAbsolute = hasTransformedRoot();
    const positionMode = useAbsolute ? 'absolute' : 'fixed';
    const offsetX = useAbsolute ? window.scrollX : 0;
    const offsetY = useAbsolute ? window.scrollY : 0;

    // Đo thật từ DOM (fallback hằng số) vì nút co giãn theo nội dung.
    const panelWidth = helperPanel.offsetWidth || 76;
    const panelHeight = helperPanel.offsetHeight || 30;

    // Nằm NGOÀI ô để không che chữ đang gõ: ưu tiên TRÊN ô sát phải, hết chỗ
    // thì DƯỚI ô; cả hai đều bí mới chui vào TRONG ô (góc phải-trên, ít đè chữ nhất).
    let left = rect.right - panelWidth;
    let top = rect.top - panelHeight - 6;
    let placement = 'above';

    if (top < 8) {
      top = rect.bottom + 6;
      placement = 'below';
    }
    if (placement === 'below' && top + panelHeight > innerHeight - 8) {
      left = rect.right - panelWidth - 8;
      top = rect.top + 6;
      placement = 'inside';
    }

    // Clamp trong viewport (toạ độ viewport), margin 8px.
    left = Math.max(8, Math.min(left, innerWidth - panelWidth - 8));
    top = Math.max(8, Math.min(top, innerHeight - panelHeight - 8));

    // Cộng offset do user kéo nút ('tm-input-helper-offset') rồi clamp lại.
    const dragOffset = helperOffset();
    left += dragOffset.dx;
    top += dragOffset.dy;
    left = Math.max(8, Math.min(left, innerWidth - panelWidth - 8));
    top = Math.max(8, Math.min(top, innerHeight - panelHeight - 8));

    // Menu/status lật hướng theo vị trí nút (helper trên ô → menu xổ XUỐNG).
    if (helperPanel.dataset.placement !== placement) helperPanel.dataset.placement = placement;

    const finalLeft = left + offsetX;
    const finalTop = top + offsetY;

    if (lastHelperPositionMode !== positionMode) {
      helperPanel.style.position = positionMode;
      lastHelperPositionMode = positionMode;
      lastHelperLeft = null;
      lastHelperTop = null;
    }
    if (
      lastHelperLeft === null ||
      Math.abs(finalLeft - lastHelperLeft) > 0.5 ||
      Math.abs(finalTop - lastHelperTop) > 0.5
    ) {
      helperPanel.style.left = `${Math.round(finalLeft)}px`;
      helperPanel.style.top = `${Math.round(finalTop)}px`;
      lastHelperLeft = finalLeft;
      lastHelperTop = finalTop;
    }
    helperPanel.classList.add('visible');
  }

  function createInputHelper() {
    if (helperHost) return; // Heartbeat có thể gọi lại khi bật/tắt toggle.
    helperHost = document.createElement('div');
    helperHost.id = 'tm-native-en-helper-host';
    helperHost.dataset.tmNoTranslate = 'true';
    helperHost.dataset.tmNoInputTranslate = 'true';
    document.documentElement.appendChild(helperHost);

    helperRoot = helperHost.attachShadow({ mode: 'closed' });
    helperRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
        }
        /* Liquid glass: nền trắng mờ + blur mạnh + highlight bóng trên, chữ tối. */
        .helper {
          position: fixed;
          display: flex;
          box-sizing: border-box;
          height: 30px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 11px;
          background: linear-gradient(150deg, rgba(var(--npt-surface),.58), rgba(var(--npt-surface),.2));
          box-shadow: 0 8px 22px rgba(15,17,23,.16), inset 0 1px 0 rgba(var(--npt-surface),.9);
          color: rgb(var(--npt-ink));
          backdrop-filter: blur(20px) saturate(1.7) brightness(1.1);
          opacity: 0;
          visibility: hidden;
          transform: translateY(3px);
          transition: opacity .2s cubic-bezier(.32,.72,0,1), transform .2s cubic-bezier(.32,.72,0,1), visibility .2s;
          pointer-events: auto;
          touch-action: none;
          user-select: none;
        }
        .helper.visible {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
        }
        .helper.dragging { cursor: grabbing; transition: none; }
        button {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          user-select: none;
          color: rgba(var(--npt-ink),.8);
          font: 650 11.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          letter-spacing: .02em;
          transition: background .18s cubic-bezier(.32,.72,0,1), color .18s, transform .14s cubic-bezier(.32,.72,0,1);
        }
        button:disabled { cursor: progress; opacity: .55; }
        .main {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          padding: 0 10px 0 9px;
          border-radius: 10px 0 0 10px;
        }
        .main > svg { color: rgba(var(--npt-ink),.55); }
        .arrow {
          width: 22px;
          display: grid;
          place-items: center;
          border-left: 1px solid rgba(15,17,23,.1);
          border-radius: 0 10px 10px 0;
          color: rgba(var(--npt-ink),.5);
        }
        button:hover:not(:disabled) { background: rgba(var(--npt-surface),.5); color: rgb(var(--npt-ink)); }
        button:hover:not(:disabled) > svg { color: rgb(var(--npt-ink)); }
        button:active:not(:disabled) { transform: scale(.94); }
        .menu {
          position: absolute;
          right: 0;
          bottom: 36px;
          width: 232px;
          padding: 5px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 15px;
          background: linear-gradient(160deg, rgba(var(--npt-surface),.68), rgba(var(--npt-surface-2),.42));
          color: rgb(var(--npt-ink));
          box-shadow: 0 18px 44px rgba(15,17,23,.24), inset 0 1px 0 rgba(var(--npt-surface),.95), inset 0 -10px 18px rgba(var(--npt-surface),.12);
          backdrop-filter: blur(24px) saturate(1.8) brightness(1.1);
        }
        .helper[data-placement="above"] .menu { top: 36px; bottom: auto; }
        .menu[hidden] { display: none; }
        .item {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          width: 100%;
          padding: 8px 9px;
          border: 0;
          border-radius: 9px;
          background: transparent;
          color: rgba(var(--npt-ink),.86);
          text-align: left;
          font: 600 12px/1.3 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .18s cubic-bezier(.32,.72,0,1);
        }
        .item > svg { flex: none; margin-top: 1px; color: rgba(var(--npt-ink),.5); }
        .item-text { flex: 1; }
        .item:hover { background: rgba(var(--npt-surface),.5); }
        .hint {
          display: block;
          margin-top: 2px;
          color: rgba(var(--npt-ink),.45);
          font: 500 10.5px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .divider { height: 1px; margin: 4px 3px; background: rgba(15,17,23,.08); }
        .status {
          position: absolute;
          right: 0;
          bottom: 36px;
          width: max-content;
          max-width: 300px;
          padding: 7px 10px;
          border: 1px solid rgba(var(--npt-surface),.6);
          border-radius: 12px;
          opacity: 0;
          visibility: hidden;
          background: linear-gradient(160deg, rgba(var(--npt-surface),.72), rgba(var(--npt-surface-2),.48));
          color: rgba(var(--npt-ink),.88);
          box-shadow: 0 12px 30px rgba(15,17,23,.2), inset 0 1px 0 rgba(var(--npt-surface),.95);
          backdrop-filter: blur(22px) saturate(1.7) brightness(1.1);
          font: 600 11px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          pointer-events: none;
          white-space: normal;
          transition: opacity .18s cubic-bezier(.32,.72,0,1), visibility .18s;
        }
        .helper[data-placement="above"] .status { top: 36px; bottom: auto; }
        .helper.show-status .status { opacity: 1; visibility: visible; }
        .status[data-error="true"] { color: #b3402f; }
      </style>
      <div class="helper" data-tm-no-translate>
        <button type="button" class="main" title="Dịch sang tiếng Anh tự nhiên · Alt+Shift+E">${NPT_MAIN_LABEL}</button>
        <button type="button" class="arrow" title="Mở tùy chọn">${NPT_INPUT_ICONS.chevron}</button>
        <div class="menu" hidden>
          <button type="button" class="item" data-action="native">
            ${NPT_INPUT_ICONS.sparkLarge}
            <span class="item-text">Native English
              <span class="hint">API tùy chỉnh · hỗ trợ key hoặc không key</span>
            </span>
          </button>
          <button type="button" class="item" data-action="quick">
            ${NPT_INPUT_ICONS.bolt}
            <span class="item-text">Quick English
              <span class="hint">Google Translate · nhanh, không cần key</span>
            </span>
          </button>
          <div class="divider"></div>
          <button type="button" class="item" data-action="context">${NPT_INPUT_ICONS.chat}<span class="item-text">✓ Dùng ngữ cảnh xung quanh</span></button>
          <button type="button" class="item" data-action="settings">${NPT_INPUT_ICONS.gear}<span class="item-text">Cài đặt API</span></button>
          <button type="button" class="item" data-action="reset-pos">${NPT_INPUT_ICONS.reset}<span class="item-text">Về vị trí mặc định<span class="hint">Nút này kéo thả được — đặt lại vị trí tự động</span></span></button>
        </div>
        <div class="status" aria-live="polite"></div>
      </div>
    `;
    applySharedShadowStyle(helperRoot);

    helperPanel = helperRoot.querySelector('.helper');
    menuElement = helperRoot.querySelector('.menu');
    mainButton = helperRoot.querySelector('.main');
    arrowButton = helperRoot.querySelector('.arrow');
    helperStatus = helperRoot.querySelector('.status');

    helperRoot.addEventListener('mousedown', event => {
      // Giữ focus và vùng bôi đen trong ô nhập khi bấm nút.
      event.preventDefault();
      if (activeEditable) {
        try { savedSnapshot = captureSnapshot(activeEditable); } catch (_) { savedSnapshot = null; }
      }
    });

    mainButton.addEventListener('click', event => {
      if (!event.isTrusted) return; // chặn click giả: JS trang tự bấm nút dịch của extension
      const mode = GM_getValue(INPUT_CONFIG.defaultModeStorage, 'native');
      runInputTranslation(mode === 'quick' ? 'quick' : 'native');
    });
    arrowButton.addEventListener('click', () => {
      if (menuElement.hidden) openMenu();
      else closeMenu();
    });

    menuElement.addEventListener('click', event => {
      const item = event.target.closest('[data-action]');
      if (!item) return;
      const action = item.dataset.action;

      if (action === 'native') runInputTranslation('native');
      else if (action === 'quick') runInputTranslation('quick');
      else if (action === 'settings') configureOpenAI();
      else if (action === 'context') toggleContextSetting();
      else if (action === 'reset-pos') {
        GM_setValue(INPUT_CONFIG.offsetStorage, null);
        closeMenu();
        repositionHelper();
        showToast('Đã đưa nút về vị trí mặc định');
      }
    });

    /* ----- Kéo nút tới vị trí mong muốn (offset lưu ở INPUT_CONFIG.offsetStorage).
     * Chỉ setPointerCapture SAU khi quá ngưỡng 6px — nếu capture ngay pointerdown
     * thì click thường bị retarget khỏi nút main/arrow. ----- */
    let drag = null;

    helperPanel.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (event.target.closest('.menu')) return; // Kéo từ trong menu thì bỏ qua.
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        baseLeft: parseFloat(helperPanel.style.left) || 0,
        baseTop: parseFloat(helperPanel.style.top) || 0,
        moved: false,
      };
    });

    helperPanel.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        helperDragging = true;
        helperPanel.classList.add('dragging');
        closeMenu();
        try { helperPanel.setPointerCapture(event.pointerId); } catch (_) { /* noop */ }
      }
      helperPanel.style.left = `${Math.round(drag.baseLeft + dx)}px`;
      helperPanel.style.top = `${Math.round(drag.baseTop + dy)}px`;
      // Reset cache vị trí để repositionHelper không bỏ qua lần ghi tiếp theo.
      lastHelperLeft = null;
      lastHelperTop = null;
    });

    const endDrag = event => {
      if (!drag) return;
      const moved = drag.moved;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      drag = null;
      if (!moved) return; // Click thường: để nút main/arrow tự xử lý.
      helperDragging = false;
      helperSuppressClick = true;
      helperPanel.classList.remove('dragging');
      // Offset mới = offset cũ + quãng kéo (vị trí auto luôn tính lại mỗi heartbeat).
      const prev = helperOffset();
      GM_setValue(INPUT_CONFIG.offsetStorage, {
        dx: Math.round(prev.dx + dx),
        dy: Math.round(prev.dy + dy),
      });
      repositionHelper();
    };
    helperPanel.addEventListener('pointerup', endDrag);
    helperPanel.addEventListener('pointercancel', endDrag);

    // Vừa kéo xong thì nuốt click ảo (không kích hoạt nút main/arrow).
    helperPanel.addEventListener('click', event => {
      if (!helperSuppressClick) return;
      event.stopPropagation();
      event.preventDefault();
      helperSuppressClick = false;
    }, true);
  }

  function activateEditable(editable) {
    if (!helperEnabled()) return; // Toggle tắt → không bám nút lên ô nhập/thanh tìm kiếm.
    if (!editable || !editable.isConnected) return;
    if (isSiteBlacklisted()) return;
    // Dựng shadow DOM + stylesheet của nút ✨ EN đúng lúc chạm ô nhập ĐẦU TIÊN.
    // Trang không có ô nhập nào (và iframe quảng cáo) không phải trả phí này nữa.
    if (!helperHost) createInputHelper();
    activeEditable = editable;
    savedSnapshot = null;
    setTimeout(repositionHelper, INPUT_CONFIG.repositionDelayMs);
  }

  function installInputListeners() {
    const detectFromEvent = event => {
      const editable = findEditableFromEvent(event);
      if (editable) activateEditable(editable);
    };

    document.addEventListener('focusin', detectFromEvent, true);
    document.addEventListener('pointerdown', detectFromEvent, true);
    document.addEventListener('click', detectFromEvent, true);
    document.addEventListener('keyup', detectFromEvent, true);
    document.addEventListener('input', detectFromEvent, true);

    document.addEventListener('focusout', () => {
      setTimeout(() => {
        const now = getDeepActiveEditable();
        if (now) {
          activateEditable(now);
          return;
        }
        if (!helperRoot?.activeElement && !busy) {
          helperPanel?.classList.remove('visible');
          closeMenu();
        }
      }, 160);
    }, true);

    document.addEventListener('selectionchange', () => {
      // Không có ô nhập nào đang hoạt động thì selectionchange (bắn cho MỌI thao
      // tác bôi đen trên trang) không liên quan gì tới nút ✨ EN — bỏ luôn,
      // khỏi tốn một lượt getDeepActiveEditable đi xuyên shadow DOM.
      if (!activeEditable && !helperHost) return;
      const now = getDeepActiveEditable();
      if (now) {
        activeEditable = now;
        savedSnapshot = null;
        scheduleReposition();
      }
    }, true);

    document.addEventListener('keydown', event => {
      if (!event.isTrusted) return; // bỏ sự kiện giả do JS trang tự phát
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (!helperEnabled()) return; // Tắt nút → tắt luôn phím tắt cho gọn.
      const editable = findEditableFromEvent(event) || getDeepActiveEditable();
      if (!editable) return;

      const key = event.key.toLowerCase();
      if (key === 'e') {
        event.preventDefault();
        event.stopPropagation();
        activeEditable = editable;
        runInputTranslation('native');
      } else if (key === 'g') {
        event.preventDefault();
        event.stopPropagation();
        activeEditable = editable;
        runInputTranslation('quick');
      }
    }, true);

    window.addEventListener('resize', scheduleReposition, { passive: true });
    window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true });

    document.addEventListener('mousedown', event => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(helperHost)) return;
      if (menuElement && !menuElement.hidden) closeMenu();
    }, true);

    /* Heartbeat vá được các editor nuốt sự kiện focus, thay DOM của chính mình,
     * hoặc nằm trong closed Shadow DOM. Nhịp thích ứng: 300ms khi user đang thao
     * tác với một ô nhập (cần bám sát), 1200ms khi không có ô nào — bản cũ chạy
     * 300ms vĩnh viễn trong MỌI frame của MỌI trang, kể cả iframe quảng cáo
     * không hề có ô nhập. */
    const HEARTBEAT_ACTIVE_MS = 300;
    const HEARTBEAT_IDLE_MS = 1200;

    const tick = () => {
      let delay = HEARTBEAT_IDLE_MS;
      try {
        if (document.hidden) return; // NPT-018: tab ẩn không polling tốn CPU/pin.
        // Toggle bật/tắt lúc đang chạy (không cần reload): tắt → gỡ hẳn UI, bật → tạo lại.
        if (!helperEnabled() || isSiteBlacklisted()) {
          if (helperHost) {
            helperHost.remove();
            helperHost = null;
            helperRoot = null;
            helperPanel = null;
            menuElement = null;
            mainButton = null;
            arrowButton = null;
            helperStatus = null;
            activeEditable = null;
            savedSnapshot = null;
          }
          return;
        }

        if (helperHost && !helperHost.isConnected && document.documentElement) {
          document.documentElement.appendChild(helperHost);
        }

        const now = getDeepActiveEditable();
        if (now && now !== activeEditable) activateEditable(now);

        if (activeEditable?.isConnected) {
          delay = HEARTBEAT_ACTIVE_MS;
          repositionHelper();
        } else if (!busy) {
          activeEditable = null;
          helperPanel?.classList.remove('visible');
          closeMenu();
        }
      } finally {
        setTimeout(tick, delay);
      }
    };
    setTimeout(tick, HEARTBEAT_IDLE_MS);
  }

  function initInputTranslator() {
    if (!document.documentElement || document.getElementById('tm-native-en-helper-host')) return;
    if (isSiteBlacklisted()) return; // Site bị chặn: không tạo nút ✨ EN.
    // UI được dựng lazy trong activateEditable — ở đây chỉ gắn listener.
    installInputListeners();
  }

  initInputTranslator();
})();


})();
