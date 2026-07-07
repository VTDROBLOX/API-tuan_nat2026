// ==============================================================================
// DB.JS — Lớp quản lý SQLite, thay thế hoàn toàn object "database" lưu RAM cũ
// Dùng better-sqlite3 vì đồng bộ (sync), nhanh, không cần await lằng nhằng
// ==============================================================================
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL'); // WAL mode để đọc/ghi đồng thời không khoá nhau

// ------------------------------------------------------------------
// KHỞI TẠO SCHEMA (chạy 1 lần, IF NOT EXISTS nên restart bao nhiêu lần cũng an toàn)
// ------------------------------------------------------------------
db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jobid TEXT NOT NULL,
        boss TEXT NOT NULL,
        type TEXT NOT NULL,
        players INTEGER DEFAULT 0,
        sea TEXT DEFAULT 'Unknown',
        placeid TEXT,
        time_up INTEGER NOT NULL,
        UNIQUE(jobid, boss)
    );

    CREATE INDEX IF NOT EXISTS idx_servers_time_up ON servers(time_up);
    CREATE INDEX IF NOT EXISTS idx_servers_type ON servers(type);

    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// ------------------------------------------------------------------
// CONFIG MẶC ĐỊNH — chỉ insert nếu chưa có (giữ nguyên config cũ khi restart)
// ------------------------------------------------------------------
const DEFAULT_CONFIG = {
    webhookUrl: "",
    autoDeleteDuplicate: "false",
    jobTimeoutSeconds: "60",
    maxJobs: "100",
    customEncodeJson: "",
    customWebhookJson: "",
    adminToken: ""   // token bảo mật /settings — rỗng nghĩa là chưa set, sẽ báo warning lúc khởi động
};

const insertConfigIfMissing = db.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`);
for (const [key, val] of Object.entries(DEFAULT_CONFIG)) {
    insertConfigIfMissing.run(key, val);
}

// meta: lưu "Total Execute" và "by" — 2 giá trị đơn lẻ không thuộc bảng nào cả
db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('total_execute', '0')`).run();
db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('last_by', 'Chưa có')`).run();

// ==============================================================================
// PREPARED STATEMENTS — chuẩn bị sẵn để tái sử dụng, nhanh hơn parse SQL mỗi lần gọi
// ==============================================================================
const stmts = {
    getAllConfig: db.prepare(`SELECT key, value FROM config`),
    setConfig: db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

    getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
    setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    incrTotalExecute: db.prepare(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'total_execute'`),

    findServer: db.prepare(`SELECT * FROM servers WHERE jobid = ? AND boss = ?`),
    countServers: db.prepare(`SELECT COUNT(*) AS c FROM servers`),
    insertServer: db.prepare(`
        INSERT INTO servers (jobid, boss, type, players, sea, placeid, time_up)
        VALUES (@jobid, @boss, @type, @players, @sea, @placeid, @time_up)
        ON CONFLICT(jobid, boss) DO UPDATE SET
            type = excluded.type,
            players = excluded.players,
            sea = excluded.sea,
            placeid = excluded.placeid,
            time_up = excluded.time_up
    `),
    deleteServer: db.prepare(`DELETE FROM servers WHERE jobid = ? AND boss = ?`),
    deleteExpired: db.prepare(`DELETE FROM servers WHERE time_up < ?`),
    selectExpired: db.prepare(`SELECT type, COUNT(*) as c FROM servers WHERE time_up < ? GROUP BY type`),

    getAllServers: db.prepare(`SELECT * FROM servers ORDER BY time_up DESC`),
    getServersByFilter: db.prepare(`
        SELECT * FROM servers
        WHERE REPLACE(LOWER(type), ' ', '') = ? OR REPLACE(LOWER(boss), ' ', '') = ?
        ORDER BY time_up DESC
    `),

    // stats được TÍNH TRỰC TIẾP từ bảng servers (COUNT thật), không lưu counter rời rạc
    // -> đây là điểm sửa bug chính: không còn khả năng lệch/âm vì không có 2 nguồn sự thật nữa
    getStats: db.prepare(`
        SELECT type, COUNT(*) as count
        FROM servers
        GROUP BY type
    `)
};

