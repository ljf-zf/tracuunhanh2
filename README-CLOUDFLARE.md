# Tra cứu Sapo trên Cloudflare Workers

## An toàn
- Không xóa Render cũ. Chỉ chuyển sang URL Workers sau khi kiểm thử thành công.
- Không đưa token Sapo vào GitHub, `worker.js`, hoặc bất kỳ tệp trong `public/`.
- Mã hiện giữ chức năng tìm theo mã đơn/mã vận đơn của ZIP được gửi. Mã nguồn ZIP này chưa có tìm theo địa chỉ trong `server.js`; không nên coi tìm địa chỉ đã được chuyển sang bản Workers.

## Triển khai bằng GitHub + Cloudflare Dashboard
1. Giải nén ZIP này. Đưa nội dung bên trong thư mục `sapo-cloudflare-workers` lên một repo GitHub mới hoặc nhánh mới. Đừng ghi đè repo đang phục vụ Render.
2. Đăng nhập https://dash.cloudflare.com/ → Workers & Pages → Create application → Workers → Connect to Git (tên mục có thể thay đổi theo giao diện).
3. Chọn repo mới/nhánh thử nghiệm. Build command: để trống nếu dashboard cho phép; Deploy command: `npx wrangler deploy`. Nếu dashboard yêu cầu build command, dùng `npm install` và deploy `npx wrangler deploy` theo các trường tương ứng.
4. Sau khi Worker được tạo, vào Settings → Variables and Secrets và thêm từng biến sau nếu chúng tồn tại trong cấu hình Render:
   - `SAPO_ORIGIN` (thường `https://market-place.sapoapps.vn`)
   - `SAPO_AUTHORIZATION` (Secret)
   - `SAPO_MARKET_ACCOUNT_ID` (Secret hoặc Text tùy tính nhạy cảm)
   - `SAPO_MARKET_TOKEN` (Secret)
   - `SAPO_CHANNEL_TYPE` (Text, nếu đang dùng)
   - `SAPO_CONNECTION_IDS` (Text, nếu đang dùng)
   - `SAPO_SORT_BY` (Text, nếu đang dùng; mặc định `ISSUED_AT`)
   - `SAPO_ORDER_BY` (Text, nếu đang dùng; mặc định `desc`)
   - `SAPO_CHANNEL_ORDER_STATUS` (Text, nếu đang dùng; mặc định `READY_TO_SHIP,RETRY_SHIP`)
   - `MAX_PAGES` (Text, tùy chọn; mặc định 10)
   - `CACHE_SECONDS` (Text, tùy chọn; mặc định 20)
5. Sau khi thêm Secrets/Variables, redeploy Worker nếu Cloudflare yêu cầu.
6. Mở URL `*.workers.dev`. Thử tra một mã đơn đã biết và một mã vận đơn đã biết.
7. Nếu gặp 401/403, cấu hình xác thực Sapo không còn hợp lệ hoặc thiếu header/biến. Không chia sẻ token trong ảnh chụp màn hình.
8. Chỉ sau khi kiểm thử ổn định mới cập nhật lối tắt/PWA trên điện thoại sang URL Workers. Render vẫn để nguyên.

## Lưu ý về Git integration
Cấu hình build/deploy trên Cloudflare có thể thay đổi theo loại tài khoản/giao diện. Nếu dashboard không nhận `wrangler.jsonc` hoặc không cung cấp kết nối Git cho loại Worker đã chọn, đừng sửa Render; dùng quy trình Workers Builds chính thức của Cloudflare hoặc triển khai thử bằng Wrangler từ máy tính.

## Khác biệt với Render
Workers không chạy `server.js`/Express như một Node server thường trực; `worker.js` xử lý từng request. Mã này chuyển API `/api/search`, còn `public/` được phục vụ bằng Static Assets. Đây không phải bảo đảm uptime tuyệt đối; vẫn có hạn mức của gói Cloudflare và phụ thuộc API Sapo.
