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
  pageFreeFallback: 'tm-page-free-fallback',
  selectionTranslate: 'tm-selection-translate',
  inputHelper: 'tm-input-helper-enabled',
  siteBlacklist: 'tm-site-blacklist',
  pageDisplayMode: 'tm-page-display-mode',
  pageStyle: 'tm-page-style',
  pageDialect: 'tm-page-dialect',
  pageTranslateMode: 'tm-page-translate-mode',
  pageGrammarFix: 'tm-page-grammar-fix',
  pageSkipCode: 'tm-page-skip-code',
  pageSkipUsernames: 'tm-page-skip-usernames',
  pageKeepProperNouns: 'tm-page-keep-proper-nouns',
  pageDynamicTranslate: 'tm-page-dynamic-translate',
  pageLazyTranslate: 'tm-page-lazy-translate',
  docMode: 'tm-doc-mode',
  ttsEnabled: 'tm-tts-enabled',
  ttsRate: 'tm-tts-rate',
  translationCache: 'tm-translation-cache',
  uiTheme: 'tm-ui-theme',
};

// Contract chung với content/background: templates, template đang dùng và glossary.
const TEMPLATE_KEYS = { templates: 'tm-prompt-templates', active: 'tm-active-template' };
const GLOSSARY_KEY = 'tm-glossary';

// Seed mặc định khi 'tm-prompt-templates' chưa từng tồn tại trong storage.
const DEFAULT_TEMPLATES = [
  { id: 'van-hoc', name: 'Văn học', prompt: 'Dịch theo phong cách văn học, giàu hình ảnh, giữ nhịp câu tự nhiên như văn xuôi.' },
  { id: 'ky-thuat', name: 'Kỹ thuật', prompt: 'Giữ nguyên thuật ngữ kỹ thuật tiếng Anh (không dịch tên hàm, lệnh, API, framework); chỉ dịch phần giải thích.' },
  { id: 'gen-z', name: 'Giọng Gen Z', prompt: 'Dịch theo giọng Gen Z Việt Nam: tự nhiên, hài hước vừa phải, dùng từ lóng phổ biến nhưng vẫn rõ nghĩa.' },
];

// Giá trị hợp lệ của văn phong trang — sai thì về 'natural' theo contract.
const PAGE_STYLE_VALUES = ['natural', 'casual', 'work-email', 'game-chat', 'genz', 'formal'];

const $ = selector => document.querySelector(selector);
const statusElement = $('#status');

let config = null;

function setStatus(text, error = false) {
  statusElement.textContent = text;
  if (text) statusElement.dataset.tone = error ? 'error' : 'ok';
  else delete statusElement.dataset.tone;
}

/* Trước đây provider URL/model/key được sửa thẳng vào object trong bộ nhớ và
 * chỉ ghi xuống storage khi bấm "Lưu cài đặt" — đóng tab là mất trắng mà không
 * có một dấu hiệu nào. Giờ mọi thay đổi bật cờ này và hiện pill cảnh báo. */
let dirty = false;

function markDirty() {
  dirty = true;
  const pill = document.querySelector('#dirtyPill');
  if (pill) pill.hidden = false;
}

