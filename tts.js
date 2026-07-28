/* ========================================================================
 * NPT TTS — đọc to bản dịch / tóm tắt bằng speechSynthesis + Fallback Audio.
 *
 * - speak(text, lang, rate): chọn voice khớp 'vi'/'en' (fallback voice chuẩn);
 *   nếu máy không có giọng tiếng Việt (vi-VN), tự động dùng Google Translate TTS
 *   fallback để phát đúng 100% giọng Việt tự nhiên thay vì bị nhại giọng Anh.
 * - stop(), isSpeaking().
 *
 * LƯU Ý RIÊNG TƯ: nhánh fallback gửi ĐOẠN VĂN BẢN đang đọc tới endpoint
 * translate_tts của Google. Đây là API không chính thức (có thể bị chặn theo
 * rate-limit bất kỳ lúc nào) và chỉ chạy khi máy KHÔNG có giọng vi-VN.
 * ====================================================================== */
(function attachTts(global) {
  'use strict';

  const MAX_CHUNK_CHARS = 200;
  let speaking = false;
  let currentAudio = null;

  function synth() {
    return typeof global.speechSynthesis !== 'undefined' ? global.speechSynthesis : null;
  }

  function getVoices() {
    const engine = synth();
    if (!engine || typeof engine.getVoices !== 'function') return [];
    return engine.getVoices() || [];
  }

  if (synth() && typeof synth().addEventListener === 'function') {
    synth().addEventListener('voiceschanged', () => getVoices());
  }

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
      if (cut < MAX_CHUNK_CHARS * 0.4) cut = MAX_CHUNK_CHARS;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  function pickVoice(lang) {
    const voices = getVoices();
    if (!voices.length) return null;
    const wanted = String(lang || '').toLowerCase();
    const isVi = wanted.startsWith('vi');
    const isEn = wanted.startsWith('en');

    if (isVi) {
      return (
        voices.find(v => String(v.lang || '').toLowerCase().replace('_', '-').startsWith('vi')) ||
        voices.find(v => /vietnamese|tiếng việt|hoaimy|namminh/i.test(v.name || '')) ||
        null
      );
    }

    if (isEn) {
      return (
        voices.find(v => String(v.lang || '').toLowerCase().replace('_', '-').startsWith('en-us')) ||
        voices.find(v => String(v.lang || '').toLowerCase().replace('_', '-').startsWith('en')) ||
        null
      );
    }

    return (
      voices.find(v => String(v.lang || '').toLowerCase().replace('_', '-').startsWith(wanted)) ||
      voices.find(v => String(v.lang || '').toLowerCase().replace('_', '-').startsWith(wanted.slice(0, 2))) ||
      null
    );
  }

  function stop() {
    const engine = synth();
    if (engine) engine.cancel();
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch (_) {}
      currentAudio = null;
    }
    speaking = false;
  }

  /* URL endpoint TTS của Google Translate.
   * Trước đây chuỗi này lọt một cặp {{ }} vào giữa template literal và đóng
   * sai chỗ (ngay trước &client=), nên new Audio() nhận một URL tương đối
   * và fallback giọng Việt không bao giờ phát được. */
  function buildTtsUrl(text, targetLang) {
    const params = new URLSearchParams({
      ie: 'UTF-8',
      client: 'tw-ob',
      tl: targetLang,
      q: text,
    });
    return `https://translate.google.com/translate_tts?${params.toString()}`;
  }

  function speakWithFallbackAudio(chunks, lang, rate) {
    if (!chunks.length) {
      speaking = false;
      return;
    }
    const chunk = chunks.shift();
    const targetLang = lang === 'vi' ? 'vi' : 'en';
    const audioUrl = buildTtsUrl(chunk, targetLang);

    try {
      const audio = new Audio(audioUrl);
      currentAudio = audio;
      audio.playbackRate = Number.isFinite(Number(rate)) ? Math.min(3, Math.max(0.5, Number(rate))) : 1;
      audio.onended = () => {
        if (chunks.length > 0) {
          speakWithFallbackAudio(chunks, lang, rate);
        } else {
          speaking = false;
          currentAudio = null;
        }
      };
      audio.onerror = () => {
        speaking = false;
        currentAudio = null;
      };
      audio.play().catch(() => {
        speaking = false;
        currentAudio = null;
      });
    } catch (_) {
      speaking = false;
      currentAudio = null;
    }
  }

  function speak(text, lang, rate = 1) {
    stop();

    const chunks = chunkText(text);
    if (!chunks.length) return;

    const engine = synth();
    const voice = pickVoice(lang);
    const wanted = String(lang || '').toLowerCase();
    const isVi = wanted.startsWith('vi');

    // Nếu đọc tiếng Việt nhưng máy không có sẵn giọng đọc tiếng Việt -> Dùng Audio Fallback Google Translate chuẩn giọng Việt 100%
    if (isVi && !voice && typeof Audio !== 'undefined') {
      speaking = true;
      speakWithFallbackAudio(chunks, lang, rate);
      return;
    }

    if (!engine || typeof global.SpeechSynthesisUtterance !== 'function') return;

    const safeRate = Number.isFinite(Number(rate)) ? Math.min(3, Math.max(0.5, Number(rate))) : 1;
    speaking = true;

    chunks.forEach((chunk, index) => {
      const utterance = new global.SpeechSynthesisUtterance(chunk);
      utterance.lang = isVi ? 'vi-VN' : wanted.startsWith('en') ? 'en-US' : String(lang || '');
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

  function isSpeaking() {
    const engine = synth();
    const synthSpeaking = Boolean(engine && (engine.speaking || engine.pending));
    const audioSpeaking = Boolean(currentAudio && !currentAudio.paused && !currentAudio.ended);
    return speaking && (synthSpeaking || audioSpeaking);
  }

  const api = { speak, stop, isSpeaking, chunkText, pickVoice, buildTtsUrl, MAX_CHUNK_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_TTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
