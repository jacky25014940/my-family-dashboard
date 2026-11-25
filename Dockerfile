# 使用官方 Node.js 輕量映像檔作為基底
FROM node:20-slim
# 避免 apt 互動提示
ENV DEBIAN_FRONTEND=noninteractive
# 讓 Puppeteer 直接使用系統安裝的 Chromium，不再額外下載
ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# 安裝 Puppeteer / Chromium 
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/* \
    && ls -la /usr/bin/chromium

# 建立工作目錄
WORKDIR /usr/src/app

# 1. 先複製 package.json 與 package-lock.json
COPY package*.json ./

# 2. 安裝專案 npm 套件
RUN npm install --omit=dev

# 3. 複製其餘所有程式碼（包含 server.js 與 uberTracker.js）至容器內
COPY . .

# 開放 Render 預設或指定的 Port
EXPOSE 3000

# 啟動指令
CMD ["node", "server.js"]