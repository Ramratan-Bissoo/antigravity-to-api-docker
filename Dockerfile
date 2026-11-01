FROM debian:bookworm-slim AS agy

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Official installer; it verifies the download's SHA-512 checksum.
RUN mkdir -p /out \
 && curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /out \
 && /out/agy --version

FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=agy /out/agy /usr/local/bin/agy

WORKDIR /app
COPY --chown=node:node package.json *.mjs ./
RUN mkdir -p /app/memory /home/node/.gemini \
 && chown -R node:node /app/memory /home/node/.gemini

# 0.0.0.0 is required inside a container; docker-compose.yml publishes it on localhost only.
ENV HOST=0.0.0.0 \
    PORT=8788 \
    AGY_BIN=/usr/local/bin/agy

USER node
EXPOSE 8788
VOLUME ["/app/memory", "/home/node/.gemini"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "api-server.mjs"]
