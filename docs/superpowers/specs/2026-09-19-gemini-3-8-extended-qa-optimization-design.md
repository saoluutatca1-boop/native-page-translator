# Design Spec: Gemini 3.8 Flash & Extended Thinking Q&A Optimization

- **Date:** 2026-09-19
- **Status:** Draft (Under User Review)
- **Topic:** Gemini 3.8 Flash, Extended Thinking Deep Math Solver, Crop Optimization & Smart Context Expansion

---

## 1. Overview & Goals
Hệ thống giải đề trắc nghiệm và câu hỏi học thuật (`qa-solver.js`, `crop-overlay.js`, `providers.js`) cần được nâng cấp để tối ưu hoá độ chính xác cho các câu toán khó, tăng tốc độ xử lý ảnh crop và mở rộng ngữ cảnh câu hỏi thông minh khi người dùng bôi đen thiếu.

### Goals
1. **Mô hình Gemini 3 Series mới nhất:**
   - Dọn sạch các model cũ (2.0, 2.5).
   - Thiết lập danh sách model mặc định & gợi ý: `gemini-3.8-flash` (flagship reasoning), `gemini-3.5-flash-lite` (nhanh, nhẹ, ~350 tok/s), `gemini-3.5-flash`.
2. **Nút / Tuỳ chọn "Giải toán sâu (Gemini 3.8 Extended Thinking)":**
   - Hỗ trợ switch trực tiếp trên UI thẻ giải bài (QA Card) hoặc thiết lập trong Options.
   - Khi kích hoạt: Tự động chuyển sang model `gemini-3.8-flash` với cấu hình chuẩn Google AI Studio REST API v1beta:
     ```json
     "generationConfig": {
       "thinkingConfig": {
         "thinkingLevel": "high"
       },
       "temperature": 1.0
     }
     ```
   - Khi ở chế độ thông thường: Sử dụng model đã chọn (mặc định `gemini-3.5-flash-lite` hoặc `gemini-3.8-flash` với `thinkingLevel: "low"` / `"medium"`).
3. **Tối ưu hoá nén ảnh màn hình (Crop Canvas Optimization):**
   - Giới hạn kích thước cạnh tối đa 1600px để không làm chậm upload với màn hình Retina / 4K.
   - Xuất Base64 dạng `image/jpeg` chất lượng 0.85 (thay vì PNG thô nặng hàng megabytes).
4. **Mở rộng ngữ cảnh thông minh (Smart Context Expansion):**
   - Kiểm tra nếu đoạn bôi đen thiếu các lựa chọn A, B, C, D hoặc thiếu nội dung dẫn: tự động tìm container cha gần nhất (`p`, `div`, `li`, `section`, `.question`) để lấy bổ sung ngữ cảnh cần thiết.
5. **Khắc phục lỗi định dạng Regex & Hiển thị Toán học:**
   - Bảo vệ an toàn các biến code dạng `snake_case` (ví dụ `user_id`, `var_name`) không bị chuyển thành `<sub>` (subscript).
   - Ngăn chặn triệt để double-escaping HTML (`&amp;lt;`) bằng cơ chế Tokenized Replacement.

---

## 2. Architecture & Detailed Module Design

### 2.1 `providers.js`
- Cập nhật `PROVIDER_DEFS.gemini`:
  - `defaultModel`: `'gemini-3.5-flash-lite'`
  - `suggestedModels`: `['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash']`
- Cập nhật hàm `buildQaRequest`:
  - Nhận thêm option `extendedThinking` (boolean) và `thinkingLevel` (`"low" | "medium" | "high"`).
  - Nếu `extendedThinking === true` hoặc `providerConfig?.extendedThinking`:
    - Ép model thành `'gemini-3.8-flash'` nếu model đang dùng không hỗ trợ hoặc là bản lite.
    - Cấu hình `generationConfig.thinkingConfig = { thinkingLevel: 'high' }`.
    - Đặt `generationConfig.temperature = 1.0` (theo khuyến nghị của Google cho chế độ thinking sâu).
  - Cập nhật regex kiểm tra model Gemini 3: `/(gemini-)?3\./i`.
  - Cập nhật prompt: Yêu cầu mô hình suy luận nháp trước, sau đó đưa ra dòng đáp án rõ ràng ở đầu hoặc cuối, hỗ trợ format markdown/latex chuẩn.

