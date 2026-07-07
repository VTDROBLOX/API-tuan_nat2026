require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const { requireAdmin } = require('./auth');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ==============================================================================
// KHỞI ĐỘNG: nếu có ADMIN_TOKEN trong env mà DB chưa có, tự đồng bộ vào DB
// Ưu tiên env var (dễ set trên hosting) nhưng vẫn cho phép đổi qua UI settings sau này
// ==============================================================================
if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.trim() !== "") {
    const currentCfg = db.getConfig();
    if (!currentCfg.adminToken || currentCfg.adminToken.trim() === "") {
        db.setConfig({ adminToken: process.env.ADMIN_TOKEN.trim() });
        console.log("✅ Đã nạp ADMIN_TOKEN từ biến môi trường vào DB.");
    }
}

const finalCfg = db.getConfig();
if (!finalCfg.adminToken || finalCfg.adminToken.trim() === "") {
    console.warn("⚠️  CẢNH BÁO: chưa set ADMIN_TOKEN. Trang /settings sẽ bị khoá hoàn toàn cho tới khi set.");
    console.warn("   -> Set biến môi trường ADMIN_TOKEN=<chuỗi bí mật của bạn> rồi restart lại server.");
}

// Hàm mã hoá ký tự dựa trên JSON Custom — giữ nguyên logic gốc, không đổi
function encodeJobId(jobId, jsonString) {
    if (!jsonString || jsonString.trim() === "") return jobId;
    try {
        const encodeMap = JSON.parse(jsonString);
        let result = "";
        for (let i = 0; i < jobId.length; i++) {
            const char = jobId[i];
            result += encodeMap[char] !== undefined ? encodeMap[char] : char;
        }
        return result;
    } catch (e) {
        return jobId;
    }
}

// ==============================================================================
// VALIDATE INPUT — chặn payload rác/độc trước khi chạm tới DB
// ==============================================================================
function validateEventPayload(data) {
    const errors = [];

    if (typeof data.Type !== 'string' || data.Type.trim() === '') {
        errors.push("Type phải là chuỗi không rỗng");
    }
    if (typeof data.JobId !== 'string' || data.JobId.trim() === '') {
        errors.push("JobId phải là chuỗi không rỗng");
    }
    if (data.Status !== undefined && !['Found', 'Lost'].includes(data.Status)) {
        errors.push("Status chỉ được là 'Found' hoặc 'Lost'");
    }
    if (data.Players !== undefined && isNaN(Number(data.Players))) {
        errors.push("Players phải là số");
    }
    // giới hạn độ dài để tránh payload khổng lồ làm phình DB hoặc phá layout HTML
    if (typeof data.Type === 'string' && data.Type.length > 100) {
        errors.push("Type quá dài (tối đa 100 ký tự)");
    }
    if (typeof data.JobId === 'string' && data.JobId.length > 200) {
        errors.push("JobId quá dài (tối đa 200 ký tự)");
    }
    if (data.EventData !== undefined && typeof data.EventData === 'string' && data.EventData.length > 200) {
        errors.push("EventData quá dài (tối đa 200 ký tự)");
    }

    return errors;
}

// Escape HTML cơ bản để chống XSS khi render ra /settings hoặc trang chủ
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ==============================================================================
// HỆ THỐNG TỰ ĐỘNG XOÁ JOB HẾT HẠN — giờ chạy qua DB, xoá thật bằng SQL thay vì filter mảng
// SỬA BUG: trước đây decrement stats bằng counter rời rạc dễ lệch/âm.
// Giờ stats được TÍNH TRỰC TIẾP từ COUNT(*) trong DB mỗi lần gọi getStats(),
// nên không còn khái niệm "decrement" nữa -> không thể lệch được.
// ==============================================================================
setInterval(() => {
    const cfg = db.getConfig();
    const timeoutMs = cfg.jobTimeoutSeconds * 1000;
    const { removedCount } = db.purgeExpired(timeoutMs);
    if (removedCount > 0) {
        console.log(`🧹 Đã dọn ${removedCount} job hết hạn.`);
    }
}, 2000);

