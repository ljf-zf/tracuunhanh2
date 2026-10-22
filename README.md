# Tra đơn nhanh Sapo — bản MVP

Web app tối ưu cho điện thoại: nhập 4 số cuối, liệt kê các đơn khớp theo mã đơn hoặc mã vận đơn, ưu tiên đơn mới nhất; hiện sản phẩm, số lượng và hãng vận chuyển.

## Quan trọng trước khi dùng

- Đây là **bộ mã nguồn triển khai**, chưa phải một website đã được public trên Internet.
- Extension cũ lưu thông tin xác thực trong `chrome.storage.local` dưới khóa `sapoAuth`; web app không tự đọc được dữ liệu này.
- API `/v2/orders` và các trường được quan sát trong extension có thể là API nội bộ Marketplace, không được đảm bảo ổn định như API công khai. Hãy kiểm tra quyền truy cập và điều khoản Sapo trước khi triển khai.
- Không gửi token hoặc file `.env` qua chat, không nhúng token vào `public/app.js`, không commit `.env` lên Git.
- Để dùng trên điện thoại từ ngoài mạng nội bộ, cần triển khai lên máy chủ có HTTPS. Chỉ dùng `(đã bỏ đăng nhập)` riêng cho ứng dụng và giới hạn người được phép truy cập.

## Chạy thử trên máy chủ/máy tính

Yêu cầu Node.js 20 trở lên.

1. Giải nén thư mục.
2. Sao chép `.env.example` thành `.env`.
3. Điền `(đã bỏ đăng nhập)` và các giá trị xác thực Sapo vào `.env` trên máy chủ.
4. Cài và chạy:

   ```bash
   npm install
   npm start
   ```

5. Mở `http://localhost:3000`.

Khi `NODE_ENV=production`, cookie đăng nhập có cờ `Secure`, vì vậy website phải chạy qua HTTPS.

## Lấy thông tin xác thực

Từ extension đã có quyền truy cập, kiểm tra giá trị `sapoAuth` trong bộ nhớ extension và ánh xạ các trường:
- `origin` → `SAPO_ORIGIN`
- `authorization` → `SAPO_AUTHORIZATION`
- `xMarketAccountId` → `SAPO_MARKET_ACCOUNT_ID`
- `xMarketToken` → `SAPO_MARKET_TOKEN`
- `channelType`, `connectionIds`, `sortBy`, `orderBy`, `channelOrderStatus` → các biến cùng tên trong `.env` nếu có.

Không đưa thông tin này vào frontend hoặc ảnh chụp màn hình. Nếu token có thời hạn, cần quy trình cập nhật/đổi token; không nên dựa vào token cũ mãi mãi.

## Giới hạn hiện tại cần kiểm tra với dữ liệu thật

1. Máy chủ dò tối đa `MAX_PAGES` trang (mặc định 10 × 100 đơn) để giữ tốc độ. Nếu có nhiều đơn hơn, có thể tăng `MAX_PAGES`.
2. Mã đang dò các trường mã đơn phổ biến: `channel_order_number`, `sapo_order_code`, `order_code`, `code`, `order_number` và `tracking_code`.
3. Tên hãng vận chuyển có thể khác nhau theo cấu trúc response của tài khoản Sapo. Nếu chưa được trả về trong trường đã hỗ trợ, giao diện sẽ hiện “Chưa xác định”; cần chỉnh bộ ánh xạ sau khi kiểm tra response thật.
4. Tên sản phẩm và số lượng được đọc từ `items`, `line_items`, `order_items`, `products` hoặc `details`; cấu trúc response thực tế có thể cần bổ sung.
5. Thứ tự “mới nhất” được sắp theo thời gian tạo đơn trả về. Nên xác nhận tên trường thời gian của API thật.

## Bảo mật

- Dùng HTTPS khi public.
- Dùng mật khẩu ứng dụng riêng, dài và khó đoán.
- Hạn chế truy cập máy chủ; không public endpoint cho người lạ.
- Token chỉ nằm trong biến môi trường phía máy chủ; không gửi token về trình duyệt.
- Phiên đăng nhập hết hạn sau 12 giờ; đăng xuất sẽ thu hồi phiên.
- Cache kết quả mặc định 20 giây, không lưu lâu dài danh sách đơn.
- Trước khi sử dụng thực tế, nên bổ sung kiểm thử với response đã ẩn thông tin cá nhân và cơ chế cập nhật token phù hợp.


## Lưu ý về truy cập nội bộ

Phiên bản này đã bỏ màn hình đăng nhập. Nếu triển khai dưới dạng Render Web Service thông thường, đường dẫn có thể truy cập công khai; chỉ chia sẻ cho nhân viên và không đăng token Sapo vào mã nguồn/GitHub. Token Sapo vẫn chỉ được đọc ở máy chủ qua biến môi trường. Nếu cần giới hạn thật sự theo nhân viên, hãy dùng VPN hoặc lớp kiểm soát truy cập ở phía máy chủ.