function markClean() {
  dirty = false;
  const pill = document.querySelector('#dirtyPill');
  if (pill) pill.hidden = true;
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

/* Badge thương hiệu 22px (bo góc 6) đứng trước tên provider — chuỗi SVG tĩnh, an toàn innerHTML. */
const PROVIDER_BADGES = {
  deepl: '<svg class="provider-badge" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><defs><linearGradient id="pb-deepl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f2b46"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs><rect width="22" height="22" rx="6" fill="url(#pb-deepl)"/><text x="11" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="inherit">D</text></svg>',
  gemini: '<svg class="provider-badge" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><defs><linearGradient id="pb-gemini" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="22" height="22" rx="6" fill="url(#pb-gemini)"/><path d="M11 5c.4 3 1.5 4.1 4.5 4.5-3 .4-4.1 1.5-4.5 4.5-.4-3-1.5-4.1-4.5-4.5 3-.4 4.1-1.5 4.5-4.5Z" fill="#fff"/><path d="M16.4 13.2c.2 1.3.8 1.8 2.1 2-1.3.2-1.9.7-2.1 2-.2-1.3-.8-1.8-2.1-2 1.3-.2 1.9-.7 2.1-2Z" fill="#fff" opacity=".85"/></svg>',
  openai: '<svg class="provider-badge" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><defs><linearGradient id="pb-openai" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#4b5563"/></linearGradient></defs><rect width="22" height="22" rx="6" fill="url(#pb-openai)"/><text x="11" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="inherit">O</text></svg>',
};

/* Icon chìa khóa nhỏ đầu mỗi key-row. */
const KEY_ICON = '<svg class="key-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="12" r="3.2"/><path d="M10.7 12h9.3m-3 0v3m3-3v2"/></svg>';

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
    row.insertAdjacentHTML('afterbegin', KEY_ICON);
    row.appendChild(el('span', 'key-text', maskKey(entry.key)));
    if (entry.label) row.appendChild(el('span', 'key-label', entry.label));
    const remove = el('button', '', 'Xoá');
    remove.type = 'button';
    remove.title = 'Xoá key này';
    remove.addEventListener('click', () => {
      if (!confirm(`Xoá key ${maskKey(entry.key)} của ${PROVIDER_DEFS[providerId].label}?\nKhông khôi phục lại được.`)) return;
      provider.keys.splice(index, 1);
      renderProviders();
      markDirty();
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
    markDirty();
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
    url.addEventListener('input', () => { provider.url = url.value.trim(); markDirty(); });
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
    format.addEventListener('change', () => { provider.format = format.value; markDirty(); });
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
    model.addEventListener('input', () => { provider.model = model.value.trim(); markDirty(); });
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
      markDirty();
    });
    head.appendChild(toggle);
    if (PROVIDER_BADGES[providerId]) head.insertAdjacentHTML('beforeend', PROVIDER_BADGES[providerId]);
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

// Parse textarea blacklist: mỗi dòng 1 domain — trim, lowercase, bỏ dòng rỗng.
function parseSiteBlacklist(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(Boolean);
}

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
    [PREFS_KEYS.pageFreeFallback]: $('#pageFreeFallback').checked,
    [PREFS_KEYS.selectionTranslate]: $('#selectionTranslate').checked,
    [PREFS_KEYS.inputHelper]: $('#inputHelper').checked,
    [PREFS_KEYS.siteBlacklist]: parseSiteBlacklist($('#siteBlacklist').value),
    [PREFS_KEYS.pageDisplayMode]: $('#pageDisplayMode').value,
    [PREFS_KEYS.pageStyle]: $('#pageStyle').value,
    [PREFS_KEYS.pageDialect]: $('#pageDialect').value,
    [PREFS_KEYS.pageTranslateMode]: $('#pageTranslateMode').value,
    [PREFS_KEYS.pageGrammarFix]: $('#pageGrammarFix').checked,
    [PREFS_KEYS.pageSkipCode]: $('#pageSkipCode').checked,
    [PREFS_KEYS.pageSkipUsernames]: $('#pageSkipUsernames').checked,
    [PREFS_KEYS.pageKeepProperNouns]: $('#pageKeepProperNouns').checked,
    [PREFS_KEYS.pageDynamicTranslate]: $('#pageDynamicTranslate').checked,
    [PREFS_KEYS.pageLazyTranslate]: $('#pageLazyTranslate').checked,
    [PREFS_KEYS.docMode]: $('#docMode').value,
    [PREFS_KEYS.ttsEnabled]: $('#ttsEnabled').checked,
    [PREFS_KEYS.ttsRate]: Number($('#ttsRate').value),
    [PREFS_KEYS.translationCache]: $('#translationCache').checked,
    [PREFS_KEYS.uiTheme]: $('#uiTheme').value,
  });
  markClean();
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

