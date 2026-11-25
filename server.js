console.log("==========================================");
console.log("   🚀 伺服器已啟動 - 版本: 20261125 10:30  ");
console.log(" 加入外送訂單機制（貼近真實 Uber 流程） "     );
console.log("==========================================");

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { fetchUberTrackingData } = require('./uberTracker');

const SECRET_KEY = "my_innovation_secret_2026";
const ADMIN_SECRET_KEY = "admin_secure_key_2026";
const ICS_CONFIG_FILE = path.resolve(__dirname, 'ics_config.json');
const ROOM_CONFIG_FILE = path.resolve(__dirname, 'room_config.json');

// Google Oauth2
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://titan-family-dashboard-poc.onrender.com/auth/google/callback";
const GOOGLE_AUTH_TTL_MS = 10 * 60 * 1000; // 10 分鐘逾時
const pendingGoogleAuthStates = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [stateKey, info] of pendingGoogleAuthStates.entries()) {
        if (!info || now > info.expiresAt) {
            pendingGoogleAuthStates.delete(stateKey);
        }
    }
}, 60 * 1000);

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function sendJsonResponse(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify(payload));
}

function fetchGoogleUserInfo(accessToken) {
    return new Promise((resolve) => {
        if (!accessToken) {
            resolve({});
            return;
        }
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/oauth2/v2/userinfo",
            method: "GET",
            headers: {
                "Authorization": "Bearer " + accessToken
            }
        }, (resp) => {
            let raw = "";
            resp.on("data", (chunk) => { raw += chunk; });
            resp.on("end", () => {
                try {
                    const parsed = raw ? JSON.parse(raw) : {};
                    resolve(parsed || {});
                } catch (e) {
                    resolve({});
                }
            });
        });
        req.on("error", () => resolve({}));
        req.end();
    });
}

// ==========================================
// 模擬外送訂單系統 & Tracking URL 引擎（貼近真實 Uber Eats 流程）
// ==========================================
const SIM_ORDERS_FILE = path.resolve(__dirname, 'sim_orders.json');
const simOrders = new Map(); // orderId -> orderObj

// 貼近真實 Uber Eats 的外送階段（statusCode 對應流程階段，etaMinutes 為該階段起算預估分鐘數）
const ORDER_STAGES = [
    { status: 'ORDER_PLACED', label: '已送出訂單，等待餐廳接單', durationSec: 60, eta: 20, etaDecayMode: 'hold' },
    { status: 'PREPARING', label: '餐廳正在準備您的餐點', durationSec: 360, eta: 19, etaDecayMode: 'slow' },
    { status: 'COURIER_TO_STORE', label: '外送合作夥伴正前往餐廳', durationSec: 240, eta: 13, etaDecayMode: 'slow' },
    { status: 'PICKING_UP', label: '外送合作夥伴正在餐廳取餐', durationSec: 120, eta: 9, etaDecayMode: 'hold' },
    { status: 'EN_ROUTE_TO_DROPOFF', label: '外送合作夥伴正前往您的地點', durationSec: 420, eta: 7, etaDecayMode: 'steady' },
    { status: 'DELIVERED', label: '餐點已送達', durationSec: 0, eta: 0, etaDecayMode: 'none' }
];

function computeRealisticEta(order, nowMs) {
    const safeIdx = Math.max(0, Math.min(order.stageIndex || 0, ORDER_STAGES.length - 1));
    const stage = ORDER_STAGES[safeIdx];
    if (!stage || stage.status === 'DELIVERED' || stage.durationSec <= 0) {
        return 0;
    }

    const nextStage = ORDER_STAGES[safeIdx + 1];
    const startEta = typeof stage.eta === 'number' ? stage.eta : 0;
    const endEta = nextStage && typeof nextStage.eta === 'number' ? nextStage.eta : 0;

    if (!nextStage || endEta >= startEta) {
        return startEta;
    }

    const elapsedSec = ((nowMs - (order.stageStartedAt || nowMs)) / 1000) * (order.speedMultiplier || 1);
    const ratio = Math.max(0, Math.min(1, elapsedSec / stage.durationSec));

    let easedRatio = ratio;
    if (stage.etaDecayMode === 'hold') {
        // 前 70% 時間維持原 ETA，尾段才微降 1 分鐘
        easedRatio = ratio < 0.7 ? 0 : ((ratio - 0.7) / 0.3) * 0.25;
    } else if (stage.etaDecayMode === 'slow') {
        // 備餐與前往餐廳階段較平緩
        easedRatio = Math.pow(ratio, 1.45);
    } else {
        // 送餐途中較明顯下降
        easedRatio = Math.pow(ratio, 0.85);
    }

    const calculated = Math.round(startEta - (startEta - endEta) * easedRatio);
    return Math.max(endEta, Math.min(startEta, calculated));
}

function loadSimOrders() {
    try {
        if (!fs.existsSync(SIM_ORDERS_FILE)) return;
        const raw = fs.readFileSync(SIM_ORDERS_FILE, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            for (let i = 0; i < arr.length; i++) {
                if (arr[i] && arr[i].id) {
                    simOrders.set(arr[i].id, arr[i]);
                }
            }
        }
    } catch (e) {
        console.error('[SimOrder] 載入 sim_orders.json 失敗:', e.message);
    }
}

function saveSimOrders() {
    try {
        const arr = Array.from(simOrders.values());
        fs.writeFileSync(SIM_ORDERS_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        console.error('[SimOrder] 儲存 sim_orders.json 失敗:', e.message);
    }
}

loadSimOrders();

function buildSimTrackingUrl(req, orderId) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = forwardedProto ? String(forwardedProto).split(',')[0].trim() : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${proto}://${host}/track/${encodeURIComponent(orderId)}`;
}

function applyStageToOrder(order, stageIndex) {
    const safeIdx = Math.max(0, Math.min(stageIndex, ORDER_STAGES.length - 1));
    const stage = ORDER_STAGES[safeIdx];
    order.stageIndex = safeIdx;
    order.status = stage.status;
    order.statusCode = stage.status;
    order.statusLabel = stage.label;
    order.etaMinutes = stage.eta;
    order.stageStartedAt = Date.now();
    order.updatedAt = new Date().toISOString();
    if (stage.status === 'DELIVERED') {
        order.etaMinutes = 0;
        order.deliveredAt = order.updatedAt;
    }
}

function createSimOrder(payload, req) {
    const orderId = 'sim_' + crypto.randomBytes(4).toString('hex');
    const nowIso = new Date().toISOString();
    const speedMultiplier = Number(payload && payload.speedMultiplier) > 0 ? Number(payload.speedMultiplier) : 1;

    const order = {
        id: orderId,
        trackingUrl: buildSimTrackingUrl(req, orderId),
        targetDashboard: (payload && payload.targetDashboard) ? String(payload.targetDashboard).trim() : '',
        merchantName: (payload && payload.merchantName) ? String(payload.merchantName) : '測試外送餐廳（中和店）',
        customerAddress: (payload && payload.customerAddress) ? String(payload.customerAddress) : '新北市中和區景平路測試地址',
        items: Array.isArray(payload && payload.items) && payload.items.length > 0
            ? payload.items
            : [{ name: '模擬主餐', qty: 1 }],
        courierName: (payload && payload.courierName) ? String(payload.courierName) : '王小明',
        speedMultiplier: speedMultiplier,
        paused: Boolean(payload && payload.paused),
        stageIndex: 0,
        status: ORDER_STAGES[0].status,
        statusCode: ORDER_STAGES[0].status,
        statusLabel: ORDER_STAGES[0].label,
        etaMinutes: ORDER_STAGES[0].eta,
        stageStartedAt: Date.now(),
        createdAt: nowIso,
        updatedAt: nowIso,
        deliveredAt: null
    };

    simOrders.set(orderId, order);
    saveSimOrders();
    return order;
}

