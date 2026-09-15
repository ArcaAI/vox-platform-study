# @arcaai/database — the Prisma 7 schema and extended client

Data-access foundation for the HOPE platform: the multi-file Prisma 7 schema (PostgreSQL), the
generated Prisma client, client extensions for soft-delete filtering and tenant scoping,
migrations, and phased seed scripts. First link in the DDD layer chain:

```
packages/database  ->  packages/domains  ->  packages/applications  ->  apps/api
(Prisma schema)         (entities/repos)      (application services)    (controllers)
```

Direct workspace consumers: `@arcaai/domains`, `@arcaai/applications`, `apps/api`. Python services
(`apps/stt`, `apps/text`, `apps/nlp`, `apps/guardrail`, `apps/harness`, `apps/tts`) do not use this
package; they talk to the API gateway.

## Layout

| Path | What it holds |
|---|---|
| `prisma.config.ts` | Prisma CLI config: env loading + migration URL resolution |
| `src/client.ts` | Client factories, soft-delete extension, `MODELS_WITHOUT_SOFT_DELETE` |
| `src/env.ts` | `NODE_ENV`-aware `.env` loading |
| `src/migration-url.ts` | `DIRECT_URL` vs `DATABASE_URL` resolver for migrations |
| `src/vault-client.ts` | `VaultPrismaClient` / `getPrismaClientWithVault` — Vault-issued short-lived credential client |
| `src/extensions/tenant-scope.ts` | Tenant-scope `$extends`, `TENANT_SCOPED_MODELS`, `SYSTEM_SHARED_READ_MODELS` |
| `src/generated/` | Generated Prisma client (created by `db:generate`, not committed) |
| `src/prisma/db_main/` | Multi-file schema: `schema.prisma` (datasource + generator) plus one `.prisma` file per domain — **not** `packages/database/prisma/` |
| `src/prisma/db_main/migrations/` | Committed SQL migrations |
| `src/prisma/db_main/seed/` | Phased seed scripts, `00-constants.ts` through `94-service-account.ts` |
| `src/prisma/db_main/manual/` | Manual SQL (e.g. `vault-admin-bootstrap.sql`) |
| `src/__tests__/` | Unit tests (client, env, seeds, extensions) |
| `src/integration/` | Integration tests (require a live Postgres) |
| `scripts/` | Operational CLIs: `decrypt-row.ts`, `dna-phi-scan.ts`, `regen-workflow-seeds.ts` |
| `tests/pgbouncer-validation/` | PgBouncer validation rig (root `pnpm pgbv:*` scripts) |
| `Dockerfile`, `migrate.sh` | Migration/seed container image for deployments |

## Commands

Run as `pnpm --filter @arcaai/database <script>`; most have root-level `pnpm db:*` aliases.

| Script | Command | Notes |
|---|---|---|
| `db:generate` | `prisma generate` + regenerate the client index via `@arcaai/tools` | Run after every schema change |
| `db:migrate` | `prisma migrate dev` + `generate-prisma-index` | Needs a migration ledger — the local dev DB does not have one; see Gotchas |
| `db:migrate:create` | `prisma migrate dev --create-only` | Generate SQL for review without applying. `-n <name>` must go to this package-level script, not the root alias |
| `db:migrate:deploy` | `prisma migrate deploy` | Production/CI migration deploy |
| `db:migrate:status` | `prisma migrate status` | |
| `db:migrate:reset` | `prisma migrate reset` | Destructive; requires explicit approval |
| `db:push` / `db:push:force` | `prisma db push` / `prisma db push --force-reset --accept-data-loss` | Schema sync without migrations (dev/test only) |
| `db:studio` | `prisma studio` | |
| `seed` | `tsx src/index.ts` | Runs the phased seed suite (root alias `pnpm db:seed`) |
| `decrypt:row` | `tsx scripts/decrypt-row.ts` | Read-only PHI decrypt CLI |
| `dna:phi-scan` | `tsx scripts/dna-phi-scan.ts` | Scans DNA writing-style content for PHI leakage |
| `seed:regen:workflows` | `tsx scripts/regen-workflow-seeds.ts` | Regenerates workflow-definition seed fixtures |
| `build` | `tsc` | |
| `test` | `vitest run` | Unit tests only |
| `test:cov` | `vitest run --coverage` | |

Additional test entry points:

- Live-Postgres WORM guard: `pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts`
- PgBouncer validation rig: root `pnpm pgbv:up` / `pnpm pgbv:test` / `pnpm pgbv:down`
- Test database lifecycle: root `pnpm test:db:push`, `pnpm test:db:seed`, `pnpm test:db:reset` (run against `.env.test`)

## How it works

### Client usage

