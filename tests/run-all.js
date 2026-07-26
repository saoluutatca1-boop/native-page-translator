/* Chạy toàn bộ test suite: node tests/run-all.js (hoặc npm test).
 *
 * Mỗi file test là một script node độc lập tự assert rồi in dòng PASS. Trước
 * đây phải nhớ và gõ tay từng file — thiếu một file là mất luôn phần đó khỏi
 * vòng kiểm tra. Runner này tự tìm mọi *.test.js, chạy trong tiến trình riêng
 * (để một file crash không kéo theo file khác) và trả exit code khác 0 nếu có
 * bất kỳ file nào hỏng.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
// Cú pháp toàn bộ source phải parse được, kể cả file không có test riêng.
const SYNTAX_CHECK_FILES = [
  'background.js',
  'content.js',
  'providers.js',
  'popup.js',
  'options.js',
  'pdf-viewer.js',
  'fancy-text.js',
  'glossary.js',
  'doc-detect.js',
  'tts.js',
];

function runNode(args, label) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const ms = Date.now() - started;
  const ok = result.status === 0;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.log(`${ok ? '✔' : '✘'} ${label} (${ms}ms)`);
  if (output) {
    console.log(output.split('\n').map(line => `    ${line}`).join('\n'));
  }
  return ok;
}

function main() {
  const root = path.join(TESTS_DIR, '..');
  let failed = 0;

  console.log('— Kiểm tra cú pháp —');
  for (const file of SYNTAX_CHECK_FILES) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      console.log(`✘ ${file} (không tồn tại)`);
      failed++;
      continue;
    }
    if (!runNode(['--check', full], file)) failed++;
  }

  // manifest.json phải là JSON hợp lệ và khớp version với package.json.
  console.log('\n— Manifest —');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.version !== pkg.version) {
      throw new Error(`version lệch: manifest ${manifest.version} vs package ${pkg.version}`);
    }
    for (const file of manifest.content_scripts?.[0]?.js || []) {
      if (!fs.existsSync(path.join(root, file))) throw new Error(`content script thiếu file: ${file}`);
    }
    console.log(`✔ manifest.json hợp lệ (v${manifest.version})`);
  } catch (error) {
    console.log(`✘ manifest.json — ${error.message}`);
    failed++;
  }

  console.log('\n— Test —');
  const testFiles = fs.readdirSync(TESTS_DIR)
    .filter(name => name.endsWith('.test.js'))
    .sort();
  for (const name of testFiles) {
    if (!runNode([path.join(TESTS_DIR, name)], name)) failed++;
  }

  console.log('');
  if (failed) {
    console.log(`${failed} mục THẤT BẠI`);
    process.exit(1);
  }
  console.log(`Tất cả ${SYNTAX_CHECK_FILES.length + 1 + testFiles.length} mục đều PASS ✔`);
}

main();