// 自動推進模擬訂單狀態與真實感 ETA（每 2 秒檢查一次）
setInterval(() => {
    let changed = false;
    const now = Date.now();

    for (const order of simOrders.values()) {
        if (!order || order.paused) continue;
        const stage = ORDER_STAGES[order.stageIndex];
        if (!stage || stage.durationSec <= 0 || order.stageIndex >= ORDER_STAGES.length - 1) {
            continue;
        }

        const elapsedSec = ((now - (order.stageStartedAt || now)) / 1000) * (order.speedMultiplier || 1);
        const nextEta = computeRealisticEta(order, now);

        if (order.etaMinutes !== nextEta) {
            order.etaMinutes = nextEta;
            order.updatedAt = new Date().toISOString();
            changed = true;
        }

        if (elapsedSec >= stage.durationSec) {
            applyStageToOrder(order, order.stageIndex + 1);
            changed = true;
        }
    }

    if (changed) {
        saveSimOrders();
    }
}, 2000);

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderTrackingHtml(order) {
    const safeId = String(order.id).replace(/[^a-zA-Z0-9_-]/g, '');
    const safeMerchant = escapeHtml(order.merchantName);
    const safeCourier = escapeHtml(order.courierName || '外送合作夥伴');
    const safeStatus = escapeHtml(order.statusCode || order.status);
    const safeLabel = escapeHtml(order.statusLabel);
    const safeEtaNum = Number(order.etaMinutes || 0);
    const safeEtaText = safeStatus === 'DELIVERED' ? '已送達' : ('預計 ' + safeEtaNum + ' 分鐘送達');

    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>外送追蹤 - ' + safeId + '</title>' +
        '<style>body{font-family:sans-serif;max-width:520px;margin:32px auto;padding:16px;background:#f7f8fa;color:#222}' +
        '.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}' +
        '.eta{font-size:26px;font-weight:bold;color:#06c167;margin:12px 0}' +
        '.badge{display:inline-block;padding:4px 10px;border-radius:999px;background:#eef6f0;color:#058a49;font-size:13px}' +
        '.meta{font-size:13px;color:#555;margin-top:8px}</style>' +
        '</head><body><div class="card">' +
        '<div class="badge" id="statusBadge" data-testid="order-status" data-status-code="' + safeStatus + '">' + safeLabel + ' (' + safeStatus + ')</div>' +
        '<h2 id="merchantName">' + safeMerchant + '</h2>' +
        '<div class="eta" data-testid="eta-string" data-eta-minutes="' + safeEtaNum + '">' + escapeHtml(safeEtaText) + '</div>' +
        '<p id="statusLabel">' + safeLabel + '</p>' +
        '<div class="meta">外送合作夥伴：<span id="courierName">' + safeCourier + '</span></div>' +
        '<p style="font-size:12px;color:#666">訂單編號：<span id="orderId">' + safeId + '</span></p>' +
        '</div><script>' +
        'setInterval(function () {' +
        '  var xhr = new XMLHttpRequest();' +
        '  xhr.open("GET", "/api/sim-orders/' + safeId + '", true);' +
        '  xhr.onreadystatechange = function () {' +
        '    if (xhr.readyState === 4 && xhr.status === 200) {' +
        '      var resJson = JSON.parse(xhr.responseText);' +
        '      if (resJson && resJson.ok && resJson.order) {' +
        '        var o = resJson.order;' +
        '        var code = o.statusCode || o.status || "";' +
        '        var etaMin = Number(o.etaMinutes || 0);' +
        '        var badgeEl = document.getElementById("statusBadge");' +
        '        var etaEl = document.querySelector("[data-testid=\\"eta-string\\"]");' +
        '        var labelEl = document.getElementById("statusLabel");' +
        '        if (badgeEl) {' +
        '          badgeEl.setAttribute("data-status-code", code);' +
        '          badgeEl.innerHTML = o.statusLabel + " (" + code + ")";' +
        '        }' +
        '        if (etaEl) {' +
        '          etaEl.setAttribute("data-eta-minutes", String(etaMin));' +
        '          etaEl.innerHTML = (code === "DELIVERED") ? "已送達" : ("預計 " + etaMin + " 分鐘送達");' +
        '        }' +
        '        if (labelEl) labelEl.innerHTML = o.statusLabel;' +
        '      }' +
        '    }' +
        '  };' +
        '  xhr.send();' +
        '}, 2000);' +
        '</script></body></html>'
    );
}

function findSimOrderByTrackingUrl(trackingUrl) {
    if (!trackingUrl) return null;
    for (const order of simOrders.values()) {
        if (order && order.trackingUrl === trackingUrl) {
            return order;
        }
    }
    const match = String(trackingUrl).match(/\/track\/([a-zA-Z0-9_-]+)/);
    if (match && simOrders.has(match[1])) {
        return simOrders.get(match[1]);
    }
    return null;
}

