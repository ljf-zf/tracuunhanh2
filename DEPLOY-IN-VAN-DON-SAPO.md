# Nâng cấp in vận đơn gốc Sapo — bản 2.0.0

## Thay đổi
- Giữ nguyên tra cứu và nút **In bill** hiện tại.
- Thêm nút **In vận đơn Sapo** trên từng kết quả.
- Thêm `sapo-bridge-extension` cho Edge: quan sát notification `PRINT_ORDER`, lấy PDF URL, và nhận lệnh từ web để gọi endpoint in của Sapo trong tab đã đăng nhập.
- Worker kiểm tra URL PDF theo allowlist `social.dktcdn.net/shopee/.../prints_orders/*.pdf`, lưu liên kết ngắn hạn trong Durable Object và chuyển PDF gốc cho Agent.
- Agent 2.0.0 in PDF bằng SumatraPDF qua driver Windows; không dựng lại barcode/QR.
- Không có hàng đợi in và không tự gửi lại khi timeout.

## A. Cloudflare
1. Vào Worker Production → Settings → Variables and Secrets.
2. Giữ nguyên các Secret đang dùng: `SAPO_SYNC_SECRET`, `PRINT_AGENT_TOKEN`, `PRINT_WEB_PIN`.
3. Tạo thêm Secret `SAPO_BRIDGE_TOKEN` (tối thiểu 32 ký tự ngẫu nhiên).
4. Lưu cùng token này để nhập vào popup extension. Không commit token vào GitHub.
5. Deploy source 2.0.0. `wrangler.jsonc` đã khai báo Secret bắt buộc và Durable Object binding hiện hữu, không cần migration mới.

Tạo token bằng PowerShell/Node:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Sau deploy kiểm tra:
- `/api/health/config` → `printing.sapoBridgeConfigured: true`
- `/api/print/status` → `connected: true` khi Agent online; `bridgeConnected: true` khi extension online.

## B. Windows Print Agent
1. Cài SumatraPDF: https://www.sumatrapdfreader.org/download-free-pdf-viewer
2. Thay thư mục Agent cũ bằng `print-agent` trong source mới (sao lưu `config.json` trước).
3. Giữ nguyên `workerUrl`, `agentToken`, `printerName`, `shopName`; thêm `pdfViewerPath` nếu SumatraPDF cài ở vị trí không mặc định.
4. Mở PowerShell tại `print-agent`, chạy `npm install`, rồi `npm start`.
5. Log phải hiển thị Agent v2.0.0 đã kết nối.

## C. Edge — Sapo Print Bridge
1. Mở `edge://extensions`.
2. Bật Developer mode → Load unpacked.
3. Chọn thư mục `sapo-bridge-extension`.
4. Bấm biểu tượng Sapo Print Bridge.
5. Nhập Worker URL (ví dụ domain Workers đang dùng) và giá trị `SAPO_BRIDGE_TOKEN`.
6. Bấm Lưu cấu hình và cấp quyền.
7. Mở/tải lại tab Sapo đang đăng nhập, ví dụ `goldentech.mysapogo.com`.
8. Giữ Edge và tab Sapo mở khi cần in từ điện thoại.

**Khởi tạo Bridge lần đầu:** sau khi cài extension, thực hiện một lần thao tác in vận đơn trên Sapo. Bridge cần quan sát request in thực tế để ghi nhận `clientId`/`accountId` dùng trong phiên. Sau đó các lần in tiếp theo có thể khởi tạo từ nút trên web tra cứu. Nếu Sapo đổi phiên hoặc cấu trúc request, cần tải lại Sapo và khởi tạo lại.

## D. Kiểm thử
1. Đảm bảo `/api/print/status` báo cả Agent và Bridge đã kết nối.
2. Tra cứu một đơn đã có thể in vận đơn trên Sapo.
3. Bấm **In vận đơn Sapo**.
4. Kỳ vọng: Edge gọi endpoint `/v2/orders/print` cho đúng `order_id`; Sapo phát notification `PRINT_ORDER`; Worker lấy PDF gốc; Agent gửi PDF qua SumatraPDF tới Xprinter.
5. Kiểm tra giấy in giữ nguyên barcode/QR và khổ giấy theo driver Xprinter.
6. Thử lại nút **In bill** để xác nhận chức năng cũ vẫn hoạt động.

## Giới hạn / an toàn
- Máy Windows, Edge, tab Sapo đã đăng nhập, extension và Agent phải đang chạy.
- Không gửi Cookie, Authorization hoặc X-Market-Token lên Worker; Bridge chỉ dùng chúng trong bộ nhớ của trang Sapo để gọi endpoint same-origin/CORS của Sapo.
- Chỉ chấp nhận PDF HTTPS từ host `social.dktcdn.net` và thư mục `shopee/.../prints_orders/`.
- Không tự động thử lại khi timeout để tránh in trùng.
- Thành công xác nhận Windows/renderer đã nhận lệnh; không chứng minh giấy đã ra nếu máy hết giấy/kẹt giấy.
- Sapo có thể thay đổi API hoặc cơ chế notification; nếu không lấy được `clientId`/phiên, Bridge báo lỗi và không fallback sang bill tự dựng.
