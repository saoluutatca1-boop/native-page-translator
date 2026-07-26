/* Test thuần node cho icons.js — chạy: node tests/icons.test.js
 *
 * Icon hỏng không làm test nào khác đỏ: nó chỉ lặng lẽ biến mất khỏi giao diện.
 * Nên phần lớn test ở đây kiểm tra tính toàn vẹn: markup hợp lệ, và MỌI tên
 * icon mà HTML/JS gọi tới đều thật sự có trong bộ.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ICONS = require('../icons.js');

const ROOT = path.join(__dirname, '..');

function run() {
  const names = ICONS.names();

  // 1. Bộ icon không rỗng và mọi nét vẽ đều là path/circle/rect hợp lệ
  {
    assert.ok(names.length >= 30, `chỉ có ${names.length} icon`);
    for (const name of names) {
      const markup = ICONS.PATHS[name];
      assert.match(markup, /^<(path|circle|rect|ellipse)/, `${name}: nét vẽ lạ`);
      // Thẻ mở và thẻ đóng phải cân nhau (mọi phần tử đều tự đóng bằng "/>").
      const open = (markup.match(/</g) || []).length;
      const close = (markup.match(/\/>/g) || []).length;
      assert.equal(open, close, `${name}: có thẻ chưa đóng`);
      // Chỉ được dùng currentColor / none: màu cứng là icon không đổi theo theme.
      for (const [, value] of markup.matchAll(/\b(?:stroke|fill)="([^"]+)"/g)) {
        assert.ok(['currentColor', 'none'].includes(value), `${name}: màu cứng "${value}"`);
      }
    }
  }

  // 2. svg(): đúng viewBox 24, kích thước theo tham số, luôn ẩn với screen reader
  {
    const markup = ICONS.svg('key', { size: 18, className: 'ico' });
    assert.match(markup, /viewBox="0 0 24 24"/);
    assert.match(markup, /width="18" height="18"/);
    assert.match(markup, /class="ico"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /stroke="currentColor"/);
    assert.equal(ICONS.svg('khong-ton-tai'), '', 'tên lạ phải trả chuỗi rỗng, không ném lỗi');
    assert.equal(ICONS.has('key'), true);
    assert.equal(ICONS.has('khong-ton-tai'), false);
  }

  // 3. brand(): mỗi lần gọi một gradient id riêng — trùng id là mọi badge dính
  //    chung một màu của cái vẽ đầu tiên.
  {
    const a = ICONS.brand('deepl');
    const b = ICONS.brand('gemini');
    const idA = /id="([^"]+)"/.exec(a)[1];
    const idB = /id="([^"]+)"/.exec(b)[1];
    assert.notEqual(idA, idB);
    assert.match(a, new RegExp(`fill="url\\(#${idA}\\)"`));

    // Slot tùy chỉnh đổi màu theo số thứ tự.
    const custom2 = ICONS.brand('openai', { custom: 2 });
    const custom3 = ICONS.brand('openai', { custom: 3 });
    const color = markup => /stop-color="([^"]+)"/.exec(markup)[1];
    assert.notEqual(color(custom2), color(custom3));

    // Tên provider lạ vẫn ra badge (fallback openai) chứ không vỡ giao diện.
    assert.match(ICONS.brand('khong-biet'), /^<svg/);
  }

  // 4. logo(): kích thước theo tham số, có gradient riêng
  {
    assert.match(ICONS.logo(40), /width="40" height="40"/);
    assert.match(ICONS.logo(), /viewBox="0 0 32 32"/);
  }

  // 5. MỌI tên icon dùng trong HTML/JS phải tồn tại — bắt lỗi gõ sai tên, thứ
  //    mà trên giao diện chỉ hiện ra dưới dạng "chỗ đó trống trơn".
  {
    const missing = [];
    for (const file of ['popup.html', 'options.html', 'pdf-viewer.html']) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of html.matchAll(/data-icon="([^"]+)"/g)) {
        if (!ICONS.has(match[1])) missing.push(`${file}: ${match[1]}`);
      }
    }
    for (const file of ['popup.js', 'options.js', 'content.js']) {
      const js = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of js.matchAll(/(?:NPT_ICONS|ICON)\??\.svg\('([^']+)'/g)) {
        if (!ICONS.has(match[1])) missing.push(`${file}: ${match[1]}`);
      }
      for (const match of js.matchAll(/\bicon\('([^']+)'/g)) {
        if (!ICONS.has(match[1])) missing.push(`${file}: ${match[1]}`);
      }
    }
    assert.deepEqual(missing, [], `tên icon không tồn tại: ${missing.join(', ')}`);
  }

  // 6. hydrate() điền đúng chỗ và bỏ qua tên lạ (giả lập DOM tối giản)
  {
    const nodes = [
      { dataset: { icon: 'key' }, innerHTML: '' },
      { dataset: { icon: 'gear', iconSize: '20' }, innerHTML: '' },
      { dataset: { icon: 'khong-ton-tai' }, innerHTML: '' },
    ];
    ICONS.hydrate({ querySelectorAll: () => nodes });
    assert.match(nodes[0].innerHTML, /^<svg/);
    assert.match(nodes[1].innerHTML, /width="20"/);
    assert.equal(nodes[2].innerHTML, '', 'tên lạ thì để nguyên, không nhét markup rác');
    assert.equal(nodes[0].dataset.iconReady, '1');
  }

  console.log(`Tất cả test icons.js đều PASS ✔ (${names.length} icon)`);
}

run();
