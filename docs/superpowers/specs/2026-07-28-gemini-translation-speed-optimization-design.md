# Design Spec: High-Speed & Rate-Limit-Proof Gemini Translation Optimization

## 1. Overview & Goals
Optimize `native-page-translator` to translate web pages 3x-5x faster using Gemini (Google AI Studio) while strictly eliminating rate limits (HTTP 429), errors, or token waste.

### Key Objectives:
- **Instant Perceived Speed**: Translate text visible in the viewport first (< 500ms).
- **Adaptive Concurrency Pool**: Send 3 parallel requests safely, dynamically load-balancing across available API keys.
- **Zero Token Waste**: Disable thinking budget (`thinkingBudget: 0`) and lower temperature to `0.1`.
- **Implicit Prompt Caching**: Keep `systemInstruction` byte-identical across page batches to hit Google's implicit prompt cache.
- **Rate-Limit Resilience**: Auto-cooldown on HTTP 429, micro-staggering dispatches (30ms jitter), and exponential backoff retry.

---

## 2. Component Architecture & Data Flow

### 2.1 Viewport Priority Scanning (`content.js`)
- **Node Classification**: During DOM tree walk, calculate element bounding rectangle via `getBoundingClientRect()`.
- **Priority Queues**:
  - `inViewportQueue`: Text nodes intersecting `window.visualViewport` or `[0, window.innerHeight]`.
  - `offscreenQueue`: Text nodes outside current viewport.
- **Dispatch Order**: `inViewportQueue` batches are formed and dispatched first. `offscreenQueue` batches are processed sequentially/concurrently immediately after.

### 2.2 Adaptive Concurrency Rate Limiter (`background.js` / `providers.js`)
- **Pool Management**:
  - Initial active concurrency limit = `3`.
  - Stagger interval = `30ms` between dispatches to prevent TCP/HTTP burst spikes.
- **Multi-Key Round-Robin**:
  - Rotate API keys across active requests.
  - If a key triggers HTTP 429, set key cooldown to `Math.max(5000, retryAfter)` and temporarily reduce pool concurrency to `2`.

### 2.3 Gemini Payload Optimization (`providers.js`)
- **Generation Configuration**:
  ```json
  {
    "generationConfig": {
      "temperature": 0.1,
      "thinkingConfig": { "thinkingBudget": 0 }
    }
  }
  ```
- **System Instruction Caching**:
  - Ensure `systemInstruction` text prefix remains strictly identical across batches on the same domain to trigger GCP Gemini's implicit prompt caching (reducing latency by ~50%).

---

## 3. Error Handling & Reliability
- **Retry Policy**: 3 automatic retries with exponential backoff (`500ms`, `1500ms`, `3000ms`) for transient 5xx or network errors.
- **Zero Loss Guarantee**: If a batch fails after retries, split into smaller sub-batches or fallback gracefully to single key without losing node text.

---

## 4. Verification Plan
- Verify with unit tests (`tests/providers.test.js` or new test suites).
- Test on long web pages (e.g. documentation / news site with > 300 paragraphs) to measure speed improvement and check zero 429 errors in console.
