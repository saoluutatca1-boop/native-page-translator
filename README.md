# Native Page Translator VI / EN — Extension v4.2

Dịch toàn trang VI/EN và đổi tiếng Việt đang gõ thành tiếng Anh tự nhiên.
Bản 4.2 thêm bộ tuỳ chọn **dịch trang nâng cao**: chế độ song ngữ, văn phong dịch, dịch lướt theo khung nhìn, nội dung động & SPA...
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

## Quota DeepL

Trang **Cài đặt** hiển thị mức dùng ký tự (đã dùng/giới hạn) của từng DeepL key ngay đầu phần provider, kèm thanh tiến trình — bấm **Làm mới quota** để cập nhật.

## Dịch cả trang: ưu tiên API riêng, fallback miễn phí

Khi bấm nút VI/EN dịch cả trang, extension **ưu tiên dùng API riêng đã cấu hình** (DeepL/Gemini/OpenAI — tốn quota). Tắt bằng toggle **"Dịch cả trang bằng API riêng"** trong popup/Cài đặt (storage key `tm-page-use-provider`, **mặc định bật**).

Khi API riêng lỗi hoặc đã tắt toggle, chuỗi **fallback miễn phí không cần key** lần lượt thử: Google Translate API endpoint → Google Translate web endpoint → MyMemory (đoạn ngắn). Gặp 429/lỗi server sẽ tự chờ rồi thử lại; dịch cả trang được gom batch để tránh hàng trăm request lẻ.

Chặn dịch trên từng site tại mục **"Không dịch trên các site"** trong Cài đặt — mỗi dòng 1 domain, khớp cả sub-domain (ví dụ `reddit.com` chặn luôn `old.reddit.com`).

## Dịch trang nâng cao (v4.2)

Bộ tuỳ chọn tinh chỉnh cách dịch cả trang — chỉnh nhanh trong popup (5 control) hoặc đầy đủ trong trang **Cài đặt** (5 mục chọn + 5 toggle). Mọi thay đổi áp dụng cho lần dịch sau, không cần cài lại.

- **Chế độ hiển thị** — chỉ bản dịch (thay thế, mặc định) hoặc **song ngữ**: bản dịch chèn ngay dưới đoạn gốc, làm mờ nhẹ để phân biệt, tự gỡ khi về bản gốc. Đổi qua lại giữa hai chế độ không tốn dịch lại.
- **Văn phong dịch** — Tự nhiên / Trò chuyện thân mật / Email công việc / Chat game / Văn phong Gen Z / Lịch sự, trang trọng. Chỉ áp dụng với provider LLM (Gemini, OpenAI-compatible); DeepL và fallback miễn phí (Google/MyMemory) không đọc instruction nên **bỏ qua** các tuỳ chọn này.
- **Tiếng Anh Mỹ / Anh** — chọn spelling, từ vựng và thành ngữ Mỹ hay Anh; chỉ ảnh hưởng khi đích dịch là tiếng Anh.
- **Dịch tự nhiên vs sát chữ** — Tự nhiên giữ văn phong bản địa (mặc định); Sát chữ bám cấu trúc câu gốc, ưu tiên độ trung thực hơn độ mượt.
- **Sửa ngữ pháp sau khi dịch** — ép kết quả hoàn chỉnh về ngữ pháp/chính tả, tự lặng sửa cả lỗi có sẵn trong câu gốc.
- **Giữ nguyên tên riêng** — tên người, thương hiệu, địa danh, username không bị dịch hay dịch âm (mặc định bật).
- **Không dịch code** — bỏ qua `code`/`pre`/`kbd`/`samp`, editor (Monaco, CodeMirror), block có class `hljs`/`prettyprint`/`prism`/`code-block`...; tôn trọng `translate="no"` và `.notranslate` (mặc định bật).
- **Không dịch username** — nhận diện heuristic: class chứa username/nickname/screen-name, handle `@abc`, `u/abc` (mặc định bật; có thể bổ sung selector theo site).
- **Nội dung động & SPA** — MutationObserver dịch nội dung tải động, kèm hook history (`pushState`/`replaceState`/`popstate`) cho SPA như Discord/Reddit/Facebook; bài mới tự dịch khi cuộn (mặc định bật).
- **Dịch lướt theo khung nhìn (lazy)** — trang dài chỉ dịch phần sắp hiển thị (IntersectionObserver, rootMargin 250px), cuộn tới đâu dịch tới đó — tiết kiệm quota. Tắt được trong Cài đặt (mặc định bật).

