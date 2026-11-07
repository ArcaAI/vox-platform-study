# 01. Getting Started

**App:** [`apps/api`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api) (`@arcaai/api`, NestJS 11)  
**Global prefix:** `api/v1`  
**Default port:** `8868`

## Prerequisites
- Node.js/pnpm (see repo root)
- Access to required env vars (see [05-configuration.md](05-configuration.md))
- Built dependencies in monorepo

## Local Development
| Command | Purpose |
| --- | --- |
| `pnpm api:dev` | Start Nest dev server with watch/debug (`nest start --debug --watch`) |
| `pnpm api:dev:watch` | Dev with watch across `@arcaai/applications` |
| `pnpm api:build` | Build with `nest build` + `tsc-alias` to `dist/` |
| `pnpm api:start` | Run built app (`dist/main.js`) |
| `pnpm api:typecheck` | `tsc --noEmit` |
| `pnpm api:lint` / `api:lint:fix` | Lint `{src,tests}` |
| `pnpm api:test` | Vitest unit + integration |

See [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md) for full command list.

## Generate API Artifacts
The route manifest, OpenAPI, and portal/SDK artifacts must stay in sync when routes change:

```bash
pnpm --filter @arcaai/api build && \
pnpm --filter @arcaai/api api:route-manifest && \
pnpm --filter @arcaai/api api:openapi && \
pnpm --filter @arcaai/api api:portal && \
pnpm --filter @arcaai/vox-node gen:admin
```

Notes from [`apps/api/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md):
- `api:route-manifest` and `api:openapi` each run `pnpm api:build` themselves (building twice back-to-back is wasteful)
- `pnpm verify` does **not** check these artifacts
- `pnpm api:test:e2e` requires a live gateway on port 8968 under `.env.test`

## Key Entry Points
| File | Purpose |
| --- | --- |
| [`apps/api/src/main.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts) | Bootstrap, global prefix, validation, ETag, security headers, boot audits |
| [`apps/api/src/app.module.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts) | Root module, global guards/interceptors/filters, feature module imports |
| [`apps/api/src/global-prefix.config.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/global-prefix.config.ts) | Global prefix config (`api/v1`) |
