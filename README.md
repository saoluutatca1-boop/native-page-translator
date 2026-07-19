# Native Page Translator VI / EN — Extension v4

Bản v4 sửa lỗi API và giảm số request khi dịch cả trang.

## Nâng cấp từ v3

1. Giải nén ZIP v4 vào một thư mục mới.
2. Mở `chrome://extensions` hoặc `edge://extensions`.
3. Có thể xóa v3 rồi chọn **Load unpacked**, hoặc chép đè file v4 vào thư mục cũ và bấm **Reload**.
4. Tải lại toàn bộ tab web đang mở. Bước này bắt buộc vì tab cũ vẫn giữ content script v3.

## Dịch miễn phí không cần key

Chế độ **Free fallback** lần lượt thử:

1. Google Translate API endpoint.
2. Google Translate web endpoint.
3. MyMemory với đoạn ngắn.

Khi gặp lỗi 429 hoặc lỗi máy chủ, extension tự chờ ngắn rồi thử lại. Khi dịch cả trang, nhiều đoạn chữ được gom thành batch để tránh gửi hàng trăm request riêng lẻ.

## Tích hợp API free của một website

Mở popup extension → **Mở rộng**, rồi điền:

- **API URL**: URL đầy đủ của endpoint.
- **API key**: có thể để trống nếu API không yêu cầu.
- **Model**: chỉ cần với API AI.
- **Định dạng API**:
  - `Tự nhận diện`: nhận dạng theo URL.
  - `OpenAI Responses`: endpoint dạng `/v1/responses`.
  - `OpenAI-compatible Chat`: endpoint dạng `/v1/chat/completions`.
  - `LibreTranslate`: POST JSON với `q`, `source`, `target`.
  - `Generic JSON translate`: gửi nhiều tên trường phổ biến và đọc `translatedText`, `translation`, `text`, `result` hoặc các trường tương tự trong `data`.

Bấm **Test API**. Lần đầu dùng domain API tùy chỉnh, Chrome/Edge sẽ hỏi quyền truy cập đúng domain đó.

## Fallback khi API lỗi

Bật **Tự dịch miễn phí khi Native API lỗi**. Khi API free hoặc AI bị hết quota, sai model, timeout hay trả JSON lạ, nút `✨ EN` sẽ tự chuyển sang dịch miễn phí thay vì dừng và báo lỗi.

## Phím tắt

- `Alt + Shift + E`: Native API, có fallback nếu bật.
- `Alt + Shift + G`: dịch miễn phí trực tiếp.

## Lưu ý

- Extension không tự tính phí hay trừ token. API bên thứ ba vẫn có thể áp dụng quota, giới hạn request hoặc cách tính riêng.
- Extension không thể chạy trên `chrome://`, `edge://`, Chrome Web Store và một số trang hệ thống.
- Với file local, bật **Allow access to file URLs** trong trang chi tiết extension.
