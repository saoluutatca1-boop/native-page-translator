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

  const storageCache = await chrome.storage.local.get(null);

  function GM_getValue(key, defaultValue) {
    return Object.prototype.hasOwnProperty.call(storageCache, key) ? storageCache[key] : defaultValue;
  }

  function GM_setValue(key, value) {
    storageCache[key] = value;
    chrome.storage.local.set({ [key]: value }).catch(error => {
      console.warn('[Native Page Translator] Storage write failed:', error);
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if ('newValue' in change) storageCache[key] = change.newValue;
      else delete storageCache[key];
    }
  });

  // Site trong blacklist ('tm-site-blacklist' = mảng domain) → tắt mọi tính năng.
  // Khớp khi hostname === domain hoặc hostname kết thúc bằng '.domain'.
  function isSiteBlacklisted() {
    const list = GM_getValue('tm-site-blacklist', []);
    if (!Array.isArray(list)) return false;
    const hostname = String(location.hostname || '').toLowerCase();
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

    // Gọi API riêng của user (DeepL/Gemini) qua background. Trả về mảng bản dịch
    // cùng thứ tự với texts, hoặc null nếu setting tắt/không có key/lỗi bất kỳ — không throw.
    async function providerTranslateViaBackground(texts, sourceLanguage, targetLanguage) {
      if (!GM_getValue('tm-page-use-provider', true)) return null;
      if (!Array.isArray(texts) || !texts.length) return null;

      try {
        const response = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(null), 65000);
          chrome.runtime.sendMessage({
            type: 'providerTranslate',
            payload: { texts, targetLanguage, sourceLanguage },
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

    async function translateRaw(text, sourceLanguage, targetLanguage) {
      // Ưu tiên API riêng của user; null (không key/lỗi) thì xuống endpoint miễn phí.
      const providerTranslations = await providerTranslateViaBackground([text], sourceLanguage, targetLanguage);
      if (providerTranslations) return providerTranslations[0].trim();

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

    async function translate(text, sourceLanguage, targetLanguage) {
      const original = String(text ?? '');
      const trimmed = original.trim();
      if (!trimmed) return original;

      const key = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${trimmed}`;
      if (cache.has(key)) return preserveWhitespace(original, cache.get(key));

      const chunks = splitLongText(trimmed);
      const translated = [];
      for (const chunk of chunks) {
        const chunkKey = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${chunk}`;
        let output = cache.get(chunkKey);
        if (!output) {
          output = await translateRaw(chunk, sourceLanguage || 'auto', targetLanguage);
          cache.set(chunkKey, output);
        }
        translated.push(output);
      }

      const output = translated.join('');
      cache.set(key, output);
      return preserveWhitespace(original, output);
    }

    function makeBatches(items, maxChars = 2800, maxItems = 28) {
      const batches = [];
      let current = [];
      let size = 0;
      for (const item of items) {
        const addition = item.text.length + 50;
        if (current.length && (current.length >= maxItems || size + addition > maxChars)) {
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

    async function translateBundle(batch, sourceLanguage, targetLanguage) {
      if (batch.length === 1) {
        return [{ index: batch[0].index, text: await translate(batch[0].text, sourceLanguage, targetLanguage) }];
      }

      // Ưu tiên API riêng của user — 1 message cho cả batch, không cần token __NPT.
      const providerTranslations = await providerTranslateViaBackground(
        batch.map(item => item.text),
        sourceLanguage || 'auto',
        targetLanguage,
      );
      if (providerTranslations) {
        return batch.map((item, index) => {
          const translated = providerTranslations[index].trim();
          const key = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${item.text.trim()}`;
          cache.set(key, translated);
          return { index: item.index, text: preserveWhitespace(item.text, translated) };
        });
      }

      const seed = Math.random().toString(36).slice(2, 8).toUpperCase();
      const tokens = batch.map((_, index) => `__NPT_${seed}_${index}__`);
      const bundled = batch.map((item, index) => `${tokens[index]}\n${item.text}`).join('\n');

      try {
        const output = await translateRaw(bundled, sourceLanguage || 'auto', targetLanguage);
        const positions = tokens.map(token => output.indexOf(token));
        const valid = positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
        if (!valid) throw new Error('API làm mất dấu phân đoạn');

        return batch.map((item, index) => {
          const start = positions[index] + tokens[index].length;
          const end = index + 1 < batch.length ? positions[index + 1] : output.length;
          const translated = output.slice(start, end).replace(/^\s+|\s+$/g, '');
          if (!translated) throw new Error('Một phân đoạn dịch bị rỗng');
          const key = `${sourceLanguage || 'auto'}\u0000${targetLanguage}\u0000${item.text.trim()}`;
          cache.set(key, translated);
          return { index: item.index, text: preserveWhitespace(item.text, translated) };
        });
      } catch (_) {
        const results = [];
        for (const item of batch) {
          try {
            results.push({ index: item.index, text: await translate(item.text, sourceLanguage, targetLanguage) });
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

    async function translateMany(texts, sourceLanguage, targetLanguage) {
      const items = texts.map((text, index) => ({ index, text: String(text ?? '') }));
      const byScript = new Map();
      for (const item of items) {
        const cls = detectScriptClass(item.text);
        if (!byScript.has(cls)) byScript.set(cls, []);
        byScript.get(cls).push(item);
      }
      const batches = [];
      for (const group of byScript.values()) batches.push(...makeBatches(group));
      const results = new Array(items.length);
      let cursor = 0;

      async function worker() {
        while (cursor < batches.length) {
          const batch = batches[cursor++];
          let translated;
          try {
            translated = await translateBundle(batch, sourceLanguage, targetLanguage);
          } catch (error) {
            translated = batch.map(item => ({ index: item.index, error }));
          }
          for (const result of translated) results[result.index] = result;
        }
      }

      await Promise.all(Array.from({ length: Math.min(3, Math.max(1, batches.length)) }, worker));
      return results;
    }

    return { translate, translateMany };
  })();


(() => {
  'use strict';

  const IS_TOP_FRAME = window === window.top;

  // Icon SVG inline: stroke 1.6-1.8, round cap/join, currentColor — không emoji, không asset ngoài.
  const NPT_ICONS = {
    undo: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    globe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a3.9 9 0 0 1 0 18 3.9 9 0 0 1 0-18"/></svg>',
    copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    close: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 4.5-4.5 3 3L16 13l3 3"/></svg>',
  };
  const NPT_SELECTION_FAB_LABEL = `${NPT_ICONS.globe}<span>Dịch</span>`;
  const NPT_SELECTION_COPY_LABEL = `${NPT_ICONS.copy}<span>Sao chép</span>`;
  const NPT_SELECTION_COPIED_LABEL = `${NPT_ICONS.copy}<span>Đã sao chép</span>`;

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
    requestConcurrency: 4,
    maxRequestChars: 3500,
    mutationDebounceMs: 220,
    minimumTextLength: 2,
    storageKey: 'tm-page-translator-language',
  };

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CANVAS', 'SVG', 'MATH',
  ]);

  const TRANSLATABLE_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

  const textRecords = new Map();
  const attributeRecords = new Map();
  const translationCache = new Map();

  const expectedTextChanges = new WeakMap();
  const expectedAttributeChanges = new WeakMap();

  let currentLanguage = 'original';
  let generation = 0;
  let mutationTimer = null;
  const pendingDynamicRoots = new Set();
  let toolbarHost = null;
  let statusElement = null;
  let buttons = {};

  function isToolbarNode(node) {
    return Boolean(toolbarHost && (node === toolbarHost || toolbarHost.contains(node)));
  }

  function isElementSkipped(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    if (isToolbarNode(element)) return true;
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    if (element.closest('[contenteditable="true"], [data-tm-no-translate]')) return true;
    return false;
  }

  function isUsefulText(value) {
    const text = String(value ?? '').trim();
    if (text.length < CONFIG.minimumTextLength) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
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
    return TRANSLATION_CORE.translate(text, 'auto', targetLanguage);
  }

  async function translateText(text, targetLanguage) {
    if (!String(text ?? '').trim() || targetLanguage === 'original') return text;
    return requestTranslation(text, targetLanguage);
  }

  function collectTextNodes(root = document.body) {
    if (!root) return [];
    const nodes = new Set();

    if (root.nodeType === Node.TEXT_NODE) {
      const parent = root.parentElement;
      if (parent && !isElementSkipped(parent) && isUsefulText(root.data)) nodes.add(root);
      return [...nodes];
    }

    for (const scanRoot of enumerateScanRoots(root)) {
      if (!scanRoot) continue;
      if (scanRoot.nodeType === Node.ELEMENT_NODE && isElementSkipped(scanRoot)) continue;

      const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || isElementSkipped(parent) || !isUsefulText(node.data)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let node;
      while ((node = walker.nextNode())) nodes.add(node);
    }

    return [...nodes];
  }

  function collectAttributeTargets(root = document.body) {
    if (!root) return [];
    const targets = [];
    const seen = new WeakMap();

    for (const scanRoot of enumerateScanRoots(root)) {
      let elements = [];
      if (scanRoot.nodeType === Node.ELEMENT_NODE) {
        elements = [scanRoot, ...scanRoot.querySelectorAll('*')];
      } else if (typeof scanRoot.querySelectorAll === 'function') {
        elements = [...scanRoot.querySelectorAll('*')];
      }

      for (const element of elements) {
        if (isElementSkipped(element)) continue;
        let attrs = seen.get(element);
        if (!attrs) {
          attrs = new Set();
          seen.set(element, attrs);
        }
        for (const attribute of TRANSLATABLE_ATTRIBUTES) {
          const value = element.getAttribute(attribute);
          if (value && isUsefulText(value) && !attrs.has(attribute)) {
            attrs.add(attribute);
            targets.push({ element, attribute });
          }
        }
      }
    }

    return targets;
  }

  function getTextRecord(node) {
    let record = textRecords.get(node);
    if (!record) {
      record = { original: node.data, vi: null, en: null };
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

  async function mapWithConcurrency(items, concurrency, worker) {
    let cursor = 0;

    async function runWorker() {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(items.length, 1)) },
      () => runWorker(),
    );

    await Promise.all(workers);
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
  }

  function restoreOriginalContent() {
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
      setStatus(`Đang dịch ${completed}/${total}${failed ? ` · lỗi ${failed}` : ''}`);
    };

    const uniqueOriginals = [];
    const originalIndex = new Map();
    for (const job of jobs) {
      if (job.record[language]) continue;
      if (!originalIndex.has(job.original)) {
        originalIndex.set(job.original, uniqueOriginals.length);
        uniqueOriginals.push(job.original);
      }
    }

    let translatedResults = [];
    if (uniqueOriginals.length) {
      translatedResults = await TRANSLATION_CORE.translateMany(uniqueOriginals, 'auto', language);
    }

    const resultByOriginal = new Map();
    for (let index = 0; index < uniqueOriginals.length; index++) {
      resultByOriginal.set(uniqueOriginals[index], translatedResults[index]);
    }

    for (const job of jobs) {
      if (runGeneration !== generation || language !== currentLanguage) break;
      try {
        if (!job.record[language]) {
          const result = resultByOriginal.get(job.original);
          if (!result || result.error) throw result?.error || new Error('Không nhận được kết quả dịch');
          job.record[language] = result.text;
        }

        if (job.kind === 'text') {
          if (job.node.isConnected) safelySetText(job.node, job.record[language]);
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
  // 2 bucket nối nhau, giữ nguyên thứ tự DOM tương đối — KHÔNG sort toàn phần.
  function orderViewportFirst(textNodes) {
    const inView = [];
    const outView = [];
    for (const node of textNodes) {
      const parent = node.parentElement;
      let visible = false;
      if (parent) {
        try {
          const rect = parent.getBoundingClientRect();
          visible = rect.top < innerHeight * 1.5 && rect.bottom > -innerHeight * 0.5;
        } catch (_) {
          visible = false;
        }
      }
      (visible ? inView : outView).push(node);
    }
    return inView.concat(outView);
  }

  async function setLanguage(language, roots = [document.body]) {
    if (!['original', 'vi', 'en'].includes(language)) return;

    if (language !== 'original' && !isExtensionContextAlive()) {
      setStatus(CONTEXT_DEAD_MESSAGE, true);
      return;
    }

    currentLanguage = language;
    const runGeneration = ++generation;
    GM_setValue(`${CONFIG.storageKey}:${location.hostname}`, language);
    updateActiveButton();

    if (language === 'original') {
      restoreOriginalContent();
      setStatus('Đang hiển thị bản gốc');
      return;
    }

    const uniqueTextNodes = new Set();
    const uniqueAttributeTargets = new Map();

    for (const root of roots) {
      for (const node of collectTextNodes(root)) uniqueTextNodes.add(node);
      for (const target of collectAttributeTargets(root)) {
        let attributes = uniqueAttributeTargets.get(target.element);
        if (!attributes) {
          attributes = new Set();
          uniqueAttributeTargets.set(target.element, attributes);
        }
        attributes.add(target.attribute);
      }
    }

    const textNodes = orderViewportFirst([...uniqueTextNodes]);
    const attributeTargets = [];
    for (const [element, attributes] of uniqueAttributeTargets) {
      for (const attribute of attributes) attributeTargets.push({ element, attribute });
    }

    for (const node of textNodes) getTextRecord(node);
    for (const { element, attribute } of attributeTargets) getAttributeRecord(element, attribute);

    const total = textNodes.length + attributeTargets.length;
    if (!total) {
      setStatus(language === 'vi' ? 'Không tìm thấy chữ cần dịch' : 'No translatable text found');
      return;
    }

    setStatus(`Đang dịch 0/${total}`);
    const result = await translateTargets(textNodes, attributeTargets, language, runGeneration);

    if (runGeneration !== generation || language !== currentLanguage) return;
    setStatus(
      result.failed
        ? `Đã dịch · ${result.failed} mục lỗi`
        : language === 'vi' ? 'Đã dịch sang tiếng Việt' : 'Translated to English',
      result.failed > 0,
    );
  }

  function queueDynamicTranslation(roots) {
    for (const root of roots) pendingDynamicRoots.add(root);
    clearTimeout(mutationTimer);

    mutationTimer = setTimeout(async () => {
      if (currentLanguage === 'original' || !pendingDynamicRoots.size) return;

      const rootsToTranslate = [...pendingDynamicRoots];
      pendingDynamicRoots.clear();
      const language = currentLanguage;
      const runGeneration = generation;

      const uniqueTextNodes = new Set();
      const uniqueAttributeTargets = new Map();

      for (const root of rootsToTranslate) {
        for (const node of collectTextNodes(root)) uniqueTextNodes.add(node);
        for (const target of collectAttributeTargets(root)) {
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

      if (textNodes.length || attributeTargets.length) {
        await translateTargets(textNodes, attributeTargets, language, runGeneration);
        if (runGeneration === generation && language === currentLanguage) {
          setStatus(language === 'vi' ? 'Đã cập nhật phần nội dung mới' : 'New content translated');
        }
      }
    }, CONFIG.mutationDebounceMs);
  }

  function handleMutations(mutations) {
    const addedRoots = new Set();

    for (const mutation of mutations) {
      if (isToolbarNode(mutation.target)) continue;

      if (mutation.type === 'characterData') {
        const node = mutation.target;
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

  function createToolbar() {
    toolbarHost = document.createElement('div');
    toolbarHost.id = 'tm-page-translator-host';
    toolbarHost.dataset.tmNoTranslate = 'true';
    document.documentElement.appendChild(toolbarHost);

    const shadow = toolbarHost.attachShadow({ mode: 'closed' });
    const wrapper = document.createElement('div');
    wrapper.className = 'translator';
    wrapper.innerHTML = `
      <div class="buttons">
        <button type="button" data-language="vi" title="Dịch sang tiếng Việt">VI</button>
        <button type="button" data-language="en" title="Translate to English">EN</button>
        <button type="button" data-language="original" title="Khôi phục bản gốc">${NPT_ICONS.undo}Gốc</button>
      </div>
      <div class="foot">
        <span class="brand-dot" aria-hidden="true"></span>
        <div class="status" aria-live="polite">Sẵn sàng</div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      }
      .translator {
        width: 190px;
        padding: 10px;
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 14px;
        background: rgba(10, 12, 16, .9);
        box-shadow: 0 18px 45px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
        color: #fff;
        backdrop-filter: blur(14px);
      }
      .buttons {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
      }
      button {
        all: unset;
        box-sizing: border-box;
        cursor: pointer;
        text-align: center;
        padding: 7px 5px;
        border-radius: 9px;
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.05);
        color: #fff;
        font: 680 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        transition: background .25s cubic-bezier(.32,.72,0,1), transform .18s cubic-bezier(.32,.72,0,1), border-color .25s;
      }
      button:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.16); }
      button:active { transform: scale(.96); }
      button[data-active="true"] {
        border: 1px solid transparent;
        background: linear-gradient(135deg, #6366f1, #3b82f6);
        box-shadow: 0 4px 14px rgba(79,102,241,.35), inset 0 1px 0 rgba(255,255,255,.22);
      }
      button[data-language="original"] svg { margin-right: 4px; vertical-align: -2px; }
      .foot { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
      .brand-dot {
        width: 14px;
        height: 14px;
        flex: none;
        border-radius: 22%;
        background: linear-gradient(135deg, #6366f1, #3b82f6);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 2px 6px rgba(79,102,241,.4);
      }
      .status {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        color: rgba(255,255,255,.62);
        font: 500 11px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status[data-error="true"] { color: #fca5a5; }
    `;

    shadow.append(style, wrapper);
    statusElement = wrapper.querySelector('.status');

    for (const button of wrapper.querySelectorAll('button[data-language]')) {
      const language = button.dataset.language;
      buttons[language] = button;
      button.addEventListener('click', () => {
        setLanguage(language);
        chrome.runtime.sendMessage({ type: 'broadcastPageLanguage', language }).catch(() => {});
      });
    }

    // fixed bị bẻ khi html/body có transform/filter/perspective → absolute theo toạ độ document.
    if (hasTransformedRoot()) {
      const box = toolbarHost.getBoundingClientRect();
      toolbarHost.style.position = 'absolute';
      toolbarHost.style.left = `${Math.round(window.scrollX + innerWidth - box.width - 14)}px`;
      toolbarHost.style.top = `${Math.round(window.scrollY + innerHeight - box.height - 14)}px`;
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

    imageRoot = imageHost.attachShadow({ mode: 'open' });
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
          padding: 9px 10px 10px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 14px;
          background: rgba(10, 12, 16, .94);
          box-shadow: 0 18px 45px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
          color: #fff;
          backdrop-filter: blur(14px);
          opacity: 0;
          visibility: hidden;
          transform: translateY(4px);
          transition: opacity .2s cubic-bezier(.32,.72,0,1), transform .2s cubic-bezier(.32,.72,0,1), visibility .2s;
          pointer-events: auto;
        }
        .panel.visible { opacity: 1; visibility: visible; transform: translateY(0); }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
        .title {
          flex: 1;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          letter-spacing: .04em;
          background: linear-gradient(135deg, #818cf8, #60a5fa);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
          font: 720 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .title svg { flex: none; color: #818cf8; }
        button {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,.08);
          background: rgba(255,255,255,.05);
          color: rgba(255,255,255,.85);
          font: 640 11px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .2s cubic-bezier(.32,.72,0,1);
        }
        button:hover { background: rgba(255,255,255,.12); }
        button[hidden] { display: none; }
        .close { padding: 4px 6px; color: rgba(255,255,255,.6); }
        .body { overflow-y: auto; overscroll-behavior: contain; }
        .loading {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 2px;
          color: rgba(255,255,255,.75);
          font: 560 12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .spinner {
          width: 13px;
          height: 13px;
          flex: none;
          border: 2px solid rgba(255,255,255,.16);
          border-top-color: #818cf8;
          border-radius: 50%;
          animation: npt-image-spin .8s linear infinite;
        }
        @keyframes npt-image-spin { to { transform: rotate(360deg); } }
        .line { padding: 5px 0; border-top: 1px solid rgba(255,255,255,.06); }
        .line:first-child { border-top: 0; padding-top: 0; }
        .original {
          color: rgba(255,255,255,.48);
          font: 500 11px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .translated {
          margin-top: 1px;
          color: rgba(255,255,255,.95);
          font: 620 13px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .empty, .error {
          padding: 6px 2px;
          font: 560 12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .empty { color: rgba(255,255,255,.6); }
        .error { color: #fca5a5; }
      </style>
      <div class="panel" data-tm-no-translate>
        <div class="head">
          <span class="title">${NPT_ICONS.image}Dịch ảnh</span>
          <button type="button" class="copy" hidden>Sao chép</button>
          <button type="button" class="close" title="Đóng">✕</button>
        </div>
        <div class="body"></div>
      </div>
    `;

    imagePanel = imageRoot.querySelector('.panel');
    imageBody = imageRoot.querySelector('.body');
    imageCopyButton = imageRoot.querySelector('.copy');
    imageRoot.querySelector('.close').addEventListener('click', hideImageTranslatePanel);
    imageCopyButton.addEventListener('click', copyImageTranslations);
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

    const loading = document.createElement('div');
    loading.className = 'loading';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    loading.append(spinner, document.createTextNode('Đang đọc ảnh bằng Gemini…'));
    imageBody.replaceChildren(loading);

    positionImagePanel(srcUrl);
    imagePanel.classList.add('visible');
  }

  function showImageTranslateResult(srcUrl, lines) {
    createImageTranslatePanel();
    clearTimeout(imageErrorTimer);
    imageLines = Array.isArray(lines) ? lines : [];
    imageCopyButton.hidden = !imageLines.length;

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
  }

  function showImageTranslateError(srcUrl, error) {
    createImageTranslatePanel();
    imageLines = [];
    imageCopyButton.hidden = true;

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
      if (message.ok) showImageTranslateResult(message.srcUrl, message.lines);
      else showImageTranslateError(message.srcUrl, message.error);
      return false;
    }
    return false;
  });

  function installKeyboardShortcuts() {
    window.addEventListener('keydown', event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof HTMLElement && (
        event.target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
      )) return;

      const key = event.key.toLowerCase();
      if (key === 'v') {
        event.preventDefault();
        setLanguage('vi');
      } else if (key === 'e') {
        event.preventDefault();
        setLanguage('en');
      } else if (key === 'o') {
        event.preventDefault();
        setLanguage('original');
      }
    }, true);
  }

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
  let selectionText = '';
  let selectionRect = null;
  let selectionScrollY = 0;
  let selectionBusy = false;
  let selectionCopyTimer = null;

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

    const shadow = selectionHost.attachShadow({ mode: 'open' });
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
        .fab {
          all: unset;
          position: fixed;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          padding: 6px 10px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 10px;
          background: rgba(10, 12, 16, .94);
          box-shadow: 0 12px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
          color: #fff;
          backdrop-filter: blur(14px);
          font: 700 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          pointer-events: auto;
          transition: background .2s cubic-bezier(.32,.72,0,1), transform .18s cubic-bezier(.32,.72,0,1);
        }
        .fab:hover { background: rgba(30, 34, 44, .95); }
        .fab:active { transform: scale(.96); }
        .fab[data-busy="true"] { cursor: progress; color: rgba(255,255,255,.6); }
        .panel {
          position: fixed;
          box-sizing: border-box;
          min-width: 180px;
          max-width: 320px;
          max-height: 40vh;
          overflow-y: auto;
          padding: 9px 10px 10px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 10px;
          background: rgba(10, 12, 16, .94);
          box-shadow: 0 18px 45px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
          color: #fff;
          backdrop-filter: blur(14px);
          pointer-events: auto;
        }
        .result {
          white-space: pre-wrap;
          word-break: break-word;
          color: rgba(255,255,255,.92);
          font: 500 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .result[data-error="true"] { color: #fca5a5; }
        .actions { display: flex; gap: 6px; margin-top: 8px; }
        .actions button {
          all: unset;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,.08);
          background: rgba(255,255,255,.05);
          color: rgba(255,255,255,.85);
          font: 640 11px/1.2 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .2s cubic-bezier(.32,.72,0,1);
        }
        .actions button:hover { background: rgba(255,255,255,.12); }
        .actions .close { margin-left: auto; padding: 4px 7px; color: rgba(255,255,255,.6); }
      </style>
      <button type="button" class="fab" data-tm-no-translate title="Dịch đoạn đã chọn" hidden>${NPT_SELECTION_FAB_LABEL}</button>
      <div class="panel" data-tm-no-translate hidden>
        <div class="result"></div>
        <div class="actions">
          <button type="button" class="copy">${NPT_SELECTION_COPY_LABEL}</button>
          <button type="button" class="close" title="Đóng">${NPT_ICONS.close}</button>
        </div>
      </div>
    `;

    selectionButton = shadow.querySelector('.fab');
    selectionPanel = shadow.querySelector('.panel');
    selectionResult = shadow.querySelector('.result');
    selectionCopyButton = shadow.querySelector('.copy');

    // Giữ nguyên vùng bôi đen khi bấm vào nút/panel.
    shadow.addEventListener('mousedown', event => event.preventDefault());

    selectionButton.addEventListener('click', () => { translateSelection(); });
    shadow.querySelector('.close').addEventListener('click', () => hideSelectionUI());
    selectionCopyButton.addEventListener('click', () => copySelectionResult());
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
    if (selectionButton) {
      selectionButton.hidden = true;
      selectionButton.dataset.busy = 'false';
      selectionButton.innerHTML = NPT_SELECTION_FAB_LABEL;
    }
    if (selectionPanel) selectionPanel.hidden = true;
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

  function init() {
    if (!document.documentElement) return;
    if (isSiteBlacklisted()) return; // Site bị chặn: không toolbar, không auto-translate.
    if (IS_TOP_FRAME) {
      createToolbar();
      installKeyboardShortcuts();
    }
    initSelectionTranslator();
    startObserver();

    const savedLanguage = GM_getValue(`${CONFIG.storageKey}:${location.hostname}`, 'original');
    if (['vi', 'en'].includes(savedLanguage)) {
      setLanguage(savedLanguage);
    } else if (IS_TOP_FRAME) {
      setStatus('Sẵn sàng · Alt+V / Alt+E / Alt+O');
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
    fallbackQuickStorage: 'tm-native-en-fallback-quick',
    contextStorage: 'tm-native-en-use-context',
    defaultModeStorage: 'tm-native-en-default-mode',
    maxInputChars: 12000,
    maxContextChars: 800,
    repositionDelayMs: 20,
  };

  // Icon SVG inline: stroke 1.6-1.8, round cap/join, currentColor — không emoji, không asset ngoài.
  const NPT_INPUT_ICONS = {
    spark: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5 13.9 10l5.6 2-5.6 2L12 19.5 10.1 14l-5.6-2 5.6-2z"/></svg>',
    sparkLarge: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5 13.9 10l5.6 2-5.6 2L12 19.5 10.1 14l-5.6-2 5.6-2z"/></svg>',
    chevron: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    bolt: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2.5 4.5 13.5H11l-1 8L18.5 10.5H12z"/></svg>',
    chat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg>',
    gear: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/></svg>',
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

      if (snapshot.hasSelection) {
        const currentValue = element.value;
        newValue = `${currentValue.slice(0, snapshot.start)}${translatedText}${currentValue.slice(snapshot.end)}`;
        cursor = snapshot.start + translatedText.length;
      } else {
        newValue = translatedText;
        cursor = translatedText.length;
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

    insertIntoContentEditable(snapshot, translatedText);
  }

  function googleTranslateToEnglish(text) {
    return TRANSLATION_CORE.translate(text, 'vi', 'en');
  }

  async function openAITranslateToNativeEnglish(snapshot) {
    const status = await chrome.runtime.sendMessage({ type: 'getProviderStatus' }).catch(() => null);
    if (!status?.configured) {
      throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });
    }

    const contextParts = [
      `Website: ${snapshot.hostname}`,
      snapshot.pageTitle ? `Page title: ${snapshot.pageTitle}` : '',
      snapshot.fieldLabel ? `Field information:\n${snapshot.fieldLabel}` : '',
      snapshot.nearbyContext ? `Nearby context (for tone only):\n${snapshot.nearbyContext}` : '',
    ].filter(Boolean);

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

  function repositionHelper() {
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

    const panelWidth = 82;
    const panelHeight = 34;

    // Ưu tiên nằm TRONG ô, góc phải-dưới, inset 8px.
    let left = rect.right - panelWidth - 8;
    let top = rect.bottom - panelHeight - 8;

    // Ô quá thấp hoặc nút tràn trái → đặt TRÊN ô, sát phải, cách 6px.
    if (rect.height < 42 || left < rect.left + 4) {
      left = rect.right - panelWidth;
      top = rect.top - panelHeight - 6;
      if (top < 0) top = rect.bottom + 6; // Không có chỗ phía trên → lật xuống dưới ô.
    }

    // Clamp trong viewport (toạ độ viewport), margin 8px.
    left = Math.max(8, Math.min(left, innerWidth - panelWidth - 8));
    top = Math.max(8, Math.min(top, innerHeight - panelHeight - 8));

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
    helperHost = document.createElement('div');
    helperHost.id = 'tm-native-en-helper-host';
    helperHost.dataset.tmNoTranslate = 'true';
    helperHost.dataset.tmNoInputTranslate = 'true';
    document.documentElement.appendChild(helperHost);

    helperRoot = helperHost.attachShadow({ mode: 'open' });
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
        .helper {
          position: fixed;
          display: flex;
          width: 82px;
          height: 32px;
          opacity: 0;
          visibility: hidden;
          transform: translateY(4px);
          transition: opacity .22s cubic-bezier(.32,.72,0,1), transform .22s cubic-bezier(.32,.72,0,1), visibility .22s;
          pointer-events: auto;
          filter: drop-shadow(0 8px 20px rgba(79,102,241,.35));
        }
        .helper.visible {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
        }
        button {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          user-select: none;
          background: linear-gradient(135deg, #6366f1, #3b82f6);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.22);
          color: white;
          border: 1px solid rgba(255,255,255,.18);
          font: 720 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: filter .2s cubic-bezier(.32,.72,0,1), transform .18s cubic-bezier(.32,.72,0,1);
        }
        button:disabled { cursor: progress; opacity: .75; }
        .main {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          border-radius: 10px 0 0 10px;
        }
        .arrow {
          width: 25px;
          display: grid;
          place-items: center;
          border-left: 1px solid rgba(255,255,255,.22);
          border-radius: 0 10px 10px 0;
        }
        button:hover:not(:disabled) { filter: brightness(1.12); }
        button:active:not(:disabled) { transform: scale(.96); }
        .menu {
          position: absolute;
          right: 0;
          bottom: 38px;
          width: 236px;
          padding: 6px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 14px;
          background: rgba(10, 12, 16, .97);
          color: white;
          box-shadow: 0 18px 45px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.05);
          backdrop-filter: blur(16px);
        }
        .menu[hidden] { display: none; }
        .item {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          width: 100%;
          padding: 9px 10px;
          border: 0;
          border-radius: 9px;
          background: transparent;
          color: white;
          text-align: left;
          font: 620 12px/1.25 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          transition: background .2s cubic-bezier(.32,.72,0,1);
        }
        .item > svg { flex: none; margin-top: 1px; }
        .item-text { flex: 1; }
        .item:hover { background: rgba(255,255,255,.08); }
        .hint {
          display: block;
          margin-top: 3px;
          color: rgba(255,255,255,.5);
          font: 500 10px/1.3 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .divider { height: 1px; margin: 5px 4px; background: rgba(255,255,255,.08); }
        .status {
          position: absolute;
          right: 0;
          bottom: 38px;
          width: max-content;
          max-width: 300px;
          padding: 8px 10px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 10px;
          opacity: 0;
          visibility: hidden;
          background: rgba(10,12,16,.96);
          color: rgba(255,255,255,.9);
          box-shadow: 0 12px 30px rgba(0,0,0,.4);
          font: 600 11px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          pointer-events: none;
          white-space: normal;
          transition: opacity .2s cubic-bezier(.32,.72,0,1), visibility .2s;
        }
        .helper.show-status .status { opacity: 1; visibility: visible; }
        .status[data-error="true"] { color: #fca5a5; }
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
        </div>
        <div class="status" aria-live="polite"></div>
      </div>
    `;

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

    mainButton.addEventListener('click', () => {
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
    });
  }

  function activateEditable(editable) {
    if (!editable || !editable.isConnected) return;
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
      const now = getDeepActiveEditable();
      if (now) {
        activeEditable = now;
        savedSnapshot = null;
        repositionHelper();
      }
    }, true);

    document.addEventListener('keydown', event => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
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

    window.addEventListener('resize', repositionHelper, { passive: true });
    window.addEventListener('scroll', repositionHelper, { passive: true, capture: true });

    document.addEventListener('mousedown', event => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(helperHost)) return;
      if (menuElement && !menuElement.hidden) closeMenu();
    }, true);

    // Heartbeat fixes editors that swallow focus events, replace their DOM, or live in closed Shadow DOM.
    setInterval(() => {
      if (helperHost && !helperHost.isConnected && document.documentElement) {
        document.documentElement.appendChild(helperHost);
      }

      const now = getDeepActiveEditable();
      if (now && now !== activeEditable) activateEditable(now);

      if (activeEditable?.isConnected) {
        repositionHelper();
      } else if (!busy) {
        activeEditable = null;
        helperPanel?.classList.remove('visible');
        closeMenu();
      }
    }, 300);
  }

  function initInputTranslator() {
    if (!document.documentElement || document.getElementById('tm-native-en-helper-host')) return;
    if (isSiteBlacklisted()) return; // Site bị chặn: không tạo nút ✨ EN.
    createInputHelper();
    installInputListeners();
  }

  initInputTranslator();
})();


})();
