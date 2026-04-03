# Stage 1: build (con build tools e devDependencies)
FROM node:20-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Stage 2: runtime (solo ciò che serve in produzione)
FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    ca-certificates && \
    wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get purge -y wget ca-certificates && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Sostituisce il yt-dlp bundlato da youtube-dl-exec (script Python) con il binario standalone
RUN ln -sf /usr/local/bin/yt-dlp /app/node_modules/youtube-dl-exec/bin/yt-dlp

ARG BUILD_DATE=unknown
RUN echo "${BUILD_DATE}" > /app/.builddate

CMD ["/bin/sh", "-c", "yt-dlp -U 2>/dev/null || true && node dist/bot.js"]