function handleSimOrderHttp(req, res, parsedUrl, urlPath) {
    if (req.method === 'POST' && urlPath === '/api/sim-orders') {
        readJsonBody(req).then((body) => {
            const order = createSimOrder(body, req);
            sendJsonResponse(res, 201, {
                ok: true,
                orderId: order.id,
                trackingUrl: order.trackingUrl,
                order: order
            });
        }).catch(() => {
            sendJsonResponse(res, 400, { ok: false, error: '無效的 JSON 請求內容' });
        });
        return true;
    }

    if (req.method === 'GET' && urlPath === '/api/sim-orders') {
        sendJsonResponse(res, 200, {
            ok: true,
            orders: Array.from(simOrders.values())
        });
        return true;
    }

    // 2.5 清除舊訂單（已完成 DELIVERED、已取消 CANCELLED）
    if ((req.method === 'DELETE' || req.method === 'POST') && urlPath === '/api/sim-orders/cleanup') {
        var removedCount = 0;
        var keptCount = 0;
        simOrders.forEach(function (order, orderId) {
            if (!order) return;
            var code = String(order.statusCode || order.status || '').toUpperCase();
            if (code === 'DELIVERED' || code === 'CANCELLED') {
                simOrders.delete(orderId);
                removedCount++;
            } else {
                keptCount++;
            }
        });
        saveSimOrders();
        sendJsonResponse(res, 200, {
            ok: true,
            removedCount: removedCount,
            remainingCount: keptCount
        });
        return true;
    }

    const apiMatch = urlPath.match(/^\/api\/sim-orders\/([a-zA-Z0-9_-]+)$/);
    if (apiMatch) {
        const orderId = apiMatch[1];
        const order = simOrders.get(orderId);
        if (!order) {
            sendJsonResponse(res, 404, { ok: false, error: '找不到該模擬訂單' });
            return true;
        }

        if (req.method === 'GET') {
            sendJsonResponse(res, 200, { ok: true, order: order });
            return true;
        }

        if (req.method === 'POST') {
            readJsonBody(req).then((body) => {
                if (typeof body.paused === 'boolean') {
                    order.paused = body.paused;
                }
                if (typeof body.speedMultiplier === 'number' && body.speedMultiplier > 0) {
                    order.speedMultiplier = body.speedMultiplier;
                }
                if (typeof body.etaMinutes === 'number') {
                    order.etaMinutes = body.etaMinutes;
                }
                if (body.cancel === true || String(body.status || '').toUpperCase() === 'CANCELLED') {
                    order.status = 'CANCELLED';
                    order.statusCode = 'CANCELLED';
                    order.statusLabel = '訂單已取消';
                    order.paused = true;
                } else if (body.status) {
                    const idx = ORDER_STAGES.findIndex((s) => s.status === body.status);
                    if (idx !== -1) {
                        applyStageToOrder(order, idx);
                    }
                } else if (body.nextStage === true) {
                    applyStageToOrder(order, order.stageIndex + 1);
                }
                order.updatedAt = new Date().toISOString();
                saveSimOrders();
                sendJsonResponse(res, 200, { ok: true, order: order });
            }).catch(() => {
                sendJsonResponse(res, 400, { ok: false, error: '無效的 JSON 請求內容' });
            });
            return true;
        }
    }

    const trackMatch = urlPath.match(/^\/track\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && trackMatch) {
        const orderId = trackMatch[1];
        const order = simOrders.get(orderId);
        if (!order) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h3>找不到此追蹤訂單，可能尚未建立或已失效。</h3>');
            return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderTrackingHtml(order));
        return true;
    }
    return false;
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    let urlPath = req.url.split('?')[0].toLowerCase();
    let tokenKey = parsedUrl.searchParams.get('key');

    if (req.method === 'OPTIONS') {
        if (urlPath === "/api/google/refresh-token") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            });
        } else {
            res.writeHead(204);
        }
        res.end();
        return;
    }
    if (req.method === "POST" && urlPath === "/api/google/refresh-token") {
        (async () => {
            try {
                const body = await readJsonBody(req);
                const refreshToken = body && body.refreshToken ? String(body.refreshToken).trim() : "";
                if (!refreshToken) {
                    sendJsonResponse(res, 400, { success: false, message: "缺少 refreshToken" });
                    return;
                }
                if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
                    sendJsonResponse(res, 500, { success: false, message: "伺服器未設定 Google OAuth 憑證" });
                    return;
                }

                const tokenResp = await postFormUrlEncoded("oauth2.googleapis.com", "/token", {
                    client_id: GOOGLE_CLIENT_ID,
                    client_secret: GOOGLE_CLIENT_SECRET,
                    refresh_token: refreshToken,
                    grant_type: "refresh_token"
                });

                if (tokenResp.statusCode !== 200 || !tokenResp.body || !tokenResp.body.access_token) {
                    sendJsonResponse(res, 400, {
                        success: false,
                        message: (tokenResp.body && tokenResp.body.error_description) || "刷新 access_token 失敗"
                    });
                    return;
                }

                sendJsonResponse(res, 200, {
                    success: true,
                    accessToken: tokenResp.body.access_token,
                    expiresIn: tokenResp.body.expires_in || 3600
                });
            } catch (err) {
                console.error("[Google OAuth] refresh-token 例外:", err);
                sendJsonResponse(res, 500, { success: false, message: "刷新 Token 發生網路或系統錯誤" });
            }
        })();
        return;
    }
    if (handleSimOrderHttp(req, res, parsedUrl, urlPath)) {
        return;
    }
    if (urlPath === '/' || urlPath === '/a.html') {
        if (tokenKey !== SECRET_KEY) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: 您沒有權限存取此儀表板');
            return;
        }
    }

    if (urlPath === '/auth/google/callback') {
        handleGoogleOAuthCallback(parsedUrl, res);
        return;
    }

    const safeRoot = path.resolve(__dirname);
    let requestedFile = urlPath === '/' ? 'A.html' : req.url.split('?')[0].substring(1);

    if (requestedFile.toLowerCase() === 'admin.html') requestedFile = 'Admin.html';
    else if (requestedFile.toLowerCase() === 'b.html') requestedFile = 'B.html';
    else if (requestedFile.toLowerCase() === 'a.html') requestedFile = 'A.html';

    let filePath = path.resolve(safeRoot, requestedFile);

    if (!filePath.startsWith(safeRoot)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden (Access Denied)');
        return;
    }

    let extname = path.extname(filePath);
    let contentType = 'text/html';
    if (extname === '.js') contentType = 'text/javascript';
    else if (extname === '.css') contentType = 'text/css';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
            res.end(content, 'utf-8');
        }
    });
});

// 核心狀態管理
const dashboardRooms = new Map();     // dashboardId -> Set(sockets)
const activeAdminSockets = new Set();
const activePhoneSockets = new Set();
const roomIcsUrls = new Map();
const roomConfigs = new Map();