## Dịch đoạn bôi đen

Bôi đen một đoạn chữ trên trang → hiện **nút nổi** cạnh vùng chọn → bấm để dịch đoạn đó qua **provider riêng** (DeepL/Gemini/OpenAI, theo thứ tự ưu tiên). Kết quả hiện trong panel nhỏ kèm **nút sao chép**. Tắt được bằng toggle **"Dịch đoạn bôi đen"** trong Cài đặt (mặc định bật).

## Nút ✨ EN (đổi văn bản đang gõ sang tiếng Anh)

- `✨ EN` / `Alt+Shift+E`: dùng API riêng (DeepL/Gemini/OpenAI), có fallback miễn phí nếu bật.
- `Alt+Shift+G`: dịch miễn phí trực tiếp.
- Nút nằm **ngoài ô nhập** (trên/dưới góc phải ô) nên không che chữ đang gõ; chỉ chui vào trong ô khi cả hai phía ngoài đều không có chỗ. Nút **kéo thả được** để đổi vị trí.
- Không muốn nút bám cạnh ô nhập/thanh tìm kiếm: tắt toggle **"Hiện nút ✨ EN cạnh ô nhập liệu"** trong popup hoặc Cài đặt — áp dụng ngay, không cần tải lại trang.

### Phong cách dịch bản địa (v4.1)

Với Gemini/OpenAI, chọn giọng văn trong popup hoặc Cài đặt:

- **Tự nhiên** — bám đúng văn phong gốc: nghiêm túc ra nghiêm túc, đùa cợt ra đùa cợt; xử lý anh/chị/em/ơi/nhé/đấy theo sắc thái xã giao tự nhiên của tiếng Anh, thành ngữ dịch sang thành ngữ tương đương.
- **Trang trọng** — email, LinkedIn, chat công việc: lịch sự, gọn gàng, vẫn ấm áp chứ không cứng nhắc.
- **Thân mật** — nhắn bạn bè, mạng xã hội. Hệ thống 2 lớp bảo đảm giống ngườ thật: prompt ép model viết kiểu texter (cấm apostrophe, dùng idk/rn/tbh/ngl/wyd/gonna/wanna...), cộng thêm bộ lọc hậu xử lý tự động bỏ apostrophe (`I'm→im`, `don't→dont`, `that's→thats`, `I→i`) kể cả khi model — hoặc DeepL — trả về văn chuẩn.

DeepL là engine dịch thuần nên không áp dụng phong cách qua prompt, nhưng khi chọn **Thân mật** thì kết quả DeepL vẫn được bộ lọc hậu xử lý bỏ apostrophe. Muốn văn "ngườ" nhất thì ưu tiên Gemini/OpenAI.

## Dịch ảnh (OCR qua Gemini)

Dịch chữ trong ảnh (meme, banner, ảnh chụp màn hình...) mà không cần gõ lại:

