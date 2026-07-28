/* Test cho tts.js — chạy: node tests/tts.test.js */
'use strict';

const TTS = require('../tts.js');

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

// 1. Kiểm tra chunkText
{
  const chunks = TTS.chunkText('Xin chào. Đây là bản dịch thử nghiệm!');
  check('chunkText chia đoạn ranh giới câu', chunks.length > 0);
  check('mỗi đoạn <= MAX_CHUNK_CHARS', chunks.every(c => c.length <= TTS.MAX_CHUNK_CHARS));
}

// 2. Kiểm tra API exports
eq('TTS.speak tồn tại', typeof TTS.speak, 'function');
eq('TTS.stop tồn tại', typeof TTS.stop, 'function');
eq('TTS.isSpeaking tồn tại', typeof TTS.isSpeaking, 'function');
eq('TTS.pickVoice tồn tại', typeof TTS.pickVoice, 'function');

if (failed > 0) {
  console.error(`\n✘ Có ${failed} test thất bại!`);
  process.exit(1);
} else {
  console.log(`    Tất cả test tts.js đều PASS ✔ (${passed} test)`);
}
