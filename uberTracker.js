const fs = require('fs');
const puppeteer = require('puppeteer');

let sharedBrowser = null;
let browserLaunchPromise = null;

function resolveExecutablePath() {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath && fs.existsSync(envPath)) {
        return envPath;
    }
    if (process.env.RENDER && fs.existsSync('/usr/bin/chromium')) {
        return '/usr/bin/chromium';
    }
    return null;
}

function resetSharedBrowser() {
    const oldBrowser = sharedBrowser;
    sharedBrowser = null;
    browserLaunchPromise = null;
    if (oldBrowser) {
        oldBrowser.close().catch(function () {});
    }
}

async function getOrCreateBrowser() {
    if (sharedBrowser && sharedBrowser.connected) {
        return sharedBrowser;
    }

    if (browserLaunchPromise) {
        return browserLaunchPromise;
    }

    const executablePath = resolveExecutablePath();
    const launchOptions = {
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    };

    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }

    browserLaunchPromise = puppeteer.launch(launchOptions)
        .then(function (browser) {
            sharedBrowser = browser;
            browserLaunchPromise = null;
            browser.on('disconnected', function () {
                if (sharedBrowser === browser) {
                    sharedBrowser = null;
                }
            });
            return browser;
        })
        .catch(function (err) {
            browserLaunchPromise = null;
            throw err;
        });

    return browserLaunchPromise;
}

function parseStatusCodeFromText(rawStatus, attrCode) {
    if (attrCode && String(attrCode).trim()) {
        return String(attrCode).trim().toUpperCase();
    }
    const text = String(rawStatus || '').trim();
    const parenMatch = text.match(/\(([A-Z0-9_]+)\)/i);
    if (parenMatch && parenMatch[1]) {
        return parenMatch[1].toUpperCase();
    }

    const upper = text.toUpperCase();
    if (upper.indexOf('DELIVERED') !== -1 || text.indexOf('已送達') !== -1) return 'DELIVERED';
    if (upper.indexOf('EN_ROUTE_TO_DROPOFF') !== -1 || upper.indexOf('HEADING YOUR WAY') !== -1 || text.indexOf('前往您的位置') !== -1) return 'EN_ROUTE_TO_DROPOFF';
    if (upper.indexOf('PICKING_UP') !== -1 || upper.indexOf('PICKING UP') !== -1 || text.indexOf('取餐') !== -1) return 'PICKING_UP';
    if (upper.indexOf('COURIER_TO_STORE') !== -1 || upper.indexOf('HEADING TO THE STORE') !== -1 || text.indexOf('前往餐廳') !== -1) return 'COURIER_TO_STORE';
    if (upper.indexOf('PREPARING') !== -1 || text.indexOf('準備') !== -1 || text.indexOf('備餐') !== -1) return 'PREPARING';
    if (upper.indexOf('ORDER_PLACED') !== -1 || text.indexOf('已送出') !== -1 || text.indexOf('等待') !== -1) return 'ORDER_PLACED';

    return text || 'TRACKING';
}

function parseEtaMinutesFromText(rawEta, attrMinutes, statusCode) {
    if (statusCode === 'DELIVERED') {
        return 0;
    }
    if (attrMinutes !== undefined && attrMinutes !== null && String(attrMinutes).trim() !== '') {
        const parsedAttr = parseInt(String(attrMinutes).trim(), 10);
        if (!isNaN(parsedAttr)) return parsedAttr;
    }
    const text = String(rawEta || '').trim();
    if (!text) return null;
    if (text.indexOf('已送達') !== -1 || text.toUpperCase().indexOf('DELIVERED') !== -1) {
        return 0;
    }
    const numMatch = text.match(/(\d+)/);
    if (numMatch && numMatch[1]) {
        const mins = parseInt(numMatch[1], 10);
        if (!isNaN(mins)) return mins;
    }
    return null;
}

function isBrowserConnectionError(errMsg) {
    const msg = String(errMsg || '').toLowerCase();
    return (
        msg.indexOf('target closed') !== -1 ||
        msg.indexOf('session closed') !== -1 ||
        msg.indexOf('connection closed') !== -1 ||
        msg.indexOf('protocol error') !== -1 ||
        msg.indexOf('browser is not connected') !== -1
    );
}

async function fetchUberTrackingData(trackingUrl) {
    let page = null;
    try {
        if (!trackingUrl || typeof trackingUrl !== 'string') {
            return { success: false, error: '無效的追蹤網址 (trackingUrl)' };
        }

        const browser = await getOrCreateBrowser();
        page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(trackingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('[data-testid="eta-string"], [data-testid="order-status"]', { timeout: 10000 }).catch(function () {});

        const rawExtracted = await page.evaluate(() => {
            const etaElement =
                document.querySelector('[data-testid="eta-string"]') ||
                document.querySelector('[data-testid*="eta"]');
            const statusElement =
                document.querySelector('[data-testid="order-status"]') ||
                document.querySelector('[data-testid*="status"]');

            return {
                etaText: etaElement ? (etaElement.innerText || etaElement.textContent || '').trim() : '',
                etaAttrMinutes: etaElement ? etaElement.getAttribute('data-eta-minutes') : null,
                statusText: statusElement ? (statusElement.innerText || statusElement.textContent || '').trim() : '',
                statusAttrCode: statusElement ? statusElement.getAttribute('data-status-code') : null
            };
        });

        const statusCode = parseStatusCodeFromText(rawExtracted.statusText, rawExtracted.statusAttrCode);
        const etaMinutes = parseEtaMinutesFromText(rawExtracted.etaText, rawExtracted.etaAttrMinutes, statusCode);

        const normalizedData = {
            eta: rawExtracted.etaText || (typeof etaMinutes === 'number' ? (etaMinutes + ' 分鐘') : '計算中...'),
            etaMinutes: etaMinutes,
            status: rawExtracted.statusText || '追蹤中',
            statusCode: statusCode,
            updateTime: new Date().toLocaleTimeString()
        };

        return { success: true, data: normalizedData };
    } catch (error) {
        const errMsg = (error && error.message) ? error.message : String(error);
        if (isBrowserConnectionError(errMsg)) {
            resetSharedBrowser();
        }
        return { success: false, error: errMsg };
    } finally {
        if (page) {
            try { await page.close(); } catch (e) {}
        }
    }
}

module.exports = { fetchUberTrackingData };