- **Cách dùng**: chuột phải vào ảnh bất kỳ → chọn **"Dịch ảnh này (Gemini)"**. Kết quả hiện trong một panel cạnh ảnh, có nút sao chép. Đích dịch mặc định là tiếng Việt.
- **Yêu cầu**: bật provider **Gemini** và có key hợp lệ (lấy tại <https://aistudio.google.com/apikey>). Gemini là model multimodal nên đọc ảnh trực tiếp — không cần OCR engine riêng.
- **Quyền truy cập**: extension fetch ảnh từ background bằng quyền host; lần đầu dịch ảnh trên một domain, trình duyệt sẽ hỏi quyền truy cập domain đó — chọn **Cho phép** để tiếp tục.

Giới hạn hiện tại:

- Chưa vẽ chữ đè lên ảnh (không inpainting) — kết quả chỉ hiện dạng text trong panel.
- Ảnh quá lớn hoặc chữ quá nhỏ/nét kém có thể đọc sai.

## Icon nổi trên trang (FAB)

- Icon kính trong suốt (liquid glass) ở góc màn hình — **kéo thả** tới vị trí bất kỳ, extension tự nhớ vị trí (storage key `tm-fab-position`).
- **Click trái**: bật/tắt dịch nhanh (bản gốc ↔ ngôn ngữ gần nhất dùng, mặc định VI).
- **Chuột phải**: mở menu chọn VI / EN / Gốc kèm trạng thái dịch.
- Nút ✨ EN cạnh ô nhập cũng **kéo thả được** (offset lưu ở `tm-input-helper-offset`); menu mũi tên → **"Về vị trí mặc định"** để reset.

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
- `options.html` / `options.js` — trang Cài đặt (quản lý key, quota DeepL, blacklist site).
- `popup.html` / `popup.js` — tác vụ nhanh.

Từ v4.2, cấu trúc file giữ nguyên — chỉ mở rộng contract message: `content.js` gửi `providerTranslate` kèm `pageOptions` `{ style, dialect, mode, grammarFix, keepProperNouns }`; `background.js` sanitize (giá trị sai về mặc định) rồi truyền vào `providers.js`, nơi `buildBatchInstructions` ghép các rule thành system instruction. DeepL là engine dịch thuần nên bỏ qua `pageOptions`.

Storage keys mới trên `chrome.storage.local`:

| Key | Giá trị | Mặc định |
|---|---|---|
| `tm-page-display-mode` | `'replace'` \| `'bilingual'` | `'replace'` |
| `tm-page-style` | `'natural'` \| `'casual'` \| `'work-email'` \| `'game-chat'` \| `'genz'` \| `'formal'` | `'natural'` |
| `tm-page-dialect` | `'us'` \| `'uk'` | `'us'` |
| `tm-page-translate-mode` | `'natural'` \| `'literal'` | `'natural'` |
| `tm-page-grammar-fix` | boolean | `false` |
| `tm-page-skip-code` | boolean | `true` |
| `tm-page-skip-usernames` | boolean | `true` |
| `tm-page-keep-proper-nouns` | boolean | `true` |
| `tm-page-dynamic-translate` | boolean | `true` |
| `tm-page-lazy-translate` | boolean | `true` |

## Khắc phục sự cố

- **"Extension context invalidated"**: extension vừa reload/nâng cấp trong khi tab cũ còn script cũ — chỉ cần **F5 tải lại trang**. Bản mới tự hiện thông báo này thay vì chuỗi lỗi gốc.
- **Không dịch được trang**: reload tab sau khi cài/nâng cấp extension (content script cũ chưa khớp background mới).
- **Trang nhiễu nhiều ngôn ngữ (Anh/Trung/Nhật/Hàn)**: extension tự gom các đoạn cùng nhóm chữ vào một batch để dịch hết — nếu dùng API riêng, DeepL/Gemini tự detect từng đoạn.
- Chỉ giữ **1 bản extension** duy nhất — xoá các bản cũ/trùng trong `chrome://extensions` để tránh xung đột.
- Kiểm tra log lỗi tại `brave://extensions` hoặc `chrome://extensions` → mục extension → **Service worker** → Console.
- Bấm nút **Test API** trong popup để kiểm tra provider/key còn hoạt động không.

## Lưu ý

- Extension không tự tính phí hay trừ token; API bên thứ ba vẫn áp quota/giới hạn riêng (DeepL Free: 500.000 ký tự/tháng).
- Extension không chạy được trên `chrome://`, `edge://`, Chrome Web Store và một số trang hệ thống.
