/* Trang Cài đặt — quản lý nhiều API key cho DeepL / Gemini / OpenAI-compatible. */
'use strict';

const {
  CONFIG_STORAGE_KEY,
  PROVIDER_ORDER,
  PROVIDER_DEFS,
  normalizeConfig,
  maskKey,
} = globalThis.NPT_PROVIDERS;

const PREFS_KEYS = {
  context: 'tm-native-en-use-context',
  defaultMode: 'tm-native-en-default-mode',
  fallbackQuick: 'tm-native-en-fallback-quick',
  pageUseProvider: 'tm-page-use-provider',
};

const $ = selector => document.querySelector(selector);
const statusElement = $('#status');

let config = null;

function setStatus(text, error = false) {
  statusElement.textContent = text;
  statusElement.style.color = error ? '#fca5a5' : '#93c5fd';
}

async function loadConfig() {
  // Bảo đảm background đã seed config (kèm key DeepL mặc định) trước khi đọc.
  await chrome.runtime.sendMessage({ type: 'getProviderStatus' }).catch(() => null);
  const values = await chrome.storage.local.get([CONFIG_STORAGE_KEY]);
  config = normalizeConfig(values[CONFIG_STORAGE_KEY]);
}

async function persistConfig() {
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: config });
}

/* ------------------------- Render provider cards ------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderPreferredSelect() {
  const select = $('#preferred');
  select.textContent = '';
  for (const id of PROVIDER_ORDER) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = PROVIDER_DEFS[id].label;
    select.appendChild(option);
  }
  select.value = config.preferred;
}

function renderKeyList(card, providerId) {
  const provider = config.providers[providerId];
  const list = el('div', 'key-list');

  if (!provider.keys.length) {
    list.appendChild(el('div', 'key-empty', providerId === 'openai'
      ? 'Không bắt buộc key nếu API của bạn là free.'
      : 'Chưa có key nào.'));
  }

  provider.keys.forEach((entry, index) => {
    const row = el('div', 'key-row');
    row.appendChild(el('span', 'key-text', maskKey(entry.key)));
    if (entry.label) row.appendChild(el('span', 'key-label', entry.label));
    const remove = el('button', '', 'Xoá');
    remove.type = 'button';
    remove.title = 'Xoá key này';
    remove.addEventListener('click', () => {
      provider.keys.splice(index, 1);
      renderProviders();
      setStatus('Đã xoá key — nhớ bấm Lưu cài đặt');
    });
    row.appendChild(remove);
    list.appendChild(row);
  });

  const addRow = el('div', 'add-key-row');
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = PROVIDER_DEFS[providerId].keyPlaceholder;
  const addButton = el('button', '', 'Thêm key');
  addButton.type = 'button';
  const addKey = () => {
    const value = input.value.trim();
    if (!value) return;
    if (provider.keys.some(entry => entry.key === value)) {
      setStatus('Key này đã có trong danh sách', true);
      return;
    }
    provider.keys.push({ key: value, label: '' });
    renderProviders();
    if (providerId === 'gemini' && !value.startsWith('AIza')) {
      setStatus('Đã thêm key, nhưng lưu ý: key Gemini chuẩn bắt đầu bằng "AIza". Key dạng "AQ." là key bị Google giới hạn — Gemini API sẽ từ chối. Hãy tạo key "AIza" bằng project/tài khoản Google khác, hoặc tạo trong Google Cloud Console.', true);
      return;
    }
    setStatus('Đã thêm key — nhớ bấm Lưu cài đặt');
  };
  addButton.addEventListener('click', addKey);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') addKey();
  });
  addRow.append(input, addButton);
  list.appendChild(addRow);

  card.appendChild(list);
}

function renderProviderFields(card, providerId) {
  const def = PROVIDER_DEFS[providerId];
  const provider = config.providers[providerId];
  const fields = el('div', 'provider-fields');

  if (def.needsUrl) {
    fields.appendChild(el('label', 'small-label', 'API URL'));
    const url = document.createElement('input');
    url.type = 'url';
    url.spellcheck = false;
    url.value = provider.url || def.defaultUrl;
    url.placeholder = def.defaultUrl;
    url.addEventListener('input', () => { provider.url = url.value.trim(); });
    fields.appendChild(url);

    fields.appendChild(el('label', 'small-label', 'Định dạng API'));
    const format = document.createElement('select');
    for (const [value, text] of [
      ['auto', 'Tự nhận diện'],
      ['responses', 'OpenAI Responses'],
      ['chat', 'OpenAI-compatible Chat'],
      ['libre', 'LibreTranslate'],
      ['generic', 'Generic JSON translate'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      format.appendChild(option);
    }
    format.value = provider.format || 'auto';
    format.addEventListener('change', () => { provider.format = format.value; });
    fields.appendChild(format);
  }

  if (def.needsModel) {
    fields.appendChild(el('label', 'small-label', providerId === 'gemini'
      ? 'Model — khuyên dùng gemini-3.1-flash-lite (rẻ, ít token)'
      : 'Model'));
    const model = document.createElement('input');
    model.type = 'text';
    model.spellcheck = false;
    model.value = provider.model || def.defaultModel;
    model.placeholder = def.defaultModel;
    if (def.suggestedModels) {
      const datalistId = `${providerId}-model-suggestions`;
      model.setAttribute('list', datalistId);
      const datalist = document.createElement('datalist');
      datalist.id = datalistId;
      for (const name of def.suggestedModels) {
        const option = document.createElement('option');
        option.value = name;
        datalist.appendChild(option);
      }
      fields.appendChild(datalist);
    }
    model.addEventListener('input', () => { provider.model = model.value.trim(); });
    fields.appendChild(model);
  }

  card.appendChild(fields);
}

function renderProviders() {
  const container = $('#providers');
  container.textContent = '';

  for (const providerId of PROVIDER_ORDER) {
    const def = PROVIDER_DEFS[providerId];
    const provider = config.providers[providerId];

    const card = el('div', 'provider-card');
    card.dataset.enabled = String(provider.enabled);

    const head = el('div', 'provider-head');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = provider.enabled;
    toggle.title = 'Bật/tắt provider này';
    toggle.addEventListener('change', () => {
      provider.enabled = toggle.checked;
      card.dataset.enabled = String(provider.enabled);
    });
    head.appendChild(toggle);
    head.appendChild(el('span', '', def.label));
    head.appendChild(el('span', 'badge', `${provider.keys.length} key`));
    card.appendChild(head);

    const site = el('div', 'provider-site');
    const link = document.createElement('a');
    link.href = def.site;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Lấy API key tại đây';
    site.appendChild(link);
    card.appendChild(site);

    renderKeyList(card, providerId);
    renderProviderFields(card, providerId);
    container.appendChild(card);
  }
}

/* ------------------------- Quyền truy cập URL tùy chỉnh ------------------------- */

