# Soạn đề thi Toán — bản chạy trên website riêng

Ứng dụng gồm: soạn đề kiểu Word (công thức toán chuẩn), bảng vẽ hình phẳng và hình không gian 3D, ngân hàng câu hỏi
Toán 10–11–12, tạo đề tự động theo dạng hoặc ma trận (nhiều mã đề, bảng đáp án), xuất in/PDF/Word,
lớp học, bài kiểm tra tự chấm, bài về nhà nộp ảnh, chấm điểm, bảng chung thời gian thực.

Có **hai cách chạy**. Chọn cách phù hợp.

## Cách 1 — Chỉ cần hosting tĩnh (đơn giản nhất)

Đưa **thư mục `public/`** lên bất kỳ hosting nào (GitHub Pages, Netlify, Cloudflare Pages, hosting PHP, Nginx...).
Mở `index.html` là dùng được ngay.

- Có: soạn đề, bảng vẽ 2D/3D, công thức, ngân hàng câu hỏi (kể cả "Của tôi"), tạo đề tự động, nhiều mã đề, in/PDF, tải file Word (.html).
- Dữ liệu lưu **trong trình duyệt** của từng người (không đồng bộ giữa các máy).
- Không có: tài khoản, lớp học dùng chung, nộp bài, bảng chung, ngân hàng của tổ.

Thử tại máy: `cd public && python3 -m http.server 8080` rồi mở http://localhost:8080

## Cách 2 — Có máy chủ (đủ tính năng lớp học)

Cần **Node.js 18 trở lên**. Không phải cài thêm thư viện nào.

```bash
cd soan-de-thi-web
npm start                # hoặc: node server.js
```
Mở http://localhost:3000. Lần đầu mở, trang hiện form **tạo tài khoản giáo viên đầu tiên**.
Sau đó giáo viên vào **Tài khoản** (góc dưới bên trái, hoặc `/admin.html`) để tạo tài khoản cho học sinh và giáo viên khác.

Biến môi trường (không bắt buộc):

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng chạy | 3000 |
| `DATA_DIR` | Nơi lưu dữ liệu (cơ sở dữ liệu, ảnh bài làm, khoá phiên) | `./data` |
| `COOKIE_SECURE` | Đặt `1` khi chạy sau HTTPS | 0 |
| `SESSION_SECRET` | Khoá ký phiên đăng nhập (tự tạo nếu bỏ trống) | tự tạo |

**Sao lưu:** chép thư mục `data/` (gồm `db.json` và `uploads/`).

### Chạy bằng Docker
```bash
docker build -t soan-de-thi .
docker run -d --name soan-de-thi -p 3000:3000 -v $(pwd)/data:/data -e COOKIE_SECURE=1 soan-de-thi
```

### Đưa lên VPS với tên miền và HTTPS (ví dụ Nginx)
```nginx
server {
  server_name de.truongban.edu.vn;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;          # bắt buộc để bảng chung thời gian thực (SSE) hoạt động
    proxy_read_timeout 1h;
  }
}
```
Cấp chứng chỉ bằng `certbot --nginx`, rồi chạy máy chủ với `COOKIE_SECURE=1`. Giữ tiến trình chạy bằng `pm2 start server.js --name soan-de-thi` hoặc `systemd`.

## Triển khai lên Vercel (chỉ chạy được bản tĩnh)

Vercel không chạy được máy chủ `server.js` (Vercel chỉ chạy hàm ngắn, không có ổ đĩa lưu dữ liệu và không giữ kết nối thời gian thực).
Vì vậy trên Vercel bạn dùng **Cách 1 (bản tĩnh)**. Đã có sẵn `vercel.json` trong gói.

Các bước:
1. Đẩy **toàn bộ thư mục `soan-de-thi-web`** lên một kho GitHub (hoặc dùng `vercel` CLI trong thư mục này).
2. Vercel → **Add New → Project** → chọn kho đó.
3. Trong màn hình cấu hình, kiểm tra:
   - **Framework Preset:** `Other`
   - **Root Directory:** thư mục chứa `vercel.json` (nếu đẩy cả thư mục `soan-de-thi-web` lên kho thì để trống)
   - **Build Command:** `npm run build` (đã có trong `vercel.json`)
   - **Output Directory:** `public`
   - **Install Command:** để trống
4. Bấm **Deploy**.

