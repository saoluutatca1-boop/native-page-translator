# AI Quick Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an accurate AI Question Solver for `native-page-translator` supporting both text selection (`Alt+Q`) and screen capture OCR (`Alt+Shift+Q`), displaying answers in a draggable floating card with high accuracy.

**Architecture:** 
A dedicated `qa-solver.js` content script manages the Draggable Floating Card UI, selection detection, and shortcut listeners. In `providers.js`, `solveQuestionWithRotation` handles prompt construction (low temperature = 0.1 for high accuracy, structured formatting, vision support for image crop). In `background.js`, a message listener handles `qaSolveQuestion` and delegates to the provider rotation engine.

**Tech Stack:** Vanilla JS (ES2022, Chrome Extensions MV3, Gemini Vision / OpenAI API).

## Global Constraints
- Must pass all existing tests in `node tests/run-all.js`.
- Strict modularity: all QA solver UI and client logic must live in `qa-solver.js`, not polluting `content.js`.
- Accuracy first: temperature set to 0.1; system instruction enforces verification and direct bold answer at the top.
- Chrome Extension MV3 compatibility (no eval, no external scripts).

---

### Task 1: Prompt & Provider Solver Engine (`providers.js` & tests)

**Files:**
- Modify: `providers.js`
- Create: `tests/qa-solver.test.js`
- Modify: `tests/run-all.js`

**Interfaces:**
- Consumes: `withKeyRotation`, `buildGeminiGenerateContentUrl`, `classifyResponse` from `providers.js`.
- Produces: `solveQuestionWithRotation({ config, text, imageBase64, mimeType, fetchText, keyState, now, sleep })` returning `{ answer: string }`.

- [ ] **Step 1: Write unit tests in `tests/qa-solver.test.js`**
  Test prompt formatting, low temperature setting, and answer extraction for both text questions and image vision requests.
- [ ] **Step 2: Run test to make sure it fails**
  Run `node tests/qa-solver.test.js` (fails because `solveQuestionWithRotation` is not implemented).
- [ ] **Step 3: Implement `solveQuestionWithRotation` in `providers.js`**
  Implement system prompt focusing on high accuracy, low temperature (0.1), deterministic multiple-choice solving, and export in `providers.js`.
- [ ] **Step 4: Run test and verify it passes**
  Run `node tests/qa-solver.test.js`.
- [ ] **Step 5: Register in `tests/run-all.js`**
  Add `qa-solver.js` and `tests/qa-solver.test.js` to runner and verify all pass.

---

### Task 2: Background Service Worker Integration (`background.js`)

**Files:**
- Modify: `background.js`
- Test: `tests/sw.smoke.test.js`

**Interfaces:**
- Consumes: `solveQuestionWithRotation` from `providers.js`.
- Produces: Chrome message listener for `qaSolveQuestion` payload `{ text, imageBase64, mimeType }`.

- [ ] **Step 1: Add handler in `background.js` for message `qaSolveQuestion`**
  Wire `qaSolveQuestion` to `solveQuestionWithRotation` using active config and keyState.
- [ ] **Step 2: Test message handler in service worker tests**
  Run `node tests/run-all.js` to ensure background syntax and smoke tests pass.

---

### Task 3: Content Script UI & Shortcuts (`qa-solver.js` & `manifest.json`)

**Files:**
- Create: `qa-solver.js`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `chrome.runtime.sendMessage({ type: 'qaSolveQuestion', ... })`, `chrome.runtime.sendMessage({ type: 'ocrTakeScreenshot' })`.
- Produces: Draggable floating card UI, keyboard shortcut listeners (`Alt+Q`, `Alt+Shift+Q`, `Escape`), selection button tooltip.

- [ ] **Step 1: Create `qa-solver.js` with Draggable Floating Card UI**
  Create elegant floating card with dark/light mode, drag-and-drop handle, loading spinner, bold answer display, explanation text, copy button, and Esc close.
- [ ] **Step 2: Implement Text Selection Resolver (`Alt+Q`)**
  Detect selected text; on `Alt+Q` (or clicking mini lightbulb icon), open card, show loading, and fetch answer.
- [ ] **Step 3: Implement OCR Screen Crop Resolver (`Alt+Shift+Q`)**
  Allow user to crop screen selection and directly send cropped image to `qaSolveQuestion` with Gemini Vision for instant solving.
- [ ] **Step 4: Register `qa-solver.js` in `manifest.json`**
  Add `qa-solver.js` to `content_scripts[0].js`.
- [ ] **Step 5: Run full test suite**
  Run `node tests/run-all.js` and ensure all checks pass.
