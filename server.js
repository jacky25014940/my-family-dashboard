console.log("==========================================");
console.log("   🚀 伺服器已啟動 - 版本: 20261109 02:00  ");
console.log("==========================================");

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const SECRET_KEY = "my_innovation_secret_2026"; 
const ADMIN_SECRET_KEY = "admin_secure_key_2026"; 
const ICS_CONFIG_FILE = path.resolve(__dirname, 'ics_config.json');
const ROOM_CONFIG_FILE = path.resolve(__dirname, 'room_config.json');

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    let urlPath = req.url.split('?')[0].toLowerCase();
    let tokenKey = parsedUrl.searchParams.get('key');

    if (urlPath === '/' || urlPath === '/a.html') {
        if (tokenKey !== SECRET_KEY) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: 您沒有權限存取此儀表板');
            return;
        }
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

// 核心狀態管理 (無冗餘參數)
const dashboardRooms = new Map();     // dashboardId -> Set(sockets)
const activeAdminSockets = new Set();  // 管理端連線池
const activePhoneSockets = new Set();  // 手機端連線池 (精準對應與解除通知)
const roomIcsUrls = new Map();         // dashboardId -> { googleUrl, iosUrl }
const roomConfigs = new Map(); // dashboardId -> Object (例如存放房間自訂屬性、備用設定等) // 核心房間設定對應表

// ICS訂閱檔
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

// RoomMAP檔
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
// 紀錄上一次檔案讀取的修改時間 (mtime)
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
}, 10000); // 每 10 秒檢查一次

const icsCache = new Map();
const ICS_CACHE_TTL = 30 * 60 * 1000; 

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

