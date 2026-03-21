ARG NODE_VERSION=22
ARG PNPM_VERSION=10.6.5

# -- DEPENDENCY STAGE --
FROM node:${NODE_VERSION}-slim AS dependencies

LABEL maintainer="HOPE Team" \
    service="api" \
    version="1.0.0" \
    description="HOPE API Backend Service - Dependencies" \
    stage="dependencies"

RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/applications/package.json ./packages/applications/
COPY packages/database/package.json ./packages/database/
COPY packages/domains/package.json ./packages/domains/
COPY packages/exceptions/package.json ./packages/exceptions/
COPY packages/logger/package.json ./packages/logger/
COPY packages/tools/package.json ./packages/tools/
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

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

RUN set -ex; \
    # Ensure no stale Prisma engines remain and generate client for correct targets
    rm -rf /app/node_modules/.prisma && \
    pnpm exec prisma generate --schema=packages/database/src/prisma/db_main/schema.prisma; \
    cd packages/tools && pnpm prisma-commander --all-domains; \
    cd /app && pnpm build:packages && pnpm build:modules && pnpm build:api; \
    # Verify build artifacts exist
    test -f apps/api/dist/main.js || { echo "Build failed: main.js not found"; exit 1; }; \
    # Preserve ALL Prisma schema domains for production image (initContainers)
    mkdir -p /app/build-artifacts/prisma && cp -r packages/database/src/prisma/* /app/build-artifacts/prisma/; \
    # Clean up unnecessary files to reduce layer size
    find packages/ -name "src" -type d -exec rm -rf {} + 2>/dev/null || true; \
    pnpm store prune

# -- PRODUCTION STAGE --
FROM node:${NODE_VERSION}-slim AS production

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
COPY packages/applications/package.json ./packages/applications/
COPY packages/database/package.json ./packages/database/
COPY packages/domains/package.json ./packages/domains/
COPY packages/exceptions/package.json ./packages/exceptions/
COPY packages/logger/package.json ./packages/logger/
COPY packages/tools/package.json ./packages/tools/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-rollup/package.json ./packages/config-rollup/
COPY packages/config-ts/package.json ./packages/config-ts/

RUN pnpm install --prod --no-frozen-lockfile && \
    pnpm store prune && \
    rm -rf ~/.pnpm-store

# Copy built API application
COPY --from=builder --chown=api:hope /app/apps/api/dist ./apps/api/dist

# Copy only packages that have built dist folders (TypeScript compiled packages)
COPY --from=builder --chown=api:hope /app/packages/applications/dist ./packages/applications/dist
COPY --from=builder --chown=api:hope /app/packages/applications/package.json ./packages/applications/package.json
COPY --from=builder --chown=api:hope /app/packages/domains/dist ./packages/domains/dist
COPY --from=builder --chown=api:hope /app/packages/domains/package.json ./packages/domains/package.json
COPY --from=builder --chown=api:hope /app/packages/exceptions/dist ./packages/exceptions/dist
COPY --from=builder --chown=api:hope /app/packages/exceptions/package.json ./packages/exceptions/package.json
COPY --from=builder --chown=api:hope /app/packages/logger/dist ./packages/logger/dist
COPY --from=builder --chown=api:hope /app/packages/logger/package.json ./packages/logger/package.json

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


ENV NODE_ENV=production \
    PORT=8868 \
    OTEL_SERVICE_NAME=hope-api \
    OTEL_SERVICE_VERSION=1.0.0 \
    OTEL_RESOURCE_ATTRIBUTES=service.name=hope-api,service.version=1.0.0,service.namespace=hope,deployment.environment=production \
    OTEL_TRACES_ENABLED=true \
    OTEL_METRICS_ENABLED=true

EXPOSE 8868

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the app (schema sync should be handled by a Kubernetes initContainer)
CMD ["node", "apps/api/dist/main.js"]