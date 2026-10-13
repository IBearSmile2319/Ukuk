# Se construye desde la raíz del repo: incluye la web (landing + portal) servida por la API.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:22-slim AS build
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/tsconfig*.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# OCR local para probar sin AWS (UKUK_OCR=tesseract).
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production UKUK_WEB_DIR=/app/web
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
COPY api/migrations ./migrations
COPY api/package.json ./
RUN mkdir -p /data/blobs && chown -R node /data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
