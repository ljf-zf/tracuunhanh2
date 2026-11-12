# Hướng dẫn cài Print Agent Windows

Print Agent nhận lệnh in trực tiếp qua WebSocket bảo mật từ Cloudflare Worker. Agent giữ nguyên chức năng in bill dựng từ dữ liệu đơn và bổ sung in PDF vận đơn gốc do Sapo tạo. Agent **không có hàng đợi**: khi máy tính tắt hoặc mất kết nối, web báo lỗi và không lưu lệnh để in bù.

## 1. Chuẩn bị Secret trên Cloudflare

Trong Cloudflare Dashboard → Workers & Pages → Worker đang chạy website → Settings → Variables and Secrets, tạo các Secret sau ở môi trường Production:

- `PRINT_AGENT_TOKEN`: chuỗi ngẫu nhiên dài tối thiểu 32 ký tự. Dùng cùng giá trị trong `print-agent/config.json`.
- `PRINT_WEB_PIN`: mã PIN do cửa hàng tự chọn, nên dùng 8–12 chữ số/ký tự. Người thao tác nhập mã này khi bấm in lần đầu trong mỗi tab web.
- Giữ nguyên `SAPO_SYNC_SECRET` đang dùng cho chức năng đồng bộ xác thực Sapo.

Tạo thêm Secret `SAPO_BRIDGE_TOKEN` bằng một chuỗi riêng (không dùng lại `PRINT_AGENT_TOKEN`). Có thể tạo token ngẫu nhiên bằng Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Không đưa các giá trị Secret lên GitHub và không gửi `PRINT_AGENT_TOKEN` cho người không được phép điều khiển máy in.

## 2. Deploy Worker

Sau khi đã tạo hai Secret mới, deploy lại Worker để áp dụng Durable Object `PrintBroker` và API in trực tiếp. `wrangler.jsonc` đã khai báo binding và migration cần thiết.

Kiểm tra `/api/health/config`. Phần `printing` cần có:

- `brokerConfigured: true`
- `agentTokenConfigured: true`
- `webPinConfigured: true`

## 3. Cài Print Agent trên Windows

1. Cài Node.js phiên bản 20 trở lên từ trang chính thức: https://nodejs.org/
2. Giải nén thư mục `print-agent` vào một vị trí cố định, ví dụ `C:\SapoPrintAgent`.
3. Sao chép `config.example.json` thành `config.json`.
4. Mở `config.json` và điền:
   - `workerUrl`: địa chỉ HTTPS website đang chạy Cloudflare Worker (không thêm `/` ở cuối).
   - `agentToken`: đúng giá trị Secret `PRINT_AGENT_TOKEN` trên Cloudflare.
   - `printerName`: để trống để dùng máy in mặc định Windows; hoặc điền chính xác tên Xprinter trong Windows.
   - `shopName`: tên cửa hàng hiển thị ở đầu bill (có thể để trống).
   - `pdfViewerPath`: đường dẫn SumatraPDF.exe; để trống nếu cài ở vị trí mặc định.
5. Mở PowerShell tại thư mục `print-agent` và chạy:

```powershell
npm install
npm start
```

Khi thấy `Đã kết nối Cloudflare Print Broker`, Agent đã sẵn sàng.

## 4. Cài PDF renderer để in vận đơn Sapo gốc

Chức năng in vận đơn gốc cần SumatraPDF trên Windows để gửi PDF trực tiếp tới driver mà không mở hộp thoại:
1. Cài SumatraPDF từ trang chính thức: https://www.sumatrapdfreader.org/download-free-pdf-viewer
2. Mở thử SumatraPDF một lần để hoàn tất cài đặt.
3. Nếu cài ở thư mục mặc định, Agent tự tìm `SumatraPDF.exe`. Nếu cài nơi khác, khai báo đường dẫn trong `pdfViewerPath` của `config.json`.
4. Khởi động lại Print Agent.

## 5. Chọn máy in Windows

- Mở Windows Settings → Bluetooth & devices → Printers & scanners.
- Kiểm tra driver Xprinter đã cài và máy in đang Online.
- Đặt Xprinter làm máy in mặc định nếu `printerName` trong config để trống.
- Nếu điền tên máy in trong config, tên đó phải khớp chính xác với tên Windows hiển thị.
- Khổ giấy và loại media hiện dùng theo cấu hình của driver Windows; chưa cố định trong mã nguồn để có thể tinh chỉnh sau khi xác nhận model và giấy thực tế.

