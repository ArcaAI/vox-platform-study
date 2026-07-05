# @arcaai/database

Data-access foundation for the HOPE platform: the Prisma 7 schema (multi-file, PostgreSQL), the generated Prisma client, client extensions for soft-delete filtering and tenant scoping, migrations, and phased seed scripts.

Last updated: 2026-07-04

## Position in the stack

First link in the DDD layer chain:

```
packages/database  →  packages/domains  →  packages/applications  →  apps/api
(Prisma schema)       (entities/repos)      (application services)    (controllers)
```

Direct workspace consumers: `@arcaai/domains`, `@arcaai/applications`, `@arcaai/api`. Python services (`apps/stt-v2`, `apps/smr`, `apps/nlp`, `apps/guardrail`, `apps/harness`) do not use this package; they talk to the API gateway.

## Directory structure

```
packages/database/
├── prisma.config.ts            # Prisma CLI config: env loading + migration URL resolution
├── src/
│   ├── client.ts               # Client factories, soft-delete extension, singletons
│   ├── env.ts                  # NODE_ENV-aware .env loading (.env.dev/.env.test/...)
│   ├── migration-url.ts        # DIRECT_URL vs DATABASE_URL resolver for migrations
│   ├── vault-client.ts         # Vault-issued short-lived credential PrismaClient wrapper
│   ├── extensions/
│   │   └── tenant-scope.ts     # Tenant-scope $extends + TENANT_SCOPED_MODELS allow-list
│   ├── generated/              # Generated Prisma client (created by db:generate, not committed)
│   ├── prisma/db_main/         # Multi-file schema: schema.prisma + one .prisma per domain
│   │   ├── migrations/         # Committed SQL migrations
│   │   ├── seed/               # Phased seed scripts (00-constants ... 91-user)
│   │   └── manual/             # Manual SQL (vault-admin-bootstrap.sql)
│   ├── __tests__/              # Unit tests (client, env, seeds, extensions)
│   └── integration/            # Integration tests (require a live Postgres)
├── scripts/                    # Operational CLIs (decrypt-row, vault smoke tests, backfills)
├── tests/pgbouncer-validation/ # PgBouncer validation rig (root pgbv:* scripts)
├── Dockerfile, migrate.sh      # Migration/seed container for deployments
└── k3s-job-db-migration.yaml   # k3s Job manifest running migrate.sh
```

## Client usage

```typescript
import { getExtendedPrismaClient } from '@arcaai/database';

const prisma = getExtendedPrismaClient();
const users = await prisma.user.findMany();
```

| Export | Purpose |
|---|---|
| `getExtendedPrismaClient()` | Default singleton. Composed `soft-delete + tenant-scope` client — use this everywhere |
| `getPlatformAdminPrismaClient_Unscoped()` | Raw client that bypasses both extensions. ESLint-gated to an allow-list (seeds, scripts, `CoreDatabaseService`); see below |
| `createNewPrismaClient()` / `createNewExtendedPrismaClient()` | Fresh instances with their own pools (test isolation) |
| `getPrismaClientWithVault()` / `VaultPrismaClient` | Client backed by Vault-issued short-lived DB credentials |
| `setTenantContextProvider(provider)` | Host registration hook for the tenant-scope extension (wired by `apps/api/src/database/tenant-context.provider.ts`) |
| `Prisma`, generated model types, `PrismaClient*Error` | Re-exported from the generated client |

The subpath export `@arcaai/database/client` exposes the raw generated client module.

### Connection pooling (Prisma 7)

In Prisma 7 the driver adapter (`@prisma/adapter-pg`) owns pool sizing — the legacy `connection_limit` URL parameter is ignored. `src/client.ts` reads:

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Runtime connection string (PgBouncer port 6432 in production) |
| `DIRECT_URL` | unset | Un-pooled URL used by `prisma.config.ts` for migrations (advisory locks do not survive PgBouncer transaction pooling) |
| `PRISMA_PG_MAX` | `5` | `max` connections per pool, per pod. Budget rule: `pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections` |

The pool pins `connectionTimeoutMillis = 5000` and `idleTimeoutMillis = 300000`. Full rationale: [docs/archive/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md](../../docs/archive/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md).

### Environment loading

`src/env.ts` (and `prisma.config.ts`) load a monorepo-root env file by `NODE_ENV`: `.env.dev` (development, falls back to `.env`), `.env.test`, `.env.staging`, `.env.production`. In CI (`CI=true`) and production, only host environment variables are used.

## Client extensions

### Soft delete

