# TASK-305 — Multi-Tenancy Hardening

| Field | Value |
| --- | --- |
| Ticket | TASK-305 |
| Created | 2026-05-26 |
| Updated | 2026-05-27 |
| Status | In Progress (Phase B complete) |
| Branch | `task-305/w2-phase-b` |

## Phase B — Tenant-scope Prisma extension + `getPrismaClient` rename + lint guard

### Goal

Make tenant isolation a structural property of every Prisma call site, not a
runtime convention each service has to remember. Layer a second `$extends`
extension on top of the existing soft-delete extension; route legitimate
"platform-admin / unscoped" callers through a renamed, lint-guarded factory.

### What shipped (B.1 → B.8)

#### B.1 — `packages/database/src/extensions/tenant-scope.ts`

- **Allow-list** of 27 tenant-scoped models (derived from a `grep "tenantId String" packages/database/src/prisma/db_main/*.prisma`; the audit doc listed 30 but four `User*` models and `DnaRegenerationSettings` do not yet carry a `tenantId` column — Phase A will add them).
- **Hooks** for `findFirst / findFirstOrThrow / findUnique / findUniqueOrThrow / findMany / count / aggregate / groupBy / create / createMany / upsert / update / updateMany / delete / deleteMany`.
- **`TenantContextProvider`** interface + singleton mutator (`setTenantContextProvider`) so the extension stays framework-agnostic; CLI / seed scripts that import `@arcaai/database` before any provider is wired behave as pass-through (the safe default).
- **Mismatch detection** — passing a different `tenantId` in `where` or `data` than the context provides throws synchronously, so a "wrong scope" bug is loud at the call site instead of leaking data.

#### B.2 — `packages/database/src/client.ts`

```
prisma  →  $extends(softDelete)  →  $extends(tenantScope)  →  Prisma engine
```

`tenantScope`'s handler runs first (Prisma applies extensions outermost-in),
merges `tenantId` into `args.where`, then hands off to the soft-delete handler
which adds `resourceStatus: { not: 'DELETED' }` on the same `where`. One full
filter pass, one mental model.

#### B.2 — Rename `getPrismaClient` → `getPlatformAdminPrismaClient_Unscoped`

The long, uncomfortable name is intentional. `getExtendedPrismaClient()`
remains the public default export — that is the path every NestJS service /
repository should use.

#### B.3 — `packages/database/src/index.ts`

Re-exports `applyTenantScopeExtension`, `setTenantContextProvider`,
`TENANT_SCOPED_MODELS`, `isTenantScopedModel`, `resolveTenantContext`, and the
`TenantContextProvider` type.

#### B.4 — Migrated call sites

| File | Bucket | Reason |
| --- | --- | --- |
| `packages/database/src/prisma/db_main/seed/index.ts` | seed | Seed populates rows across tenants; runs before CLS exists. |
| `packages/database/scripts/backfill-globalsetting-encryption.ts` | back-fill | Admin script encrypts existing rows across all tenants. |
| `packages/database/src/integration/soft-delete.integration.test.ts` | test fixture | Needs unfiltered DB state to assert soft-delete behaviour. |
| `packages/database/src/integration/database-e2e.integration.test.ts` | test fixture | Same. |
| `packages/database/src/__tests__/client-lifecycle.test.ts` | unit test | Pins the renamed factory's singleton contract. |
| `packages/domains/src/integration/repository-soft-delete.integration.test.ts` | test fixture | Same. |
| `packages/domains/src/common/databaseServices/core/core.database.service.ts` | CoreDatabaseService | `baseClient` is the documented platform-admin bypass surface; consumers default to `.client` (extended). |
| `packages/domains/src/common/databaseServices/core/core.database.types.ts` | types re-export | `export * as CoreDataModel from '@arcaai/database'` is dead today; flagged-and-allow-listed pending removal in a future ticket. |
| `tests/helpers/db.helper.ts` | e2e helper | Used by Playwright fixtures; no CLS context pre-request. |

#### B.5 — ESLint guard (`packages/config-eslint/base.js`)

```
'no-restricted-imports' on '@arcaai/database' / { importNames: ['getPlatformAdminPrismaClient_Unscoped'] }
```

Allow-listed via `// eslint-disable-next-line no-restricted-imports -- TASK-305 B.4 …`
comments in each of the call sites above. The rule fires on direct imports
from `@arcaai/database` and on relative imports from `**/database/src/client*`.

#### B.6 — Unit tests

- `packages/database/src/extensions/__tests__/tenant-scope.test.ts` — 44 tests
  covering allow-list integrity, every read/write hook, mismatch detection,
  pass-through cases, and the singleton mutator.
- `packages/database/src/extensions/__tests__/composition.test.ts` — 4 tests
  verifying the soft-delete + tenant-scope composition order and `where`
  clause merging.

Technique: spy on `prisma.$extends`, extract the registered `query.$allModels`
handler bag, and invoke handlers directly with synthetic args. No live DB.

#### B.7 — `apps/api/src/database/tenant-context.provider.ts`

`ClsTenantContextProvider` reads `ClsService.get('tenantId') ?? user.tenantId`
and `user.roles.includes(SUPER_ADMIN_ROLE)`. Registers itself via
`setTenantContextProvider(this)` from `onApplicationBootstrap`; clears the
singleton on `onApplicationShutdown`. Wired in `AppModule.imports`.

#### B.8 — Verification

| Command | Result |
| --- | --- |
| `pnpm --filter @arcaai/database build` | ✅ |
| `pnpm exec vitest run packages/database` | ✅ 573 tests, 12 files |
| `pnpm --filter @arcaai/applications typecheck` | ✅ |
| `pnpm --filter api build` | ✅ |
| `pnpm --filter api test` | ✅ 1163 tests, 60 files |
| `rg 'getPrismaClient\(' --type ts` | ✅ only the local test-helper wrapper remains |
| `pnpm --filter @arcaai/domains lint` | ✅ no new `no-restricted-imports` errors (pre-existing prettier warnings unchanged) |

### Anti-patterns avoided

- `.prisma` schemas, `BaseTenantEntity`, factories untouched (Phase A territory).
- No tenant-scope code added to NestJS services — the extension does it transparently.
- Soft-delete extension preserved; tenant-scope composes on top.
- Default export of `@arcaai/database` is still `getExtendedPrismaClient`.

### Out of scope (Phases C / D follow-on)

- `SET LOCAL app.tenant_id` and matching Postgres RLS policies (Phase C).
- Cross-aggregate tenant equality guards (parent.tenantId vs child) — Phase D.
- BullMQ / event-listener `cls.run()` wrappers (Phase D).