async function loadPrefs() {
  const values = await chrome.storage.local.get(Object.values(PREFS_KEYS));
  $('#useContext').checked = values[PREFS_KEYS.context] !== false;
  $('#defaultMode').value = values[PREFS_KEYS.defaultMode] === 'quick' ? 'quick' : 'native';
  $('#fallbackQuick').checked = values[PREFS_KEYS.fallbackQuick] !== false;
  $('#pageUseProvider').checked = values[PREFS_KEYS.pageUseProvider] !== false;
  $('#pageFreeFallback').checked = values[PREFS_KEYS.pageFreeFallback] !== false;
  $('#selectionTranslate').checked = values[PREFS_KEYS.selectionTranslate] !== false;
  $('#inputHelper').checked = values[PREFS_KEYS.inputHelper] !== false;
  const blacklist = values[PREFS_KEYS.siteBlacklist];
  $('#siteBlacklist').value = Array.isArray(blacklist) ? blacklist.join('\n') : '';
  // Dịch trang nâng cao — default khớp contract khi storage chưa có key (checkbox mặc định true).
  $('#pageDisplayMode').value = values[PREFS_KEYS.pageDisplayMode] === 'bilingual' ? 'bilingual' : 'replace';
  $('#pageStyle').value = PAGE_STYLE_VALUES.includes(values[PREFS_KEYS.pageStyle]) ? values[PREFS_KEYS.pageStyle] : 'natural';
  $('#pageDialect').value = values[PREFS_KEYS.pageDialect] === 'uk' ? 'uk' : 'us';
  $('#pageTranslateMode').value = values[PREFS_KEYS.pageTranslateMode] === 'literal' ? 'literal' : 'natural';
  $('#pageGrammarFix').checked = values[PREFS_KEYS.pageGrammarFix] === true;
  $('#pageSkipCode').checked = values[PREFS_KEYS.pageSkipCode] !== false;
  $('#pageSkipUsernames').checked = values[PREFS_KEYS.pageSkipUsernames] !== false;
  $('#pageKeepProperNouns').checked = values[PREFS_KEYS.pageKeepProperNouns] !== false;
  $('#pageDynamicTranslate').checked = values[PREFS_KEYS.pageDynamicTranslate] !== false;
  $('#pageLazyTranslate').checked = values[PREFS_KEYS.pageLazyTranslate] !== false;
  // Trang tài liệu & TTS — default khớp contract ('auto' / bật / 1x).
  $('#docMode').value = ['auto', 'on', 'off'].includes(values[PREFS_KEYS.docMode]) ? values[PREFS_KEYS.docMode] : 'auto';
  $('#ttsEnabled').checked = values[PREFS_KEYS.ttsEnabled] !== false;
  const ttsRate = Number(values[PREFS_KEYS.ttsRate]);
  $('#ttsRate').value = (ttsRate >= 0.5 && ttsRate <= 2) ? String(ttsRate) : '1';
  $('#ttsRateValue').textContent = $('#ttsRate').value;
  $('#translationCache').checked = values[PREFS_KEYS.translationCache] !== false;
  const theme = values[PREFS_KEYS.uiTheme];
  $('#uiTheme').value = ['dark', 'light'].includes(theme) ? theme : 'auto';
  applyTheme(theme);
}

/* ------------------------- Prompt Templates ------------------------- */

let templates = [];
let activeTemplateId = '';
let editingTemplateId = null;

async function persistTemplates() {
  await chrome.storage.local.set({ [TEMPLATE_KEYS.templates]: templates });
}

