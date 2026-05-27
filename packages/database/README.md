# @arcaai/database

Database package for the HOPE platform, containing Prisma schema definitions, database client configuration, migration management, and seeding scripts.

## Overview

The `@arcaai/database` package provides the data access layer for the HOPE platform using Prisma 7 with the PostgreSQL adapter. It includes a singleton Prisma client with a soft-delete extension that automatically filters deleted records, schema definitions following standardized model conventions, and database seeding utilities.

## Usage

```typescript
import { getExtendedPrismaClient } from '@arcaai/database';

const prisma = getExtendedPrismaClient();
const users = await prisma.user.findMany();
```

## Structure

- `src/client.ts` - Prisma client singleton with soft-delete extension
- `src/prisma/db_main/` - Prisma schema files and seed scripts
- `src/generated/` - Auto-generated Prisma client

## Development

### Setup

Create a `.env` file with your database connection string:

```
DATABASE_URL="postgresql://username:password@localhost:5432/hope"
```

#### Pool sizing (Prisma 7 — TASK-302 Stream C Phase 0)

In Prisma 7, the driver adapter (`@prisma/adapter-pg`) owns pool sizing —
the legacy `connection_limit` URL parameter is ignored. The HOPE client
in `src/client.ts` reads two env vars:

| Env var          | Default | Purpose                                          |
|------------------|---------|--------------------------------------------------|
| `PRISMA_PG_MAX`  | `5`     | `max` connections per pool (per pod).            |
| `DIRECT_URL`     | unset   | Un-pooled URL consumed by `prisma.config.ts` for migrations. Required after the PgBouncer cutover (TASK-302 Stream C Phase 2A/2B); optional today. |

The client also pins `connectionTimeoutMillis = 5_000` and
`idleTimeoutMillis = 300_000` so a saturated pool fails fast and idle
backends survive Patroni / PgBouncer keep-alives.

**Budget rule** for `PRISMA_PG_MAX`:

```
pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections
```

See [`docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md`](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md)
for the full rationale, validation rig, and rollout plan.

### Commands

- `pnpm build` - Build the package
- `pnpm dev` - Build in watch mode
- `pnpm lint` - Lint the code
- `pnpm seed` - Run the database seeding script

### Schema Management

```bash
# Generate Prisma client after schema changes
npx prisma generate

# Create and apply a new migration
npx prisma migrate dev --name describe_your_changes

# Deploy migrations to production
npx prisma migrate deploy
```

## Key Features

- **Prisma 7** with `@prisma/adapter-pg` for PostgreSQL
- **Soft-Delete Extension** - Automatically filters `resourceStatus: DELETED` records
- **Tenant-Scope Extension** - Injects `tenantId` from `nestjs-cls` on every read and asserts equality on every write (see "Tenant scoping & RLS posture" below)
- **Singleton Pattern** - `getExtendedPrismaClient()` (composed default) + `getPlatformAdminPrismaClient_Unscoped()` (lint-gated platform-admin escape hatch)
- **Standardized Models** - All models include UUIDv7 IDs, audit fields, multi-tenancy, and resource status

## Tenant scoping & RLS posture (TASK-305)

The HOPE platform enforces tenant isolation in **three composed layers**.
Each layer is a complete fallback for the layer above it; together they
form the defence-in-depth posture mandated by HIPAA §164.312(a)(1),
GDPR Art.32 and SOC2 CC6.1.

### Layer 1 — Schema substrate (Prisma + Postgres)

Migration `20*_task_305_phase_a_*.sql` lands:

- `tenantId` is **NOT NULL** on every tenant-scoped model (27 in
  total) — the `'50000000-…'` sentinel default is removed everywhere.
- Scoped uniques: `Webhook(tenantId, name)` replaces the old global
  `Webhook.name @unique`; `Tag(tenantId, resourceTypeName, resourceId, tagKey)`
  is now constrained instead of an unbounded growth surface.
- 14 composite `[tenantId, X]` indexes lead query-hot paths
  (`Consultation`, `ContextItem`, `NamedEntity`, `SummaryMeta`,
  `AudioRecording`, etc.) so future RLS policies don't trigger
  seq-scan regressions.
- The reserved `system` Tenant row (UUID
  `00000000-0000-0000-0000-000000000000`) seeded by
  `prisma/db_main/seed/05-system-tenant.ts` absorbs former nullable
  rows where no real tenant exists (login audit, platform events).

Foreign keys back to `Tenant` were **NOT** added — the bloat across
every Prisma model was rejected; the tenant-scope extension + RLS
together cover the same isolation invariant without per-model
relation fields.

### Layer 2 — Prisma `$extends` (application-runtime)

`src/extensions/tenant-scope.ts` ships
`applyTenantScopeExtension(prisma, options)`. The composed default
client is built by `createExtendedPrismaClient()` as
`prisma → softDelete → tenantScope → engine`. Highlights:

- 27-model allow-list (`TENANT_SCOPED_MODELS`, mirrors the schema).
- All 16 Prisma ops hooked: `findFirst`, `findFirstOrThrow`,
  `findUnique`, `findUniqueOrThrow`, `findMany`, `count`, `aggregate`,
  `groupBy`, `create`, `createMany`, `upsert`, `update`, `updateMany`,
  `delete`, `deleteMany`.
- **Read ops**: merge `where: { tenantId: ctxTenantId }` into the
  caller's args (or throw if the caller passed an explicit different
  `tenantId`).
