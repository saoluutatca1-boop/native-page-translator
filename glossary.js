/* ========================================================================
 * NPT Glossary — bảng thuật ngữ cố định khi dịch (nguồn => đích).
 *
 * - normalize: trim, bỏ entry rỗng, dedupe theo source (case-insensitive,
 *   entry sau ghi đè), cap 500 entries.
 * - toPromptText: dòng "- source => target" đưa vào prompt LLM, cap 200.
 * - parse: auto-detect JSON array / CSV / TSV / "=>" / ":"; chịu BOM, header.
 * - serialize: xuất 'json' hoặc 'csv'.
 *
 * JS thuần (không chrome.*): chạy được trong content script, options page
 * lẫn node (test).
 * ====================================================================== */
(function attachGlossary(global) {
  'use strict';

  const MAX_ENTRIES = 500;
  const MAX_PROMPT_ENTRIES = 200;

  function normalize(entries) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    const indexBySource = new Map(); // source lowercase -> vị trí trong out
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const source = String(entry.source ?? '').trim();
      const target = String(entry.target ?? '').trim();
      if (!source || !target) continue;
      const key = source.toLowerCase();
      if (indexBySource.has(key)) {
        out[indexBySource.get(key)] = { source, target }; // entry sau ghi đè
        continue;
      }
      if (out.length >= MAX_ENTRIES) break;
      indexBySource.set(key, out.length);
      out.push({ source, target });
    }
    return out;
  }

  function toPromptText(entries) {
    return normalize(entries)
      .slice(0, MAX_PROMPT_ENTRIES)
      .map(entry => `- ${entry.source} => ${entry.target}`)
      .join('\n');
  }

  /* Bỏ ngoặc kép bao quanh 1 CSV field + unescape "" → " (nếu có). */
  function unquoteField(value) {
    const text = String(value ?? '');
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      return text.slice(1, -1).replace(/""/g, '"');
    }
    return text;
  }

  /* Tách 1 dòng theo format phát hiện được. Trả về [source, target] hoặc null.
   * Ưu tiên: TSV (tab) → "=>" → CSV (ngoặc kép hoặc phẩy đầu) → ":" đầu tiên. */
  function splitLine(line) {
    if (line.includes('\t')) {
      const index = line.indexOf('\t');
      return [line.slice(0, index), line.slice(index + 1)];
    }
    if (line.includes('=>')) {
      const index = line.indexOf('=>');
      return [line.slice(0, index), line.slice(index + 2)];
    }
    if (line.startsWith('"')) {
      // CSV field có ngoặc kép: "nguồn, có phẩy",đích
      const closing = line.indexOf('"', 1);
      if (closing > 0 && line[closing + 1] === ',') {
        return [line.slice(1, closing).replace(/""/g, '"'), unquoteField(line.slice(closing + 2))];
      }
    }
    if (line.includes(',')) {
      const index = line.indexOf(',');
      return [line.slice(0, index), unquoteField(line.slice(index + 1))];
    }
    if (line.includes(':')) {
      const index = line.indexOf(':');
      return [line.slice(0, index), line.slice(index + 1)];
    }
    return null;
  }

  function isHeaderRow(source, target) {
    return source.trim().toLowerCase() === 'source' && target.trim().toLowerCase() === 'target';
  }

  function parse(text) {
    const input = String(text ?? '').replace(/^﻿/, '').trim(); // strip BOM (\uFEFF)
    if (!input) return [];

    // JSON array of {source, target}
    if (input.startsWith('[')) {
      try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) return normalize(parsed);
      } catch (_) {
        // JSON hỏng → rơi xuống parse theo dòng.
      }
    }

    const entries = [];
    for (const rawLine of input.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const pair = splitLine(line);
      if (!pair) continue;
      const [source, target] = pair;
      if (!entries.length && isHeaderRow(source, target)) continue; // bỏ header row
      entries.push({ source, target });
    }
    return normalize(entries);
  }

  function csvField(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function serialize(entries, format) {
    const clean = normalize(entries);
    if (format === 'csv') {
      return clean.map(entry => `${csvField(entry.source)},${csvField(entry.target)}`).join('\n');
    }
    return JSON.stringify(clean, null, 2); // mặc định 'json'
  }

  const api = { normalize, toPromptText, parse, serialize, MAX_ENTRIES, MAX_PROMPT_ENTRIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NPT_GLOSSARY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
