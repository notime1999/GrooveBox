FROM node:20-slim

# python3 + build tools for native modules (sodium-native), ffmpeg for audio, wget for yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ffmpeg \
    wget \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Latest yt-dlp binary
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

RUN npm run build

CMD ["/bin/sh", "-c", "yt-dlp -U 2>/dev/null || true && node dist/bot.js"]
