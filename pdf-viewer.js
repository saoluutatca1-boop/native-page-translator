/* Trang Dịch PDF — trích xuất text bằng pdf.js, dịch theo batch qua background,
 * hiển thị song ngữ / chỉ bản dịch / chỉ gốc. Bản dịch dạng văn bản, không giữ layout. */
'use strict';

/* pdf.js 4.3.136 — bản ESM duy nhất (4.x bỏ UMD), đã vá CVE-2024-4367 gốc.
 * Load dạng ES module: pdf-viewer.html khai báo <script type="module" src="pdf-viewer.js">,
 * nên file này import trực tiếp thay vì dùng global pdfjsLib như bản 3.x. */
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

// Worker cũng là bản ESM (.mjs) — pdf.js 4.x tự spawn module worker.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const CHAR_CAP = 60000;          // cap tổng ký tự trích xuất — vượt thì dừng + banner.
// Background chấp nhận 64 đoạn / 20000 ký tự mỗi request — gom sát trần (chừa
// headroom) thay vì 25/12000, và chạy 3 batch song song. PDF vài trăm đoạn
// trước đây đi tuần tự từng batch nhỏ nên chờ rất lâu.
const BATCH_MAX_TEXTS = 48;      // tối đa đoạn mỗi batch dịch.
const BATCH_MAX_CHARS = 15000;   // tối đa ký tự mỗi batch dịch.
const BATCH_CONCURRENCY = 3;     // số batch chạy song song.
const Y_TOLERANCE = 2;           // gom item cùng dòng theo toạ độ y.

const $ = selector => document.querySelector(selector);

// icons.js nạp trước ở dạng script thường -> logo/icon lấy từ global chung.
$('#brandLogo').innerHTML = globalThis.NPT_ICONS?.logo(28) || '';
globalThis.NPT_ICONS?.hydrate();

// Kết quả giữ trong bộ nhớ để đổi chế độ hiển thị không cần dịch lại.
// pages = [{ pageNumber, paragraphs: [{ original, translation }] }]
let pages = [];
let pendingUrl = null;

function setProgress(text, ratio = null) {
  $('#progressText').textContent = text;
  if (ratio === null) return;
  $('#progressWrap').hidden = false;
  $('#progressFill').style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function showBanner(text) {
  const banner = $('#banner');
  banner.textContent = text;
  banner.hidden = false;
}

function showError(text, { permission = false, settings = false } = {}) {
  $('#errorText').textContent = text;
  $('#btnGrant').hidden = !permission;
  $('#btnOpenSettings').hidden = !settings;
  $('#errorBox').hidden = false;
}

function hideError() {
  $('#errorBox').hidden = true;
  $('#btnGrant').hidden = true;
  $('#btnOpenSettings').hidden = true;
}

function setSourceName(name) {
  $('#sourceName').textContent = name;
  $('#sourceName').title = name;
}

/* ------------------------- Nguồn PDF ------------------------- */

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').pop()) || url;
  } catch (_) {
    return url;
  }
}

async function fetchPdfBytes(url) {
  const result = await chrome.runtime.sendMessage({ type: 'fetchPdf', payload: { url } }).catch(error => ({ ok: false, error: error.message }));
  if (result?.ok) return base64ToBytes(result.base64);
  if (result?.needsPermission || result?.error === 'NO_PERMISSION') {
    pendingUrl = url;
    showError('Extension cần quyền truy cập trang web để tải PDF này.', { permission: true });
    setProgress('Đang chờ cấp quyền…');
    return null;
  }
  throw new Error(result?.error || 'Không tải được PDF');
}

async function loadRemotePdf(url) {
  hideError();
  setSourceName(fileNameFromUrl(url));
  setProgress('Đang tải PDF…', 0);
  const bytes = await fetchPdfBytes(url);
  if (!bytes) return;
  await processPdf(bytes);
}

async function requestPermissionAndRetry() {
  const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
  if (!granted) return showError('Bạn chưa cấp quyền — không tải được PDF từ trang này.');
  if (pendingUrl) {
    const url = pendingUrl;
    pendingUrl = null;
    await loadRemotePdf(url).catch(error => showError(error.message));
  }
}

/* ------------------------- Trích xuất text ------------------------- */

// Gom text item thành dòng theo y (tolerance), rồi gom dòng thành đoạn theo khoảng cách y.
function extractParagraphs(items) {
  const lines = [];
  for (const item of items) {
    const text = (item.str || '').trim();
    if (!text) continue;
    const y = Math.round(item.transform[5]);
    const height = Math.abs(item.transform[3]) || item.height || 10;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= Y_TOLERANCE) {
      last.text += ` ${text}`;
    } else {
      lines.push({ y, height, text });
    }
  }

  const paragraphs = [];
  let current = null;
  for (const line of lines) {
    const gap = current ? Math.abs(current.lastY - line.y) : 0;
    if (current && gap > Math.max(8, line.height * 1.5)) {
      paragraphs.push(current.text);
      current = null;
    }
    if (!current) current = { text: line.text, lastY: line.y };
    else {
      current.text += ` ${line.text}`;
      current.lastY = line.y;
    }
  }
  if (current) paragraphs.push(current.text);
  return paragraphs.filter(text => text.trim());
}