Nếu Vercel báo lỗi, xem tab **Build Logs** và đối chiếu:
- `No Output Directory named "public" found`: đẩy sai thư mục lên kho. Thư mục `public/` phải nằm cùng cấp với `vercel.json`. Hãy chỉnh **Root Directory** cho đúng.
- `Missing script: build`: dùng `package.json` trong gói này (đã có script `build`), hoặc xoá Build Command.
- Trang trắng hoặc 404: kiểm tra `public/index.html` có trong kho và Output Directory là `public`.

Muốn đủ tính năng lớp học, nộp bài, bảng chung, hãy chạy `server.js` ở nơi giữ được tiến trình và ổ đĩa:

| Nơi chạy | Phù hợp? | Ghi chú |
|---|---|---|
| Vercel / Netlify | Chỉ bản tĩnh | Không chạy được `server.js` |
| VPS (Ubuntu + Nginx) | Có | Linh hoạt nhất, xem phần Nginx ở trên |
| Render.com | Có | Dùng `render.yaml`; cần gói có ổ đĩa để giữ dữ liệu |
| Railway / Fly.io | Có | Tự nhận `package.json`, lệnh `npm start`; gắn volume vào `/data` và đặt `DATA_DIR=/data` |
| Docker ở máy trường | Có | Xem phần Docker ở trên |

## Phân quyền

| Dữ liệu | Giáo viên | Học sinh |
|---|---|---|
| Lớp, chương, bài soạn, bài kiểm tra | đọc, ghi | chỉ đọc |
| Ngân hàng của tổ, dữ liệu quản trị | đọc, ghi | không truy cập |
| Bài nộp (điểm làm bài, ảnh) | đọc tất cả | đọc, ghi của chính mình |
| Điểm và nhận xét bài về nhà | ghi | đọc phần của mình |
| Ngân hàng cá nhân, ma trận cá nhân | chỉ chủ tài khoản | chỉ chủ tài khoản |
| Bảng chung | đọc, ghi | đọc, ghi |

Các quy tắc này nằm trong hàm `allowed()` của `server.js`, có thể sửa theo nhu cầu.

## Cấu trúc thư mục
```
server.js              máy chủ (không cần thư viện ngoài)
package.json
vercel.json            cấu hình triển khai bản tĩnh lên Vercel
render.yaml            cấu hình triển khai đầy đủ lên Render
Dockerfile
public/
  index.html           ứng dụng (một tệp, đã gồm ngân hàng câu hỏi)
  claude-shim.js       lớp nối ứng dụng với máy chủ (đăng nhập, kho dữ liệu, tải ảnh, bảng chung)
  admin.html           trang quản lý tài khoản của giáo viên
data/                  tự tạo khi chạy (cơ sở dữ liệu, ảnh)
```

## Tuỳ chỉnh

- **Thêm câu hỏi vào ngân hàng có sẵn:** trong `public/index.html`, tìm `const BANK=[`, `const B11=[`, `const B12=[` và các dòng `addD(...)`.
  Mỗi câu có dạng: trắc nghiệm `['m', 'đề', ['A','B','C','D'], chỉ số đáp án đúng, 'lời giải', 'N|T|V|C']`,
  đúng/sai `['t', 'đề', [['ý a',1],['ý b',0],...], 'lời giải', 'mức độ']`, trả lời ngắn `['s','đề','đáp án','lời giải','mức độ']`.
  Mức độ: N nhận biết, T thông hiểu, V vận dụng, C vận dụng cao. Công thức có thể gõ thẳng như `(x² − 4)/(x − 2)` hoặc LaTeX trong dấu `$...$`.
  Cách đơn giản hơn là dùng ngân hàng **Của tôi / Của tổ** ngay trong ứng dụng.
- **Đổi tên trường, đầu đề:** tìm chuỗi `SỞ GIÁO DỤC VÀ ĐÀO TẠO` trong `index.html`.

## Giới hạn cần biết

- Cơ sở dữ liệu là tệp JSON: phù hợp một trường hoặc một tổ (vài trăm tài khoản). Muốn quy mô lớn hơn, thay phần `DB` trong `server.js` bằng PostgreSQL hoặc SQLite.
- Chưa có chức năng quên mật khẩu bằng email: giáo viên đặt lại mật khẩu trong trang Tài khoản.
- Tải file Word xuất ra tệp `.html` mở được bằng Word (lưu lại thành .docx nếu cần). Có thêm nút **Sao chép sang Word**.
- Công thức dùng phông STIX Two Text từ Google Fonts. Nếu không có mạng, trình duyệt dùng phông Times thay thế.
- Mỗi tài liệu dữ liệu tối đa khoảng 1,5 MB. Ngân hàng của tổ nên giữ dưới khoảng 240 KB.