function renderTemplates() {
  const list = $('#templateList');
  list.textContent = '';

  if (!templates.length) {
    list.appendChild(el('div', 'key-empty', 'Chưa có template nào.'));
  }

  templates.forEach(tpl => {
    const row = el('div', 'key-row');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activeTemplate';
    radio.className = 'tpl-radio';
    radio.checked = tpl.id === activeTemplateId;
    radio.title = 'Chọn làm template đang dùng';
    radio.addEventListener('change', async () => {
      activeTemplateId = tpl.id;
      await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: activeTemplateId });
      renderTemplates();
      setStatus(`Đang dùng template "${tpl.name}"`);
    });
    row.appendChild(radio);
    row.appendChild(el('span', 'tpl-name', tpl.name));

    const edit = el('button', '', 'Sửa');
    edit.type = 'button';
    edit.title = 'Sửa template này';
    edit.addEventListener('click', () => {
      editingTemplateId = tpl.id;
      $('#tplName').value = tpl.name;
      $('#tplPrompt').value = tpl.prompt;
      $('#tplSave').textContent = 'Cập nhật template';
      $('#tplCancel').hidden = false;
      $('#tplName').focus();
    });
    row.appendChild(edit);

    const remove = el('button', '', 'Xoá');
    remove.type = 'button';
    remove.title = 'Xoá template này';
    remove.addEventListener('click', async () => {
      templates = templates.filter(item => item.id !== tpl.id);
      if (activeTemplateId === tpl.id) {
        activeTemplateId = '';
        await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: '' });
      }
      if (editingTemplateId === tpl.id) resetTemplateForm();
      await persistTemplates();
      renderTemplates();
      setStatus('Đã xoá template');
    });
    row.appendChild(remove);
    list.appendChild(row);
  });

  // Dòng "không dùng template" — radio về mặc định.
  const noneRow = el('div', 'key-row');
  const noneRadio = document.createElement('input');
  noneRadio.type = 'radio';
  noneRadio.name = 'activeTemplate';
  noneRadio.className = 'tpl-radio';
  noneRadio.checked = activeTemplateId === '';
  noneRadio.title = 'Không dùng template';
  noneRadio.addEventListener('change', async () => {
    activeTemplateId = '';
    await chrome.storage.local.set({ [TEMPLATE_KEYS.active]: '' });
    renderTemplates();
    setStatus('Đã bỏ chọn template — dịch theo mặc định');
  });
  noneRow.appendChild(noneRadio);
  noneRow.appendChild(el('span', 'tpl-name', 'Mặc định (không dùng template)'));
  list.appendChild(noneRow);
}

function resetTemplateForm() {
  editingTemplateId = null;
  $('#tplName').value = '';
  $('#tplPrompt').value = '';
  $('#tplSave').textContent = 'Lưu template';
  $('#tplCancel').hidden = true;
}

async function saveTemplateForm() {
  const name = $('#tplName').value.trim();
  const prompt = $('#tplPrompt').value.trim();
  if (!name || !prompt) return setStatus('Nhập đủ tên và prompt cho template', true);

  if (editingTemplateId) {
    const tpl = templates.find(item => item.id === editingTemplateId);
    if (tpl) {
      tpl.name = name;
      tpl.prompt = prompt;
    }
    setStatus(`Đã cập nhật template "${name}"`);
  } else {
    templates.push({ id: `tpl-${Date.now().toString(36)}`, name, prompt });
    setStatus(`Đã thêm template "${name}"`);
  }
  resetTemplateForm();
  await persistTemplates();
  renderTemplates();
}

async function loadTemplates() {
  const values = await chrome.storage.local.get([TEMPLATE_KEYS.templates, TEMPLATE_KEYS.active]);
  if (values[TEMPLATE_KEYS.templates] === undefined) {
    // Chưa từng tồn tại → seed bộ mặc định (mảng rỗng đã lưu thì tôn trọng, không seed lại).
    templates = DEFAULT_TEMPLATES.map(tpl => ({ ...tpl }));
    await persistTemplates();
  } else {
    templates = Array.isArray(values[TEMPLATE_KEYS.templates]) ? values[TEMPLATE_KEYS.templates] : [];
  }
  const savedActive = values[TEMPLATE_KEYS.active];
  activeTemplateId = typeof savedActive === 'string' && templates.some(tpl => tpl.id === savedActive) ? savedActive : '';
  renderTemplates();
}

/* ------------------------- Glossary thuật ngữ ------------------------- */

let glossary = [];

async function persistGlossary() {
  await chrome.storage.local.set({ [GLOSSARY_KEY]: glossary });
}

function renderGlossary() {
  const list = $('#glossaryList');
  list.textContent = '';
  $('#glossaryCount').textContent = `${glossary.length} từ`;

  if (!glossary.length) {
    list.appendChild(el('div', 'key-empty', 'Chưa có thuật ngữ nào.'));
    return;
  }

  glossary.forEach((entry, index) => {
    const row = el('div', 'key-row glossary-row');
    row.appendChild(el('span', 'glossary-source', entry.source));
    row.appendChild(el('span', 'glossary-arrow', '→'));
    row.appendChild(el('span', 'glossary-target', entry.target));
    const remove = el('button', '', 'Xoá');
    remove.type = 'button';
    remove.title = 'Xoá cặp từ này';
    remove.addEventListener('click', async () => {
      glossary.splice(index, 1);
      await persistGlossary();
      renderGlossary();
      setStatus('Đã xoá cặp từ');
    });
    row.appendChild(remove);
    list.appendChild(row);
  });
}