// ==============================================================================
// HÀM PUBLIC — export ra để server.js dùng, che giấu hết chi tiết SQL bên trong
// ==============================================================================

function getConfig() {
    const rows = stmts.getAllConfig.all();
    const cfg = {};
    for (const row of rows) cfg[row.key] = row.value;
    // convert đúng kiểu dữ liệu như bản gốc (bool/number) để phần còn lại của code không phải đổi
    cfg.autoDeleteDuplicate = cfg.autoDeleteDuplicate === 'true';
    cfg.jobTimeoutSeconds = Number(cfg.jobTimeoutSeconds) || 60;
    cfg.maxJobs = Number(cfg.maxJobs) || 100;
    return cfg;
}

function setConfig(updates) {
    const tx = db.transaction((entries) => {
        for (const [key, val] of entries) {
            stmts.setConfig.run(key, String(val));
        }
    });
    tx(Object.entries(updates));
}

function recordExecute(byWhom) {
    stmts.incrTotalExecute.run();
    stmts.setMeta.run('last_by', byWhom);
}

function getMetaSnapshot() {
    return {
        totalExecute: Number(stmts.getMeta.get('total_execute')?.value || 0),
        by: stmts.getMeta.get('last_by')?.value || 'Chưa có'
    };
}

function countActiveServers() {
    return stmts.countServers.get().c;
}

// Trả về server đã tồn tại (để check duplicate) hoặc null
function findServer(jobid, boss) {
    return stmts.findServer.get(jobid, boss) || null;
}

// Upsert 1 job — nếu đã tồn tại (cùng jobid+boss) sẽ update thay vì lỗi UNIQUE constraint
function upsertServer(server) {
    stmts.insertServer.run({
        jobid: server.jobid,
        boss: server.boss,
        type: server.type,
        players: server.players,
        sea: server.sea,
        placeid: server.placeid,
        time_up: server.timeUp
    });
}

function removeServer(jobid, boss) {
    const info = stmts.deleteServer.run(jobid, boss);
    return info.changes > 0; // true nếu thực sự đã xoá được (khớp use-case "Lost")
}

// Dọn job hết hạn — chạy định kỳ trong server.js. Trả về danh sách type bị ảnh hưởng để log nếu cần.
function purgeExpired(timeoutMs) {
    const cutoff = Date.now() - timeoutMs;
    const affected = stmts.selectExpired.all(cutoff);
    const info = stmts.deleteExpired.run(cutoff);
    return { removedCount: info.changes, affected };
}

function getAllServers() {
    return stmts.getAllServers.all().map(rowToServerObject);
}

function getServersByFilter(normalizedTarget) {
    return stmts.getServersByFilter.all(normalizedTarget, normalizedTarget).map(rowToServerObject);
}

// stats bây giờ luôn CHÍNH XÁC vì tính trực tiếp từ dữ liệu thật, không phải counter riêng dễ lệch
function getStats() {
    const rows = stmts.getStats.all();
    const stats = {};
    for (const row of rows) {
        const statName = row.type.toLowerCase().replace(/ /g, '_');
        stats[statName] = row.count;
    }
    return stats;
}

// Chuẩn hoá tên cột SQL (snake_case) về lại đúng field như code gốc dùng (jobid, timeUp, Placeid...)
function rowToServerObject(row) {
    return {
        boss: row.boss,
        type: row.type,
        jobid: row.jobid,
        players: row.players,
        sea: row.sea,
        Placeid: row.placeid,
        timeUp: row.time_up
    };
}

module.exports = {
    getConfig,
    setConfig,
    recordExecute,
    getMetaSnapshot,
    countActiveServers,
    findServer,
    upsertServer,
    removeServer,
    purgeExpired,
    getAllServers,
    getServersByFilter,
    getStats
};