function loadIcsConfig() {
    try {
        if (fs.existsSync(ICS_CONFIG_FILE)) {
            const rawData = fs.readFileSync(ICS_CONFIG_FILE, 'utf8');
            const jsonData = JSON.parse(rawData);
            for (let dashId in jsonData) {
                roomIcsUrls.set(dashId, jsonData[dashId]);
            }
        }
    } catch (e) {}
}
function saveIcsConfig() {
    try {
        const obj = {};
        for (let [dashId, urls] of roomIcsUrls.entries()) {
            obj[dashId] = urls;
        }
        fs.writeFileSync(ICS_CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {}
}
loadIcsConfig();

function loadRoomConfig() {
    try {
        if (fs.existsSync(ROOM_CONFIG_FILE)) {
            const rawData = fs.readFileSync(ROOM_CONFIG_FILE, 'utf8');
            const jsonData = JSON.parse(rawData);
            for (let dashId in jsonData) {
                roomConfigs.set(dashId, jsonData[dashId]);
            }
            console.log(`[系統] 成功載入 ${roomConfigs.size} 個房間的持久化設定`);
        }
    } catch (e) {
        console.error("[系統] 載入 room_config.json 失敗：", e);
    }
}
function saveRoomConfig() {
    try {
        const obj = {};
        for (let [dashId, config] of roomConfigs.entries()) {
            obj[dashId] = config;
        }
        fs.writeFileSync(ROOM_CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error("[系統] 儲存 room_config.json 失敗：", e);
    }
}
loadRoomConfig();

let lastRoomConfigMtime = 0;
setInterval(() => {
    try {
        if (fs.existsSync(ROOM_CONFIG_FILE)) {
            const stats = fs.statSync(ROOM_CONFIG_FILE);
            if (stats.mtimeMs > lastRoomConfigMtime) {
                lastRoomConfigMtime = stats.mtimeMs;
                loadRoomConfig();
                console.log("[系統] 偵測到 room_config.json 已更新，記憶體設定已自動熱重載 (Hot Reload)！");
            }
        }
    } catch (e) {}
}, 10000);

const icsCache = new Map();
const ICS_CACHE_TTL = 30 * 60 * 1000;

// ==========================================
// 統一的外送追蹤工作階段管理（支援同一房號多筆訂單並行追蹤）
// ==========================================
// dashId -> Map(trackingUrl -> { timer, trackingUrl, latestData })
const activeTrackingSessions = new Map();

function stopUberTrackingSession(dashId, trackingUrl = null, reasonText = '已停止追蹤') {
    const key = (dashId || 'demo_tv').trim();
    const roomMap = activeTrackingSessions.get(key);
    if (!roomMap) return;

    if (trackingUrl) {
        const session = roomMap.get(trackingUrl);
        if (session && session.timer) {
            clearInterval(session.timer);
            session.timer = null;
        }
        roomMap.delete(trackingUrl);
        if (roomMap.size === 0) {
            activeTrackingSessions.delete(key);
        }
        console.log(`[Uber 追蹤] ${reasonText} (房號: ${key}, 網址: ${trackingUrl})`);
        broadcastAdminLog(`[Uber 追蹤] ${reasonText}`, key);
        return;
    }

    // 未指定特定 trackingUrl 時，停止該房號下所有追蹤
    for (const [, session] of roomMap.entries()) {
        if (session && session.timer) {
            clearInterval(session.timer);
            session.timer = null;
        }
    }
    roomMap.clear();
    activeTrackingSessions.delete(key);
    console.log(`[Uber 追蹤] ${reasonText} (房號: ${key})`);
    broadcastAdminLog(`[Uber 追蹤] ${reasonText}`, key);
}

function startUberTrackingSession(trackingUrl, targetDash) {
    const dashId = (targetDash || 'demo_tv').trim();
    if (!trackingUrl) return;

    // 若同房號已經在追蹤同一條 trackingUrl，先清掉舊 timer 避免重複輪詢
    stopUberTrackingSession(dashId, trackingUrl, '重新啟動同單追蹤');

    if (!activeTrackingSessions.has(dashId)) {
        activeTrackingSessions.set(dashId, new Map());
    }
    const roomMap = activeTrackingSessions.get(dashId);

    const session = {
        timer: null,
        trackingUrl: trackingUrl,
        latestData: null
    };
    roomMap.set(trackingUrl, session);

    console.log(`[Uber 追蹤] 開始監控網址: ${trackingUrl} (房號: ${dashId}, 目前並行數: ${roomMap.size})`);
    broadcastAdminLog(`[Uber 追蹤] 開始監控訂單進度（並行第 ${roomMap.size} 單）`, dashId);

    const executeFetch = async () => {
        // 若此 session 已被停止或移除，立即中斷
        const currentRoomMap = activeTrackingSessions.get(dashId);
        if (!currentRoomMap || !currentRoomMap.has(session.trackingUrl)) {
            if (session.timer) {
                clearInterval(session.timer);
                session.timer = null;
            }
            return;
        }

        const result = await fetchUberTrackingData(session.trackingUrl);
        if (result.success) {
            const matchedOrder = findSimOrderByTrackingUrl(session.trackingUrl);
            const rawStatus = String((result.data && result.data.status) || '');
            const codeMatch = rawStatus.match(/\(([A-Z0-9_]+)\)/);
            const statusCode = (result.data && result.data.statusCode) || (codeMatch ? codeMatch[1] : rawStatus);

            const rawEta = String((result.data && result.data.eta) || '');
            const etaMatch = rawEta.match(/(\d+)/);
            const etaMinutes = (typeof (result.data && result.data.etaMinutes) === 'number')
                ? result.data.etaMinutes
                : (etaMatch ? parseInt(etaMatch[1], 10) : (statusCode === 'DELIVERED' ? 0 : null));

            const normalizedPayload = Object.assign({}, result.data, {
                success: true,
                orderId: matchedOrder ? matchedOrder.id : (result.data.orderId || ''),
                merchantName: matchedOrder ? matchedOrder.merchantName : (result.data.merchantName || ''),
                statusCode: statusCode,
                etaMinutes: etaMinutes,
                trackingUrl: session.trackingUrl
            });

            session.latestData = normalizedPayload;

            console.log(`[Uber 追蹤更新] [${normalizedPayload.orderId || session.trackingUrl}] ETA: ${normalizedPayload.eta} (${etaMinutes}m), 狀態: ${statusCode}`);
            broadcastAdminLog(`[Uber 追蹤更新] ${normalizedPayload.orderId || ''} ETA: ${normalizedPayload.eta}, 狀態: ${statusCode}`, dashId);

            const tvSockets = dashboardRooms.get(dashId);
            if (tvSockets) {
                for (let s of tvSockets) {
                    if (!s.destroyed) {
                        sendWs(s, {
                            type: 'uber_delivery_status_update',
                            data: normalizedPayload
                        });
                    }
                }
            }

            if (statusCode === 'DELIVERED' || rawStatus.indexOf('DELIVERED') !== -1 || etaMinutes === 0) {
                stopUberTrackingSession(dashId, session.trackingUrl, '訂單已送達，已停止該單輪詢');
            }
        } else {
            console.error(`[Uber 追蹤錯誤] ${result.error}`);
            broadcastAdminLog(`[Uber 追蹤錯誤] ${result.error}`, dashId);
        }
    };

    executeFetch();
    session.timer = setInterval(executeFetch, 45 * 1000);
}

function sendWs(socket, dataObj) {
    if (!socket || socket.destroyed) return;
    const jsonStr = JSON.stringify(dataObj);
    const payloadBytes = Buffer.from(jsonStr, 'utf8');
    const length = payloadBytes.length;

    let frameHead;
    if (length < 126) {
        frameHead = Buffer.alloc(2);
        frameHead[1] = length;
    } else if (length < 65536) {
        frameHead = Buffer.alloc(4);
        frameHead[1] = 126;
        frameHead.writeUInt16BE(length, 2);
    } else {
        frameHead = Buffer.alloc(10);
        frameHead[1] = 127;
        frameHead.writeUInt32BE(0, 2);
        frameHead.writeUInt32BE(length, 6);
    }
    frameHead[0] = 0x81;
    socket.write(Buffer.concat([frameHead, payloadBytes]));
}

function broadcastAdminStatus() {
    const isAnyDashboardOnline = dashboardRooms.size > 0;
    const activeDashboards = Array.from(dashboardRooms.keys());

    const adminPayload = {
        type: "admin_status_sync",
        dashboardStatus: isAnyDashboardOnline ? "online" : "offline",
        activeDashboards: activeDashboards
    };

    for (let adminSocket of activeAdminSockets) {
        if (!adminSocket.destroyed) sendWs(adminSocket, adminPayload);
    }
}

function broadcastAdminLog(message, dashboardId = 'SYSTEM') {
    const logPayload = {
        type: 'admin_tv_log',
        dashboardId: dashboardId,
        message: message,
        time: new Date().toLocaleTimeString()
    };
    for (let adminSocket of activeAdminSockets) {
        if (!adminSocket.destroyed) sendWs(adminSocket, logPayload);
    }
}

function parseIcsContent(icsText, calendarType = 'ios') {
    const events = [];
    const rawLines = icsText.split(/\r\n|\n|\r/);
    const lines = [];
    for (let line of rawLines) {
        if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
            lines[lines.length - 1] += line.substring(1);
        } else {
            lines.push(line);
        }
    }
    let currentEvent = null;
    const now = new Date();
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    for (let line of lines) {
        line = line.trim();
        if (line === 'BEGIN:VEVENT') {
            currentEvent = {};
        } else if (line === 'END:VEVENT' && currentEvent) {
            if (currentEvent.summary && currentEvent.dtstart) {
                const baseStart = parseIcsDateObj(currentEvent.dtstart);
                const baseEnd = parseIcsDateObj(currentEvent.dtend || currentEvent.dtstart);
                const duration = baseEnd.getTime() - baseStart.getTime();
                const rrule = currentEvent.rrule || '';
                if (!rrule) {
                    if (baseEnd >= windowStart && baseStart <= windowEnd) {
                        addEventInstance(events, currentEvent, baseStart, baseEnd, calendarType);
                    }
                } else {
                    expandRecurringEvents(events, currentEvent, baseStart, duration, rrule, windowStart, windowEnd, calendarType);
                }
            }
            currentEvent = null;
        } else if (currentEvent) {
            if (line.startsWith('SUMMARY:')) currentEvent.summary = line.substring(8);
            else if (line.startsWith('UID:')) currentEvent.uid = line.substring(4);
            else if (line.startsWith('DTSTART')) {
                currentEvent.dtstart = line;
                if (line.includes('VALUE=DATE')) {
                    currentEvent.isAllDay = true;
                }
            }
            else if (line.startsWith('DTEND')) currentEvent.dtend = line;
            else if (line.startsWith('RRULE:')) currentEvent.rrule = line.substring(6);
        }
    }
    console.log(`[ICS 解析完畢] 類別: ${calendarType}, 總共解析出有效行程筆數: ${events.length}`);
    broadcastAdminLog(`[ICS 解析完畢] 類別: ${calendarType}, 總共解析出有效行程筆數: ${events.length}`, 'SYSTEM');
    return events;
}

function parseIcsDateObj(lineStr) {
    if (!lineStr) return new Date();
    let tzid = null;
    const tzidMatch = lineStr.match(/TZID=([^:\s]+)/);
    if (tzidMatch) {
        tzid = tzidMatch[1].trim();
    }
    const isUtc = lineStr.endsWith('Z');
    const parts = lineStr.split(':');
    const val = parts[parts.length - 1].replace('Z', '');
    if (val.length < 8) return new Date();

    const y = parseInt(val.substring(0, 4), 10);
    const m = parseInt(val.substring(4, 6), 10) - 1;
    const d = parseInt(val.substring(6, 8), 10);

    if (val.length >= 15) {
        let h = parseInt(val.substring(9, 11), 10);
        let min = parseInt(val.substring(11, 13), 10);
        let s = parseInt(val.substring(13, 15), 10);

        if (isUtc || !tzid) {
            return new Date(Date.UTC(y, m, d, h, min, s));
        } else {
            const tentativeUtc = new Date(Date.UTC(y, m, d, h, min, s));
            try {
                const utcDate = new Date(tentativeUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
                const tzDate = new Date(tentativeUtc.toLocaleString('en-US', { timeZone: tzid }));
                const offsetMs = tzDate.getTime() - utcDate.getTime();
                return new Date(tentativeUtc.getTime() - offsetMs);
            } catch (e) {
                return tentativeUtc;
            }
        }
    } else {
        return new Date(Date.UTC(y, m, d, 0, 0, 0));
    }
}

function addEventInstance(events, currentEvent, startObj, endObj, calendarType) {
    const dateStr = startObj.toISOString().split('T')[0];
    const baseKey = currentEvent.uid || currentEvent.summary || 'event';
    const uniqueKey = `${calendarType}_${baseKey}_${dateStr}`;
    const isIos = (calendarType === 'ios');
    events.push({
        id: 'ical-' + crypto.createHash('md5').update(uniqueKey).digest('hex').substring(0, 10),
        deviceId: isIos ? 'IOS_ICAL' : 'ICS_CALENDAR',
        senderName: isIos ? 'iCloud 行事曆' : 'iCal 行事曆',
        source: isIos ? 'icloud' : 'ics',
        title: currentEvent.summary,
        start: startObj.toISOString(),
        end: endObj.toISOString(),
        isAllDay: !!currentEvent.isAllDay,
        timestamp: new Date().toISOString()
    });
}

function expandRecurringEvents(events, currentEvent, baseStart, duration, rruleStr, windowStart, windowEnd, calendarType) {
    const freqMatch = rruleStr.match(/FREQ=([A-Z]+)/);
    if (!freqMatch) return;
    const freq = freqMatch[1];
    const dayMap = { 'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6 };
    let byDays = [];
    const byDayMatch = rruleStr.match(/BYDAY=([A-Z,]+)/);
    if (byDayMatch) byDays = byDayMatch[1].split(',').map(d => dayMap[d]).filter(d => d !== undefined);

    let loopDate = new Date(windowStart.getTime());
    if (loopDate < baseStart) loopDate = new Date(baseStart.getTime());
    loopDate.setUTCHours(0, 0, 0, 0);
    const endLimit = new Date(windowEnd.getTime());

    while (loopDate <= endLimit) {
        let match = false;
        const dayOfWeek = loopDate.getUTCDay();
        const dateNum = loopDate.getUTCDate();
        const monthNum = loopDate.getUTCMonth();
        const yearNum = loopDate.getUTCFullYear();
        const baseDayOfWeek = baseStart.getUTCDay();

        if (freq === 'DAILY') {
            if (loopDate >= baseStart) match = true;
        } else if (freq === 'YEARLY') {
            if (dateNum === baseStart.getUTCDate() && monthNum === baseStart.getUTCMonth() && loopDate >= baseStart) match = true;
        } else if (freq === 'MONTHLY') {
            if (dateNum === baseStart.getUTCDate() && loopDate >= baseStart) match = true;
        } else if (freq === 'WEEKLY') {
            if (byDays.length > 0) {
                if (byDays.includes(dayOfWeek) && loopDate >= baseStart) match = true;
            } else {
                if (dayOfWeek === baseDayOfWeek && loopDate >= baseStart) match = true;
            }
        }

        if (match) {
            const instanceStart = new Date(Date.UTC(yearNum, monthNum, dateNum, baseStart.getUTCHours(), baseStart.getUTCMinutes(), baseStart.getUTCSeconds()));
            const instanceEnd = new Date(instanceStart.getTime() + duration);
            if (instanceEnd >= windowStart && instanceStart <= windowEnd) {
                addEventInstance(events, currentEvent, instanceStart, instanceEnd, calendarType);
            }
        }
        loopDate.setUTCDate(loopDate.getUTCDate() + 1);
    }
}

function normalizeIcsUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    let clean = rawUrl.trim();
    if (!clean) return '';
    if (/^webcal:\/\//i.test(clean)) {
        clean = clean.replace(/^webcal:\/\//i, 'https://');
    } else if (!/^https?:\/\//i.test(clean)) {
        clean = 'https://' + clean;
    }
    return clean;
}

function fetchAndParseIcs(rawUrl, calendarType, callback) {
    const url = normalizeIcsUrl(rawUrl);
    if (!url) { callback([]); return; }
    const cacheKey = `${calendarType}_${url}`;
    const now = Date.now();
    if (icsCache.has(cacheKey)) {
        const cached = icsCache.get(cacheKey);
        if (now < cached.expireAt) {
            console.log(`[ICS Cache 命中] 類別: ${calendarType}, 筆數: ${cached.events.length}`);
            broadcastAdminLog(`[ICS Cache 命中] 類別: ${calendarType}, 筆數: ${cached.events.length}`, 'SYSTEM');
            callback(cached.events);
            return;
        }
    }
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            console.log(`[ICS 下載成功] 類別: ${calendarType}, 內容大小: ${data.length} bytes`);
            broadcastAdminLog(`[ICS 下載成功] 類別: ${calendarType}, 內容大小: ${data.length} bytes`, 'SYSTEM');
            try {
                const events = parseIcsContent(data, calendarType);
                icsCache.set(cacheKey, { events, expireAt: Date.now() + ICS_CACHE_TTL });
                callback(events);
            } catch (e) {
                console.error(`[ICS 解析例外錯誤] 類別: ${calendarType}`, e);
                callback([]);
            }
        });
    }).on('error', (err) => {
        console.error(`[ICS 下載失敗] 類別: ${calendarType}`, err);
        callback([]);
    });
}

