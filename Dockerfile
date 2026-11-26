FROM node:22-alpine

# ffmpeg: mobile audio/video conversion at import; libarchive-tools: 7z/rar via bsdtar;
# libwebp-tools: cwebp, large PNGs → lossless WebP at import
RUN apk add --no-cache ffmpeg libarchive-tools libwebp-tools tini

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY runtime ./runtime
COPY web ./web
COPY vendor ./vendor

ENV RPGM_DATA=/data \
    RPGM_PORT=8080 \
    RPGM_HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${RPGM_PORT:-8080}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/bin/rpgm-web.js"]
CMD ["serve"]