// Merge entries mới vào glossary, dedupe theo source (source đã có thì cập nhật target).
async function mergeGlossary(entries) {
  let added = 0;
  for (const entry of entries) {
    const source = String(entry?.source || '').trim();
    const target = String(entry?.target || '').trim();
    if (!source || !target) continue;
    const existing = glossary.find(item => item.source === source);
    if (existing) existing.target = target;
    else {
      glossary.push({ source, target });
      added++;
    }
  }
  await persistGlossary();
  renderGlossary();
  return added;
}

async function addGlossaryEntry() {
  const source = $('#glossarySource').value.trim();
  const target = $('#glossaryTarget').value.trim();
  if (!source || !target) return setStatus('Nhập đủ thuật ngữ gốc và bản dịch', true);
  await mergeGlossary([{ source, target }]);
  $('#glossarySource').value = '';
  $('#glossaryTarget').value = '';
  $('#glossarySource').focus();
  setStatus('Đã thêm cặp từ vào glossary');
}

async function importGlossaryFile(file) {
  const helper = globalThis.NPT_GLOSSARY;
  if (!helper?.parse) return setStatus('Module glossary.js chưa sẵn sàng — không import được', true);
  const text = await file.text();
  const entries = helper.parse(text);
  if (!Array.isArray(entries) || !entries.length) return setStatus('Không đọc được cặp từ nào từ file này', true);
  const added = await mergeGlossary(entries);
  setStatus(`Đã import ${entries.length} cặp từ (${added} từ mới, còn lại cập nhật/trùng)`);
}

