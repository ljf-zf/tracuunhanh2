# Hướng dẫn cấu hình Cloudflare

1. Đưa toàn bộ nội dung thư mục này lên repository dành riêng cho Cloudflare.
2. Trong Workers Builds chọn repository đó, deploy command `npx wrangler deploy`.
3. Mở Worker đang chạy website → Settings → Variables and Secrets.
4. Tạo các Secret ở môi trường Production:
   - `SAPO_SYNC_SECRET` (giữ giá trị đang dùng cho chức năng đồng bộ token Sapo).
   - `PRINT_AGENT_TOKEN` (token ngẫu nhiên tối thiểu 32 ký tự; dùng cùng giá trị trong `print-agent/config.json`).
   - `PRINT_WEB_PIN` (mã PIN in do cửa hàng tự đặt; nhập mã này trên web khi bấm in).
5. Nếu `SAPO_AUTHORIZATION` và `SAPO_MARKET_TOKEN` đang là loại Text/Variable, xóa và tạo lại đúng loại Secret với token Sapo mới, còn hạn. Không gửi hoặc lưu token trong GitHub.
6. Deploy lại Worker. Cấu hình đã khai báo Durable Object `PrintBroker` cùng migration `v1` để chuyển lệnh in trực tiếp; không có hàng đợi lưu trữ.
7. Mở `/api/health/config`. Kết quả đúng cần có `auth.hasAnyCredential: true`, ít nhất một trong `authorizationConfigured` hoặc `marketTokenConfigured: true`, và trong `printing` cả `brokerConfigured`, `agentTokenConfigured`, `webPinConfigured` đều là `true`.
8. Thử `/api/search?q=<mã-đơn-đang-tồn-tại>`.
9. Cài Windows Print Agent theo `PRINT-AGENT-HUONG-DAN.md`, mở `/api/print/status` hoặc xem chỉ báo máy in trên website.

Nếu health báo Secret đã có nhưng tìm kiếm trả 401/403, lấy token hiện tại từ Sapo; không sửa `worker.js` để xử lý lỗi token hết hạn.

## Lưu ý triển khai

- `wrangler.jsonc` giữ các biến không bí mật và khai báo Durable Object binding/migration. Không ghi token, PIN hoặc khóa đồng bộ vào file cấu hình.
- Nếu dùng Cloudflare Workers Builds, hãy tạo đủ Secrets trong Dashboard trước lần deploy có thay đổi này.
- ZIP không chứa `config.json` thật của Agent và không chứa bất kỳ Secret nào.
