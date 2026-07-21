/* Test cho doc-detect.js — chạy: node tests/doc-detect.test.js */
'use strict';

const DOC_DETECT = require('../doc-detect.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`✘ ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `nhận ${JSON.stringify(actual)}, muốn ${JSON.stringify(expected)}`);
}

function expectDoc(name, url, reason) {
  const result = DOC_DETECT.isDocumentationPage(url);
  eq(`${name} -> isDoc`, result.isDoc, true);
  if (reason !== undefined) eq(`${name} -> reason`, result.reason, reason);
}

function expectNotDoc(name, url) {
  const result = DOC_DETECT.isDocumentationPage(url);
  eq(`${name} -> không phải docs`, result.isDoc, false);
  eq(`${name} -> reason rỗng`, result.reason, '');
}

/* 1. Hostname known list */
expectDoc('MDN', 'https://developer.mozilla.org/en-US/docs/Web/API', 'developer.mozilla.org');
expectDoc('GitHub repo', 'https://github.com/user/repo', 'github.com');
expectDoc('StackOverflow', 'https://stackoverflow.com/questions/123/abc', 'stackoverflow.com');
expectDoc('docs.rs', 'https://docs.rs/serde/latest/serde/', 'docs.rs');
expectDoc('npmjs', 'https://www.npmjs.com/package/react'.replace('www.', ''), 'npmjs.com');
expectDoc('learn.microsoft.com', 'https://learn.microsoft.com/en-us/dotnet/', 'learn.microsoft.com');
expectDoc('developer.chrome.com', 'https://developer.chrome.com/docs/extensions', 'developer.chrome.com');

/* 2. Hostname suffix */
expectDoc('stackexchange subdomain', 'https://unix.stackexchange.com/questions/1', '*.stackexchange.com');
expectDoc('readthedocs', 'https://flask.readthedocs.io/en/latest/', '*.readthedocs.io');

/* 3. Subdomain prefix */
expectDoc('docs.example.com', 'https://docs.example.com/guide', 'docs.*');
expectDoc('developer.example.com', 'https://developer.example.com/', 'developer.*');
expectDoc('api.example.com', 'https://api.example.com/v1', 'api.*');
expectDoc('dev.example.com', 'https://dev.example.com/blog', 'dev.*');

/* 4. Path pattern */
expectDoc('path /docs/', 'https://example.com/en/docs/getting-started', 'path:/docs/');
expectDoc('path /api-reference/', 'https://example.com/api-reference/v2/users', 'path:/api-reference/');
expectDoc('path /wiki/', 'https://example.org/wiki/Page', 'path:/wiki/');

/* 5. Case-insensitive */
{
  const result = DOC_DETECT.isDocumentationPage('HTTPS://DEVELOPER.MOZILLA.ORG/En-US/Docs/Web');
  eq('URL hoa -> isDoc', result.isDoc, true);
}

/* 6. Negative */
expectNotDoc('example.com', 'https://example.com/');
expectNotDoc('news site', 'https://vnexpress.net/the-thao/bong-da');
expectNotDoc('blog thường', 'https://medium.com/@user/bai-viet');
expectNotDoc('path chỉ /doc/ không phải /docs/', 'https://example.com/doc/file');
expectNotDoc('subdomain không khớp (mydocs.)', 'https://mydocs.example.com/');

/* 7. URL không hợp lệ */
{
  const result = DOC_DETECT.isDocumentationPage('không phải url');
  eq('URL lỗi, không doc -> false', result.isDoc, false);
}

/* 8. DOM heuristic qua fake doc object */
function fakeDoc(codeBlocks, bodyChars) {
  return {
    querySelectorAll(selector) {
      eq('fake doc nhận selector pre, code', selector, 'pre, code');
      return codeBlocks.map(text => ({ textContent: text }));
    },
    body: { innerText: 'x'.repeat(bodyChars) },
  };
}
{
  // 3 block code, code chiếm 30% body -> dom
  const code = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
  const result = DOC_DETECT.isDocumentationPage('https://example.com/blog', fakeDoc(code, 1000));
  eq('DOM heuristic -> isDoc', result.isDoc, true);
  eq('DOM heuristic -> reason dom', result.reason, 'dom');
}
{
  // chỉ 2 block -> không đủ
  const code = ['a'.repeat(500), 'b'.repeat(500)];
  const result = DOC_DETECT.isDocumentationPage('https://example.com/blog', fakeDoc(code, 1000));
  eq('ít hơn 3 block code -> false', result.isDoc, false);
}
{
  // 4 block nhưng code chỉ 5% body -> không đủ tỷ trọng
  const code = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10), 'd'.repeat(20)];
  const result = DOC_DETECT.isDocumentationPage('https://example.com/blog', fakeDoc(code, 1000));
  eq('code dưới 15% body -> false', result.isDoc, false);
}
{
  // body rỗng -> false
  const code = ['a', 'b', 'c'];
  const result = DOC_DETECT.isDocumentationPage('https://example.com/blog', fakeDoc(code, 0));
  eq('body rỗng -> false', result.isDoc, false);
}
{
  // URL đã match thì không cần DOM (vẫn isDoc kể cả doc null)
  const result = DOC_DETECT.isDocumentationPage('https://github.com/a/b', null);
  eq('URL match + doc null -> isDoc', result.isDoc, true);
}

console.log(failed ? `\n${failed} test FAIL, ${passed} PASS` : `Tất cả test doc-detect.js đều PASS ✔ (${passed} test)`);
process.exit(failed ? 1 : 0);
