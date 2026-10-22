# Tra cứu nhanh Sapo — Cloudflare Workers

Bản triển khai dùng Cloudflare Workers + Static Assets; không chạy Express/`server.js`.

## Cấu hình quan trọng

### Biến thường (đã khai báo trong `wrangler.jsonc`)
- `SAPO_ORIGIN`
- `SAPO_MARKET_ACCOUNT_ID`
- `SAPO_CHANNEL_TYPE`
- `SAPO_CONNECTION_IDS`
- `SAPO_SORT_BY`
- `SAPO_ORDER_BY`
- `SAPO_CHANNEL_ORDER_STATUS`
- `MAX_PAGES`
- `CACHE_SECONDS`

Chỉ chỉnh các giá trị thường trong `wrangler.jsonc` khi cần.

### Secret (bắt buộc cấu hình riêng trên Cloudflare)
- `SAPO_AUTHORIZATION`
- `SAPO_MARKET_TOKEN`

Trong Cloudflare Dashboard → Workers & Pages → `tracuunhanh-worker` → Settings → Variables and Secrets, tạo hai mục ở loại **Secret**, trong đúng Worker và môi trường **Production**. Không tạo chúng là Text/Variable, không ghi chúng vào GitHub, và không dán token vào mã nguồn. Có thể cần redeploy sau khi cập nhật Secrets.

Nếu chưa có token còn hạn, lấy thông tin xác thực mới từ quy trình Sapo đang hoạt động. Không tái sử dụng token đã công khai trong log.

## Deploy qua GitHub/Cloudflare Workers Builds
- Build command: để trống nếu hệ thống cho phép.
- Deploy command: `npx wrangler deploy`.
- Giữ repository này độc lập với repository đang dùng cho Render. Không xóa Render cho tới khi bản Workers được xác nhận hoạt động.

File `wrangler.jsonc` đã khai báo các `vars` không bí mật để mỗi lần deploy không loại bỏ chúng khỏi cấu hình từ Dashboard. Hai Secret được khai báo là bắt buộc để Wrangler báo lỗi ngay nếu thiếu; giá trị Secret không được ghi trong file này.

## Kiểm tra sau deploy
Mở `https://<worker-domain>/api/health/config`. Kết quả chỉ báo `true/false`, không tiết lộ giá trị Secret. Hai trường `hasAnyCredential` và `authorizationConfigured`/`marketTokenConfigured` cho biết Worker có nhận được Secret hay chưa.

Tiếp theo kiểm tra `/api/search?q=<mã-đơn-thật>`. Lỗi `Máy chủ chưa cấu hình...` là Secret chưa được binding vào Worker; lỗi `401/403` là Sapo từ chối token (token sai/hết hạn/quyền không đủ); `count: 0` nghĩa là API đã chạy nhưng đơn không xuất hiện trong các trang/trạng thái đã quét.

## Tính năng
- Tra cứu một phần mã đơn hoặc mã vận đơn.
- Tra cứu một đoạn địa chỉ giao hàng nếu đoạn đó có trong dữ liệu API Sapo trả về.
- Hiển thị SKU, số lượng, tên sản phẩm, đơn vị vận chuyển, ngày tạo, mã vận đơn và địa chỉ có sẵn.
- Phân trang theo `MAX_PAGES`; giao diện báo khi dữ liệu có khả năng bị giới hạn.
- Endpoint chẩn đoán `/api/health/config` không bao giờ trả nội dung Secret.

**Giới hạn:** Bản này không thể khôi phục phần địa chỉ mà chính API Sapo đã che/mask hoặc không trả về. Nó chỉ tìm trong dữ liệu máy chủ nhận được.