function postFormUrlEncoded(hostname, pathName, paramsObj) {
    return new Promise((resolve, reject) => {
        const bodyStr = new URLSearchParams(paramsObj).toString();
        const reqOptions = {
            hostname: hostname,
            path: pathName,
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(bodyStr)
            }
        };

        const tokenReq = https.request(reqOptions, (tokenRes) => {
            let raw = "";
            tokenRes.on("data", (chunk) => { raw += chunk; });
            tokenRes.on("end", () => {
                let parsed = null;
                if (raw) {
                    try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
                }
                resolve({ statusCode: tokenRes.statusCode, body: parsed });
            });
        });

        tokenReq.on("error", reject);
        tokenReq.write(bodyStr);
        tokenReq.end();
    });
}

function pushBindResultToDashboard(dashboardId, payload) {
    const sockets = dashboardRooms.get(dashboardId);
    if (!sockets || sockets.size === 0) {
        return false;
    }
    let sentCount = 0;
    for (const tvSocket of sockets) {
        if (!tvSocket.destroyed) {
            sendWs(tvSocket, payload);
            sentCount++;
        }
    }
    return sentCount > 0;
}

async function handleGoogleOAuthCallback(parsedUrl, res) {
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    const oauthError = parsedUrl.searchParams.get("error");

    if (!state || !pendingGoogleAuthStates.has(state)) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>Google 綁定失敗：無效或已過期的 state 參數，請回電視端重新發起綁定。</h3>");
        return;
    }

    const sessionInfo = pendingGoogleAuthStates.get(state);
    pendingGoogleAuthStates.delete(state);
    const targetDashboardId = sessionInfo.dashboardId;

    if (Date.now() > sessionInfo.expiresAt) {
        pushBindResultToDashboard(targetDashboardId, {
            type: "google_oauth_bind_result",
            success: false,
            state: state,
            message: "授權工作階段已逾時，請重新發起綁定"
        });
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>Google 綁定逾時，請回電視端重新操作。</h3>");
        return;
    }

    if (oauthError || !code) {
        const errMsg = oauthError ? ("使用者取消或拒絕授權: " + oauthError) : "未收到授權碼 code";
        pushBindResultToDashboard(targetDashboardId, {
            type: "google_oauth_bind_result",
            success: false,
            state: state,
            message: errMsg
        });
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>Google 授權未完成：" + errMsg + "</h3>");
        return;
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        pushBindResultToDashboard(targetDashboardId, {
            type: "google_oauth_bind_result",
            success: false,
            state: state,
            message: "伺服器尚未設定 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET"
        });
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>伺服器端尚未設定 Google OAuth 憑證。</h3>");
        return;
    }

    try {
        const tokenResp = await postFormUrlEncoded("oauth2.googleapis.com", "/token", {
            code: code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: "authorization_code"
        });

        if (tokenResp.statusCode !== 200 || !tokenResp.body || !tokenResp.body.refresh_token) {
            const detailErr = (tokenResp.body && tokenResp.body.error_description) ||
                              (tokenResp.body && tokenResp.body.error) ||
                              "未取得 refresh_token（請確認已帶 prompt=consent 或曾撤銷舊授權）";
            console.error("[Google OAuth] 換取 refresh_token 失敗:", tokenResp.statusCode, tokenResp.body);
            pushBindResultToDashboard(targetDashboardId, {
                type: "google_oauth_bind_result",
                success: false,
                state: state,
                message: detailErr
            });
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h3>換取 refresh_token 失敗：" + detailErr + "</h3>");
            return;
        }

        const tokenData = tokenResp.body;
        const userInfo = await fetchGoogleUserInfo(tokenData.access_token);
        const userEmail = userInfo.email || "";
        const userName = userInfo.name || "";
        const accountLabel = (userName && userEmail) ? `${userName} (${userEmail})` : (userEmail || userName || "Google 帳號");
        const pushed = pushBindResultToDashboard(targetDashboardId, {
            type: "google_oauth_bind_result",
            success: true,
            state: state,
            refreshToken: tokenData.refresh_token,
            accessToken: tokenData.access_token || "",
            expiresIn: tokenData.expires_in || 3600,
            calendarId: "primary",
            email: userEmail,
            name: userName,
            label: accountLabel
        });

        console.log(`[Google OAuth] 房號 [${targetDashboardId}] 取得 refresh_token 成功，推送電視狀態: ${pushed}`);
        broadcastAdminLog(`[Google OAuth] 房號 [${targetDashboardId}] 綁定成功並已推送憑證`, targetDashboardId);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
            "<h3>Google 帳號授權成功！</h3>" +
            "<p>憑證已傳送至電視端（房號：" + targetDashboardId + "），您可以關閉此視窗並回到電視查看。</p>"
        );
    } catch (err) {
        console.error("[Google OAuth] 交換 Token 發生例外:", err);
        pushBindResultToDashboard(targetDashboardId, {
            type: "google_oauth_bind_result",
            success: false,
            state: state,
            message: "向 Google 換取 Token 時發生網路或系統錯誤"
        });
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>交換 Token 發生錯誤，請稍後再試。</h3>");
    }
}

