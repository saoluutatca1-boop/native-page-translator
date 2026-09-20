# Kế Hoạch Triển Khai: Hệ Thống Giải Toán Lai Thần Kinh - Biểu Tượng (Hybrid Neuro-Symbolic QA Solver)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tích hợp Giao thức Giải mù (Blind Solving Protocol) và công cụ thực thi mã Python (`code_execution`) của Google Gemini vào QA Solver nhằm triệt tiêu hiện tượng ép số ngụy biện và đảm bảo độ chính xác toán học tất định.

**Architecture:** Sử dụng kiến trúc kết hợp thần kinh - biểu tượng: LLM thiết lập mô hình toán học giải mù, tự sinh mã Python và gọi công cụ `code_execution` đám mây của Gemini API để tính toán vi tích phân/đại số tất định, sau đó tổng hợp kết quả đối chiếu với phương án trắc nghiệm.

**Tech Stack:** JavaScript (ES2022, Chrome Extension Manifest V3), Google Gemini REST API v1beta (`code_execution` tool), Node.js test runner.

## Global Constraints
- Tuân thủ toàn bộ 21 test suites hiện hữu (`npm test` phải pass 100%).
- Giữ vững cấu trúc đóng kín Closed Shadow DOM của extension UI.
- Phản hồi bằng tiếng Việt.

---

### Task 1: Cập nhật System Instructions với Giao thức Giải mù (Blind Solving Protocol)

**Files:**
- Modify: `providers.js`
- Test: `tests/qa-solver.test.js`

**Interfaces:**
- Consumes: `buildQaInstructions()`
- Produces: Chuỗi prompt hướng dẫn giải toán 4 giai đoạn chuẩn mực, cấm ngụy biện hậu nghiệm.

- [ ] **Step 1: Viết test kiểm tra các điều khoản của Blind Solving Protocol trong `tests/qa-solver.test.js`**
- [ ] **Step 2: Cập nhật `buildQaInstructions()` trong `providers.js` theo 4 giai đoạn: Blind Solve ➔ Python Tool ➔ Constraint Check ➔ Option Mapping**
- [ ] **Step 3: Chạy test và xác nhận PASS**

---

### Task 2: Kích hoạt công cụ `code_execution` trong `buildQaRequest()`

**Files:**
- Modify: `providers.js`
- Test: `tests/qa-solver.test.js`

**Interfaces:**
- Consumes: `buildQaRequest({ providerId, providerConfig, apiKey, text, imageBase64, mimeType, extendedThinking, thinkingLevel })`
- Produces: `tools: [{ code_execution: {} }]` được gắn vào payload gửi đến Gemini API.

- [ ] **Step 1: Viết test kiểm tra `tools` chứa `code_execution` trong `tests/qa-solver.test.js`**
- [ ] **Step 2: Cập nhật `buildQaRequest()` trong `providers.js` để gắn `code_execution: {}` khi provider là Gemini**
- [ ] **Step 3: Chạy test và xác nhận PASS**

---

### Task 3: Nâng cấp bộ phân tích phản hồi (Multi-part Response Parser) cho Code Execution

**Files:**
- Modify: `providers.js`
- Test: `tests/qa-solver.test.js`

**Interfaces:**
- Consumes: `classifyResponse({ bodyText, ... })`
- Produces: Trích xuất `text`, `executableCode` và `codeExecutionResult` và ghép thành văn bản Markdown hoàn chỉnh.

- [ ] **Step 1: Viết test giả lập response chứa `executableCode` và `codeExecutionResult`**
- [ ] **Step 2: Cập nhật `classifyResponse()` trong `providers.js` để nối các phần code và kết quả chạy thành Markdown có cấu trúc**
- [ ] **Step 3: Chạy test và xác nhận PASS**

---

### Task 4: Nâng cấp hiển thị Markdown & Khối Python Code trong `qa-solver.js`

**Files:**
- Modify: `qa-solver.js`
- Test: `tests/qa-solver.test.js`

**Interfaces:**
- Consumes: `formatMarkdown(text)`
- Produces: Render các khối ```python ... ``` với giao diện code block đẹp mắt, có nút xem chi tiết tính toán.

- [ ] **Step 1: Viết test render code block python trong `tests/qa-solver.test.js`**
- [ ] **Step 2: Cập nhật hàm `formatMarkdown()` trong `qa-solver.js`**
- [ ] **Step 3: Chạy test và xác nhận PASS**

---

### Task 5: Kiểm thử toàn diện và tích hợp hệ thống (Regression Verification)

**Files:**
- Test: `tests/run-all.js`

- [ ] **Step 1: Chạy toàn bộ test suites `npm test` (bao gồm smoke test và 21 suites)**
- [ ] **Step 2: Commit và push mã nguồn lên nhánh chính**
