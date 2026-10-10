# syntax=docker/dockerfile:1

# ── Stage 1: install deps and compile native modules (@discordjs/opus) ──────────
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── Stage 2: slim runtime (no compilers) ────────────────────────────────────────
FROM node:24-alpine

# ffmpeg: audio · python3: runs yt-dlp · tini: proper PID 1 · su-exec: drop root
RUN apk add --no-cache ffmpeg python3 tini su-exec ca-certificates \
 # The official yt-dlp release (not Alpine's package) so `yt-dlp -U` can update itself.
 && mkdir -p /opt/yt-dlp \
 && wget -qO /opt/yt-dlp/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod 755 /opt/yt-dlp/yt-dlp \
 && chown -R node:node /opt/yt-dlp

ENV PATH="/opt/yt-dlp:${PATH}" \
    NODE_ENV=production \
    HEALTH_FILE=/tmp/discodj-health

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data && chown node:node /app/data

# Healthy = logged in to Discord within the last 2 minutes (the bot writes a heartbeat file).
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "try{process.exit(Date.now()-Number(require('fs').readFileSync(process.env.HEALTH_FILE,'utf8'))<120000?0:1)}catch{process.exit(1)}"

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
