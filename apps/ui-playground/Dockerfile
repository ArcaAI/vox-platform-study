ARG NODE_VERSION=22
ARG PNPM_VERSION=10.6.5

# -- DEPENDENCY STAGE --
FROM node:${NODE_VERSION}-slim AS dependencies

WORKDIR /app

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

RUN npm install -g pnpm@${PNPM_VERSION} turbo@2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/ui-playground/package.json ./apps/ui-playground/
COPY packages/ui/package.json ./packages/ui/
COPY packages/noise-filter/package.json ./packages/noise-filter/
COPY packages/med-ner/package.json ./packages/med-ner/
COPY packages/room/package.json ./packages/room/
COPY packages/stt/package.json ./packages/stt/
COPY packages/vad/package.json ./packages/vad/
COPY packages/agentic-sdk-v2/package.json ./packages/agentic-sdk-v2/
COPY packages/config-eslint/package.json ./packages/config-eslint/
COPY packages/config-rollup/package.json ./packages/config-rollup/
COPY packages/config-ts/package.json ./packages/config-ts/
COPY packages/config-tailwind/package.json ./packages/config-tailwind/
COPY packages/types/package.json ./packages/types/

RUN --mount=type=cache,id=pnpm-store-ui-playground,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# -- BUILD STAGE --
FROM dependencies AS builder

COPY packages/ ./packages/
COPY apps/ui-playground/ ./apps/ui-playground/

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN --mount=type=cache,id=pnpm-store-ui-playground,target=/pnpm/store \
    turbo run build --filter=@arcaai/ui-playground...

# -- PRODUCTION STAGE --
FROM node:${NODE_VERSION}-alpine AS production

LABEL maintainer="HOPE Team" \
    service="ui-playground" \
    version="1.0.0" \
    description="HOPE UI Playground Frontend"

RUN npm install -g serve@14 && \
    addgroup -g 1001 -S hope && \
    adduser -u 1001 -S ui -G hope

WORKDIR /app

COPY --from=builder --chown=ui:hope /app/apps/ui-playground/dist ./dist

USER ui

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["serve", "-s", "dist", "-l", "3000"]
