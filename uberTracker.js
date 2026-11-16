const puppeteer = require('puppeteer');

async function fetchUberTrackingData(trackingUrl) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: '/usr/bin/chromium', // Docker 內系統安裝的路徑
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process' // 在記憶體受限的環境下建議加入
            ]
        });
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(trackingUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const trackingData = await page.evaluate(() => {
            const etaElement = document.querySelector('[data-testid="eta-string"]');
            const statusElement = document.querySelector('[data-testid="order-status"]');
            
            return {
                eta: etaElement ? etaElement.innerText : '計算中...',
                status: statusElement ? statusElement.innerText : '追蹤中',
                updateTime: new Date().toLocaleTimeString()
            };
        });

        await browser.close();
        return { success: true, data: trackingData };
    } catch (error) {
        if (browser) await browser.close();
        return { success: false, error: error.message };
    }
}

module.exports = { fetchUberTrackingData };