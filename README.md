# Native Page Translator VI / EN — Extension v4.1

Dịch toàn trang VI/EN và đổi tiếng Việt đang gõ thành tiếng Anh tự nhiên.
Bản 4.1 thêm **hỗ trợ nhiều API key** (DeepL · Google AI Studio/Gemini · OpenAI-compatible) với xoay vòng key tự động.

## Cài đặt / nâng cấp

1. Giải nén ZIP (hoặc `git clone`) vào một thư mục.
2. Mở `chrome://extensions` hoặc `edge://extensions`, bật **Developer mode**.
3. Chọn **Load unpacked** → trỏ vào **đúng thư mục chứa file `manifest.json`**.
   - Nếu tải ZIP từ GitHub, sau khi giải nén thường có thư mục lồng `native-page-translator-main/` — hãy chọn thư mục bên trong đó.
   - Lỗi "Could not load manifest" gần như luôn do chọn sai cấp thư mục.
4. Tải lại toàn bộ tab web đang mở sau khi cài/nâng cấp.

## Nhiều API key (v4.1)

Mở popup → **Quản lý key** (hoặc menu chuột phải icon → **Options**):

- **DeepL** — hỗ trợ tiếng Việt. Key free kết thúc bằng `:fx` (endpoint `api-free.deepl.com`), key Pro tự nhận diện.
  Extension **seed sẵn 1 key DeepL Free mặc định** để dùng ngay — xoá được trong Cài đặt.
- **Google AI Studio (Gemini)** — lấy key tại <https://aistudio.google.com/apikey>, model mặc định `gemini-3.1-flash-lite` (rẻ, nhanh, ít token — hợp dịch). Có thể đổi sang `gemini-3.5-flash` nếu muốn chất lượng cao nhất.
  - **Key chuẩn phải bắt đầu bằng `AIza`.** Nếu AI Studio trả về key dạng `AQ.`, tài khoản Google của bạn đang bị giới hạn — Gemini API sẽ từ chối key đó. Cách xử lý: tạo key trong project mới, dùng tài khoản Google khác, hoặc tạo API key tại [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (bật Generative Language API).
  - Với model dòng 2.5, extension tự tắt "thinking" để tiết kiệm token.
- **OpenAI-compatible** — endpoint tùy ý (OpenAI, LibreTranslate, API tự host...), có thể không cần key.

Mỗi provider thêm được **nhiều key**. Khi dịch:

1. Thử **provider ưu tiên** trước (chọn trong Cài đặt).
2. Key bị từ chối (401/403) hoặc hết quota (429/456) → tự xoay sang **key tiếp theo**.
3. Hết key → tự chuyển sang **provider tiếp theo** đang bật.
4. Tất cả đều lỗi → báo gộp lý do từng provider (và fallback miễn phí nếu bật).

### Lưu trữ & riêng tư

- Key chỉ lưu trong `chrome.storage.local` của extension — **gỡ extension là xoá sạch toàn bộ dữ liệu**.
- Key không được gửi đi đâu ngoài chính API của provider tương ứng.

## Dịch cả trang: ưu tiên API riêng, fallback miễn phí

Khi bấm nút VI/EN dịch cả trang, extension **ưu tiên dùng API riêng đã cấu hình** (DeepL/Gemini/OpenAI — tốn quota). Tắt bằng toggle **"Dịch cả trang bằng API riêng"** trong popup/Cài đặt (storage key `tm-page-use-provider`, **mặc định bật**).

Khi API riêng lỗi hoặc đã tắt toggle, chuỗi **fallback miễn phí không cần key** lần lượt thử: Google Translate API endpoint → Google Translate web endpoint → MyMemory (đoạn ngắn). Gặp 429/lỗi server sẽ tự chờ rồi thử lại; dịch cả trang được gom batch để tránh hàng trăm request lẻ.

## Nút ✨ EN (đổi văn bản đang gõ sang tiếng Anh)

- `✨ EN` / `Alt+Shift+E`: dùng API riêng (DeepL/Gemini/OpenAI), có fallback miễn phí nếu bật.
- `Alt+Shift+G`: dịch miễn phí trực tiếp.

### Phong cách dịch bản địa (v4.1)

Với Gemini/OpenAI, chọn giọng văn trong popup hoặc Cài đặt:

- **Tự nhiên** — bám đúng văn phong gốc: nghiêm túc ra nghiêm túc, đùa cợt ra đùa cợt; xử lý anh/chị/em/ơi/nhé/đấy theo sắc thái xã giao tự nhiên của tiếng Anh, thành ngữ dịch sang thành ngữ tương đương.
- **Trang trọng** — email, LinkedIn, chat công việc: lịch sự, gọn gàng, vẫn ấm áp chứ không cứng nhắc.
- **Thân mật** — nhắn bạn bè, mạng xã hội: contractions, slang tự nhiên như tin nhắn thật. Viết như ngườ thật nhắn tin: bỏ apostrophe (im, dont, gonna), viết tắt chat phổ biến (u, rn, tbh, ngl...), lowercase theo vibe.

DeepL là engine dịch thuần nên không áp dụng phong cách này.

## Phím tắt dịch trang

- `Alt+V`: dịch trang sang tiếng Việt.
- `Alt+E`: dịch trang sang tiếng Anh.
- `Alt+O`: về bản gốc.

## Phát triển

```bash
node tests/providers.test.js   # chạy unit test cho providers.js
```

Cấu trúc:

- `providers.js` — định nghĩa provider + xoay vòng key (JS thuần, dùng chung cho background/options, test được bằng node).
- `background.js` — service worker: routing dịch, seed config, proxy fetch có kiểm soát quyền.
- `content.js` — dịch trang + nút ✨ EN trên ô nhập.
- `options.html` / `options.js` — trang Cài đặt (quản lý key).
- `popup.html` / `popup.js` — tác vụ nhanh.

## Khắc phục sự cố

- **Không dịch được trang**: reload tab sau khi cài/nâng cấp extension (content script cũ chưa khớp background mới).
- Chỉ giữ **1 bản extension** duy nhất — xoá các bản cũ/trùng trong `chrome://extensions` để tránh xung đột.
- Kiểm tra log lỗi tại `brave://extensions` hoặc `chrome://extensions` → mục extension → **Service worker** → Console.
- Bấm nút **Test API** trong popup để kiểm tra provider/key còn hoạt động không.

## Lưu ý

- Extension không tự tính phí hay trừ token; API bên thứ ba vẫn áp quota/giới hạn riêng (DeepL Free: 500.000 ký tự/tháng).
- Extension không chạy được trên `chrome://`, `edge://`, Chrome Web Store và một số trang hệ thống.