function parseIcsContent(icsText, calendarType = 'google') {
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
                    currentEvent.isAllDay = true; // 💡 標記為整天行程
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

// 💡 萬國通用的動態時區解析函式（不寫死任何特定國家/城市）
function parseIcsDateObj(lineStr) {
    if (!lineStr) return new Date();
    
    // 1. 動態擷取 ICS 中宣告的時區 ID（例如 TZID=Asia/Taipei 或 TZID=America/New_York）
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

        // 如果是絕對 UTC (Z) 或者是沒有宣告時區的浮動時間
        if (isUtc || !tzid) {
            return new Date(Date.UTC(y, m, d, h, min, s));
        } else {
            // 2. 動態時區轉換機制：利用 Node.js 內建的 Intl 尋找該 TZID 在當下的真實偏移量
            const tentativeUtc = new Date(Date.UTC(y, m, d, h, min, s));
            try {
                const utcDate = new Date(tentativeUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
                const tzDate = new Date(tentativeUtc.toLocaleString('en-US', { timeZone: tzid }));
                const offsetMs = tzDate.getTime() - utcDate.getTime();
                
                // 將宣告的本地時間減去該時區的動態偏移量，還原為絕對 UTC 時間戳
                return new Date(tentativeUtc.getTime() - offsetMs);
            } catch (e) {
                // 若遇到系統不支援的罕見時區字串，安全退回原樣
                return tentativeUtc;
            }
        }
    } else {
        // 全天事件 (VALUE=DATE)，不帶時分秒
        return new Date(Date.UTC(y, m, d, 0, 0, 0));
    }
}

function addEventInstance(events, currentEvent, startObj, endObj, calendarType) {
    const dateStr = startObj.toISOString().split('T')[0];
    const uniqueKey = (currentEvent.uid || currentEvent.summary) + '_' + dateStr;
    const isIos = (calendarType === 'ios');
    events.push({
        id: 'ical-' + crypto.createHash('md5').update(uniqueKey).digest('hex').substring(0, 10),
        deviceId: isIos ? 'IOS_ICAL' : 'GOOGLE_ICAL',
        senderName: isIos ? 'iCloud 行事曆' : 'Google 行事曆',
        title: currentEvent.summary,
        start: startObj.toISOString(),
        end: endObj.toISOString(),
        isAllDay: !!currentEvent.isAllDay, // 💡 傳遞整天行程標記
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

function fetchAndParseIcs(url, calendarType, callback) {
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
                    if (urls.googleUrl) {
                        pending++;
                        fetchAndParseIcs(urls.googleUrl, 'google', (events) => { allEvents = allEvents.concat(events); sendMergedCalendars(); });
                    }
                    if (urls.iosUrl) {
                        pending++;
                        fetchAndParseIcs(urls.iosUrl, 'ios', (events) => { allEvents = allEvents.concat(events); sendMergedCalendars(); });
                    }
                }
                return;
            }

            // 3. 手機端註冊 (直接轉發給電視端處理)
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
                                googleIcsUrl: data.googleIcsUrl,
                                iosIcsUrl: data.iosIcsUrl
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

            // 8. 泛用訊息與指令轉發 (Pure Relay)
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

            // 10. 處理手機端或管理端更新 iCal 訂閱網址的請求
            if (data.type === 'update_ics_url') {
                console.log("data.type === update_ics_url");
                const targetDash = (currentClientType === 'phone') ? boundDashboardId : (data.targetDashboard || currentDashboardId);
                if (targetDash) {
                    if (!roomIcsUrls.has(targetDash)) {
                        roomIcsUrls.set(targetDash, { googleUrl: '', iosUrl: '' });
                    }
                    const urls = roomIcsUrls.get(targetDash);
                    
                    // 💡 修正快取刪除的 Key 格式，確保與 fetchAndParseIcs 一致
                    icsCache.delete(`google_${urls.googleUrl}`);
                    icsCache.delete(`ios_${urls.iosUrl}`);

                    if (data.calendarType === 'ios') {
                        urls.iosUrl = data.icsUrl || '';
                    } else {
                        urls.googleUrl = data.icsUrl || '';
                    }
                    roomIcsUrls.set(targetDash, urls);
                    saveIcsConfig();

                    console.log(`[SYSTEM] 已更新房間 [${targetDash}] 的 ${data.calendarType} 訂閱網址`);
                    broadcastAdminLog(`[SYSTEM] 已更新房間 [${targetDash}] 的 ${data.calendarType} 訂閱網址`, targetDash);

                    let allEvents = [];
                    let pending = 0;

                    const checkAndSend = () => {
                        pending--;
                        if (pending <= 0) {
                            broadcastAdminLog(`[SYSTEM] 網址更新後即時抓取完成，共 ${allEvents.length} 筆，主動推播給電視`, targetDash);
                            const tvSockets = dashboardRooms.get(targetDash);
                            if (tvSockets) {
                                for (let s of tvSockets) {
                                    if (!s.destroyed) {
                                        sendWs(s, { type: 'ics_sync_result', calendars: allEvents });
                                    }
                                }
                            }
                        }
                    };

                    if (urls.googleUrl) pending++;
                    if (urls.iosUrl) pending++;

                    if (pending === 0) {
                        const tvSockets = dashboardRooms.get(targetDash);
                        if (tvSockets) {
                            for (let s of tvSockets) {
                                if (!s.destroyed) sendWs(s, { type: 'ics_sync_result', calendars: [] });
                            }
                        }
                    } else {
                        if (urls.googleUrl) {
                            fetchAndParseIcs(urls.googleUrl, 'google', (events) => {
                                allEvents = allEvents.concat(events);
                                checkAndSend();
                            });
                        }
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
            
            // 11. 處理電視端或前台要求手動觸發 ICS 同步的請求
            if (data.type === 'request_ics_sync') {
                const targetDash = data.dashboard || data.targetDashboard || currentDashboardId || 'demo_tv';
                console.log(`[SYSTEM] 收到房號 [${targetDash}] 的 ICS 同步請求，開始抓取...`);
                broadcastAdminLog(`[SYSTEM] 收到房號 [${targetDash}] 的 ICS 同步請求，開始抓取...`, targetDash);

                const urls = roomIcsUrls.get(targetDash);
                if (!urls || (!urls.googleUrl && !urls.iosUrl)) {
                    broadcastAdminLog(`[SYSTEM] 房號 [${targetDash}] 沒有設定任何 ICS 網址`, targetDash);
                    sendWs(socket, { type: 'ics_sync_result', calendars: [] });
                    return;
                }

                let allEvents = [];
                let pending = 0;

                const checkAndSend = () => {
                    pending--;
                    if (pending <= 0) {
                        broadcastAdminLog(`[SYSTEM] 房號 [${targetDash}] 的 ICS 同步完成，共 ${allEvents.length} 筆`, targetDash);
                        sendWs(socket, { type: 'ics_sync_result', calendars: allEvents });
                    }
                };

                if (urls.googleUrl) pending++;
                if (urls.iosUrl) pending++;

                if (urls.googleUrl) {
                    fetchAndParseIcs(urls.googleUrl, 'google', (events) => {
                        allEvents = allEvents.concat(events);
                        checkAndSend();
                    });
                }

                if (urls.iosUrl) {
                    fetchAndParseIcs(urls.iosUrl, 'ios', (events) => {
                        allEvents = allEvents.concat(events);
                        checkAndSend();
                    });
                }
                return;
            }

            // 12. 處理管理端要求清除ICS快取的請求
            if (data.type === 'admin_clear_ics_cache') {
                if (data.key !== ADMIN_SECRET_KEY) {
                    sendWs(socket, { type: 'auth_error', message: '認證失敗：管理員金鑰錯誤' });
                    return;
                }
                icsCache.clear();
                console.log(`[SYSTEM] 管理員已強制清除所有 ICS 快取 (icsCache cleared)`);
                broadcastAdminLog(`[SYSTEM] 管理員已成功清除所有 ICS 快取`);

                for (let [dashId, sockets] of dashboardRooms.entries()) {
                    const urls = roomIcsUrls.get(dashId);
                    if (urls) {
                        let allEvents = [];
                        let pending = 0;
                        const sendMerged = () => {
                            pending--;
                            if (pending <= 0) {
                                for (let s of sockets) {
                                    if (!s.destroyed) {
                                        sendWs(s, { type: 'ics_sync_result', calendars: allEvents });
                                    }
                                }
                                console.log(`[SYSTEM] 已自動重新抓取房號 [${dashId}] 的最新行程並推播給電視`);
                                broadcastAdminLog(`[SYSTEM] 已自動重新抓取房號 [${dashId}] 的最新行程並推播給電視`, dashId);
                            }
                        };

                        if (urls.googleUrl) {
                            pending++;
                            fetchAndParseIcs(urls.googleUrl, 'google', (events) => { allEvents = allEvents.concat(events); sendMerged(); });
                        }
                        if (urls.iosUrl) {
                            pending++;
                            fetchAndParseIcs(urls.iosUrl, 'ios', (events) => { allEvents = allEvents.concat(events); sendMerged(); });
                        }
                    }
                }
                sendWs(socket, { type: 'admin_action_success', message: 'ICS 快取已清除, 且已自動推播最新行程至在線電視' });
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