## 6. Dùng từ điện thoại

1. Bật máy tính Windows tại cửa hàng.
2. Chạy `start-agent-hidden.vbs` hoặc `npm start` trong thư mục Agent.
3. Mở website tra cứu trên điện thoại. Điện thoại không cần cùng Wi-Fi với máy tính, miễn cả hai có Internet.
4. Tra cứu đơn và chọn `In bill` hoặc `In vận đơn Sapo`.
5. Với `In vận đơn Sapo`, Edge trên máy tính cửa hàng phải đang mở trang Sapo đã đăng nhập và extension `Sapo Print Bridge` phải kết nối. Extension sẽ gọi lệnh in Sapo cho đúng ID đơn, nhận PDF gốc từ notification và chuyển qua Worker tới Agent.
6. Nếu đây là lần đầu cài Bridge, cần mở Sapo trên Edge, tải lại trang và thực hiện một lần in thử trực tiếp trên Sapo để Bridge nhận `clientId`/thông tin phiên. Các lần sau có thể bấm in vận đơn từ web tra cứu.
7. Nhập `PRINT_WEB_PIN` khi được hỏi.
8. Web gửi lệnh trực tiếp đến Agent; Agent sử dụng driver Windows để gửi lệnh vào Windows Print Spooler.

## 7. Tự chạy khi đăng nhập Windows (tùy chọn)

Nhấn `Win + R`, nhập `shell:startup`, rồi tạo shortcut đến `start-agent-hidden.vbs` trong thư mục này. Node.js phải được cài và nằm trong PATH. Agent sẽ chạy nền sau khi người dùng đăng nhập Windows và tự kết nối lại khi Internet chập chờn.

## 8. Giới hạn cần biết

- Không có hàng đợi in và không tự in bù khi Agent offline.
- Một thời điểm chỉ xử lý một lệnh in; yêu cầu khác trong lúc đang in sẽ nhận lỗi `409`, không được xếp hàng.
- Thành công có nghĩa Windows Print Spooler đã tiếp nhận lệnh; không khẳng định giấy đã ra khỏi máy in hoặc máy không hết giấy.
- Mẫu in sử dụng dữ liệu Sapo API trả về. Nếu API không cung cấp tên người nhận, số điện thoại hoặc giá trị tiền, trường tương ứng có thể không xuất hiện trên bill.
- Hiện tại Agent sử dụng khổ giấy và media mặc định của driver. Cần kiểm tra bản in thử trước khi dùng hàng loạt; có thể cấu hình kích thước giấy sau khi xác định chính xác model và loại giấy.
- Web PIN và Agent token là hai lớp bảo vệ khác nhau. Không chia sẻ PIN in rộng rãi; thay token nếu nghi ngờ Agent bị lộ.


## 9. Cài Sapo Print Bridge Extension trên Edge

1. Mở `edge://extensions` và bật **Developer mode**.
2. Chọn **Load unpacked**, trỏ tới thư mục `sapo-bridge-extension` trong source ZIP.
3. Bấm biểu tượng extension, nhập Worker URL và cùng giá trị Secret `SAPO_BRIDGE_TOKEN` đã tạo trên Cloudflare.
4. Cấp quyền kết nối tới Worker, sau đó tải lại tab Sapo đã đăng nhập.
5. Giữ Edge và tab Sapo mở trong lúc cần in từ điện thoại.

Bridge chỉ gửi event `PRINT_ORDER` cùng đường dẫn PDF từ host `social.dktcdn.net` đã allowlist. Không gửi Authorization, X-Market-Token, cookie hoặc mật khẩu Sapo lên Worker. Khi web yêu cầu in, Worker gửi lệnh qua WebSocket tới Bridge; Bridge gọi endpoint in Sapo trong phiên trình duyệt; notification trả PDF gốc; Worker chuyển PDF cho Agent.

**Lưu ý:** Sapo có thể thay đổi cấu trúc API hoặc cơ chế notification. Nếu Bridge không lấy được `clientId`/thông tin xác thực trong phiên hiện tại, nó sẽ báo lỗi và không tự dựng bill thay thế.