`applySoftDeleteExtension` injects `resourceStatus: { not: 'DELETED' }` into `findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, and `groupBy` unless the caller filters `resourceStatus` explicitly. Immutable tables (version history, usage records, WORM audit) are listed in `MODELS_WITHOUT_SOFT_DELETE` and skipped; `modelHasSoftDelete(model)` exposes the check.

### Tenant scope

`src/extensions/tenant-scope.ts` enforces tenant isolation at the client layer (multi-tenancy hardening, archived ticket [TASK-305](../../docs/archive/TASK-305-Multi-Tenancy-Hardening/README.md)):

- `TENANT_SCOPED_MODELS` — allow-list of tenant-scoped models (currently 44). `User`/`UserProfile`/`UserSettings` are deliberately absent: user identity is global, and tenant membership is modeled via the scoped join tables `UserRoleAssignment` and `UserDepartment`. `TenantEntitlement` is a reviewed exception (pre-auth throttler + global-admin cross-tenant override CRUD read it outside a matching CLS tenant; see the drift-guard test's `INTENTIONALLY_UNSCOPED`).
- Reads merge `where: { tenantId: <CLS tenant> }` into caller args; writes assert `data.tenantId` equals the CLS tenant (auto-injected when missing, error on mismatch).
- `SYSTEM_SHARED_READ_MODELS` — catalog models (e.g. seeded ASR pipelines) whose reads widen to `tenantId IN [caller, SYSTEM]`; writes are never widened.
- `SYSTEM_TENANT_ID` (`00000000-0000-0000-0000-000000000000`) — reserved system tenant owning platform-wide rows.
- Global-admin bypass applies only when no CLS context exists (seeds, CLI); with an active CLS tenant the scope still applies.

The context provider is registered at API bootstrap via `setTenantContextProvider` (`apps/api/src/database/tenant-context.provider.ts` reads `tenantId`/roles from `nestjs-cls`). Cross-aggregate guards (parent/child tenant equality, user-tenant membership) live one layer up in `packages/applications/src/common/tenant-guards.ts`.

### Unscoped client guard

`getPlatformAdminPrismaClient_Unscoped` bypasses both extensions. A `no-restricted-imports` rule in `packages/config-eslint/flat/core.js` fails the build when it is imported outside the documented allow-list (seed runner, `packages/database/scripts/`, integration-test fixtures, and `CoreDatabaseService` in `@arcaai/domains`). Enumerate current call sites with `rg getPlatformAdminPrismaClient_Unscoped`.

## Schema conventions

Schema lives in `src/prisma/db_main/` as one `.prisma` file per domain (`consultation.prisma`, `user.prisma`, `harness.prisma`, ...) plus `schema.prisma` (datasource + generator). Key conventions, verified in the schema:

- Generator: `prisma-client` provider, output `src/generated/core-prisma-client`; datasource uses schemas `["public", "core"]` with the `vector` extension (pgvector).
- Every model declares `@@schema("core")` and follows the standard field order: meta (`metaData`, `version`, `id @default(uuid(7))`), `tenantId` (for tenant-scoped models, NOT NULL), business fields, relations, resource status (`resourceStatus` + `resourceStatusUpdatedAt/By`), audit fields (`createdBy`, `updatedBy`, `createdAt`, `updatedAt`), optional `tags String[]`.
- Soft delete via `resourceStatus: DELETED`; never hard-delete rows.
- Composite `[tenantId, ...]` indexes lead the query-hot paths; WORM tables (`HarnessAuditEvent`, `*PolicyChange`) are append-only with UPDATE/DELETE revoked in migrations.
- Encrypted PHI columns use the `encrypted*` naming convention; decrypt-on-read is handled by the domains repository layer (archived ticket TASK-369).

## Commands

Package scripts (run as `pnpm --filter @arcaai/database <script>`; most have root-level `pnpm db:*` aliases):

| Script | Command | Notes |
|---|---|---|
| `db:generate` | `prisma generate` + regenerate the client index via `@arcaai/tools` | Run after every schema change |
| `db:migrate` | `prisma migrate dev --skip-generate` | Create + apply a dev migration |
| `db:migrate:create` | `prisma migrate dev --create-only` | Generate SQL for review without applying |
| `db:migrate:deploy` | `prisma migrate deploy` | Production/CI migration deploy |
| `db:migrate:status` | `prisma migrate status` | |
| `db:migrate:reset` | `prisma migrate reset` | Destructive; requires explicit approval |
| `db:push` / `db:push:force` | `prisma db push [--force-reset --accept-data-loss]` | Schema sync without migrations (dev/test only) |
| `db:studio` | `prisma studio` | |
| `seed` | `tsx src/index.ts` | Runs the phased seed suite (root alias `pnpm db:seed`) |
| `decrypt:row` | `tsx scripts/decrypt-row.ts` | Read-only PHI decrypt CLI |
| `build` | `tsc` | |
| `test` | `vitest run` | Unit tests only (excludes `integration/**` and `*.postgres.test.ts`) |

Additional test entry points:

- Live-Postgres WORM guard: `pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts`
- PgBouncer validation rig: root `pnpm pgbv:up` / `pnpm pgbv:test` / `pnpm pgbv:down` (compose file under `tests/pgbouncer-validation/`)
- Test database lifecycle: root `pnpm test:db:push`, `pnpm test:db:seed`, `pnpm test:db:reset` (run against `.env.test`)

## Migrations and seeding

Migration workflow: edit the relevant `.prisma` file, run `pnpm db:migrate` (or `db:migrate:create` to review SQL first), inspect the generated SQL under `src/prisma/db_main/migrations/`, then `pnpm db:generate`. Never edit a committed migration; roll forward instead.

`prisma.config.ts` prefers `DIRECT_URL` over `DATABASE_URL` for migrations (see `src/migration-url.ts`) so Prisma Migrate's advisory locks bypass PgBouncer.

Seeds live in `src/prisma/db_main/seed/` and run in file order (`00-constants.ts`, `01-policy.ts`, ... `15-entitlements.ts`, `91-user.ts`). `00-constants.ts` defines the reserved UUIDs, including `SYSTEM_TENANT_ID`. Seeds use the unscoped client because no CLS context exists at seed time.

For containerized deployments, `Dockerfile` + `migrate.sh` build a job image that generates the client, runs `migrate deploy` (production/staging) or `db push` (dev), then seeds; `k3s-job-db-migration.yaml` is the corresponding k3s Job.
