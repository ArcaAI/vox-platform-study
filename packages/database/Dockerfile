FROM node:22-alpine AS builder

RUN apk add --no-cache dumb-init && \
    npm install -g pnpm && \
    npm cache clean --force

WORKDIR /app

ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config-ts/package.json ./packages/config-ts/
COPY packages/database/package.json ./packages/database/

RUN pnpm install --frozen-lockfile

COPY packages/config-ts/ ./packages/config-ts/
COPY packages/database/ ./packages/database/
COPY prisma.config.ts ./

RUN pnpm db:generate && pnpm --filter @arcaai/database build

FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init postgresql-client && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 dbinit

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
COPY packages/database/migrate.sh ./packages/database/

RUN chown -R dbinit:nodejs /app && \
    chmod +x ./packages/database/migrate.sh

USER dbinit
WORKDIR /app/packages/database

ENTRYPOINT ["dumb-init", "--"]
CMD ["./migrate.sh"]