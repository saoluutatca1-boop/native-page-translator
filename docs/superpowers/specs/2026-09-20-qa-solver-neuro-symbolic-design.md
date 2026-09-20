# Thiết Kế Kỹ Thuật: Hệ Thống Giải Toán Lai Thần Kinh - Biểu Tượng (Hybrid Neuro-Symbolic QA Solver)

- **Ngày tạo:** 2026-09-20
- **Dự án:** Native Page Translator (`native-page-translator`)
- **Trạng thái:** Được phê duyệt (Approved)

---

## 1. Bối Cảnh & Vấn Đề

Dựa trên thực nghiệm với các bài toán học thuật cấp độ nghiên cứu (như Quá trình điểm Poisson 2 chiều trong lý thuyết xác suất nâng cao), các mô hình ngôn ngữ lớn thuần túy (Autoregressive Dense LLMs) gặp phải 2 điểm nghẽn nghiêm trọng:
1. **Lỗi tính toán giải tích biểu tượng (Symbolic Algebra Error)**: Mạng nơ-ron chỉ dự đoán token tiếp theo theo xác suất thống kê, không có công cụ đại số biểu tượng (CAS) nên thường tính nhẩm sai tích phân nhiều lớp hoặc bỏ quên các hằng số (như mất hằng số $\pi$ ở mẫu số).
2. **Hiện tượng "Ép số / Ngụy biện hậu nghiệm" (Post-hoc Rationalization)**: Khi mô hình nhìn thấy sẵn các phương án trắc nghiệm A, B, C, D ngay từ đầu, nếu kết quả tự tính của nó không khớp, thay vì quay lui (backtracking) kiểm tra lại phép tính, nó sẽ tự động bịa ra các lập luận ngụy biện như *"Theo tài liệu chuẩn... ta có Cov = ..."* để ép về phương án đích.

## 2. Mục Tiêu Cốt Lõi

1. **Triệt tiêu hiện tượng "ép số"**: Triển khai Giao thức "Giải mù" (Blind Solving Protocol) trong System Instructions.
2. **Đạt độ chính xác toán học tất định 100%**: Kích hoạt công cụ `code_execution` gốc của Google Gemini API để AI tự lập trình Python tính toán vi tích phân và đại số phức tạp trong sandbox đám mây của Google.
3. **Trải nghiệm người dùng cao cấp**: Hiển thị đáp án chính xác trên cùng, kèm giải thích chi tiết và khối thu gọn `[🐍 Xem mã Python tính toán]` nếu người dùng muốn kiểm chứng.

---

## 3. Kiến Trúc Chi Tiết

### 3.1. Giao thức "Giải Mù" (Blind Solving Protocol) trong `providers.js`
Trong hàm `buildQaInstructions()`, cấu trúc chỉ thị được chia thành 4 giai đoạn bắt buộc:
* **Giai đoạn 1 (Blind Solve)**: Giả lập che hoàn toàn các phương án A, B, C, D. Phân tích đề bài, thiết lập mô hình toán học và tự dẫn xuất biểu thức giải tích độc lập.
* **Giai đoạn 2 (Tận dụng Python Code Execution)**: Đối với các phép tính tích phân suy rộng, giải phương trình, ma trận, xác suất phức tạp, viết mã Python để tính toán chính xác, không tính nhẩm mò mẫm.
* **Giai đoạn 3 (Constraint & Dimension Check)**: Kiểm tra thứ nguyên vật lý và các giá trị tiệm cận biên ($\lambda \to 0, \lambda \to \infty$).
* **Giai đoạn 4 (Anti-Rationalization & Option Mapping)**: Nghiêm cấm mọi hành vi trích dẫn công thức không có bước dẫn xuất tương ứng. Sau khi đã có biểu thức tự thân, mới đối chiếu với 4 phương án A, B, C, D để kết luận.

### 3.2. Tích hợp công cụ `code_execution` trong `buildQaRequest()`
* Khi provider là `gemini`:
  * Đối với các câu hỏi toán học/khoa học/tính toán hoặc khi bật chế độ Extended Thinking (`extendedThinking: true`):
    * Gắn công cụ: `tools: [{ code_execution: {} }]`.
    * Tránh gắn kèm `google_search` khi bài toán là thuần lý thuyết để không làm cạn kiệt quota Free Tier.

### 3.3. Xử lý phản hồi đa thành phần (Multi-part Response Parsing) trong `providers.js`
API của Gemini khi dùng `code_execution` trả về các part trong `candidates[0].content.parts`:
* `{ text: "..." }`: Lời giải thích của mô hình.
* `{ executableCode: { language: "PYTHON", code: "..." } }`: Mã nguồn Python do AI viết.
* `{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "..." } }`: Kết quả chạy code từ sandbox Google.

Bộ parser `classifyResponse` sẽ tổng hợp các phần này một cách thông minh:
* Ghép phần giải thích toán học và kết quả chạy code lại với nhau.
* Định dạng khối code Python dưới dạng Markdown ````python ... ```` để UI `qa-solver.js` hiển thị gọn gàng trong mục *Giải thích chi tiết*.

### 3.4. Nâng cấp giao diện hiển thị trong `qa-solver.js`
* Trong hàm `formatMarkdown`: nhận diện khối code Python và tô màu cú pháp nhẹ nhàng, kèm nút sao chép mã hoặc xem chi tiết tính toán.
* Giữ nguyên Hero Answer Card và Accordion giải thích chi tiết như hiện tại.

---

## 4. Kế Hoạch Kiểm Thử (Verification Plan)

1. **Unit Tests trong `tests/qa-solver.test.js`**:
   * Kiểm tra `buildQaRequest` kích hoạt đúng `tools: [{ code_execution: {} }]` khi có yêu cầu.
   * Kiểm tra `classifyResponse` bóc tách và tích hợp đúng các part `executableCode` và `codeExecutionResult`.
   * Kiểm tra System Instructions chứa đầy đủ các điều khoản của Blind Solving Protocol.
2. **Integration & Smoke Tests**:
   * Chạy toàn bộ 21 test suites (`npm test`) đảm bảo 100% PASS và không gây lỗi hồi quy (regression).