### 2.2 `crop-overlay.js`
- Thêm hàm phụ trợ `compressAndResizeCanvas(canvas, maxDim = 1600, quality = 0.85)`:
  - Tính toán tỉ lệ scale: nếu `max(width, height) > maxDim`, vẽ sang canvas tạm thời có kích thước scale down.
  - Gọi `toDataURL('image/jpeg', quality)`.
  - Gửi dataURL (JPEG) về `background.js` kèm `mimeType: 'image/jpeg'`.

### 2.3 `qa-solver.js`
- **Smart Context Expansion:**
  - `expandSelectionIfIncomplete(range, originalText)`:
    - Kiểm tra `/[A-D][\.\)\:]/i.test(originalText)`.
    - Nếu false và text ngắn (< 150 ký tự): Lấy `commonAncestorContainer`, tìm khối `closest('div, li, p, section, article, tr, .question')` lấy `innerText`. Nếu khối đó chứa `[A-D][\.\)\:]`, đính kèm vào mục "Ngữ cảnh xung quanh câu hỏi".
- **Tokenized LaTeX / Markdown Parser (`formatMarkdown`):**
  - Tách các biểu thức math `$ ... $` hoặc `$$ ... $$` ra trước, lưu vào mảng `tokens`.
  - Escape HTML cho các phần văn bản thông thường (tránh XSS và tránh double escape).
  - Khôi phục tokens và render qua `renderLatexSnippet`.
  - Regex subscript: Chỉ match `_([a-zA-Z0-9]+)` khi nằm trong context toán học, hoặc yêu cầu dấu ngoặc nhọn `_{...}` để tránh biến `snake_case` bị biến thành subscript.
- **UI Tooltip & QA Card:**
  - Bổ sung nút toggle / checkbox `🧠 Giải toán sâu (Gemini 3.8 Extended)` trên thanh điều khiển của thẻ QA.
  - Khi người dùng click toggle: tự động gọi lại `solveQA` với cờ `extendedThinking: true` và hiển thị trạng thái "Đang suy luận chuyên sâu...".

### 2.4 `options.html` & `options.js`
- Cập nhật danh sách model Gemini gợi ý trong giao diện Options.
- Thêm checkbox tuỳ chọn: "Mặc định bật Giải toán sâu (Gemini 3.8 Extended Thinking)".

---

## 3. Error Handling & Edge Cases
1. **Fallback API Error:** Nếu API key không có quyền truy cập Gemini 3.8 hoặc báo lỗi thinkingLevel, tự động fallback về request thông thường không có thinkingConfig.
2. **Device Pixel Ratio & Canvas Tainted:** Đảm bảo hàm resize canvas xử lý an toàn, kiểm tra canvas context trước khi vẽ.
3. **Selection rỗng hoặc lỗi DOM:** Giữ nguyên text bôi đen ban đầu nếu việc tìm parent node bị chặn hoặc vượt ngoài frame.

---

## 4. Testing & Verification Strategy
1. **Unit Tests (Jest):**
   - Test suite cho `providers.js`: verify request payload sinh ra có `thinkingConfig: { thinkingLevel: 'high' }`, model `gemini-3.8-flash`, temperature 1.0 khi bật `extendedThinking`.
   - Test suite cho `formatMarkdown`: verify các trường hợp `user_id`, `<` (không double escape), công thức toán `$T$`, `\lambda`, ma trận.
   - Test suite cho `compressAndResizeCanvas`: verify ảnh lớn được scale down đúng kích thước và xuất ra mimeType `image/jpeg`.
2. **E2E & Linting:**
   - Chạy `npm test` toàn bộ test suites hiện có (21 suites) đảm bảo không bị regression.
