ARG NODE_VERSION=24
ARG PNPM_VERSION=10.34.5

# -- DEPENDENCY STAGE --
FROM node:${NODE_VERSION}-slim AS dependencies

WORKDIR /app

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

RUN npm install -g pnpm@${PNPM_VERSION} turbo@2

# pnpm resolves the FULL workspace graph before installing, so every workspace
# package in the app's dependency closure must have its package.json present or
# `pnpm install` aborts with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. The app pulls the
# whole @arcaai/vox audio SDK (playground screens), so beyond @arcaai/ui + the
# config packages we also need room / stt / vox / vad / noise-filter / med-ner
# (their transitive workspace closure) and eslint-plugin-arcaai-internal
# (dep of config-eslint). Their source is copied wholesale in the build stage.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/admin-console/package.json ./apps/admin-console/
COPY packages/ui/package.json ./packages/ui/
COPY packages/json-schema-subset/package.json ./packages/json-schema-subset/
COPY packages/room/package.json ./packages/room/
COPY packages/stt/package.json ./packages/stt/
COPY packages/agentic-sdk-v2/package.json ./packages/agentic-sdk-v2/
COPY packages/vad/package.json ./packages/vad/
COPY packages/noise-filter/package.json ./packages/noise-filter/
COPY packages/med-ner/package.json ./packages/med-ner/
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

# ── bake build identity, LAST layer ───────────────────────────
# These args change on every commit; kept below every COPY/RUN so they never
# invalidate the layer cache above them. Written to /app/build-info.json per
# docs/implementation/TASK-648-Service-Version-And-Release-Registry/contracts/build-info.schema.json.
ARG BUILD_SERVICE
ARG BUILD_VERSION
ARG BUILD_RELEASE_TAG
ARG BUILD_GIT_BRANCH
ARG BUILD_GIT_SHA
ARG BUILD_AT
ARG BUILD_CI_PIPELINE_ID
ARG BUILD_CI_PIPELINE_URL
RUN set -eu; \
    release_tag=$( [ -n "${BUILD_RELEASE_TAG:-}" ] && printf '"%s"' "${BUILD_RELEASE_TAG}" || printf 'null' ); \
    pipeline_id=$( [ -n "${BUILD_CI_PIPELINE_ID:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_ID}" || printf 'null' ); \
    pipeline_url=$( [ -n "${BUILD_CI_PIPELINE_URL:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_URL}" || printf 'null' ); \
    printf '{"service":"%s","version":"%s","releaseTag":%s,"gitBranch":"%s","gitCommitSha":"%s","buildAt":"%s","ciPipelineId":%s,"ciPipelineUrl":%s}\n' \
      "${BUILD_SERVICE}" "${BUILD_VERSION}" "${release_tag}" "${BUILD_GIT_BRANCH}" "${BUILD_GIT_SHA}" "${BUILD_AT}" "${pipeline_id}" "${pipeline_url}" \
      > /app/build-info.json && \
    chown console:hope /app/build-info.json

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

USER console

EXPOSE 3000

# /login is the public route (the session gate 307s everything else).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/login || exit 1

CMD ["node", "apps/admin-console/server.js"]
