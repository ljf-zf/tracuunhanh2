# Sapo Print Bridge Extension

## Cài trên Edge
1. Mở `edge://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và chọn nguyên thư mục `sapo-bridge-extension`.
4. Bấm biểu tượng extension, nhập Worker URL đang chạy và cùng giá trị Secret `SAPO_BRIDGE_TOKEN` đã tạo trên Cloudflare.
5. Cấp quyền kết nối Worker.
6. Tải lại tab `market-place.sapoapps.vn` đang đăng nhập Sapo.

Extension chỉ theo dõi response notification Socket.IO polling của Sapo và chỉ chuyển sự kiện `PRINT_ORDER` có `status=SUCCESS`, kèm URL PDF thuộc `https://social.dktcdn.net/shopee/.../prints_orders/*.pdf`. Không đọc hoặc chuyển Authorization, X-Market-Token, cookie hay mật khẩu Sapo.

## Cách hoạt động
Khi người dùng thao tác In vận đơn trên Sapo, extension nhận event chứa `order_id`, `sapo_order_code` và `data_to_print`, sau đó gửi metadata tới Worker bằng `SAPO_BRIDGE_TOKEN`. Worker lưu ánh xạ ngắn hạn trong Durable Object. Từ web tra cứu, nút **In vận đơn Sapo** yêu cầu Worker lấy PDF gốc và chuyển cho Windows Print Agent.
