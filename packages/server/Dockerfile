# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
    && corepack prepare pnpm@10.33.4 --activate

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/

RUN pnpm install --frozen-lockfile

COPY packages/core packages/core
COPY packages/server packages/server

RUN pnpm --filter gemdex-server... build \
    && pnpm --filter gemdex-server deploy --prod --legacy /opt/gemdex

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV GEMDEX_SERVER_HOST=0.0.0.0
ENV GEMDEX_SERVER_PORT=8765

RUN groupadd --system --gid 10001 gemdex \
    && useradd --system --uid 10001 --gid gemdex --home-dir /nonexistent --shell /usr/sbin/nologin gemdex

WORKDIR /app
COPY --from=build --chown=gemdex:gemdex /opt/gemdex ./

USER gemdex
EXPOSE 8765

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8765/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
