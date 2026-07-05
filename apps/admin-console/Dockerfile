ARG NODE_VERSION=22
ARG PNPM_VERSION=10.31.0

# -- DEPENDENCY STAGE --
FROM node:${NODE_VERSION}-slim AS dependencies

WORKDIR /app

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

RUN npm install -g pnpm@${PNPM_VERSION} turbo@2

# pnpm resolves the FULL workspace graph before installing, so every workspace
# package referenced (even transitively / dev-only) must have its package.json
# present: @arcaai/ui (runtime dep) + the config packages (dev deps of the app
# and of @arcaai/ui) + eslint-plugin-arcaai-internal (dep of config-eslint).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/admin-console/package.json ./apps/admin-console/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-tailwind/package.json ./packages/config-tailwind/
COPY packages/config-ts/package.json ./packages/config-ts/
COPY packages/eslint-plugin-arcaai-internal/package.json ./packages/eslint-plugin-arcaai-internal/

RUN --mount=type=cache,id=pnpm-store-admin-console,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# -- BUILD STAGE --
FROM dependencies AS builder

COPY packages/ ./packages/
COPY apps/admin-console/ ./apps/admin-console/

# Browser-reachable gateway origin for DIRECT SSE/WS connections — inlined
# into the client bundle at build time (rule 13: non-secret NEXT_PUBLIC_* only).
ARG NEXT_PUBLIC_API_HOST
ENV NEXT_PUBLIC_API_HOST=${NEXT_PUBLIC_API_HOST}

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"

# `next build` (output: standalone) needs no secrets: the server env in
# src/config/env.ts is validated lazily at request time.
RUN --mount=type=cache,id=pnpm-store-admin-console,target=/pnpm/store \
    turbo run build --filter=@arcaai/admin-console

# -- PRODUCTION STAGE --
FROM node:${NODE_VERSION}-alpine AS production

LABEL maintainer="HOPE Team" \
    service="admin-console" \
    version="1.0.0" \
    description="HOPE Admin Console (Next.js BFF)"

RUN addgroup -g 1001 -S hope && \
    adduser -u 1001 -S console -G hope

WORKDIR /app

# Standalone output mirrors the monorepo layout: server.js lives under
# apps/admin-console/ next to a pruned root node_modules.
COPY --from=builder --chown=console:hope /app/apps/admin-console/.next/standalone ./
COPY --from=builder --chown=console:hope /app/apps/admin-console/.next/static ./apps/admin-console/.next/static

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

USER console

EXPOSE 3000

# /login is the public route (the session gate 307s everything else).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/login || exit 1

CMD ["node", "apps/admin-console/server.js"]
