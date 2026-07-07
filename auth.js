// ==============================================================================
// AUTH.JS — Bảo vệ /settings và /api/settings bằng token đơn giản
// Không dùng session/cookie phức tạp vì đây là 1 dashboard cá nhân, không cần login đa user
// Token check qua: header "x-admin-token" HOẶC query "?token=" HOẶC cookie "admin_token"
// ==============================================================================
const crypto = require('crypto');

// So sánh chuỗi an toàn chống timing-attack (thay vì === thông thường)
function safeCompare(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function extractToken(req) {
    return req.headers['x-admin-token']
        || req.query.token
        || (req.cookies && req.cookies.admin_token)
        || null;
}

// Middleware chính — gắn vào route cần bảo vệ
function requireAdmin(getConfigFn) {
    return (req, res, next) => {
        const cfg = getConfigFn();
        const realToken = cfg.adminToken;

        // Nếu chưa set token trong config -> chặn hoàn toàn, KHÔNG cho bypass
        // (tránh trường hợp deploy quên set token thì /settings mở toang cho cả thế giới)
        if (!realToken || realToken.trim() === "") {
            return res.status(503).send(renderLockedPage());
        }

        const provided = extractToken(req);
        if (!provided || !safeCompare(provided, realToken)) {
            return res.status(401).send(renderLoginPage(req.originalUrl));
        }

        next();
    };
}

function renderLockedPage() {
    return `
    <body style="background:#111827; color:#f3f4f6; font-family:sans-serif; padding:40px; text-align:center;">
        <h2 style="color:#ef4444;">🔒 Chưa cấu hình ADMIN_TOKEN</h2>
        <p style="color:#9ca3af; font-size:14px;">Set biến môi trường <code>ADMIN_TOKEN</code> trước khi truy cập trang quản trị.</p>
    </body>`;
}

function renderLoginPage(redirectTo) {
    return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>Đăng nhập quản trị</title>
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    </head>
    <body class="bg-gray-950 text-gray-100 min-h-screen flex items-center justify-center font-sans">
        <form method="GET" action="${redirectTo.split('?')[0]}" class="bg-gray-900 p-8 rounded-2xl border border-gray-800 shadow-xl w-full max-w-sm space-y-4">
            <h1 class="text-lg font-black text-indigo-400">🔐 Đăng nhập quản trị</h1>
            <input type="password" name="token" placeholder="Nhập admin token"
                class="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500" autofocus>
            <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs py-3 rounded-lg uppercase tracking-wider transition">
                Vào trang quản trị
            </button>
            <p class="text-xs text-gray-500">Token được cấu hình qua biến môi trường ADMIN_TOKEN.</p>
        </form>
    </body>
    </html>`;
}

module.exports = { requireAdmin, safeCompare };