```typescript
import { getExtendedPrismaClient } from '@arcaai/database';

const prisma = getExtendedPrismaClient();
const users = await prisma.user.findMany();
```

| Export | Purpose |
|---|---|
| `getExtendedPrismaClient()` | Default singleton. Composed soft-delete + tenant-scope client — use this everywhere |
| `getPlatformAdminPrismaClient_Unscoped()` | Raw client that bypasses both extensions. Lint-gated to an allow-list; see Gotchas |
| `createNewPrismaClient()` / `createNewExtendedPrismaClient()` | Fresh instances with their own pools (test isolation) |
| `getPrismaClientWithVault()` / `VaultPrismaClient` | Client backed by Vault-issued short-lived DB credentials |
| `setTenantContextProvider(provider)` | Host registration hook for the tenant-scope extension (wired by `apps/api/src/database/tenant-context.provider.ts`) |
| `Prisma`, generated model types, `PrismaClient*Error` | Re-exported from the generated client |

The subpath export `@arcaai/database/client` exposes the raw generated client module.

### Connection pooling (Prisma 7)

The driver adapter (`@prisma/adapter-pg`) owns pool sizing — the legacy `connection_limit` URL
parameter is ignored. `src/client.ts` reads:

| Env var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Runtime connection string |
| `DIRECT_URL` | unset | Un-pooled URL used by `prisma.config.ts` for migrations (advisory locks do not survive PgBouncer transaction pooling) |
| `PRISMA_PG_MAX` | `5` | `max` connections per pool, per pod |

The current k3s deployment has NO pooler (one in-cluster Postgres server, roughly a dozen
workloads) — the `DIRECT_URL`/PgBouncer guidance above is conditional on a pooled deployment
actually being used, not a description of the cluster today (see `.claude/rules/09-infrastructure-devops.md`).

### Environment loading

`src/env.ts` (and `prisma.config.ts`) load a monorepo-root env file by `NODE_ENV`: `.env.dev`,
`.env.test`, `.env.production`. In CI (`CI=true`) and production, only host environment variables
are used — no file is read.

### Client extensions

