FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SHIM_HOST=0.0.0.0 SHIM_PORT=8788 SHIM_CONFIG=/app/config/config.json
COPY --from=build --chown=node:node /app/dist/shim.js ./dist/shim.js
COPY --chown=node:node config/docker.example.json ./config/config.json
COPY --chown=node:node scripts/export-grok-bot-session.cjs ./scripts/export-grok-bot-session.cjs
RUN mkdir -p /app/data/desktop-jobs /app/data/video-jobs /app/secrets && chown -R node:node /app/data /app/secrets
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8788/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/shim.js"]
