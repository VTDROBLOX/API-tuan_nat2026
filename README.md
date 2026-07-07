# Job Tracker API — Bản nâng cấp v2.0

## Cài đặt

```bash
npm install
cp .env.example .env
```

Mở `.env`, đổi `ADMIN_TOKEN` thành chuỗi bí mật của cậu. Đây là bắt buộc — nếu để trống, `/settings` sẽ bị khoá hoàn toàn (403), không phải mở toang như bản cũ.

```bash
npm start
```

Server chạy ở `http://localhost:3000`, DB tự tạo file `data.sqlite` cạnh `server.js`.

## Vào trang quản trị

```
http://localhost:3000/settings?token=<ADMIN_TOKEN_cua_cau>
```

Lần đầu vào bằng query `?token=`, hệ thống tự set cookie 7 ngày nên lần sau khỏi gõ lại. Có nút "Đăng xuất" để xoá cookie.

## Những gì đã thay đổi so với bản gốc

### 1. Bảo mật `/settings` + `/api/settings`
Trước đây ai cũng vào đổi webhook, xoá config được. Giờ cần `ADMIN_TOKEN` qua header `x-admin-token`, query `?token=`, hoặc cookie. So sánh token dùng `crypto.timingSafeEqual` để chống timing attack.

### 2. Data chuyển từ RAM sang SQLite (`better-sqlite3`)
Toàn bộ `database` object cũ giờ nằm trong `data.sqlite`. Restart server không mất data nữa. File `db.js` gói toàn bộ query, `server.js` không đụng SQL trực tiếp.

### 3. Sửa bug stats lệch/âm
Bản gốc dùng counter rời (`database.stats[statName] += 1` / `-= 1`) ở 3 chỗ khác nhau (Found, Lost, auto-expire) — dễ lệch nếu 2 sự kiện chạy gần nhau. Giờ `getStats()` tính trực tiếp bằng `COUNT(*) GROUP BY type` từ bảng `servers` thật, nên không thể lệch được nữa — luôn khớp với data thật.

### 4. Validate input ở `/api/event`
Check `Type`, `JobId`, `Status`, `Players` đúng kiểu và giới hạn độ dài trước khi xử lý. Trả `400` với chi tiết lỗi nếu payload sai.

### 5. Escape HTML chống XSS
`bossName`, `sea`, config text hiển thị trong `/settings` giờ qua `escapeHtml()` trước khi render — trước đây một `EventData` chứa `<script>` có thể chạy trong trang settings.

### 6. Lưu ý về route `/api/:eventName`
Route catch-all này khớp mọi `/api/xxx` kể cả `/api/settings` (GET). Hiện `/api/settings` chỉ định nghĩa POST nên không đụng nhau, nhưng đã ghi chú rõ trong code — nếu sau này thêm GET `/api/settings`, phải định nghĩa **trước** route catch-all.

## Cấu trúc file

```
server.js    → route + logic nghiệp vụ (giữ nguyên hành vi gốc)
db.js        → toàn bộ SQL, export hàm sạch cho server.js dùng
auth.js      → middleware kiểm tra admin token
.env         → PORT, ADMIN_TOKEN, DB_PATH (tự tạo từ .env.example)
data.sqlite  → DB tự sinh, đừng xoá nếu không muốn mất data
```

## Deploy lên Render

Repo đã có sẵn `render.yaml` — Render tự đọc file này (Blueprint) và cấu hình đúng, không cần bấm tay trong dashboard:

1. Push code này lên GitHub, rồi trên Render chọn **New > Blueprint**, trỏ vào repo.
2. Render sẽ hỏi giá trị cho `ADMIN_TOKEN` (đánh dấu `sync: false` nên không lưu sẵn trong file, phải nhập tay lúc deploy) — đặt 1 chuỗi bí mật dài, đừng để trống.
3. `render.yaml` đã tự gắn **Persistent Disk** 1GB tại `/opt/render/project/data` và trỏ `DB_PATH` vào đó. **Bắt buộc phải có bước này** — free tier của Render không giữ filesystem giữa các lần container restart/sleep, nên nếu không gắn disk, `data.sqlite` sẽ mất sạch mỗi khi service ngủ dậy, dù code persist đúng logic.

### Nếu không dùng render.yaml (deploy tay qua dashboard)

Set thủ công trong phần **Settings** của service:
- Build Command: `rm -f yarn.lock package-lock.json && npm install`
- Start Command: `npm start`
- Thêm 1 Disk, mount vào ví dụ `/opt/render/project/data`, rồi set env `DB_PATH=/opt/render/project/data/data.sqlite`

Lý do cần xoá `yarn.lock`/`package-lock.json` trong build command: Render tự phát hiện package manager dựa vào lockfile nào có sẵn trên máy chủ (kể cả lockfile sót lại từ lần deploy trước). Nếu máy chủ đang có `package-lock.json` cũ trong khi lần deploy mới build bằng yarn, log sẽ hiện cảnh báo lẫn lộn package manager. Dòng `rm -f` đảm bảo luôn build sạch bằng `npm install` mỗi lần, khớp với `package.json` hiện tại.

### Vì sao trước đó bị warning đỏ trong log

Mấy dòng warning (`No license field`, `better-sqlite3 ... No longer maintained`) không phải lỗi làm fail build — build vẫn tiếp tục chạy sau đó. Đã thêm `"license": "MIT"` vào `package.json` để tắt warning đầu. Warning `better-sqlite3` deprecated là do chính tác giả package đó không maintain activity thường xuyên nữa (khác với "không hoạt động") — bản `11.3.0` vẫn build và chạy bình thường, đã ghim cứng version này (bỏ dấu `^`) để tránh Render tự kéo bản mới hơn có thể chưa có prebuilt binary cho môi trường của họ, việc đó mới thực sự gây build fail (phải compile from source, dễ timeout trên free tier).

## Việc chưa làm (nói để cậu biết, không tự ý làm)

- Chưa thêm rate-limit cho `/api/event` — nếu script game gọi quá nhiều có thể cần thêm `express-rate-limit`.
- Chưa mã hoá `data.sqlite` — nếu server bị truy cập file trực tiếp, data đọc được thẳng.
- `adminToken` lưu plaintext trong DB — đủ dùng cho 1 admin cá nhân, nhưng nếu multi-admin nên hash bằng bcrypt.

Nói nếu cần thêm mấy cái này hoặc tính năng khác.