function exportGlossary(format) {
  const helper = globalThis.NPT_GLOSSARY;
  if (!helper?.serialize) return setStatus('Module glossary.js chưa sẵn sàng — không export được', true);
  if (!glossary.length) return setStatus('Glossary đang trống', true);
  const text = helper.serialize(glossary, format);
  const isJson = format === 'json';
  const blob = new Blob([text], { type: isJson ? 'application/json' : 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = isJson ? 'glossary.json' : 'glossary.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`Đã xuất ${glossary.length} từ ra ${anchor.download}`);
}

async function loadGlossary() {
  const values = await chrome.storage.local.get([GLOSSARY_KEY]);
  glossary = Array.isArray(values[GLOSSARY_KEY]) ? values[GLOSSARY_KEY] : [];
  renderGlossary();
}

/* ------------------------- Quota DeepL ------------------------- */

// Một dòng quota: 'DeepL <keyMasked>: count/limit ký tự' + thanh progress theo %.
function renderUsageRow(container, usage) {
  const row = el('div');
  row.style.cssText = 'margin-top:8px';

  if (usage.error) {
    const line = el('div', 'note', `DeepL ${usage.keyMasked || ''}: ${usage.error}`);
    line.style.cssText = 'margin:0;color:#fca5a5';
    row.appendChild(line);
    container.appendChild(row);
    return;
  }

  const count = Number(usage.count) || 0;
  const limit = Number(usage.limit) || 0;
  const label = el('div', 'note',
    `DeepL ${usage.keyMasked}: ${count.toLocaleString('vi-VN')}/${limit.toLocaleString('vi-VN')} ký tự`);
  label.style.margin = '0';
  row.appendChild(label);

  if (limit > 0) {
    const percent = Math.min(100, Math.round((count / limit) * 100));
    const track = el('div');
    track.style.cssText = 'height:6px;margin-top:4px;border-radius:99px;background:var(--panel-strong);overflow:hidden';
    const fill = el('div');
    fill.style.cssText = `height:100%;width:${percent}%;border-radius:99px;background:linear-gradient(135deg,var(--accent),var(--accent-2))`;
    track.appendChild(fill);
    row.appendChild(track);
  }
  container.appendChild(row);
}

async function renderDeeplUsage() {
  const container = $('#deeplUsage');
  container.textContent = '';
  const result = await chrome.runtime.sendMessage({ type: 'deeplUsage' }).catch(() => null);
  const usages = Array.isArray(result?.usages) ? result.usages : [];
  if (!result?.ok || !usages.length) {
    const line = el('div', 'note', result?.error || 'Chưa có dữ liệu quota DeepL.');
    if (!result?.ok) line.style.color = 'var(--danger)';
    container.appendChild(line);
    return;
  }
  for (const usage of usages) renderUsageRow(container, usage);
}

/* ------------------------- Giao diện: tab, theme ------------------------- */

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.tabpanel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  location.hash = name;
}

/* ------------------------- Cache bản dịch ------------------------- */

async function refreshCacheStats() {
  const result = await chrome.runtime.sendMessage({ type: 'translationCacheStats' }).catch(() => null);
  $('#cacheCount').textContent = result?.ok ? `${result.entries.toLocaleString('vi-VN')} mục` : '— mục';
}

async function clearCache() {
  const result = await chrome.runtime.sendMessage({ type: 'clearTranslationCache' }).catch(() => null);
  if (!result?.ok) return setStatus(result?.error || 'Không xoá được cache', true);
  await refreshCacheStats();
  setStatus('Đã xoá cache bản dịch');
}

/* ------------------------- Sao lưu / khôi phục -------------------------
 * File backup hay bị chia sẻ hoặc đồng bộ lên cloud nên TUYỆT ĐỐI không được
 * mang theo credential.
 *
 * Dùng danh sách TRẮNG, không phải danh sách đen. Bản đầu lọc bằng danh sách
 * đen 2 phần tử và lấy nguyên chrome.storage.local.get(null) — nghĩa là bất kỳ
 * key nào không nghĩ ra lúc đó đều tự động lọt vào file. Nó lọt thật:
 * 'tm-native-en-openai-key' (Bearer key thô của bản v4.0) không bao giờ bị xoá
 * sau khi ensureConfig migrate, nên ngưởi dùng nâng cấp từ v4.0 xuất cài đặt ra
 * là kèm luôn key — trong khi UI ghi rõ "API key không nằm trong file xuất".
 * Danh sách trắng thì key mới thêm sau này mặc định KHÔNG được xuất. */
const BACKUP_KEYS = [
  ...Object.values(PREFS_KEYS),
  TEMPLATE_KEYS.templates,
  TEMPLATE_KEYS.active,
  GLOSSARY_KEY,
  'tm-fab-position',
  'tm-input-helper-offset',
  'tm-image-target',
];

// Ngôn ngữ đã chọn cho từng site: 'tm-page-translator-language:<hostname>'.
const BACKUP_KEY_PATTERN = /^tm-page-translator-language:/;

function isBackupKey(key) {
  return BACKUP_KEYS.includes(key) || BACKUP_KEY_PATTERN.test(key);
}

function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportSettings() {
  await saveSettings(false);
  const all = await chrome.storage.local.get(null);
  const data = {};
  for (const [key, value] of Object.entries(all)) {
    if (!isBackupKey(key)) continue;
    data[key] = value;
  }
  downloadFile(
    `native-translator-settings-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ version: chrome.runtime.getManifest().version, settings: data }, null, 2),
    'application/json',
  );
  setStatus('Đã xuất cài đặt (không kèm API key)');
}

async function importSettings(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_) {
    return setStatus('File không phải JSON hợp lệ', true);
  }
  const data = parsed?.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  if (!data || typeof data !== 'object') return setStatus('Không đọc được cài đặt trong file', true);

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    // Đối xứng với lúc xuất: chỉ nhận đúng những key được phép, nên file do
    // ngưởi khác đưa không thể ghi đè config API/endpoint hay nhét key lạ.
    if (!isBackupKey(key)) continue;
    clean[key] = value;
  }
  if (!Object.keys(clean).length) return setStatus('File không chứa cài đặt nào dùng được', true);

  await chrome.storage.local.set(clean);
  setStatus(`Đã nhập ${Object.keys(clean).length} mục cài đặt — đang tải lại…`);
  setTimeout(() => location.reload(), 700);
}

async function resetSettings() {
  if (!confirm('Đưa mọi cài đặt về mặc định?\nAPI key, glossary và prompt template sẽ được GIỮ NGUYÊN.')) return;
  const all = await chrome.storage.local.get(null);
  const remove = Object.keys(all).filter(key =>
    isBackupKey(key)
    && key !== GLOSSARY_KEY
    && key !== TEMPLATE_KEYS.templates
    && key !== TEMPLATE_KEYS.active);
  await chrome.storage.local.remove(remove);
  setStatus('Đã về mặc định — đang tải lại…');
  setTimeout(() => location.reload(), 700);
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}
$('#save').addEventListener('click', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#testApi').addEventListener('click', () => testApi().catch(error => setStatus(error.message, true)));
$('#preferred').addEventListener('change', () => { config.preferred = $('#preferred').value; markDirty(); });
$('#tone').addEventListener('change', () => { config.tone = $('#tone').value; markDirty(); });
$('#uiTheme').addEventListener('change', () => applyTheme($('#uiTheme').value));
$('#cacheClear').addEventListener('click', () => clearCache().catch(error => setStatus(error.message, true)));
$('#settingsExport').addEventListener('click', () => exportSettings().catch(error => setStatus(error.message, true)));
$('#settingsImport').addEventListener('click', () => $('#settingsFile').click());
$('#settingsFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) await importSettings(file).catch(error => setStatus(error.message, true));
});
$('#settingsReset').addEventListener('click', () => resetSettings().catch(error => setStatus(error.message, true)));

// Đóng tab khi còn thay đổi chưa lưu → cảnh báo thay vì mất im lặng.
window.addEventListener('beforeunload', event => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});
$('#refreshDeeplUsage').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await renderDeeplUsage();
  } finally {
    button.disabled = false;
  }
});
// Prompt Templates.
$('#tplSave').addEventListener('click', () => saveTemplateForm().catch(error => setStatus(error.message, true)));
$('#tplCancel').addEventListener('click', resetTemplateForm);
// Glossary.
$('#glossaryAdd').addEventListener('click', () => addGlossaryEntry().catch(error => setStatus(error.message, true)));
$('#glossaryTarget').addEventListener('keydown', event => {
  if (event.key === 'Enter') addGlossaryEntry().catch(error => setStatus(error.message, true));
});
$('#glossaryImport').addEventListener('click', () => $('#glossaryFile').click());
$('#glossaryFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) await importGlossaryFile(file).catch(error => setStatus(error.message, true));
});
$('#glossaryExportJson').addEventListener('click', () => exportGlossary('json'));
$('#glossaryExportCsv').addEventListener('click', () => exportGlossary('csv'));
// TTS: hiển thị giá trị tốc độ đọc ngay khi kéo slider.
$('#ttsRate').addEventListener('input', () => { $('#ttsRateValue').textContent = $('#ttsRate').value; });

// Mọi control prefs đều bật cờ "chưa lưu" — trước đây chỉ có provider mới bẩn.
for (const control of document.querySelectorAll('.tabpanel input, .tabpanel select, .tabpanel textarea')) {
  if (control.type === 'file') continue;
  control.addEventListener('change', markDirty);
}

/* Popup lưu ngay khi đổi, trang này lưu khi bấm nút. Mở cả hai cùng lúc thì
 * trang này đang giữ ảnh chụp cũ và sẽ ghi đè thay đổi vừa làm ở popup.
 * Quay lại tab mà chưa có gì chưa lưu → nạp lại từ storage. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden || dirty) return;
  Promise.all([loadConfig(), loadPrefs()])
    .then(() => {
      $('#tone').value = config.tone;
      renderPreferredSelect();
      renderProviders();
      markClean();
    })
    .catch(() => { /* nạp lại thất bại: giữ nguyên màn hình đang có */ });
});

(async () => {
  try {
    $('#versionPill').textContent = `v${chrome.runtime.getManifest().version}`;
    const hash = location.hash.replace('#', '');
    if (document.querySelector(`.tab[data-tab="${CSS.escape(hash)}"]`)) selectTab(hash);

    await loadConfig();
    $('#tone').value = config.tone;
    renderPreferredSelect();
    renderProviders();
    await loadPrefs();
    await loadTemplates();
    await loadGlossary();
    markClean();
    document.body.dataset.ready = 'true';
    renderDeeplUsage();
    refreshCacheStats();
  } catch (error) {
    document.body.dataset.ready = 'true';
    setStatus(error.message, true);
  }
})();
