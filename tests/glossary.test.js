/* Test cho glossary.js — chạy: node tests/glossary.test.js */
'use strict';

const GLOSSARY = require('../glossary.js');

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

/* 1. normalize: trim, bỏ rỗng, giữ thứ tự */
{
  const out = GLOSSARY.normalize([
    { source: '  hello ', target: ' xin chào ' },
    { source: '', target: 'bỏ' },
    { source: 'thiếu target' },
    null,
    'không phải object',
    { source: 'world', target: 'thế giới' },
  ]);
  eq('normalize bỏ entry rỗng/lỗi', JSON.stringify(out),
    JSON.stringify([{ source: 'hello', target: 'xin chào' }, { source: 'world', target: 'thế giới' }]));
}
eq('normalize input không phải array -> []', JSON.stringify(GLOSSARY.normalize('abc')), '[]');
eq('normalize undefined -> []', JSON.stringify(GLOSSARY.normalize()), '[]');

/* 2. normalize: dedupe theo source case-insensitive, entry sau ghi đè */
{
  const out = GLOSSARY.normalize([
    { source: 'API', target: 'giao diện lập trình' },
    { source: 'api', target: 'API' },
    { source: 'other', target: 'khác' },
  ]);
  eq('dedupe giữ 1 entry', out.length, 2);
  eq('entry sau ghi đè target', out[0].target, 'API');
  eq('ghi đè giữ source của entry sau', out[0].source, 'api');
}

/* 3. normalize: cap 500 entries */
{
  const many = [];
  for (let i = 0; i < 600; i++) many.push({ source: `s${i}`, target: `t${i}` });
  eq('cap 500 entries', GLOSSARY.normalize(many).length, 500);
}

/* 4. toPromptText: dòng "- source => target", cap 200 */
{
  eq('toPromptText 1 dòng', GLOSSARY.toPromptText([{ source: 'a', target: 'b' }]), '- a => b');
  eq('toPromptText nhiều dòng',
    GLOSSARY.toPromptText([{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }]),
    '- a => b\n- c => d');
  eq('toPromptText rỗng -> chuỗi rỗng', GLOSSARY.toPromptText([]), '');
  const many = [];
  for (let i = 0; i < 300; i++) many.push({ source: `s${i}`, target: `t${i}` });
  eq('toPromptText cap 200 dòng', GLOSSARY.toPromptText(many).split('\n').length, 200);
}

/* 5. parse: JSON array */
{
  const out = GLOSSARY.parse('[{"source":"a","target":"b"},{"source":"c","target":"d"}]');
  eq('parse JSON array', JSON.stringify(out),
    JSON.stringify([{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }]));
}
{
  const out = GLOSSARY.parse('[\n  { "source": "x", "target": "y" }\n]');
  eq('parse JSON pretty', JSON.stringify(out), JSON.stringify([{ source: 'x', target: 'y' }]));
}

/* 6. parse: CSV + header + BOM */
{
  const out = GLOSSARY.parse('﻿source,target\nhello,xin chào\nworld,thế giới');
  eq('parse CSV có BOM + header', JSON.stringify(out),
    JSON.stringify([{ source: 'hello', target: 'xin chào' }, { source: 'world', target: 'thế giới' }]));
}
{
  const out = GLOSSARY.parse('"hello, world",xin chào thế giới');
  eq('parse CSV field có ngoặc kép chứa phẩy', JSON.stringify(out),
    JSON.stringify([{ source: 'hello, world', target: 'xin chào thế giới' }]));
}

/* 7. parse: TSV */
{
  const out = GLOSSARY.parse('hello\txin chào\nworld\tthế giới');
  eq('parse TSV', JSON.stringify(out),
    JSON.stringify([{ source: 'hello', target: 'xin chào' }, { source: 'world', target: 'thế giới' }]));
}

/* 8. parse: "source => target" (cũng chính là output toPromptText) */
{
  const out = GLOSSARY.parse('- hello => xin chào\n- world => thế giới');
  eq('parse định dạng =>', JSON.stringify(out),
    JSON.stringify([{ source: '- hello', target: 'xin chào' }, { source: '- world', target: 'thế giới' }]));
}

/* 9. parse: "source: target" */
{
  const out = GLOSSARY.parse('hello: xin chào\nworld: thế giới');
  eq('parse định dạng :', JSON.stringify(out),
    JSON.stringify([{ source: 'hello', target: 'xin chào' }, { source: 'world', target: 'thế giới' }]));
}

/* 10. parse: kết quả đã normalize (bỏ dòng trống/rỗng, dedupe) */
{
  const out = GLOSSARY.parse('a,1\n\n  \nb\na,2');
  eq('parse bỏ dòng trống + dòng thiếu target', JSON.stringify(out),
    JSON.stringify([{ source: 'a', target: '2' }]));
}
eq('parse chuỗi rỗng -> []', JSON.stringify(GLOSSARY.parse('   ')), '[]');

/* 11. serialize json/csv + round-trip */
{
  const entries = [{ source: 'hello', target: 'xin chào' }, { source: 'a,b', target: 'c"d' }];
  const json = GLOSSARY.serialize(entries, 'json');
  eq('serialize json', json, JSON.stringify(entries, null, 2));
  eq('round-trip json', JSON.stringify(GLOSSARY.parse(json)), JSON.stringify(entries));

  const csv = GLOSSARY.serialize(entries, 'csv');
  eq('serialize csv quote field đặc biệt', csv, 'hello,xin chào\n"a,b","c""d"');
  eq('round-trip csv', JSON.stringify(GLOSSARY.parse(csv)), JSON.stringify(entries));

  eq('serialize format lạ -> json', GLOSSARY.serialize(entries, 'yaml'),
    JSON.stringify(entries, null, 2));
}

console.log(failed ? `\n${failed} test FAIL, ${passed} PASS` : `Tất cả test glossary.js đều PASS ✔ (${passed} test)`);
process.exit(failed ? 1 : 0);
