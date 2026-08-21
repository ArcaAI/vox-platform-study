ARG NODE_VERSION=24
ARG PNPM_VERSION=10.34.5

# -- DEPENDENCY STAGE --
FROM node:${NODE_VERSION}-bookworm-slim AS dependencies

LABEL maintainer="HOPE Team" \
    service="api" \
    version="1.0.0" \
    description="HOPE API Backend Service - Dependencies" \
    stage="dependencies"

RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
# pnpm resolves the FULL workspace graph before pruning dev deps, so every
# workspace package referenced (even transitively / dev-only) must have its
# package.json present or `pnpm install` aborts with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
# @arcaai/types = runtime dep of @arcaai/applications; eslint-plugin-arcaai-internal
# = dev dep of api + config-eslint. Without these, NOTHING installs (incl. sharp).
COPY packages/types/package.json ./packages/types/
COPY packages/eslint-plugin-arcaai-internal/package.json ./packages/eslint-plugin-arcaai-internal/
COPY packages/applications/package.json ./packages/applications/
# @arcaai/async-contract = runtime dep of apps/api; @arcaai/workflow-contract =
# runtime dep of @arcaai/applications. Both were added after this list was
# written and neither was appended, so `pnpm install` aborted with
# ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. `dockerfile-workspace-manifests.test.ts`
# now recomputes the closure and fails when this list falls behind again.
COPY packages/async-contract/package.json ./packages/async-contract/
COPY packages/workflow-contract/package.json ./packages/workflow-contract/
COPY packages/json-schema-subset/package.json ./packages/json-schema-subset/
COPY packages/database/package.json ./packages/database/
COPY packages/domains/package.json ./packages/domains/
COPY packages/exceptions/package.json ./packages/exceptions/
COPY packages/logger/package.json ./packages/logger/
COPY packages/tools/package.json ./packages/tools/
COPY packages/utils/package.json ./packages/utils/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-rollup/package.json ./packages/config-rollup/
COPY packages/config-ts/package.json ./packages/config-ts/

# Install all dependencies (allow install even if lockfile is outdated)
RUN pnpm install --no-frozen-lockfile

# -- BUILD STAGE --
FROM dependencies AS builder

LABEL maintainer="HOPE Team" \
    service="api" \
    version="1.0.0" \
    description="HOPE API Backend Service - Builder" \
    stage="builder"

ARG DATABASE_URL

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

