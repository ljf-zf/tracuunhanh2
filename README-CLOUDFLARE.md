# Hướng dẫn cấu hình Cloudflare

1. Đưa toàn bộ nội dung thư mục này lên repository dành riêng cho Cloudflare.
2. Trong Workers Builds chọn repository đó, deploy command `npx wrangler deploy`.
3. Sau deploy, mở Worker `tracuunhanh-worker` → Settings → Variables and Secrets.
4. Xóa các mục `SAPO_AUTHORIZATION` và `SAPO_MARKET_TOKEN` nếu chúng đang là loại Text/Variable. Tạo lại từng mục đúng loại **Secret** với token Sapo mới, còn hạn. Log cũ đã làm lộ token và thời hạn `exp` trong token đó là 21/10/2026, nên đừng dùng lại token cũ. Không gửi hoặc lưu token trong GitHub.
5. Redeploy nếu Dashboard yêu cầu.
6. Mở `/api/health/config`. Kết quả đúng phải có `auth.hasAnyCredential: true` và ít nhất một trong `authorizationConfigured` hoặc `marketTokenConfigured` là `true`.
7. Thử `/api/search?q=<mã-đơn-đang-tồn-tại>` rồi thử giao diện trên điện thoại.

Nếu health báo Secret đã có nhưng gọi tìm kiếm trả 401/403, lấy token hiện tại từ Sapo; không sửa lại `worker.js` để xử lý lỗi token hết hạn.