**Soft delete.** `applySoftDeleteExtension` injects `resourceStatus: { not: 'DELETED' }` into
`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, and `groupBy` unless the caller filters
`resourceStatus` explicitly. Models in `MODELS_WITHOUT_SOFT_DELETE` are skipped;
`modelHasSoftDelete(model)` exposes the check.

**Tenant scope.** `src/extensions/tenant-scope.ts` enforces tenant isolation at the client layer:

- `TENANT_SCOPED_MODELS` — allow-list of tenant-scoped models (90 as of this pass — verify with
  `rg "^export const TENANT_SCOPED_MODELS"` before citing a count elsewhere, it changes every
  sprint). `User`/`UserProfile`/`UserSettings` are deliberately absent: user identity is global,
  and tenant membership is modeled via the scoped join tables `UserRoleAssignment` and
  `UserDepartment`. `ApiKey` and `ServiceAccount` are deliberately absent too — both are read
  pre-auth, before any tenant context exists.
- Reads merge `where: { tenantId: <CLS tenant> }` into caller args; writes assert `data.tenantId`
  equals the CLS tenant (auto-injected when missing, error on mismatch).
- `SYSTEM_SHARED_READ_MODELS` — catalog models whose reads widen to `tenantId IN [caller, SYSTEM]`;
  writes are never widened.
- `SYSTEM_TENANT_ID` (`00000000-0000-0000-0000-000000000000`) — reserved system tenant owning
  platform-wide rows. The other reserved tenant, `50000000-...` ("Global"), is a customer tenant
  and never appears in this cascade — see `.claude/rules/00-project-context.md`.
- Super-admin bypass applies only when no CLS context exists (seeds, CLI); with an active CLS
  tenant the scope still applies.

The context provider is registered at API bootstrap via `setTenantContextProvider`
(`apps/api/src/database/tenant-context.provider.ts` reads `tenantId`/roles from `nestjs-cls`).
Cross-aggregate guards (parent/child tenant equality, user-tenant membership) live one layer up in
`packages/applications/src/common/tenant-guards.ts`.

**Unscoped client guard.** `getPlatformAdminPrismaClient_Unscoped` bypasses both extensions. A
`no-restricted-imports` rule in `packages/config-eslint/flat/core.js` fires wherever it is imported;
the documented allow-list (seed scripts, `packages/database/scripts/**`, integration/e2e test
fixtures, and `CoreDatabaseService.baseClient` in `@arcaai/domains`) silences it per-line with an
explicit `// eslint-disable-next-line no-restricted-imports` naming the rationale.

### Schema conventions

Schema lives in `src/prisma/db_main/` as one `.prisma` file per domain plus `schema.prisma`
(datasource + generator). Key conventions, verified in the schema:

- Generator: `prisma-client` provider, output `src/generated/core-prisma-client`; datasource uses
  schemas `["public", "core"]` with the `vector` extension (pgvector).
- Every model declares `@@schema("core")` and follows the standard field order: meta (`metaData`,
  `version`, `id @default(uuid(7))`), `tenantId` (for tenant-scoped models, NOT NULL), business
  fields, relations, resource status (`resourceStatus` + `resourceStatusUpdatedAt/By`), audit
  fields (`createdBy`, `updatedBy`, `createdAt`, `updatedAt`), optional `tags String[]`.
- Soft delete via `resourceStatus: DELETED`; never hard-delete rows.
- WORM tables (`HarnessAuditEvent`, `*PolicyChange`) are append-only with UPDATE/DELETE revoked in
  migrations.

### Migrations and seeding

Edit the relevant `.prisma` file, author a migration against a throwaway shadow database (the local
dev DB is `db push`-managed and has no `_prisma_migrations` ledger, so `db:migrate` cannot run
against it directly — full recipe in `.claude/rules/02-database-prisma.md`), then `pnpm db:generate`.
Never edit a committed migration; roll forward instead. `prisma.config.ts` prefers `DIRECT_URL` over
`DATABASE_URL` for migrations (`src/migration-url.ts`) so Prisma Migrate's advisory locks bypass any
pooler in front of Postgres.

Seeds live in `src/prisma/db_main/seed/` and run in file order (`00-constants.ts` defines the
reserved UUIDs including `SYSTEM_TENANT_ID`, through `94-service-account.ts`). Seeds use the
unscoped client because no CLS context exists at seed time.

For containerized deployments, `Dockerfile` + `migrate.sh` build a job image. `migrate.sh` ALWAYS
runs `prisma migrate deploy` (never `db push`) regardless of environment, then gates seeding on
`RUN_SEED`: `none` (default, no seeding, no connection opened), `safe` (platform configuration
only — no demo credentials, no synthetic PHI, no audit-trail writes), or `all` (everything;
refused unless `NODE_ENV` is explicitly `development` or `test`, re-validated by the seed entry
point itself so the gate holds even when invoked another way).

## Gotchas

- **`packages/database/k3s-job-db-migration.yaml` is orphaned, not the deployed manifest.** It
  targets namespace `apps` and an unrelated image (`gitlab-server:5000/vuvu/4bits:migration-...`)
  from a different project — it predates the current deployment and is not what
  `migrate.sh` is invoked by. The real migration Job lives in the separate `hope-v2-deployment`
  repo (`deployment/k8s/base/db-migrate.yaml`, referenced by comments inside `migrate.sh` itself).
  Do not treat this file as documentation of the current deploy path.
- `migrate.sh` used to branch on `NODE_ENV` to choose `db push` vs `migrate deploy`; because the
  k8s Job carried no `NODE_ENV`, every environment (including production) silently took the
  `db push` branch, which can drop columns with no migration record. The script now ALWAYS runs
  `migrate deploy` — do not reintroduce an environment branch here.
- Seeding used to run unconditionally in `migrate.sh`, upserting fabricated rows into the audit
  trail and synthetic PHI into consultations on every deploy. It is now `RUN_SEED`-gated and off
  by default — do not call the seed entry point directly from a deploy path without checking that
  gate.
- `-n <name>` on `db:migrate:create` must be passed to the package-level script
  (`pnpm --filter @arcaai/database db:migrate:create -n <name>`) — the root `pnpm db:migrate:create`
  alias does not forward it, and Prisma will hang on an interactive name prompt instead.
- Several Prisma 6 CLI flags no longer exist in Prisma 7: `migrate dev --skip-generate`,
  `db push --skip-generate`, `migrate diff --shadow-database-url`,
  `migrate diff --to-schema-datamodel`/`--from-schema-datamodel`. See
  `.claude/rules/02-database-prisma.md` for the replacements.
- Never stage a not-yet-applied migration under `migrations/` — Prisma applies every subdirectory
  containing a `migration.sql` regardless of name; a `PENDING_`/`DRAFT_` prefix protects nothing.

## Related

- [`02-database-prisma.md`](../../.claude/rules/02-database-prisma.md) — full migration workflow, model field template, generated-code discipline
- [`00-project-context.md`](../../.claude/rules/00-project-context.md) — the two reserved tenants, configuration tiers
- [`09-infrastructure-devops.md`](../../.claude/rules/09-infrastructure-devops.md) — cluster deploy path (separate `hope-v2-deployment` repo), storage/pooling posture
- [`03-domain-layer.md`](../../.claude/rules/03-domain-layer.md) — the entity/factory/mapper/repository layer built on this client
- [PgBouncer validation rig README](tests/pgbouncer-validation/README.md)
