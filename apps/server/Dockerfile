FROM node:24-slim AS builder

WORKDIR /app

# Copy workspace manifests & shared types
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/

# Install only server workspace dependencies
RUN npm install --workspace=@xiziterm/server --include-workspace-root

# Copy server source & compile TypeScript
COPY apps/server/src ./apps/server/src
RUN npm run build --workspace=@xiziterm/server

FROM node:24-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DB_PATH=/data/xiziterm.db

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/dist ./apps/server/dist

RUN mkdir -p /data

EXPOSE 8787

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
