# 使用官方 Node.js 輕量映像檔作為基底
FROM node:18-slim

# 安裝 Puppeteer / Chromium 在 Debian/Ubuntu 系統下所需的底層相依共用庫與憑證
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libxtst6 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libglib2.0-0 \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
    
# 建立工作目錄
WORKDIR /usr/src/app

# 1. 先複製 package.json 與 package-lock.json
COPY package*.json ./

# 2. 安裝專案 npm 套件（包含我們剛剛在 package.json 補上的 puppeteer）
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install

# 3. 複製其餘所有程式碼（包含 server.js 與 uberTracker.js）至容器內
COPY . .

# 開放 Render 預設或指定的 Port
EXPOSE 3000

# 啟動指令
CMD ["node", "server.js"]