// ==============================================================================
// [API ENDPOINT] NHẬN DATA TỪ SCRIPT GAME (POST)
// ==============================================================================
app.post('/api/event', async (req, res) => {
    const data = req.body;

    if (data.cac) {
        db.recordExecute(String(data.cac).slice(0, 200)); // giới hạn độ dài field "by"
    }

    // Validate trước khi xử lý bất cứ thứ gì
    const validationErrors = validateEventPayload(data);
    if (validationErrors.length > 0) {
        return res.status(400).json({ error: "Dữ liệu không hợp lệ", details: validationErrors });
    }

    const eventType = data.Type;
    const jobId = data.JobId;
    const status = data.Status || "Found";
    const bossName = (typeof data.EventData === 'string' && data.EventData.trim() !== '') ? data.EventData : eventType;

    const cfg = db.getConfig();

    if (status === "Found") {
        if (db.countActiveServers() >= cfg.maxJobs) {
            return res.status(429).json({ error: "API đã đầy Job" });
        }

        // Check tồn tại TRƯỚC khi upsert (upsert sẽ update nếu trùng, nên phải check trước để biết isDuplicate)
        const existing = db.findServer(jobId, bossName);
        const isDuplicate = existing !== null;

        // autoDeleteDuplicate: nếu bật, xoá bản cũ trước (thực chất upsert đã tự update,
        // nhưng giữ nhánh này để hành vi giống hệt bản gốc khi cần "làm mới timeUp hoàn toàn")
        if (cfg.autoDeleteDuplicate && isDuplicate) {
            db.removeServer(jobId, bossName);
        }

        const serverSchema = {
            boss: bossName,
            type: eventType,
            jobid: jobId,
            players: Number(data.Players) || 0,
            sea: data.Sea || "Unknown",
            placeid: data.PlaceID,
            timeUp: Date.now()
        };
        db.upsertServer(serverSchema);

        // CHỈ GỬI WEBHOOK NẾU ĐÂY LÀ JOBID MỚI XUẤT HIỆN LẦN ĐẦU — giữ nguyên logic gốc
        if (!isDuplicate) {
            if (cfg.webhookUrl && cfg.webhookUrl.startsWith("http") && cfg.customWebhookJson && cfg.customWebhookJson.trim() !== "") {
                try {
                    const encodedId = encodeJobId(jobId, cfg.customEncodeJson);
                    const currentTimeIso = new Date().toISOString();

                    let template = cfg.customWebhookJson;
                    template = template
                        .replace(/{{boss}}/g, bossName)
                        .replace(/{{sea}}/g, serverSchema.sea)
                        .replace(/{{players}}/g, serverSchema.players)
                        .replace(/{{job}}/g, encodedId)
                        .replace(/{{time}}/g, currentTimeIso);

                    await fetch(cfg.webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: template
                    });
                } catch (err) {
                    console.log("Lỗi gửi Webhook: " + err.message);
                }
            }
        }
    }
    else if (status === "Lost") {
        db.removeServer(jobId, bossName);
    }

    res.status(200).json({ message: "Success" });
});

