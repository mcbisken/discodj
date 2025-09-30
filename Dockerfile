FROM node:22-alpine

# System deps: ffmpeg + yt-dlp + build tools for native modules
RUN apk add --no-cache ffmpeg yt-dlp python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
RUN mkdir -p /app/data

ENV NODE_ENV=production
CMD ["npm", "start"]
