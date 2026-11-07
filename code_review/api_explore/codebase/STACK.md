# Stack

> Evidence-based snapshot of the `apps/api` NestJS gateway. Generated: 2026-10-23. Repository root: `/Users/apple/repos/VOX/project-hope`, HEAD: `4e1434992f4eed101836aa532311b31c3402ac47` (clean). Outputs written outside the repo to `../review/api_explore/`.

## Runtime
- **Framework:** NestJS 11.2.3 (`@nestjs/core`), Express underlying (Node.js). [apps/api/package.json:72-105]
- **Language:** TypeScript 6.0.3. [apps/api/package.json:153]
- **Process entry:** `node --import ./dist/instrumentation.js dist/main.js` (production). [apps/api/package.json:49, Dockerfile:243]
- **Port:** `8868` (exposed in Docker). [apps/api/package.json:183, apps/api/README.md:24]
- **Global prefix:** `api/v1` (excluded: `/metrics` only). [apps/api/src/global-prefix.config.ts, apps/api/README.md:153]
- **WS adapter:** `WsAdapter` from `@nestjs/platform-ws`. [apps/api/src/main.ts:4,153]

## Key dependencies
| Area | Package | Purpose | Evidence |
|---|---|---|---|
| AuthN/Z | `@nestjs/passport`, `passport-jwt`, `jsonwebtoken`, `speakeasy` | JWT/passport auth, MFA. | [apps/api/package.json:94-112] |
| AuthZ | `@arcaai/applications` (workspace) | `UnifiedAuthGuard`, `AuthorizationModule`, policy engine, CASL abilities. | [apps/api/src/app.module.ts:3,48,217,617-618], [packages/applications/src/authorization/unified-auth.guard.ts] |
| ORM / DB | `@arcaai/database`, `@prisma/instrumentation` | Prisma client + extensions; pool telemetry. | [apps/api/package.json:61,99], [apps/api/README.md:41] |
| Domain | `@arcaai/domains`, `@arcaai/exceptions`, `@arcaai/async-contract` | Repos, enums, errors, contracts. | [apps/api/package.json:59-61] |
| Queue | `@nestjs/bullmq`, `bullmq` | Redis-backed queues; see `JobQueue` enum. | [apps/api/package.json:68,84, apps/api/src/app.module.ts:293, packages/domains/src/enums/JobQueue.enum.ts] |
| Cache/Redis | `ioredis`, `@nest-lab/throttler-storage-redis` | Redis for throttling/queues/tickets. | [apps/api/package.json:88,110], [apps/api/src/config/env.descriptors.ts:73] |
| Validation | `class-validator` 0.15.1, `class-transformer`, `zod` | DTO validation, schema validation. | [apps/api/package.json:85-86,149] |
| Security | `helmet`, `compression`, `express-session`, `bcryptjs` | Headers, compression, sessions, hashing. | [apps/api/package.json:87-91] |
| Observability | `@opentelemetry/*`, `prom-client`, `winston`, `nestjs-cls` | Tracing, metrics, logging, request context. | [apps/api/package.json:100-109, apps/api/src/observability/*] |
| Swagger | `@nestjs/swagger` | OpenAPI generation. | [apps/api/package.json:96], [apps/api/src/openapi/*] |

## Build & test
- **Build:** `rimraf dist tsconfig.build.tsbuildinfo && nest build && tsc-alias`. [apps/api/package.json:48]
- **Unit/integration:** `vitest run` (see `vitest.config.ts`). Includes `src/**/*.test.ts`, `tests/unit/**/*.test.ts`, `tests/integration/**/*.spec.ts`; excludes `tests/e2e/**`. Coverage V8 to `./coverage` by default. [apps/api/package.json:66-69, apps/api/vitest.config.ts]
- **E2E:** Playwright API tests in `tests/e2e/*.spec.ts` (165 specs), base URL `http://localhost:8968/api/v1`. [apps/api/package.json:70, playwright.config.ts:212-260]
- **Route/OpenAPI artifacts:** `pnpm api:route-manifest`, `pnpm api:openapi`, `pnpm api:portal` (must be regenerated together on route changes). [apps/api/README.md:232-248]

## Evidence
- Package manifest: [apps/api/package.json](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/package.json)
- README: [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)
- Bootstrap: [apps/api/src/main.ts:50-499](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/main.ts#L50-L499), [apps/api/src/app.module.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/app.module.ts)
- Test config: [apps/api/vitest.config.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/vitest.config.ts), [playwright.config.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/playwright.config.ts)
- Inventory: [inventory/summary.json](./inventory/summary.json), [inventory/routes-by-module.md](./inventory/routes-by-module.md)
- Coverage: [docs/06a-COVERAGE-BY-AREA.md](./docs/06a-COVERAGE-BY-AREA.md)