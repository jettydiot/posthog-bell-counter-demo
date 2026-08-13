# The service has zero runtime dependencies, so there is no install step and no
# node_modules to copy — the image is the Node runtime plus ~30 KB of source.
FROM node:22-alpine AS base

# Tini reaps zombies and forwards SIGTERM, so `docker stop` reaches the graceful
# shutdown handler instead of being swallowed by PID 1.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Ownership is set at copy time so the running user never needs write access.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

# Uses the app's own health endpoint, so an unhealthy container is one that
# cannot actually answer a request — not merely one whose process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
