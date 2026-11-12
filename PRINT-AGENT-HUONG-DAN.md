# Hướng dẫn cài Print Agent Windows

Print Agent nhận lệnh in trực tiếp qua WebSocket bảo mật từ Cloudflare Worker và gửi nội dung bill đến máy in bằng driver Windows. Agent **không có hàng đợi**: khi máy tính tắt hoặc mất kết nối, web báo lỗi và không lưu lệnh để in bù.

## 1. Chuẩn bị Secret trên Cloudflare

Trong Cloudflare Dashboard → Workers & Pages → Worker đang chạy website → Settings → Variables and Secrets, tạo các Secret sau ở môi trường Production:

- `PRINT_AGENT_TOKEN`: chuỗi ngẫu nhiên dài tối thiểu 32 ký tự. Dùng cùng giá trị trong `print-agent/config.json`.
- `PRINT_WEB_PIN`: mã PIN do cửa hàng tự chọn, nên dùng 8–12 chữ số/ký tự. Người thao tác nhập mã này khi bấm in lần đầu trong mỗi tab web.
- Giữ nguyên `SAPO_SYNC_SECRET` đang dùng cho chức năng đồng bộ xác thực Sapo.

Có thể tạo token ngẫu nhiên bằng Node.js:

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
5. Mở PowerShell tại thư mục `print-agent` và chạy:

```powershell
npm install
npm start
```

Khi thấy `Đã kết nối Cloudflare Print Broker`, Agent đã sẵn sàng.

## 4. Chọn máy in Windows

- Mở Windows Settings → Bluetooth & devices → Printers & scanners.
- Kiểm tra driver Xprinter đã cài và máy in đang Online.
- Đặt Xprinter làm máy in mặc định nếu `printerName` trong config để trống.
- Nếu điền tên máy in trong config, tên đó phải khớp chính xác với tên Windows hiển thị.
- Khổ giấy và loại media hiện dùng theo cấu hình của driver Windows; chưa cố định trong mã nguồn để có thể tinh chỉnh sau khi xác nhận model và giấy thực tế.

## 5. Dùng từ điện thoại

1. Bật máy tính Windows tại cửa hàng.
2. Chạy `start-agent-hidden.vbs` hoặc `npm start` trong thư mục Agent.
3. Mở website tra cứu trên điện thoại. Điện thoại không cần cùng Wi-Fi với máy tính, miễn cả hai có Internet.
4. Tra cứu đơn và nhấn `In bill`.
5. Nhập `PRINT_WEB_PIN` khi được hỏi.
6. Web gửi lệnh trực tiếp đến Agent; Agent sử dụng driver Windows để gửi lệnh vào Windows Print Spooler.

## 6. Tự chạy khi đăng nhập Windows (tùy chọn)

Nhấn `Win + R`, nhập `shell:startup`, rồi tạo shortcut đến `start-agent-hidden.vbs` trong thư mục này. Node.js phải được cài và nằm trong PATH. Agent sẽ chạy nền sau khi người dùng đăng nhập Windows và tự kết nối lại khi Internet chập chờn.

## 7. Giới hạn cần biết

- Không có hàng đợi in và không tự in bù khi Agent offline.
- Một thời điểm chỉ xử lý một lệnh in; yêu cầu khác trong lúc đang in sẽ nhận lỗi `409`, không được xếp hàng.
- Thành công có nghĩa Windows Print Spooler đã tiếp nhận lệnh; không khẳng định giấy đã ra khỏi máy in hoặc máy không hết giấy.
- Mẫu in sử dụng dữ liệu Sapo API trả về. Nếu API không cung cấp tên người nhận, số điện thoại hoặc giá trị tiền, trường tương ứng có thể không xuất hiện trên bill.
- Hiện tại Agent sử dụng khổ giấy và media mặc định của driver. Cần kiểm tra bản in thử trước khi dùng hàng loạt; có thể cấu hình kích thước giấy sau khi xác định chính xác model và loại giấy.
- Web PIN và Agent token là hai lớp bảo vệ khác nhau. Không chia sẻ PIN in rộng rãi; thay token nếu nghi ngờ Agent bị lộ.
