const KEYS = {
  apiUrl: 'tm-native-en-api-url',
  apiKey: 'tm-native-en-openai-key',
  model: 'tm-native-en-openai-model',
  apiFormat: 'tm-native-en-api-format',
  context: 'tm-native-en-use-context',
  defaultMode: 'tm-native-en-default-mode',
  fallbackQuick: 'tm-native-en-fallback-quick',
};

const BUILTIN_ORIGINS = new Set([
  'https://api.openai.com',
  'https://translate.googleapis.com',
  'https://translate.google.com',
  'https://api.mymemory.translated.net',
]);

const $ = selector => document.querySelector(selector);
const status = $('#status');

function setStatus(text, error = false) {
  status.textContent = text;
  status.style.color = error ? '#fca5a5' : '#93c5fd';
}

function readForm() {
  return {
    [KEYS.apiUrl]: $('#apiUrl').value.trim() || 'https://api.openai.com/v1/responses',
    [KEYS.apiKey]: $('#apiKey').value.trim(),
    [KEYS.model]: $('#model').value.trim() || 'gpt-5-mini',
    [KEYS.apiFormat]: $('#apiFormat').value,
    [KEYS.context]: $('#useContext').checked,
    [KEYS.defaultMode]: $('#defaultMode').value,
    [KEYS.fallbackQuick]: $('#fallbackQuick').checked,
  };
}

async function requestEndpointPermission(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    throw new Error('API URL không hợp lệ');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API URL phải dùng HTTP/HTTPS');
  if (BUILTIN_ORIGINS.has(url.origin)) return true;

  const pattern = `${url.origin}/*`;
  return chrome.permissions.request({ origins: [pattern] });
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
  const values = await chrome.storage.local.get(Object.values(KEYS));
  $('#apiUrl').value = values[KEYS.apiUrl] || 'https://api.openai.com/v1/responses';
  $('#apiKey').value = values[KEYS.apiKey] || '';
  $('#model').value = values[KEYS.model] || 'gpt-5-mini';
  $('#apiFormat').value = values[KEYS.apiFormat] || 'auto';
  $('#useContext').checked = values[KEYS.context] !== false;
  $('#defaultMode').value = values[KEYS.defaultMode] === 'quick' ? 'quick' : 'native';
  $('#fallbackQuick').checked = values[KEYS.fallbackQuick] !== false;
}

async function saveSettings(showSaved = true) {
  const values = readForm();
  const granted = await requestEndpointPermission(values[KEYS.apiUrl]);
  if (!granted) throw new Error('M chưa cấp quyền truy cập API URL này');
  await chrome.storage.local.set(values);
  if (showSaved) setStatus('Đã lưu cài đặt');
  return values;
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
  if (!result?.ok) throw new Error(result?.error || 'API test thất bại');
  setStatus(`API hoạt động:\n${result.text}`);
}

document.querySelectorAll('[data-lang]').forEach(button => {
  button.addEventListener('click', () => setPageLanguage(button.dataset.lang).catch(error => setStatus(error.message, true)));
});
$('#save').addEventListener('click', () => saveSettings().catch(error => setStatus(error.message, true)));
$('#testApi').addEventListener('click', () => testApi().catch(error => setStatus(error.message, true)));
$('#openOptions')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
loadSettings().catch(error => setStatus(error.message, true));