RUN set -ex; \
    export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/hope?schema=public}"; \
    # Ensure no stale Prisma engines remain and generate client for correct targets
    rm -rf /app/node_modules/.prisma && \
    pnpm exec prisma generate --schema=packages/database/src/prisma/db_main/schema.prisma; \
    cd packages/tools && pnpm prisma-commander generate --all; \
    # Build ONLY the api's workspace graph (`@arcaai/api...`), not every package.
    # `build:packages` compiled ./packages/* wholesale — dragging in @arcaai/ui,
    # @arcaai/vox and the audio SDK that the API never consumes (and whose deps
    # aren't even installed in this image, so their build fails). `api:build`
    # (turbo --filter=@arcaai/api...) is the correct scope. (`build:modules` /
    # `build:api` were also dangling — no such root scripts exist.)
    cd /app && pnpm api:build; \
    # Verify build artifacts exist
    test -f apps/api/dist/main.js || { echo "Build failed: main.js not found"; exit 1; }; \
    # Preserve ALL Prisma schema domains for production image (initContainers)
    mkdir -p /app/build-artifacts/prisma && cp -r packages/database/src/prisma/* /app/build-artifacts/prisma/; \
    # Prisma v7 may not generate /app/node_modules/.prisma; keep path for production COPY compatibility
    mkdir -p /app/node_modules/.prisma; \
    # Clean up unnecessary files to reduce layer size
    find packages/ -name "src" -type d -exec rm -rf {} + 2>/dev/null || true; \
    pnpm store prune

# -- PRODUCTION STAGE --
FROM node:${NODE_VERSION}-bookworm-slim AS production

LABEL maintainer="HOPE Team" \
    service="apps-api" \
    version="1.0.0" \
    description="HOPE API Backend Service" \
    stage="production" \
    org.opencontainers.image.title="HOPE API Service" \
    org.opencontainers.image.description="NestJS API Gateway with full business logic" \
    org.opencontainers.image.version="1.0.0" \
    org.opencontainers.image.vendor="HOPE Team" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.expose.8868/tcp="API Service HTTP" \
    org.opencontainers.image.documentation="Required environment variables: DB_CONNECTION_STRING, REDIS_HOST, MQTT_HOST, LOG_LEVEL"

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    wget \
    dumb-init && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1001 hope && \
    useradd -r -m -u 1001 -g hope api && \
    npm install -g pnpm@${PNPM_VERSION} && \
    npm cache clean --force

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
# Same workspace-graph completeness requirement as the dependencies stage —
# these must be present for `pnpm install --prod` (which installs sharp + its
# platform-native optional dep, e.g. @img/sharp-linux-x64) to resolve.
COPY packages/types/package.json ./packages/types/
COPY packages/eslint-plugin-arcaai-internal/package.json ./packages/eslint-plugin-arcaai-internal/
COPY packages/applications/package.json ./packages/applications/
# @arcaai/async-contract = runtime dep of apps/api; @arcaai/workflow-contract =
# runtime dep of @arcaai/applications. Both were added after this list was
# written and neither was appended, so `pnpm install` aborted with
# ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. `dockerfile-workspace-manifests.test.ts`
# now recomputes the closure and fails when this list falls behind again.
COPY packages/async-contract/package.json ./packages/async-contract/
COPY packages/workflow-contract/package.json ./packages/workflow-contract/
COPY packages/json-schema-subset/package.json ./packages/json-schema-subset/
COPY packages/database/package.json ./packages/database/
COPY packages/domains/package.json ./packages/domains/
COPY packages/exceptions/package.json ./packages/exceptions/
COPY packages/logger/package.json ./packages/logger/
COPY packages/tools/package.json ./packages/tools/
COPY packages/utils/package.json ./packages/utils/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-rollup/package.json ./packages/config-rollup/
COPY packages/config-ts/package.json ./packages/config-ts/

RUN pnpm install --prod --no-frozen-lockfile && \
    pnpm store prune && \
    rm -rf ~/.pnpm-store

# Fail the build loudly if sharp's native binary can't load in THIS image,
# instead of silently degrading thumbnailUrl to the full-size URL at runtime
# (sharp follow-up). Resolved from @arcaai/applications, which owns the
# `sharp` dep — pnpm's isolated node_modules does NOT hoist it to /app/node_modules,
# so `node -e "require('sharp')"` from the app root would falsely fail.
RUN cd /app/packages/applications && \
    node -e "const s=require('sharp'); console.log('[build] sharp native binary OK — libvips', s.versions.vips)"

# Copy built API application
COPY --from=builder --chown=api:hope /app/apps/api/dist ./apps/api/dist

# Copy only packages that have built dist folders (TypeScript compiled packages)
COPY --from=builder --chown=api:hope /app/packages/applications/dist ./packages/applications/dist
COPY --from=builder --chown=api:hope /app/packages/applications/package.json ./packages/applications/package.json
# @arcaai/json-schema-subset is require()d at runtime by @arcaai/applications
# (consultation-context-schema validation).
COPY --from=builder --chown=api:hope /app/packages/json-schema-subset/dist ./packages/json-schema-subset/dist
COPY --from=builder --chown=api:hope /app/packages/json-schema-subset/package.json ./packages/json-schema-subset/package.json
COPY --from=builder --chown=api:hope /app/packages/domains/dist ./packages/domains/dist
COPY --from=builder --chown=api:hope /app/packages/domains/package.json ./packages/domains/package.json
COPY --from=builder --chown=api:hope /app/packages/exceptions/dist ./packages/exceptions/dist
COPY --from=builder --chown=api:hope /app/packages/exceptions/package.json ./packages/exceptions/package.json
COPY --from=builder --chown=api:hope /app/packages/logger/dist ./packages/logger/dist
COPY --from=builder --chown=api:hope /app/packages/logger/package.json ./packages/logger/package.json
# @arcaai/types ships a runtime enum (StorageProvider) that the compiled storage
# providers require() at boot, so its dist must be present like the other deps.
COPY --from=builder --chown=api:hope /app/packages/types/dist ./packages/types/dist
COPY --from=builder --chown=api:hope /app/packages/types/package.json ./packages/types/package.json
# @arcaai/utils is require()d at runtime by @arcaai/applications (build-info service).
COPY --from=builder --chown=api:hope /app/packages/utils/dist ./packages/utils/dist
COPY --from=builder --chown=api:hope /app/packages/utils/package.json ./packages/utils/package.json
# @arcaai/async-contract (direct dep of apps/api) and @arcaai/workflow-contract
# (dep of @arcaai/applications) both resolve to ./dist/index.js. Their manifests
# are copied above so `pnpm install --prod` can LINK them — but a workspace
# symlink pointing at a directory that has only a package.json is not an install
# error, it is a MODULE_NOT_FOUND at boot. dev-1c410d31 crash-looped on exactly
# that: `Cannot find module '/app/packages/applications/node_modules/
# @arcaai/workflow-contract/dist/index.js'`. Manifest presence and dist presence
# are two separate obligations; `dockerfile-runtime-dist.test.ts` guards this one.
COPY --from=builder --chown=api:hope /app/packages/async-contract/dist ./packages/async-contract/dist
COPY --from=builder --chown=api:hope /app/packages/async-contract/package.json ./packages/async-contract/package.json
COPY --from=builder --chown=api:hope /app/packages/workflow-contract/dist ./packages/workflow-contract/dist
COPY --from=builder --chown=api:hope /app/packages/workflow-contract/package.json ./packages/workflow-contract/package.json

# Copy packages that don't build but are needed at runtime (source code packages)
COPY --from=builder --chown=api:hope /app/packages/database ./packages/database
COPY --from=builder --chown=api:hope /app/packages/tools ./packages/tools

# Copy Prisma generated files
COPY --from=builder --chown=api:hope /app/node_modules/.prisma ./node_modules/.prisma

# Ensure Prisma CLI and engines are present in the final image for initContainers
COPY --from=builder --chown=api:hope /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=api:hope /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=api:hope /app/node_modules/.bin ./node_modules/.bin
RUN chmod +x /app/node_modules/.bin/prisma || true

# Copy ALL preserved Prisma domains to a stable path used by initContainers
COPY --from=builder --chown=api:hope /app/build-artifacts/prisma /app/schema

RUN mkdir -p /app/logs && chown -R api:hope /app/logs

# ── bake build identity, LAST layer ──
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
    chown api:hope /app/build-info.json

ENV NODE_ENV=production \
    PORT=8868 \
    OTEL_SERVICE_NAME=api-gateway \
    OTEL_SERVICE_VERSION=1.0.0 \
    OTEL_TRACES_ENABLED=true \
    OTEL_METRICS_ENABLED=true \
    OTEL_LOGS_ENABLED=true

EXPOSE 8868

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the app (schema sync should be handled by a Kubernetes initContainer)
CMD ["node", "--import", "./apps/api/dist/instrumentation.js", "apps/api/dist/main.js"]
