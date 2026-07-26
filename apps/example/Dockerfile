ARG NODE_VERSION=24

# Build stage
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# Copy root workspace manifests so pnpm can install with the monorepo lockfile
COPY package.json pnpm-lock.yaml* .npmrc* ./

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN pnpm install --frozen-lockfile || pnpm install

# Copy only the example app sources into the container
COPY apps/example ./apps/example

WORKDIR /app/apps/example

RUN pnpm install --frozen-lockfile || pnpm install

RUN pnpm build

# Runtime stage: serve static files with nginx
FROM nginx:1.27-alpine AS runner

COPY --from=builder /app/apps/example/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]