// ==============================================================================
// TRANG CHỦ (/) -> BẢO MẬT KHÔNG HIỆN JSON
// ==============================================================================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
        <body style="background:#111827; color:#f3f4f6; font-family:sans-serif; padding:40px; text-align:center;">
            <h2 style="color:#818cf8;">Hệ thống API đang chạy ẩn an toàn!</h2>
            <p style="color:#9ca3af; font-size:14px;">Dữ liệu JSON gốc đã được khóa tại trang chủ.</p>
            <div style="margin-top:20px;">
                <a href="/api/all" style="color:#34d399; text-decoration:none; margin:0 15px; font-weight:bold;">🌐 Xem JSON Dữ Liệu (/api/all)</a>
                <a href="/settings" style="color:#f59e0b; text-decoration:none; margin:0 15px; font-weight:bold;">⚙️ Trang quản trị (/settings)</a>
            </div>
        </body>
    `);
});

// ==============================================================================
// ĐƯỜNG DẪN (/api/all) -> HIỆN TOÀN BỘ JSON LIVE ĐẦY ĐỦ
// ==============================================================================
app.get('/api/all', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const cfg = db.getConfig();
    const servers = db.getAllServers();
    const meta = db.getMetaSnapshot();

    let publicData = {
        "Total Execute": meta.totalExecute,
        "by": meta.by,
        "stats": db.getStats(),
        "all_servers": servers
    };

    if (cfg.customEncodeJson && cfg.customEncodeJson.trim() !== "") {
        publicData.all_servers = publicData.all_servers.map(server => {
            server.jobid = encodeJobId(server.jobid, cfg.customEncodeJson);
            return server;
        });
    }

    res.send(JSON.stringify(publicData, null, 2));
});

// ==============================================================================
// ĐƯỜNG DẪN LỌC RIÊNG (/api/:eventName)
// LƯU Ý QUAN TRỌNG: route này là catch-all cho MỌI /api/xxx, kể cả /api/settings (GET).
// Vì Express match theo THỨ TỰ ĐỊNH NGHĨA, và /api/settings hiện tại chỉ định nghĩa
// method POST, nên GET /api/settings vẫn đang bị route này nuốt mất — không lỗi,
// nhưng sẽ trả về mảng lọc rỗng thay vì trang settings. Đây không phải bug mới phát
// sinh, mà là hành vi có sẵn từ bản gốc. Nếu sau này muốn thêm GET /api/settings,
// PHẢI định nghĩa nó TRƯỚC route catch-all này.
// ==============================================================================
app.get('/api/:eventName', (req, blockRes) => {
    blockRes.setHeader('Content-Type', 'application/json');
    const target = req.params.eventName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cfg = db.getConfig();

    const filtered = db.getServersByFilter(target);

    const result = filtered.map(server => ({
        "boss": server.boss,
        "type": server.type,
        "jobid": encodeJobId(server.jobid, cfg.customEncodeJson),
        "players": server.players,
        "sea": server.sea,
        "Placeid": server.Placeid,
        "status": "Found",
        "timeUp": server.timeUp
    }));

    blockRes.send(JSON.stringify(result, null, 2));
});

// ==============================================================================
// GIAO DIỆN PHÍA ADMIN QUẢN TRỊ CÀI ĐẶT (/settings) — GIỜ ĐÃ CÓ AUTH
// ==============================================================================
app.get('/settings', requireAdmin(db.getConfig), (req, res) => {
    const cfg = db.getConfig();
    const stats = db.getStats();

    let statsHtml = '';
    for (const [key, val] of Object.entries(stats)) {
        statsHtml += `
            <div class="bg-gray-900 p-3 rounded-lg border border-gray-800 flex justify-between items-center">
                <span class="text-gray-300 font-mono text-xs font-semibold capitalize">${escapeHtml(key.replace(/_/g, ' '))}</span>
                <span class="bg-indigo-600 text-white text-xs px-2 py-0.5 rounded-full font-bold font-mono">${val}</span>
            </div>`;
    }
    if (statsHtml === '') statsHtml = '<p class="text-gray-500 text-xs py-2">Chưa ghi nhận sự kiện nào.</p>';

    const currentToken = req.query.token || req.headers['x-admin-token'] || (req.cookies && req.cookies.admin_token) || '';

    const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Settings API Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    </head>
    <body class="bg-gray-950 text-gray-100 p-4 md:p-8 font-sans">
        <div class="max-w-4xl mx-auto space-y-6">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl gap-4">
                <div>
                    <h1 class="text-xl font-black text-indigo-400 tracking-tight">⚙️ API SETTINGS MANAGER</h1>
                    <p class="text-xs text-gray-400 mt-1">Cấu hình Webhook & Custom JSON Encode</p>
                </div>
                <div class="flex gap-2">
                    <button onclick="window.location.href='/api/all'" class="cursor-pointer bg-gray-800 hover:bg-gray-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition">
                        🌐 Xem /api/all
                    </button>
                    <button onclick="document.cookie='admin_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/'; window.location.href='/settings'" class="cursor-pointer bg-red-900 hover:bg-red-800 text-white px-4 py-2 rounded-lg text-xs font-bold transition">
                        🚪 Đăng xuất
                    </button>
                </div>
            </div>

            <div class="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl">
                <h2 class="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">📊 Bộ đếm số lượng tên sự kiện hiện tại</h2>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">${statsHtml}</div>
            </div>

            <form action="/api/settings?token=${encodeURIComponent(currentToken)}" method="POST" class="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl space-y-5">
                <input type="hidden" name="_token" value="${escapeHtml(currentToken)}">

                <div>
                    <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Đường dẫn Discord Webhook gửi về</label>
                    <input type="text" name="webhookUrl" value="${escapeHtml(cfg.webhookUrl)}" placeholder="https://discord.com/api/webhooks/..." class="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500">
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Auto xóa Job trùng lặp</label>
                        <select name="autoDeleteDuplicate" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500">
                            <option value="true" ${cfg.autoDeleteDuplicate ? 'selected' : ''}>Bật</option>
                            <option value="false" ${!cfg.autoDeleteDuplicate ? 'selected' : ''}>Tắt (Mặc định)</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Giữ Job trong bao lâu (Giây)</label>
                        <input type="number" name="jobTimeoutSeconds" value="${cfg.jobTimeoutSeconds}" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 font-mono">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Số JobID tối đa API có</label>
                        <input type="number" name="maxJobs" value="${cfg.maxJobs}" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 font-mono">
                    </div>
                </div>

                <div>
                    <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Bảng JSON Mã hóa từng ký tự JobID</label>
                    <textarea name="customEncodeJson" rows="6" placeholder='Nhập JSON từ điển cấu trúc...' class="w-full bg-gray-950 border border-gray-800 rounded-lg p-3 text-xs font-mono text-amber-400 focus:outline-none focus:border-indigo-500">${escapeHtml(cfg.customEncodeJson)}</textarea>
                </div>

                <div>
                    <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Cấu hình Custom Webhook JSON gửi đi</label>
                    <textarea name="customWebhookJson" rows="8" placeholder='Nhập cấu trúc payload Discord JSON...' class="w-full bg-gray-950 border border-gray-800 rounded-lg p-3 text-xs font-mono text-emerald-400 focus:outline-none focus:border-indigo-500">${escapeHtml(cfg.customWebhookJson)}</textarea>
                </div>

                <div class="border-t border-gray-800 pt-5">
                    <label class="block text-xs font-bold text-red-400 uppercase tracking-wider mb-2">🔑 Đổi Admin Token (để trống nếu không đổi)</label>
                    <input type="password" name="adminToken" placeholder="Token mới..." class="w-full bg-gray-950 border border-red-900 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-red-500">
                </div>

                <button type="submit" class="cursor-pointer w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs py-3 rounded-lg uppercase tracking-wider transition active:scale-[0.99]">
                    💾 Lưu cấu hình hệ thống
                </button>
            </form>
        </div>
    </body>
    </html>`;

    // set cookie để lần sau khỏi gõ lại token qua URL
    if (req.query.token) {
        res.cookie('admin_token', req.query.token, { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
    }
    res.send(html);
});

app.post('/api/settings', requireAdmin(db.getConfig), (req, res) => {
    const updates = {
        webhookUrl: req.body.webhookUrl || "",
        autoDeleteDuplicate: req.body.autoDeleteDuplicate === 'true' ? 'true' : 'false',
        jobTimeoutSeconds: String(Number(req.body.jobTimeoutSeconds) || 60),
        maxJobs: String(Number(req.body.maxJobs) || 100),
        customEncodeJson: req.body.customEncodeJson || "",
        customWebhookJson: req.body.customWebhookJson || ""
    };

    // chỉ đổi token nếu người dùng thực sự nhập giá trị mới (không ghi đè bằng chuỗi rỗng)
    if (req.body.adminToken && req.body.adminToken.trim() !== "") {
        updates.adminToken = req.body.adminToken.trim();
    }

    db.setConfig(updates);

    const tokenToKeep = req.body._token || req.query.token || '';
    res.redirect('/settings?token=' + encodeURIComponent(tokenToKeep));
});

app.listen(port, () => {
    console.log(`API JSON đang chạy tại cổng: ${port}`);
    console.log(`Database: ${process.env.DB_PATH || './data.sqlite'}`);
});