server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const acceptKey = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n');

    let currentClientType = null;
    let currentDashboardId = null;
    let boundDashboardId = null;
    let boundDeviceId = null;

    socket.on('data', (buffer) => {
        try {
            let opcode = buffer[0] & 0x0f;
            if (opcode === 0x8) { socket.end(); return; }
            if (opcode !== 0x1) return;

            let mask = (buffer[1] & 0x80) !== 0;
            let payloadLen = buffer[1] & 0x7f;
            let offset = 2;

            if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
            else if (payloadLen === 127) { payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }

            let masks = mask ? buffer.slice(offset, offset + 4) : null;
            offset += mask ? 4 : 0;
            let payload = buffer.slice(offset, offset + payloadLen);

            if (mask) { for (let i = 0; i < payload.length; i++) payload[i] ^= masks[i % 4]; }

            const data = JSON.parse(payload.toString('utf8'));

            // 1. 管理端註冊
            if (data.type === 'register_admin') {
                if (data.key !== ADMIN_SECRET_KEY) {
                    sendWs(socket, { type: 'auth_error', message: '認證失敗：管理員金鑰錯誤' });
                    socket.end();
                    return;
                }
                activeAdminSockets.add(socket);
                currentClientType = 'admin';
                broadcastAdminStatus();
                return;
            }

            // 2. 電視端註冊
            if (data.type === 'register_dashboard') {
                currentDashboardId = data.dashboardId || 'demo_tv';
                currentClientType = 'dashboard';

                if (!dashboardRooms.has(currentDashboardId)) {
                    dashboardRooms.set(currentDashboardId, new Set());
                }
                dashboardRooms.get(currentDashboardId).add(socket);
                console.log(`📺[TV] [${currentDashboardId}] 註冊成功上線`);
                broadcastAdminLog(`📺[TV] [${currentDashboardId}] 註冊成功上線`);
                sendWs(socket, { type: 'registered_dashboard_success', dashboardId: currentDashboardId });
                broadcastAdminStatus();

                let allEvents = [];
                let pending = 0;
                const sendMergedCalendars = () => {
                    pending--;
                    if (pending <= 0) sendWs(socket, { type: 'ics_sync_result', calendars: allEvents });
                };

                const urls = roomIcsUrls.get(currentDashboardId);
                if (urls) {
                    if (urls.iosUrl) {
                        pending++;
                        fetchAndParseIcs(urls.iosUrl, 'ios', (events) => { allEvents = allEvents.concat(events); sendMergedCalendars(); });
                    }
                }
                return;
            }

            // 3. 手機端註冊
            if (data.type === 'register_phone') {
                const requestedTv = (data.targetDashboard || "").trim();
                if (!requestedTv || !dashboardRooms.has(requestedTv)) {
                    sendWs(socket, { type: 'register_error', message: `註冊失敗：找不到指定的電視 ID [${requestedTv}]` });
                    return;
                }

                currentClientType = 'phone';
                boundDashboardId = requestedTv;
                boundDeviceId = data.preferredId || null;
                socket.boundDashboardId = requestedTv;
                socket.boundDeviceId = data.preferredId || null;
                activePhoneSockets.add(socket);

                const tvSockets = dashboardRooms.get(requestedTv);
                if (tvSockets) {
                    for (let tvSocket of tvSockets) {
                        if (!tvSocket.destroyed) {
                            sendWs(tvSocket, {
                                type: 'tv_handle_phone_register',
                                sourceSocketId: socket._socketId || (socket._socketId = crypto.randomBytes(8).toString('hex')),
                                token: data.token,
                                preferredId: data.preferredId,
                                name: data.name
                            });
                            socket._targetTvSocket = tvSocket;
                        }
                    }
                }
                return;
            }

            // 4. 電視端回傳手機註冊結果
            if (data.type === 'tv_phone_register_result') {
                for (let phoneSock of activePhoneSockets) {
                    if (phoneSock._socketId === data.targetSocketId) {
                        if (data.success) {
                            boundDeviceId = data.deviceId;
                            phoneSock.boundDeviceId = data.deviceId;
                            phoneSock.boundDashboardId = data.roomId;

                            sendWs(phoneSock, {
                                type: 'registered_success',
                                deviceId: data.deviceId,
                                name: data.name,
                                token: data.token,
                                roomId: data.roomId,
                                iosIcsUrl: data.iosIcsUrl,
                                googleBound: !!data.googleBound,
                                googleAccountLabel: data.googleAccountLabel || ''
                            });
                        } else {
                            sendWs(phoneSock, { type: 'register_error', message: data.message || '註冊失敗' });
                        }
                        break;
                    }
                }
                return;
            }

            // 5. 管理端查詢房間狀態
            if (data.type === 'admin_query_room_status') {
                const targetDash = data.targetDashboard || 'demo_tv';
                const tvSockets = dashboardRooms.get(targetDash);
                if (tvSockets) {
                    for (let tvSocket of tvSockets) {
                        if (!tvSocket.destroyed) {
                            sendWs(tvSocket, { type: 'admin_query_room_status' });
                        }
                    }
                }
                return;
            }

            // 6. 電視端廣播房間狀態給 Admin
            if (data.type === 'room_status_response') {
                broadcastAdminLog(`📥 收到 TV(${data.roomId}) 房號狀態更新，轉發給 Admin`);
                for (let adminSocket of activeAdminSockets) {
                    if (!adminSocket.destroyed) sendWs(adminSocket, data);
                }
                if (data.roomId) {
                    for (let phoneSock of activePhoneSockets) {
                        if (!phoneSock.destroyed && phoneSock.boundDashboardId === data.roomId) {
                            sendWs(phoneSock, data);
                        }
                    }
                }
                return;
            }

            // 7. 管理端發起強制解除裝置
            if (data.type === 'admin_force_unregister') {
                if (data.key !== ADMIN_SECRET_KEY) return;
                const targetId = data.targetDeviceId;
                const targetDash = data.targetDashboard;

                const tvSockets = dashboardRooms.get(targetDash);
                if (tvSockets) {
                    for (let tvS of tvSockets) {
                        if (!tvS.destroyed) sendWs(tvS, { type: 'admin_force_unregister', targetDeviceId: targetId });
                    }
                }

                for (let phoneSock of activePhoneSockets) {
                    if (!phoneSock.destroyed && phoneSock.boundDashboardId === targetDash && phoneSock.boundDeviceId === targetId) {
                        console.log(`[SYSTEM] 執行強制解除：已發送 unregistered 給手機端 [${targetId}]`);
                        broadcastAdminLog(`[SYSTEM] 執行強制解除：已發送 unregistered 給手機端 [${targetId}]`, targetDash);
                        sendWs(phoneSock, { type: 'unregistered' });
                    }
                }
                return;
            }

            // 8. 泛用訊息與指令轉發
            if (data.type === 'message' ||
                data.type === 'calendar' ||
                data.type === 'todo' ||
                data.type === 'delivery_order' ||
                data.type === 'config_update_server_ip' ||
                data.type.includes('traffic') ||
                data.type.includes('phone_name_sync')) {

                let targetDash = null;
                if (currentClientType === 'admin') {
                    targetDash = (data.targetDashboard || "").trim();
                } else if (currentClientType === 'phone') {
                    targetDash = boundDashboardId;
                } else if (currentClientType === 'dashboard') {
                    targetDash = (data.dashboard || data.targetDashboard || currentDashboardId || "").trim();
                }

                if (!targetDash || !dashboardRooms.has(targetDash)) {
                    sendWs(socket, { type: 'error', message: `發送失敗：${targetDash}目標電視未上線` });
                    broadcastAdminLog(`[SYSTEM] 發送失敗：${targetDash}目標電視未上線`, targetDash);
                    return;
                }

                data.targetDashboard = targetDash;
                const sockets = dashboardRooms.get(targetDash);
                if (sockets) {
                    for (let s of sockets) {
                        if (!s.destroyed) sendWs(s, data);
                    }
                }

                if (currentClientType === 'phone' && boundDashboardId && boundDeviceId) {
                    activePhoneSockets.add(socket);
                }
                return;
            }

            // 9. 管理端強制重啟電視
            if (data.type === 'admin_force_restart_dashboard') {
                if (data.key !== ADMIN_SECRET_KEY) return;
                for (let [dashId, sockets] of dashboardRooms.entries()) {
                    for (let s of sockets) {
                        if (!s.destroyed) {
                            sendWs(s, { type: 'force_disconnect', message: '管理員已強制重啟電視端。' });
                            s.end();
                        }
                    }
                }
                dashboardRooms.clear();
                broadcastAdminLog(`[Admin] 所有 TV Dashboard 已被強制重啟`);
                broadcastAdminStatus();
                return;
            }

            // 10. 更新 iCal 訂閱網址
            if (data.type === 'update_ics_url') {
                const targetDash = (currentClientType === 'phone') ? boundDashboardId : (data.targetDashboard || currentDashboardId);
                if (targetDash) {
                    if (!roomIcsUrls.has(targetDash)) {
                        roomIcsUrls.set(targetDash, { iosUrl: '' });
                    }
                    const urls = roomIcsUrls.get(targetDash);
                    icsCache.delete(`ios_${urls.iosUrl}`);

                    let updatedCalendarType = data.calendarType || 'ios';
                    let updatedIcsUrl = data.icsUrl || '';

                    if (updatedCalendarType === 'ios') {
                        urls.iosUrl = updatedIcsUrl;
                    }
                    roomIcsUrls.set(targetDash, urls);
                    saveIcsConfig();

                    const tvSockets = dashboardRooms.get(targetDash);
                    if (tvSockets) {
                        for (let s of tvSockets) {
                            if (!s.destroyed) {
                                sendWs(s, {
                                    type: 'update_ics_url',
                                    calendarType: updatedCalendarType,
                                    icsUrl: updatedIcsUrl
                                });
                                sendWs(s, { type: 'admin_query_room_status' });
                            }
                        }
                    }

                    let allEvents = [];
                    let pending = 0;

                    const checkAndSend = () => {
                        pending--;
                        if (pending <= 0) {
                            if (tvSockets) {
                                for (let s of tvSockets) {
                                    if (!s.destroyed) {
                                        sendWs(s, { type: 'ics_sync_result', calendars: allEvents });
                                    }
                                }
                            }
                        }
                    };

                    if (urls.iosUrl) pending++;

                    if (pending === 0) {
                        if (tvSockets) {
                            for (let s of tvSockets) {
                                if (!s.destroyed) {
                                    sendWs(s, { type: 'ics_sync_result', calendars: [] });
                                }
                            }
                        }
                    } else {
                        if (urls.iosUrl) {
                            fetchAndParseIcs(urls.iosUrl, 'ios', (events) => {
                                allEvents = allEvents.concat(events);
                                checkAndSend();
                            });
                        }
                    }
                }
                return;
            }

            // 11. 手動觸發 ICS 同步
            if (data.type === 'request_ics_sync') {
                const targetDash = data.dashboard || data.targetDashboard || currentDashboardId || 'demo_tv';
                if (data.iosIcsUrl && String(data.iosIcsUrl).trim()) {
                    const currentCfg = roomIcsUrls.get(targetDash) || {};
                    currentCfg.iosUrl = String(data.iosIcsUrl).trim();
                    roomIcsUrls.set(targetDash, currentCfg);
                    icsCache.delete(`ios_${currentCfg.iosUrl}`);
                    saveIcsConfig();
                }

                const urls = roomIcsUrls.get(targetDash);
                if (!urls || !urls.iosUrl) {
                    sendWs(socket, { type: 'ics_sync_result', calendars: [] });
                    return;
                }

                let allEvents = [];
                let pending = 0;

                const checkAndSend = () => {
                    pending--;
                    if (pending <= 0) {
                        sendWs(socket, { type: 'ics_sync_result', calendars: allEvents });
                    }
                };

                if (urls.iosUrl) pending++;

                if (urls.iosUrl) {
                    fetchAndParseIcs(urls.iosUrl, 'ios', (events) => {
                        allEvents = allEvents.concat(events);
                        checkAndSend();
                    });
                }
                return;
            }

            // 12. 清除 ICS 快取
            if (data.type === 'admin_clear_ics_cache') {
                if (data.key !== ADMIN_SECRET_KEY) {
                    sendWs(socket, { type: 'auth_error', message: '認證失敗：管理員金鑰錯誤' });
                    return;
                }
                icsCache.clear();
                for (let [dashId, sockets] of dashboardRooms.entries()) {
                    const urls = roomIcsUrls.get(dashId);
                    if (urls && urls.iosUrl) {
                        fetchAndParseIcs(urls.iosUrl, 'ios', (events) => {
                            for (let s of sockets) {
                                if (!s.destroyed) {
                                    sendWs(s, { type: 'ics_sync_result', calendars: events });
                                }
                            }
                        });
                    }
                }
                sendWs(socket, { type: 'admin_action_success', message: 'ICS 快取已清除, 且已自動推播最新行程至在線電視' });
                return;
            }

            // 13. 啟動外送追蹤（走統一工作階段函式）
            if (data.type === 'start_uber_tracking') {
                const trackingUrl = data.trackingUrl;
                const targetDash = (data.targetDashboard || currentDashboardId || 'demo_tv').trim();

                if (!trackingUrl) {
                    sendWs(socket, { type: 'error', message: '追蹤失敗：未提供 Tracking URL' });
                    return;
                }

                startUberTrackingSession(trackingUrl, targetDash);
                return;
            }

            // 14. 停止外送追蹤
            if (data.type === 'stop_uber_tracking') {
                const targetDash = (data.targetDashboard || currentDashboardId || 'demo_tv').trim();
                const specificUrl = data.trackingUrl ? String(data.trackingUrl).trim() : null;
                stopUberTrackingSession(targetDash, specificUrl, '已停止追蹤');
                return;
            }

            // 15. 同步房間設定檔
            if (data.type === 'sync_room_config') {
                const targetDash = data.dashboardId || currentDashboardId;
                if (targetDash) {
                    if (typeof data.iosUrl === 'string') {
                        roomIcsUrls.set(targetDash, { iosUrl: data.iosUrl.trim() });
                        saveIcsConfig();
                    }
                    if (data.roomConfig) {
                        roomConfigs.set(targetDash, data.roomConfig);
                        saveRoomConfig();
                    }
                    sendWs(socket, {
                        type: 'sync_room_config_result',
                        success: true,
                        message: '伺服器設定已與電視端對齊成功'
                    });
                    broadcastAdminLog(`[SYSTEM] 房號 [${targetDash}] 設定檔已成功與伺服器對齊`, targetDash);
                }
                return;
            }

            // Google OAuth 授權網址
            if (data.type === 'request_google_auth_url') {
                const targetDash = (data.dashboardId || currentDashboardId || 'demo_tv').trim();
                if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
                    sendWs(socket, {
                        type: 'google_auth_url_error',
                        message: '伺服器尚未設定 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET'
                    });
                    return;
                }

                const state = crypto.randomBytes(16).toString('hex');
                const now = Date.now();
                pendingGoogleAuthStates.set(state, {
                    dashboardId: targetDash,
                    createdAt: now,
                    expiresAt: now + GOOGLE_AUTH_TTL_MS
                });

                const authParams = new URLSearchParams({
                    client_id: GOOGLE_CLIENT_ID,
                    redirect_uri: GOOGLE_REDIRECT_URI,
                    response_type: "code",
                    scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
                    access_type: "offline",
                    prompt: "consent",
                    state: state
                });

                const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + authParams.toString();
                sendWs(socket, {
                    type: 'google_auth_url_result',
                    authUrl: authUrl,
                    state: state,
                    expiresIn: Math.floor(GOOGLE_AUTH_TTL_MS / 1000)
                });
                return;
            }

            if (data.type === 'ping') {
                sendWs(socket, { type: 'pong' });
                return;
            }
        } catch (e) {}
    });

    socket.on('close', () => {
        activePhoneSockets.delete(socket);
        if (activeAdminSockets.has(socket)) activeAdminSockets.delete(socket);

        if (currentDashboardId && dashboardRooms.has(currentDashboardId)) {
            dashboardRooms.get(currentDashboardId).delete(socket);
            if (dashboardRooms.get(currentDashboardId).size === 0) dashboardRooms.delete(currentDashboardId);
            broadcastAdminStatus();
        }

        if (currentClientType === 'phone' && boundDashboardId && boundDeviceId) {
            const tvSockets = dashboardRooms.get(boundDashboardId);
            if (tvSockets) {
                for (let tvS of tvSockets) {
                    if (!tvS.destroyed) {
                        sendWs(tvS, { type: "phone_disconnected", deviceId: boundDeviceId });
                    }
                }
            }
        }
    });

    socket.on('error', () => {});
});

server.listen(3000, () => {
    console.log('【SYSTEM】 伺服器已啟動 - 埠口: 3000');
});