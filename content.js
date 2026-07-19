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
      if (!aborted) options.onerror?.({ error: error?.message || String(error) });
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

    async function translateRaw(text, sourceLanguage, targetLanguage) {
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

    async function translateMany(texts, sourceLanguage, targetLanguage) {
      const items = texts.map((text, index) => ({ index, text: String(text ?? '') }));
      const batches = makeBatches(items);
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

  async function setLanguage(language, roots = [document.body]) {
    if (!['original', 'vi', 'en'].includes(language)) return;

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

    const textNodes = [...uniqueTextNodes];
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
        <button type="button" data-language="original" title="Khôi phục bản gốc">Gốc</button>
      </div>
      <div class="status" aria-live="polite">Sẵn sàng</div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .translator {
        width: 190px;
        padding: 9px;
        border: 1px solid rgba(255,255,255,.15);
        border-radius: 12px;
        background: rgba(20, 20, 24, .92);
        box-shadow: 0 10px 35px rgba(0,0,0,.35);
        color: #fff;
        backdrop-filter: blur(12px);
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
        border-radius: 8px;
        background: rgba(255,255,255,.09);
        color: #fff;
        font: 700 12px/1 system-ui, sans-serif;
        transition: background .15s ease, transform .15s ease;
      }
      button:hover { background: rgba(255,255,255,.18); }
      button:active { transform: scale(.96); }
      button[data-active="true"] { background: #2563eb; }
      .status {
        margin-top: 7px;
        overflow: hidden;
        color: rgba(255,255,255,.72);
        font: 500 11px/1.35 system-ui, sans-serif;
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

    updateActiveButton();
  }

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
    if (IS_TOP_FRAME) {
      createToolbar();
      installKeyboardShortcuts();
    }
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
      setLanguage(message.language);
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
 * - Native English: OpenAI Responses API (cần API key riêng của người dùng)
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
    keyStorage: 'tm-native-en-openai-key',
    modelStorage: 'tm-native-en-openai-model',
    apiUrlStorage: 'tm-native-en-api-url',
    apiFormatStorage: 'tm-native-en-api-format',
    fallbackQuickStorage: 'tm-native-en-fallback-quick',
    contextStorage: 'tm-native-en-use-context',
    defaultModeStorage: 'tm-native-en-default-mode',
    defaultModel: 'gpt-5-mini',
    maxInputChars: 12000,
    maxContextChars: 800,
    repositionDelayMs: 20,
  };

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

  function extractOpenAIText(data) {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
      return data.output_text.trim();
    }

    const chunks = [];
    for (const item of data?.output || []) {
      for (const content of item?.content || []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') {
          chunks.push(content.text);
        } else if (typeof content?.text === 'string') {
          chunks.push(content.text);
        }
      }
    }
    return chunks.join('').trim();
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

  function openAITranslateToNativeEnglish(snapshot) {
    const apiKey = String(GM_getValue(INPUT_CONFIG.keyStorage, '') || '').trim();
    const apiUrl = String(GM_getValue(INPUT_CONFIG.apiUrlStorage, '') || '').trim();

    if (!apiKey && !apiUrl) {
      return Promise.reject(Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' }));
    }

    const contextParts = [
      `Website: ${snapshot.hostname}`,
      snapshot.pageTitle ? `Page title: ${snapshot.pageTitle}` : '',
      snapshot.fieldLabel ? `Field information:\n${snapshot.fieldLabel}` : '',
      snapshot.nearbyContext ? `Nearby context (for tone only):\n${snapshot.nearbyContext}` : '',
    ].filter(Boolean);

    return chrome.runtime.sendMessage({
      type: 'nativeTranslate',
      payload: {
        source: snapshot.text,
        context: contextParts.join('\n\n'),
      },
    }).then(response => {
      if (!response?.ok) throw new Error(response?.error || 'API Native bị lỗi');
      if (!response.text) throw new Error('API không trả về bản dịch');
      return response.text;
    });
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
    if (mainButton) mainButton.textContent = value ? '…' : '✨ EN';
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
              : String(nativeError?.message || 'API lỗi').slice(0, 70);
            showToast(`Đã fallback miễn phí · ${reason}`);
            return;
          } catch (fallbackError) {
            throw new Error(`Native: ${nativeError?.message || nativeError} · Free: ${fallbackError?.message || fallbackError}`);
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
        showToast(String(error?.message || 'Dịch thất bại').slice(0, 240), true);
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
      contextItem.textContent = `${enabled ? '✓' : '○'} Dùng ngữ cảnh xung quanh`;
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
      closeMenu();
      return;
    }

    const rect = getBestEditableRect(activeEditable);
    if (rect.width < 20 || rect.height < 12 || rect.bottom < 0 || rect.top > innerHeight) {
      helperPanel.classList.remove('visible');
      closeMenu();
      return;
    }

    const panelWidth = 82;
    const panelHeight = 34;
    let left = rect.right - panelWidth - 6;
    let top = rect.bottom - panelHeight - 5;

    if (rect.height < 42 || left < rect.left + 4) {
      top = rect.bottom + 6;
      left = rect.right - panelWidth;
    }

    left = Math.max(8, Math.min(left, innerWidth - panelWidth - 8));
    top = Math.max(8, Math.min(top, innerHeight - panelHeight - 8));

    helperPanel.style.left = `${Math.round(left)}px`;
    helperPanel.style.top = `${Math.round(top)}px`;
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
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .helper {
          position: fixed;
          display: flex;
          width: 82px;
          height: 32px;
          opacity: 0;
          visibility: hidden;
          transform: translateY(3px);
          transition: opacity .12s ease, transform .12s ease, visibility .12s;
          pointer-events: auto;
          filter: drop-shadow(0 5px 14px rgba(0,0,0,.28));
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
          background: #2563eb;
          color: white;
          border: 1px solid rgba(255,255,255,.24);
          font: 750 12px/1 system-ui, sans-serif;
        }
        button:disabled { cursor: progress; opacity: .75; }
        .main {
          flex: 1;
          display: grid;
          place-items: center;
          border-radius: 9px 0 0 9px;
        }
        .arrow {
          width: 25px;
          display: grid;
          place-items: center;
          border-left: 1px solid rgba(255,255,255,.25);
          border-radius: 0 9px 9px 0;
        }
        button:hover:not(:disabled) { background: #1d4ed8; }
        .menu {
          position: absolute;
          right: 0;
          bottom: 38px;
          width: 230px;
          padding: 6px;
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 12px;
          background: rgba(20, 20, 24, .97);
          color: white;
          box-shadow: 0 14px 38px rgba(0,0,0,.38);
          backdrop-filter: blur(14px);
        }
        .menu[hidden] { display: none; }
        .item {
          width: 100%;
          padding: 9px 10px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: white;
          text-align: left;
          font: 600 12px/1.25 system-ui, sans-serif;
        }
        .item:hover { background: rgba(255,255,255,.11); }
        .hint {
          display: block;
          margin-top: 3px;
          color: rgba(255,255,255,.55);
          font: 500 10px/1.3 system-ui, sans-serif;
        }
        .divider { height: 1px; margin: 5px 4px; background: rgba(255,255,255,.1); }
        .status {
          position: absolute;
          right: 0;
          bottom: 38px;
          width: max-content;
          max-width: 300px;
          padding: 7px 9px;
          border-radius: 8px;
          opacity: 0;
          visibility: hidden;
          background: rgba(20,20,24,.96);
          color: rgba(255,255,255,.9);
          box-shadow: 0 8px 24px rgba(0,0,0,.3);
          font: 600 11px/1.35 system-ui, sans-serif;
          pointer-events: none;
          white-space: normal;
        }
        .helper.show-status .status { opacity: 1; visibility: visible; }
        .status[data-error="true"] { color: #fecaca; }
      </style>
      <div class="helper" data-tm-no-translate>
        <button type="button" class="main" title="Dịch sang tiếng Anh tự nhiên · Alt+Shift+E">✨ EN</button>
        <button type="button" class="arrow" title="Mở tùy chọn">▾</button>
        <div class="menu" hidden>
          <button type="button" class="item" data-action="native">
            ✨ Native English
            <span class="hint">API tùy chỉnh · hỗ trợ key hoặc không key</span>
          </button>
          <button type="button" class="item" data-action="quick">
            ⚡ Quick English
            <span class="hint">Google Translate · nhanh, không cần key</span>
          </button>
          <div class="divider"></div>
          <button type="button" class="item" data-action="context">✓ Dùng ngữ cảnh xung quanh</button>
          <button type="button" class="item" data-action="settings">⚙ Cài đặt API</button>
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
    createInputHelper();
    installInputListeners();
  }

  initInputTranslator();
})();


})();
