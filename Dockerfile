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

# 複製 package.json 與相依性檔案
COPY package*.json ./

# 安裝專案 npm 套件（建議指定跳過 puppeteer 內建自動下載 Chromium，改用系統安裝的 Chromium）
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install

# 複製其餘程式碼至容器內
COPY . .

# 開放 Render 預設或指定的 Port
EXPOSE 3000

# 啟動指令
CMD ["node", "server.js"]