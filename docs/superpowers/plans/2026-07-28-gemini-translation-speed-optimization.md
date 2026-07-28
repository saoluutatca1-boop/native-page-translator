# Gemini Translation Speed Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize Gemini translation speed by 3x-5x using Viewport Priority Queue, Adaptive Batch Concurrency Pool (3 parallel requests), and Zero Token Waste Generation Config (`temperature: 0.1`, `thinkingBudget: 0`).

**Architecture:** 
- In `providers.js`: Tune Gemini request payload parameters (`generationConfig`, `thinkingConfig`) and enforce identical system instruction formatting to hit GCP implicit prompt cache.
- In `content.js`: Categorize text nodes into viewport vs offscreen priority queues using `getBoundingClientRect()` and dispatch visible nodes first.
- In `background.js` / `providers.js`: Add micro-staggering (30ms delay between batch dispatches) and adaptive concurrency pool handling.

**Tech Stack:** JavaScript (ES6+ Vanilla), Chrome Extension Manifest v3 API, Node.js test runner (`tests/providers.test.js`).

## Global Constraints
- **Framework & Runtime**: Manifest V3 Vanilla JS (Service Worker in `background.js`, DOM in `content.js`).
- **No breaking changes**: Keep all existing provider options, DeepL, and OpenAI-compatible fallback behavior intact.
- **Zero 429 Errors**: Enforce micro-staggering and safe concurrency limits.

---

### Task 1: Optimize Gemini Generation Config & Payload in `providers.js`

**Files:**
- Modify: `providers.js:562-584`
- Modify/Test: `tests/providers.test.js`

**Interfaces:**
- Consumes: `buildRequest({ providerId: 'gemini', providerConfig, apiKey, source, context, tone })`
- Produces: Updated Gemini payload JSON body with `temperature: 0.1` and `thinkingBudget: 0`.

- [ ] **Step 1: Write test for Gemini generationConfig tuning**

Add test case in `tests/providers.test.js`:

```javascript
test('buildRequest for Gemini includes temperature 0.1 and thinkingBudget 0', () => {
  const req = NPT_PROVIDERS.buildRequest({
    providerId: 'gemini',
    providerConfig: { model: 'gemini-3.1-flash-lite' },
    apiKey: 'AIzaSyTestKey',
    source: 'Xin chào thế giới',
    tone: 'natural'
  });
  const body = JSON.parse(req.body);
  assert.strictEqual(body.generationConfig.temperature, 0.1);
  assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/providers.test.js`
Expected: FAIL due to `temperature` being `0.3` and missing `thinkingConfig`.

- [ ] **Step 3: Update `providers.js` Gemini request builder**

Modify `providers.js` lines 567-568:

```javascript
const generationConfig = {
  temperature: 0.1,
  thinkingConfig: { thinkingBudget: 0 }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/providers.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add providers.js tests/providers.test.js
git commit -m "perf: set temperature 0.1 and thinkingBudget 0 for Gemini requests"
```

---

### Task 2: Implement Viewport Priority Queue in `content.js`

**Files:**
- Modify: `content.js`

**Interfaces:**
- Consumes: DOM text nodes extracted via TreeWalker.
- Produces: `inViewportNodes` array prioritized before `offscreenNodes`.

- [ ] **Step 1: Create helper to check if a node is in the viewport**

In `content.js`:

```javascript
function isNodeInViewport(node) {
  if (!node || !node.parentElement) return false;
  try {
    const rect = node.parentElement.getBoundingClientRect();
    const vHeight = window.innerHeight || document.documentElement.clientHeight;
    const vWidth = window.innerWidth || document.documentElement.clientWidth;
    return (
      rect.bottom >= 0 &&
      rect.top <= vHeight &&
      rect.right >= 0 &&
      rect.left <= vWidth
    );
  } catch (_) {
    return false;
  }
}
```

- [ ] **Step 2: Prioritize text nodes in batch collector**

In `content.js`, group nodes such that `isNodeInViewport(node)` elements form the first batches sent to background translation worker.

- [ ] **Step 3: Verify node priority grouping**

Check syntax and verify with linting or node run.

- [ ] **Step 4: Commit changes**

```bash
git add content.js
git commit -m "feat: prioritize viewport text nodes for instant visual translation"
```

---

### Task 3: Adaptive Micro-Staggering & Parallel Batch Pool

**Files:**
- Modify: `providers.js` / `background.js`

**Interfaces:**
- Consumes: Batch translation requests array.
- Produces: Parallel execution pool with max 3 concurrent requests and 30ms micro-staggering.

- [ ] **Step 1: Implement micro-staggering delay helper**

In `background.js` / `providers.js`:

```javascript
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Update batch translation queue to execute with concurrency = 3 and 30ms stagger**

- [ ] **Step 3: Run existing unit test suite**

Run: `npm test` or `node tests/providers.test.js`
Expected: ALL PASS

- [ ] **Step 4: Commit changes**

```bash
git add providers.js background.js
git commit -m "perf: add 3x adaptive concurrency pool with 30ms micro-staggering"
```