async function requestEndpointPermission(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    throw new Error('API URL không hợp lệ');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API URL phải dùng HTTP/HTTPS');

  const builtin = new Set([
    'https://api.openai.com',
    'https://translate.googleapis.com',
    'https://translate.google.com',
    'https://api.mymemory.translated.net',
    'https://generativelanguage.googleapis.com',
    'https://api-free.deepl.com',
    'https://api.deepl.com',
  ]);
  if (builtin.has(url.origin)) return true;

  return chrome.permissions.request({ origins: [`${url.origin}/*`] });
}

/* ------------------------- Lưu / Test / Dịch trang ------------------------- */

async function saveSettings(showSaved = true) {
  config.preferred = $('#preferred').value;
  const openai = config.providers.openai;
  if (openai.enabled || openai.keys.length) {
    const granted = await requestEndpointPermission(openai.url);
    if (!granted) throw new Error('Bạn chưa cấp quyền truy cập API URL tùy chỉnh');
  }

  await persistConfig();
  await chrome.storage.local.set({
    [PREFS_KEYS.context]: $('#useContext').checked,
    [PREFS_KEYS.defaultMode]: $('#defaultMode').value,
    [PREFS_KEYS.fallbackQuick]: $('#fallbackQuick').checked,
    [PREFS_KEYS.pageUseProvider]: $('#pageUseProvider').checked,
  });
  if (showSaved) setStatus('Đã lưu cài đặt');
}

async function testApi() {
  setStatus('Đang test API…');
  await saveSettings(false);
  const result = await chrome.runtime.sendMessage({
    type: 'nativeTranslate',
    payload: {
      source: 'Câu này chỉ để kiểm tra API dịch có hoạt động không.',
      context: 'This is a connection test. Return only the English translation.',
    },
  });
  if (!result?.ok) {
    const message = result?.error === 'NO_API_KEY'
      ? 'Chưa có provider nào được bật kèm API key'
      : (result?.error || 'API test thất bại');
    throw new Error(message);
  }
  setStatus(`API hoạt động (${result.providerLabel}):\n${result.text}`);
}

async function setPageLanguage(language) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus('Không tìm thấy tab hiện tại', true);
  const result = await chrome.runtime.sendMessage({
    type: 'broadcastPageLanguage',
    tabId: tab.id,
    language,
  });
  setStatus(result?.ok ? 'Đã gửi lệnh dịch' : 'Không thể điều khiển trang này', !result?.ok);
}

async function loadPrefs() {
  const values = await chrome.storage.local.get(Object.values(PREFS_KEYS));
  $('#useContext').checked = values[PREFS_KEYS.context] !== false;
  $('#defaultMode').value = values[PREFS_KEYS.defaultMode] === 'quick' ? 'quick' : 'native';
  $('#fallbackQuick').checked = values[PREFS_KEYS.fallbackQuick] !== false;
  $('#pageUseProvider').checked = values[PREFS_KEYS.pageUseProvider] !== false;
}

document.querySelectorAll('[data-lang]').forEach(button => {
  button.addEventListener('click', () => setPageLanguage(button.dataset.lang).catch(error => setStatus(error.message, true)));
});
$('#save').addEventListener('click', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#testApi').addEventListener('click', () => testApi().catch(error => setStatus(error.message, true)));
$('#preferred').addEventListener('change', () => { config.preferred = $('#preferred').value; });
$('#tone').addEventListener('change', () => { config.tone = $('#tone').value; });

(async () => {
  try {
    await loadConfig();
    $('#tone').value = config.tone;
    renderPreferredSelect();
    renderProviders();
    await loadPrefs();
  } catch (error) {
    setStatus(error.message, true);
  }
})();
