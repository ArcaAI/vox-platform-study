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

USER compat

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["serve", "-s", "dist", "-l", "3000"]
