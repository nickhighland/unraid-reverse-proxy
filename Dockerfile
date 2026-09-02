# syntax=docker/dockerfile:1

# The app uses only the Node standard library, so it needs a Node runtime and
# nothing else — no npm, no build step. Alpine + nodejs is less than half the
# size of the full node image.
FROM alpine:3.22

LABEL org.opencontainers.image.title="Unraid Reverse Proxy" \
      org.opencontainers.image.description="Maps Unraid Docker containers to .local hostnames with a dashboard, admin UI and built-in mDNS responder." \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache nodejs

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    HTTP_PORT=80

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /config

VOLUME ["/config"]
EXPOSE 80/tcp 5353/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1 || exit 1

# Runs as root so it can bind port 80 and join the mDNS multicast group.
CMD ["node", "src/server.js"]
