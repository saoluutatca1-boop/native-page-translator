/* ========================================================================
 * NPT TTS — đọc to bản dịch / tóm tắt bằng speechSynthesis.
 *
 * - speak(text, lang, rate): chọn voice khớp 'vi'/'en' (fallback voice mặc
 *   định); text dài tự chunk thành utterance ≤200 ký tự (cắt theo ranh giới
 *   câu) để tránh giới hạn utterance của Chrome; cancel() trước khi nói mới.
 * - stop(), isSpeaking().
 * - Không có speechSynthesis (node, môi trường lạ) → mọi hàm no-op.
 *
 * JS thuần (không chrome.*): chạy được trong content script lẫn node (test).
 * ====================================================================== */
(function attachTts(global) {
  'use strict';

  const MAX_CHUNK_CHARS = 200;
  let speaking = false;

  function synth() {
    return typeof global.speechSynthesis !== 'undefined' ? global.speechSynthesis : null;
  }

  /* Cắt text dài thành các đoạn ≤ MAX_CHUNK_CHARS, ưu tiên ranh giới câu
   * (. ! ? ; , xuống dòng), fallback cắt theo khoảng trắng. */
  function chunkText(text) {
    const chunks = [];
    let rest = String(text || '').trim();
    while (rest.length > MAX_CHUNK_CHARS) {
      const window_ = rest.slice(0, MAX_CHUNK_CHARS);
      let cut = -1;
      for (const mark of ['. ', '! ', '? ', '。', '；', '; ', ', ', '\n', ' ']) {
        const index = window_.lastIndexOf(mark);
        if (index >= 0 && index + mark.length > cut) cut = index + mark.length;
      }
      if (cut < MAX_CHUNK_CHARS * 0.4) cut = MAX_CHUNK_CHARS; // không có ranh giới đẹp → cắt cứng
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  function pickVoice(lang) {
    const engine = synth();
    if (!engine || typeof engine.getVoices !== 'function') return null;
    const wanted = String(lang || '').toLowerCase();
    const voices = engine.getVoices() || [];
    return (
      voices.find(voice => String(voice.lang || '').toLowerCase().startsWith(wanted)) ||
      voices.find(voice => String(voice.lang || '').toLowerCase().startsWith(wanted.slice(0, 2))) ||
      null
    );
  }

  function speak(text, lang, rate = 1) {
    const engine = synth();
    if (!engine || typeof global.SpeechSynthesisUtterance !== 'function') return;
    engine.cancel(); // huỷ lượt đang nói trước khi xếp lượt mới

    const chunks = chunkText(text);
    if (!chunks.length) return;

    const voice = pickVoice(lang);
    const safeRate = Number.isFinite(Number(rate)) ? Math.min(3, Math.max(0.5, Number(rate))) : 1;
    speaking = true;

    chunks.forEach((chunk, index) => {
      const utterance = new global.SpeechSynthesisUtterance(chunk);
      utterance.lang = lang === 'vi' ? 'vi-VN' : lang === 'en' ? 'en-US' : String(lang || '');
      if (voice) utterance.voice = voice;
      utterance.rate = safeRate;
      if (index === chunks.length - 1) {
        const done = () => { speaking = false; };
        utterance.onend = done;
        utterance.onerror = done;
      }
      engine.speak(utterance);
    });
  }

  function stop() {
    const engine = synth();
    if (engine) engine.cancel();
    speaking = false;
  }

  function isSpeaking() {
    const engine = synth();
    return Boolean(engine && speaking && (engine.speaking || engine.pending));
  }

  const api = { speak, stop, isSpeaking, chunkText, MAX_CHUNK_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_TTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
