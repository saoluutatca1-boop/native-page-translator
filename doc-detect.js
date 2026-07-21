/* ========================================================================
 * NPT Doc Detect — nhận diện trang tài liệu kỹ thuật (docs/API reference/
 * wiki...) để bật "chế độ tài liệu" (giữ nguyên code block, dịch sát nghĩa).
 *
 * isDocumentationPage(urlString, doc?) → { isDoc, reason }
 *   - doc optional (node test không truyền → chỉ xét URL).
 *   - reason: chuỗi ngắn mô tả pattern match ('developer.mozilla.org',
 *     '*.stackexchange.com', 'docs.*', 'path:/docs/', 'dom'; '' khi không phải).
 *
 * JS thuần (không chrome.*): chạy được trong content script lẫn node (test).
 * ====================================================================== */
(function attachDocDetect(global) {
  'use strict';

  const KNOWN_DOC_HOSTNAMES = new Set([
    'developer.mozilla.org',
    'github.com',
    'stackoverflow.com',
    'askubuntu.com',
    'serverfault.com',
    'superuser.com',
    'docs.rs',
    'devdocs.io',
    'learn.microsoft.com',
    'developers.google.com',
    'developer.chrome.com',
    'npmjs.com',
    'pypi.org',
    'rubygems.org',
    'packagist.org',
    'crates.io',
  ]);
  const DOC_HOSTNAME_SUFFIXES = ['.stackexchange.com', '.readthedocs.io'];
  const DOC_SUBDOMAIN_PREFIXES = ['docs.', 'developer.', 'developers.', 'wiki.', 'api.', 'dev.'];
  const DOC_PATH_PATTERNS = ['/docs/', '/documentation/', '/api-reference/', '/reference/', '/wiki/'];

  // DOM heuristic: nhiều khối code VÀ code chiếm tỷ trọng lớn → trang kỹ thuật.
  const DOM_MIN_CODE_BLOCKS = 3;
  const DOM_CODE_TEXT_RATIO = 0.15;

  function detectByUrl(urlString) {
    const url = new URL(String(urlString));
    const hostname = url.hostname.toLowerCase();
    const path = String(url.pathname || '/').toLowerCase();

    if (KNOWN_DOC_HOSTNAMES.has(hostname)) return hostname;
    for (const suffix of DOC_HOSTNAME_SUFFIXES) {
      if (hostname.endsWith(suffix)) return `*${suffix}`;
    }
    for (const prefix of DOC_SUBDOMAIN_PREFIXES) {
      if (hostname.startsWith(prefix)) return `${prefix}*`;
    }
    for (const pattern of DOC_PATH_PATTERNS) {
      if (path.includes(pattern)) return `path:${pattern}`;
    }
    return '';
  }

  function detectByDom(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    let nodes;
    try {
      nodes = doc.querySelectorAll('pre, code');
    } catch (_) {
      return false;
    }
    if (!nodes || nodes.length < DOM_MIN_CODE_BLOCKS) return false;
    let codeChars = 0;
    for (const node of nodes) codeChars += String(node?.textContent || '').length;
    const bodyChars = String(doc.body?.innerText || '').length;
    if (bodyChars <= 0) return false;
    return codeChars / bodyChars > DOM_CODE_TEXT_RATIO;
  }

  function isDocumentationPage(urlString, doc) {
    try {
      const reason = detectByUrl(urlString);
      if (reason) return { isDoc: true, reason };
    } catch (_) {
      // URL không parse được → rơi xuống DOM heuristic.
    }
    if (detectByDom(doc)) return { isDoc: true, reason: 'dom' };
    return { isDoc: false, reason: '' };
  }

  const api = { isDocumentationPage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_DOC_DETECT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
