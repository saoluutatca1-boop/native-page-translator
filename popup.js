/* Popup — tác vụ nhanh: dịch trang, chọn chế độ, xem trạng thái provider. */
'use strict';

const { CONFIG_STORAGE_KEY, normalizeConfig } = globalThis.NPT_PROVIDERS;

const KEYS = {
  defaultMode: 'tm-native-en-default-mode',
  fallbackQuick: 'tm-native-en-fallback-quick',
  pageUseProvider: 'tm-page-use-provider',
  inputHelper: 'tm-input-helper-enabled',
  pageDisplayMode: 'tm-page-display-mode',
  pageStyle: 'tm-page-style',
  pageDialect: 'tm-page-dialect',
  pageTranslateMode: 'tm-page-translate-mode',
  pageGrammarFix: 'tm-page-grammar-fix',
};

// Giá trị hợp lệ của văn phong trang — sai thì về 'natural' theo contract.
const PAGE_STYLE_VALUES = ['natural', 'casual', 'work-email', 'game-chat', 'genz', 'formal'];

const $ = selector => document.querySelector(selector);
const statusElement = $('#status');

function setStatus(text, error = false) {
  statusElement.textContent = text;
  statusElement.style.color = error ? '#fca5a5' : '#93c5fd';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function setPageLanguage(language) {
  const tab = await getActiveTab();
  if (!tab?.id) return setStatus('Không tìm thấy tab hiện tại', true);
  const injected = await ensureInjected(tab.id);
  if (!injected) return setStatus('Trang này không cho extension chạy', true);

  const result = await chrome.runtime.sendMessage({
    type: 'broadcastPageLanguage',
    tabId: tab.id,
    language,
  });
  setStatus(result?.ok ? 'Đã gửi lệnh dịch' : 'Không thể điều khiển trang này', !result?.ok);
}

async function loadSettings() {
  const values = await chrome.storage.local.get([...Object.values(KEYS), CONFIG_STORAGE_KEY]);
  $('#defaultMode').value = values[KEYS.defaultMode] === 'quick' ? 'quick' : 'native';
  $('#fallbackQuick').checked = values[KEYS.fallbackQuick] !== false;
  $('#pageUseProvider').checked = values[KEYS.pageUseProvider] !== false;
  $('#inputHelper').checked = values[KEYS.inputHelper] !== false;
  $('#tone').value = normalizeConfig(values[CONFIG_STORAGE_KEY]).tone;
  // Dịch trang nâng cao — default khớp contract khi storage chưa có key.
  $('#pageDisplayMode').value = values[KEYS.pageDisplayMode] === 'bilingual' ? 'bilingual' : 'replace';
  $('#pageStyle').value = PAGE_STYLE_VALUES.includes(values[KEYS.pageStyle]) ? values[KEYS.pageStyle] : 'natural';
  $('#pageDialect').value = values[KEYS.pageDialect] === 'uk' ? 'uk' : 'us';
  $('#pageTranslateMode').value = values[KEYS.pageTranslateMode] === 'literal' ? 'literal' : 'natural';
  $('#pageGrammarFix').checked = values[KEYS.pageGrammarFix] === true;
}

async function saveSettings() {
  await chrome.storage.local.set({
    [KEYS.defaultMode]: $('#defaultMode').value,
    [KEYS.fallbackQuick]: $('#fallbackQuick').checked,
    [KEYS.pageUseProvider]: $('#pageUseProvider').checked,
    [KEYS.inputHelper]: $('#inputHelper').checked,
    [KEYS.pageDisplayMode]: $('#pageDisplayMode').value,
    [KEYS.pageStyle]: $('#pageStyle').value,
    [KEYS.pageDialect]: $('#pageDialect').value,
    [KEYS.pageTranslateMode]: $('#pageTranslateMode').value,
    [KEYS.pageGrammarFix]: $('#pageGrammarFix').checked,
  });
}

async function saveTone() {
  const values = await chrome.storage.local.get([CONFIG_STORAGE_KEY]);
  const config = normalizeConfig(values[CONFIG_STORAGE_KEY]);
  config.tone = $('#tone').value;
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: config });
}

async function loadProviderStatus() {
  const element = $('#providerStatus');
  const result = await chrome.runtime.sendMessage({ type: 'getProviderStatus' }).catch(() => null);
  if (!result?.ok || !result.configured) {
    element.textContent = 'Chưa cấu hình provider nào — bấm "Quản lý key" để thêm API key.';
    return;
  }

  const parts = result.active.map(id => {
    const provider = result.providers[id];
    return `${provider?.label || id} (${provider?.keyCount || 0} key)`;
  });
  element.textContent = `Đang dùng: ${parts.join(' → ')}`;
}

async function testApi() {
  setStatus('Đang test API…');
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

document.querySelectorAll('[data-lang]').forEach(button => {
  button.addEventListener('click', () => setPageLanguage(button.dataset.lang).catch(error => setStatus(error.message, true)));
});
$('#defaultMode').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#fallbackQuick').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#pageUseProvider').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#inputHelper').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#tone').addEventListener('change', () => saveTone().catch(error => setStatus(error.message, true)));
// Dịch trang nâng cao: lưu ngay khi đổi — content.js tự nghe storage.onChanged, không gọi lại vào trang.
$('#pageDisplayMode').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#pageStyle').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#pageDialect').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#pageTranslateMode').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#pageGrammarFix').addEventListener('change', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#testApi').addEventListener('click', () => testApi().catch(error => setStatus(error.message, true)));
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#openOptions2').addEventListener('click', () => chrome.runtime.openOptionsPage());

loadSettings().catch(error => setStatus(error.message, true));
loadProviderStatus();
