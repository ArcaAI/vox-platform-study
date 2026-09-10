ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init openssl && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm && \
    npm cache clean --force

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config-ts/package.json ./packages/config-ts/
# @arcaai/types is a RUNTIME dependency of @arcaai/database (declared in its
# package.json). Under `--frozen-lockfile` pnpm trusts the lockfile and does NOT
# abort when a referenced workspace project is absent from the context — it just
# never links it, so the failure surfaces two layers later as
# `TS2307: Cannot find module '@arcaai/types'` from
# src/prisma/db_main/seed/ai-models/shared.ts. That is exactly how build-database
# failed in pipeline 1161. Guarded by
# packages/database/src/__tests__/dockerfile-workspace-deps.test.ts.
COPY packages/types/package.json ./packages/types/
COPY packages/database/package.json ./packages/database/

RUN pnpm install --frozen-lockfile

COPY packages/config-ts/ ./packages/config-ts/
COPY packages/types/ ./packages/types/
COPY packages/database/ ./packages/database/
COPY prisma.config.ts ./
# Both prisma.config.ts files import the dependency-free env-file resolver by
# SOURCE PATH (packages/applications/src/common/env/env-file-resolution.ts —
# imports only node:fs / node:path). The Prisma CLI executes the config before
# the workspace is built, so the file must be present on disk; it is NOT a pnpm
# dependency (@arcaai/applications depends on @arcaai/database, never the
# reverse), so no install is needed — just the one file at its expected path.
COPY packages/applications/src/common/env ./packages/applications/src/common/env

# @arcaai/types resolves through its package.json `types` field
# (./dist/index.d.ts), so it must be emitted BEFORE `tsc` runs over the seed
# sources. `.dockerignore` excludes **/*.tsbuildinfo precisely so this
# `tsc --build` cannot trust a host-stale buildinfo and skip the emit.
RUN pnpm --filter @arcaai/types build

# `prisma generate` (codegen) + `tsc`, run directly — NOT `pnpm db:generate`.
# db:generate additionally runs `@arcaai/tools generate-prisma-index`, which
# would drag @prisma/internals / ts-morph / handlebars / inquirer into this lean
# migrations image just to emit the `./client` sub-path barrel. This image only
# runs migrate + seed (tsx dist/index.js), and the seed imports the generated
# client.js directly — it never resolves `@arcaai/database/client` — so the
# barrel is dead weight here and `tsc` builds without it.
RUN DATABASE_URL="postgresql://build:build@localhost/build" \
    pnpm --filter @arcaai/database exec prisma generate --schema=src/prisma/db_main && \
    pnpm --filter @arcaai/database build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init postgresql-client openssl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 -g nodejs dbinit

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config-ts/package.json ./packages/config-ts/
# Same workspace-graph reason as the builder stage. No `dist` is carried over:
# the only reference to @arcaai/types in this package is `import type`, which tsc
# erases, so nothing in dist/ resolves it at runtime — the manifest alone keeps
# the prod install's workspace link honest.
COPY packages/types/package.json ./packages/types/
COPY packages/database/package.json ./packages/database/

RUN npm install -g pnpm && \
    pnpm install --prod --frozen-lockfile && \
    npm cache clean --force

COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/database/src/prisma ./packages/database/src/prisma
COPY --from=builder /app/prisma.config.ts ./
# migrate.sh runs prisma from /app, so the root prisma.config.ts loads at
# runtime too and imports the same dependency-free env resolver — carry it over.
COPY --from=builder /app/packages/applications/src/common/env ./packages/applications/src/common/env
COPY packages/database/migrate.sh ./packages/database/

RUN chown -R dbinit:nodejs /app && \
    chmod +x ./packages/database/migrate.sh

# ── bake build identity, LAST layer ───────────────────────────
# These args change on every commit; kept below every COPY/RUN so they never
# invalidate the layer cache above them. Written to /app/build-info.json per
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
    chown dbinit:nodejs /app/build-info.json

USER dbinit
WORKDIR /app/packages/database

ENTRYPOINT ["dumb-init", "--"]
CMD ["./migrate.sh"]