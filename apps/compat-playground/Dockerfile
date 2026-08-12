ARG NODE_VERSION=24
ARG PNPM_VERSION=10.31.0

FROM node:${NODE_VERSION}-slim AS dependencies

WORKDIR /app

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

RUN npm install -g pnpm@${PNPM_VERSION} turbo@2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/compat-playground/package.json ./apps/compat-playground/
COPY packages/ui/package.json ./packages/ui/
COPY packages/json-schema-subset/package.json ./packages/json-schema-subset/
COPY packages/agentic-sdk-v2/package.json ./packages/agentic-sdk-v2/
COPY packages/room/package.json ./packages/room/
COPY packages/stt/package.json ./packages/stt/
COPY packages/vad/package.json ./packages/vad/
COPY packages/noise-filter/package.json ./packages/noise-filter/
COPY packages/med-ner/package.json ./packages/med-ner/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-tailwind/package.json ./packages/config-tailwind/
COPY packages/config-ts/package.json ./packages/config-ts/
COPY packages/eslint-plugin-arcaai-internal/package.json ./packages/eslint-plugin-arcaai-internal/

RUN --mount=type=cache,id=pnpm-store-compat-playground,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM dependencies AS builder

COPY packages/ ./packages/
COPY apps/compat-playground/ ./apps/compat-playground/

ARG VITE_API_BASE_URL
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=4096" \
    VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN --mount=type=cache,id=pnpm-store-compat-playground,target=/pnpm/store \
    turbo run build --filter=@arcaai/compat-playground

FROM node:${NODE_VERSION}-alpine AS production

LABEL maintainer="HOPE Team" \
      service="compat-playground" \
      version="1.0.0" \
      description="HOPE v1-to-v2 compatibility playground"

RUN npm install -g serve@14 && \
    addgroup -g 1001 -S hope && \
    adduser -u 1001 -S compat -G hope

WORKDIR /app

COPY --from=builder --chown=compat:hope /app/apps/compat-playground/dist ./dist

# ── TASK-648 W3 — bake build identity, LAST layer ───────────────────────────
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
    chown compat:hope /app/build-info.json

USER compat

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["serve", "-s", "dist", "-l", "3000"]
