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
COPY packages/database/package.json ./packages/database/

RUN pnpm install --frozen-lockfile

COPY packages/config-ts/ ./packages/config-ts/
COPY packages/database/ ./packages/database/
COPY prisma.config.ts ./
# Both prisma.config.ts files import the dependency-free env-file resolver by
# SOURCE PATH (packages/applications/src/common/env/env-file-resolution.ts —
# imports only node:fs / node:path). The Prisma CLI executes the config before
# the workspace is built, so the file must be present on disk; it is NOT a pnpm
# dependency (@arcaai/applications depends on @arcaai/database, never the
# reverse), so no install is needed — just the one file at its expected path.
COPY packages/applications/src/common/env ./packages/applications/src/common/env

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

USER dbinit
WORKDIR /app/packages/database

ENTRYPOINT ["dumb-init", "--"]
CMD ["./migrate.sh"]