- **Write ops**: enforce `data.tenantId === ctxTenantId`; auto-inject
  when missing; throw on caller-supplied mismatch (bidirectional
  detection — read and write).
- **SUPER_ADMIN bypass**: when `options.isSuperAdmin()` is true AND no
  CLS context exists, the extension passes through unchanged (seed
  scripts, startup hooks, etc.). When CLS *does* set a tenant id and
  the caller is SUPER_ADMIN, the extension still applies the merge —
  the bypass is only the "no context = system" path.

The NestJS wiring lives in
`apps/api/src/database/tenant-context.provider.ts`
(`ClsTenantContextProvider`) — a tiny adapter that reads `tenantId` /
`user.roles` from `nestjs-cls` and registers itself via
`setTenantContextProvider(this)` on application bootstrap.

### Layer 3 — Service / domain guards (cross-aggregate)

The extension cannot reach cross-aggregate equality (parent tenant vs
child tenant) or User-tenant membership (does this user have an
`ENABLED` `UserRoleAssignment` in the target tenant?). Those checks
live in `packages/applications/src/common/tenant-guards.ts`:

- `assertEqualTenants(parent, child)` — used by
  `DepartmentService.create/update`, `ContextService` parent/array
  loaders, `SummaryService.regenerate`, etc.
- `assertUserBelongsToTenant(userRoleAssignmentRepo, userId, tenantId)`
  — used by `Consultation.createConsultation/createRevisit`,
  `NotificationService.create`, `ApiKeyService.issue`,
  `DnaWritingStyleService.start`.
- `assertParentInScope(repo, parentId, callerTenantId)` — sugar for
  the common "load parent, assert same tenant" idiom.

`BaseTenantEntity.validate()` is the floor: throws if `tenantId` is
empty so a buggy factory path surfaces as a runtime failure, not a
silent write to the sentinel tenant.

### Using the unscoped client (`getPlatformAdminPrismaClient_Unscoped`)

The default export — `getExtendedPrismaClient()` — is what every
service and repository should use. The unscoped client
(`getPlatformAdminPrismaClient_Unscoped`) **bypasses both** soft-delete
and tenant-scope and is reserved for platform-admin flows, seed
scripts and the tenant CRUD service itself.

A custom ESLint rule in `packages/config-eslint/base.js` enforces this
contract: importing the symbol from anywhere outside the allow-list
fails CI. As of TASK-305 the allow-list contains 8 call-sites
(`rg getPlatformAdminPrismaClient_Unscoped` to enumerate at any time):

| # | File | Reason |
|---|------|--------|
| 1 | `packages/database/src/client.ts` | Definition site. |
| 2 | `packages/database/src/index.ts` | Re-export with `⚠️` JSDoc. |
| 3 | `packages/database/src/prisma/db_main/seed/index.ts` | Seed runner — no CLS context exists at seed time. |
| 4 | `packages/database/scripts/backfill-globalsetting-encryption.ts` | One-shot back-fill (TASK-302 Phase 4). |
| 5 | `packages/database/src/integration/soft-delete.integration.test.ts` | Integration test fixture. |
| 6 | `packages/database/src/integration/database-e2e.integration.test.ts` | Integration test fixture. |
| 7 | `packages/domains/src/integration/repository-soft-delete.integration.test.ts` | Integration test fixture. |
| 8 | `packages/domains/src/common/databaseServices/core/core.database.service.ts` | `CoreDatabaseService.baseClient` (transitional — tracked for removal). |

Anywhere else, the import is a build error. To use the symbol
intentionally inside an allow-listed path, add a line-level
`// eslint-disable-next-line no-restricted-imports` comment that
references TASK-305 §B.4 and explains why.

### Row-Level Security (RLS) — rollout status

**Not yet deployed.** Plan §3.3 Phase C is drafted (see
`docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md`) but
deferred pending TASK-302 (PgBouncer / Vault dynamic credentials,
`hope_tenant_user NOSUPERUSER NOBYPASSRLS` role split).

The application-layer guards (layers 2 and 3 above) provide the same
isolation invariant today. RLS adds a defence-in-depth DB-layer policy
that backstops any future code path that escapes the extension —
ad-hoc `psql` sessions, future BI dashboards, raw `$queryRawUnsafe`
calls, etc.

When RLS lands, every `$transaction(callback)` will open with:

```sql
SELECT set_config('app.tenant_id', $1, true);
```

(The `true` arg makes the GUC `LOCAL` — transaction-scoped — so it
won't leak across PgBouncer pool connections.) The 7 PHI tables in
scope are: `Consultation`, `ContextItem`, `AudioRecording`,
`SummaryMeta`, `NamedEntity`, `ContextItemVersion`, `AuditLog`. The
remaining 20 tenant-scoped models are handed off to TASK-302 Phase 3.

### Sample CLS payload shape

The provider expects (and the extension consumes) this object —
mirroring the `IActiveUserContext` interface in
`packages/applications/src/interfaces/IActiveUserContext.ts`:

```ts
{
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  user: {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    roles: ['DOCTOR'],          // 'SUPER_ADMIN' flips the bypass bit
    permissions: [],
  },
}
```

Tests that need this shape should import
`createCrossTenantFixture()` from `tests/cross-tenant/fixtures.ts`
(TASK-305 Phase E.1) rather than re-rolling it locally.

## License

MIT