async function processPdf(data) {
  $('#emptyHint')?.remove();
  pages = [];
  // isEvalSupported:false — phòng thủ thứ hai cho CVE-2024-4367 (bản 4.3 đã vá gốc,
  // nhưng tắt eval cũng không ảnh hưởng gì vì ta chỉ trích xuất text, không render glyph).
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

  let totalChars = 0;
  let truncated = false;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    setProgress(`Đang xử lý trang ${pageNumber}/${pdf.numPages}`, (pageNumber - 1) / pdf.numPages * 0.3);
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const extracted = extractParagraphs(textContent.items);

    const paragraphs = [];
    for (const text of extracted) {
      if (totalChars + text.length > CHAR_CAP) {
        truncated = true;
        break;
      }
      totalChars += text.length;
      paragraphs.push({ original: text, translation: '' });
    }
    if (paragraphs.length) pages.push({ pageNumber, paragraphs });
    if (truncated) break;
  }

  if (truncated) showBanner('Tài liệu quá dài, chỉ dịch phần đầu.');
  if (!pages.length) {
    setProgress('');
    showError('Không trích xuất được chữ từ PDF này (có thể là PDF scan dạng ảnh).');
    return;
  }

  renderPages();
  await translateAll();
}

/* ------------------------- Dịch theo batch ------------------------- */

function buildBatches(pending) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of pending) {
    if (current.length && (current.length >= BATCH_MAX_TEXTS || chars + item.text.length > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function translateAll() {
  const targetLanguage = $('#targetLang').value;
  const pending = [];
  pages.forEach((page, pageIndex) => {
    page.paragraphs.forEach((para, paraIndex) => {
      if (!para.translation) pending.push({ pageIndex, paraIndex, text: para.original });
    });
  });
  if (!pending.length) {
    setProgress('Hoàn tất.', 1);
    return;
  }

  const batches = buildBatches(pending);
  let done = 0;
  let cursor = 0;
  let failure = null;

  const runWorker = async () => {
    while (cursor < batches.length && !failure) {
      const batch = batches[cursor++];
      const result = await chrome.runtime.sendMessage({
        type: 'providerTranslate',
        payload: {
          texts: batch.map(item => item.text),
          targetLanguage,
          sourceLanguage: 'auto',
          requestId: crypto.randomUUID(),
        },
      }).catch(error => ({ ok: false, error: error.message }));

      if (!result?.ok) {
        // Batch đầu tiên hỏng thì dừng cả lượt — các worker khác thấy cờ và thoát.
        failure = failure || (result?.error || 'lỗi không rõ');
        return;
      }

      batch.forEach((item, index) => {
        const text = result.translations?.[index] || '';
        pages[item.pageIndex].paragraphs[item.paraIndex].translation = text;
        const el = document.getElementById(`trans-${pages[item.pageIndex].pageNumber}-${item.paraIndex}`);
        if (el) el.textContent = text || '…';
      });
      done += batch.length;
      setProgress(`Đang dịch… ${done}/${pending.length} đoạn`, 0.3 + 0.7 * (done / pending.length));
    }
  };

  setProgress(`Đang dịch… 0/${pending.length} đoạn`, 0.3);
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, runWorker),
  );

  if (failure) {
    showError(
      `Dịch thất bại: ${failure}. Kiểm tra API key/provider trong trang Cài đặt.`,
      { settings: true },
    );
    setProgress(`Đã dịch ${done}/${pending.length} đoạn trước khi lỗi.`);
    return;
  }
  setProgress(`Hoàn tất — đã dịch ${done} đoạn.`, 1);
}

/* ------------------------- Render ------------------------- */

function renderPages() {
  const container = $('#content');
  container.textContent = '';

  for (const page of pages) {
    const block = document.createElement('section');
    block.className = 'page-block';
    const heading = document.createElement('h2');
    heading.className = 'page-heading';
    heading.textContent = `Trang ${page.pageNumber}`;
    block.appendChild(heading);

    for (let pIdx = 0; pIdx < page.paragraphs.length; pIdx++) {
      const para = page.paragraphs[pIdx];
      const row = document.createElement('div');
      row.className = 'para';
      const orig = document.createElement('p');
      orig.className = 'orig';
      orig.textContent = para.original;
      const trans = document.createElement('p');
      trans.className = 'trans';
      trans.id = `trans-${page.pageNumber}-${pIdx}`;
      trans.textContent = para.translation || '…';
      row.append(orig, trans);
      block.appendChild(row);
    }
    container.appendChild(block);
  }
}

/* ------------------------- Events & init ------------------------- */

$('#fileInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  hideError();
  $('#banner').hidden = true;
  setSourceName(file.name);
  setProgress('Đang đọc file…', 0);
  const reader = new FileReader();
  reader.onload = () => processPdf(new Uint8Array(reader.result)).catch(error => showError(error.message));
  reader.onerror = () => showError('Không đọc được file này.');
  reader.readAsArrayBuffer(file);
});

$('#viewMode').addEventListener('change', () => {
  document.body.dataset.view = $('#viewMode').value;
});

$('#targetLang').addEventListener('change', () => {
  if (!pages.length) return;
  // Đổi ngôn ngữ đích → xoá bản dịch cũ và dịch lại.
  for (const page of pages) for (const para of page.paragraphs) para.translation = '';
  hideError();
  translateAll().catch(error => showError(error.message));
});

$('#btnGrant').addEventListener('click', () => requestPermissionAndRetry());
$('#btnOpenSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Theo lựa chọn "Giao diện" trong Cài đặt như popup/options ('auto' = theo hệ thống).
chrome.storage.local.get(['tm-ui-theme']).then(values => {
  const theme = values['tm-ui-theme'];
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
}).catch(() => { /* không đọc được: giữ theo prefers-color-scheme */ });

const sourceUrl = new URLSearchParams(location.search).get('src');
if (sourceUrl) {
  loadRemotePdf(sourceUrl).catch(error => showError(error.message));
}
