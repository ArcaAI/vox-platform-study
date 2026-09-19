# TASK-967 — Platform buckets are manageable by a platform admin

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix |
| Branch | `dev-2.2` |
| Owner directive | 2026-09-13 — "platform admin MUST be able to manage any buckets including registering or creating new bucket" |
| Supersedes | the "no action at all" posture of `05be5cf19` / `fe9776845`, and the delete narrowing of `79bdd4a6d` (both 2026-09-13) |

## Requirement Analysis

A platform admin (unscoped SUPER_ADMIN, no working tenant) must be able to **browse, register,
create and delete** any bucket, including the nine platform buckets in
`packages/domains/src/utils/platformBuckets.ts`.

Two owner decisions taken 2026-09-13 fix the shape:

- **OD-1 — a registered platform bucket is owned by the SYSTEM tenant** (`00000000-…`), never by a
  customer tenant. This is the schema rule already in force (`02-database-prisma.md`: *"`NULL =
  global` is banned — platform-wide rows use the SYSTEM tenant"*), and SYSTEM already owns
  `hope-attachments-system` / `hope-recordings-system`, so it is an existing shape rather than a
  new tier.
- **OD-2 — a platform admin MAY delete a platform bucket.** The provider still wins: object lock on
  `hope-models` makes MinIO refuse, and `deleteBucket` already re-raises that verbatim instead of
  soft-deleting the row (`79bdd4a6d`). The console requires a typed-name confirmation.

## Current State Evaluation (verified live, 2026-09-13, against the running dev gateway)

| # | Gap | Evidence |
|---|---|---|
| G-1 | **Browse is blocked in the console only.** The gateway already serves a platform bucket to an unscoped platform admin: `GET /api/v1/storage/buckets/hope-models/files` → **200** with real objects (`mlflow`, `backups`, `hope-audio` → 200 `[]`). It works because `storage.controller.ts:186` carries `scope: 'super-admin'` and `tenant-owned-resource.interceptor.ts:119` returns before any ownership lookup when there is no CLS tenant. | `all-tenants-panel.tsx:140` gates `Browse` on `bucket.registered`; `:77` gates `browsingBucket` the same way, so even `?bucket=hope-models` is ignored. |
| G-2 | **Register is refused for every caller.** `assertNotPlatformBucket` fires in `registerBucket`, `adoptPhysicalBucket` and `deleteBucket`. | `POST admin/tenants/storage/buckets/register {"name":"hope-models","tenantId":"5000…001"}` → **400** *"'hope-models' is a platform bucket and cannot be registered to a tenant."* |
| G-3 | **Create leaves an orphan.** `POST /storage/buckets` as an unscoped platform admin creates the physical bucket, then `registerBucket` returns `null` for want of a tenant context — the bucket exists with no `TenantBucket` row, so every id- and name-addressed management route 404s on it. | `tenant-bucket.service.ts:484`. |
| G-4 | **Delete is unreachable while unscoped.** `DELETE admin/tenants/storage/buckets/:id` carries the default `@TenantOwnedResource` scope, so an unscoped platform admin gets 404 before the service runs; and `isSystemBucket` → 403 for SYSTEM-typed rows. | `tenant-bucket.controller.ts:133`, `tenant-bucket.service.ts:589`. |

### The conflict this ticket resolves

`79bdd4a6d` deliberately declined to widen `DELETE :id` to `scope: 'super-admin'`, pinned it with a
metadata test, and recorded the reason at the decorator: an unscoped delete destroys a physical
bucket without the "Acting on: «Tenant»" banner. That reasoning is sound **for a customer tenant's
bucket** and is preserved. It does not hold for a SYSTEM-tenant row, which has no customer to name.

The rule that replaces it is one line, and it is the same line that commit already drew
(*"routes that name their tenant EXPLICITLY are the platform-level exception"*):

> **An unscoped platform admin may act on SYSTEM-tenant rows only. A customer tenant's bucket still
> requires selecting that tenant.**

## Implementation Plan

TDD, layer order `domains → applications → api → admin-console`.

### 1. `packages/domains`
- `TenantBucketFactory.CreatePlatformBucket(name, description?, createdBy?)` — `tenantId =
  SYSTEM_TENANT_ID`, `bucketType = SYSTEM`, `purpose = CUSTOM`, `name` verbatim, slug sanitized.
  `SYSTEM` (not `CUSTOM`) is what makes the row self-describing; the delete guard no longer keys
  off it alone (see 2).
- Tests: name/slug/tenant/type stamping; `isPlatformBucket` unchanged.

### 2. `packages/applications` — `TenantBucketService`
- `adoptPhysicalBucket(name, tenantId, …)`: replace the flat `assertNotPlatformBucket` with —
  platform bucket **and** `tenantId === SYSTEM_TENANT_ID` → `CreatePlatformBucket`; platform bucket
  **and** a customer tenant → 400 naming SYSTEM as the remedy; non-platform → unchanged.
  `// AUTH-NOTE:` imperative `isSuperAdmin` gate (403) on the platform branch — there is no
  super-admin CASL subject, so the decorator cannot express it (`05-nestjs-api.md` §Imperative
  Privilege Checks, "super-admin-only action on a tenant-manageable resource").
- `registerBucket(name)`: when there is no tenant context **and** the caller is a super admin,
  register to SYSTEM instead of returning `null` — closes G-3. A non-super-admin with no tenant
  context keeps the existing `null` skip.
- `deleteBucket(id)`: order becomes platform-first —
  platform bucket → `// AUTH-NOTE:` `isSuperAdmin` else 403, then proceed;
  else `isSystemBucket` → 403 unchanged (a tenant's own system buckets stay undeletable).
  The provider-failure re-raise from `79bdd4a6d` is untouched.
- New shared `assertUnscopedAccessAllowed(bucket)`: an unscoped super admin passes only for
  `bucket.tenantId === SYSTEM_TENANT_ID`; a customer row 404s exactly as today.
- Tests: adopt-to-SYSTEM, adopt-to-customer 400, adopt as non-super-admin 403, register-with-no-
  tenant → SYSTEM row, delete platform bucket succeeds, delete tenant SYSTEM bucket still 403,
  unscoped access to a customer row still 404.

### 3. `apps/api`
- `StorageController.createBucket`: keep the reserved-name rejection for **creating** a platform
  name (the bucket already exists; adoption is the route for it), but `registerBucket` now attaches
  the row for a platform admin creating any other name.
- `TenantBucketController`: `scope: 'super-admin'` on the id-addressed routes the Buckets tab needs
  — `getBucketTree`, `getPresignedUrl`, `deleteBucket`, `uploadObject`, `deleteObject` (`listObjects`
  already has it). Policy stays in the service via `assertUnscopedAccessAllowed`, so the widened
  scope grants nothing beyond SYSTEM rows.
- Replace the decorator comment on `deleteBucket` with the new rule; update the metadata test that
  asserts the absent scope (`79bdd4a6d`) to assert the present one **and** the SYSTEM-only service
  guard, so the boundary is still pinned rather than merely removed.
- Regenerate all five artifacts: `api:build`, `api:route-manifest`, `api:openapi`, `api:portal`,
  `vox-node gen:admin`.

### 4. `apps/admin-console`
- `all-tenants-panel.tsx`: a Platform row gets **Browse** (unchanged gateway call) **and** a
  Register link carrying `?register=<name>`; drop `registered` from the `browsingBucket` predicate.
- `tenant-storage-screen.tsx` `RegisterBucketDialog`: when the prefilled name is a platform bucket,
  lock the tenant select to **System** with an inline note instead of the current "cannot be
  registered" copy.
- `BucketsTab`: `deleteBlockedReason` no longer fires for a SYSTEM-tenant platform row while
  unscoped; keep it for a customer row (the "switch tenant" remedy is still correct there).
  Typed-name confirmation on platform delete (OD-2).
- Update `all-tenants-panel.test.tsx:219` (currently asserts no Browse **and** no Register) and the
  `79bdd4a6d` delete tests.

## Verification Criteria

- `pnpm --filter @arcaai/domains test`, `--filter @arcaai/applications test`, `pnpm test:unit`,
  `pnpm --filter @arcaai/admin-console build lint test` green, output pasted.
- `pnpm api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check` green.
- Live proof on the running dev stack, as an unscoped `super_admin`: adopt `hope-models` → SYSTEM
  row; it appears on `/tenants/storage`; Browse lists its objects; `backups` deletes; `hope-models`
  delete surfaces MinIO's object-lock refusal verbatim with the row left intact.
- A boot smoke (`GET /health`) — widened decorators change route metadata the boot audit reads.

## Implementation Summary

### The rule, in one line

> An unscoped platform admin may WRITE only to SYSTEM-tenant rows. A customer tenant's bucket
> still requires selecting that tenant.

Stated once, in `TenantBucketService.assertUnscopedWriteAllowed`, and leaned on by every widened
decorator. It preserves exactly what `79bdd4a6d` was protecting — a customer's bucket is never
destroyed without the "Acting on: «Tenant»" banner — while making SYSTEM-owned rows reachable,
which they must be, because nobody can select SYSTEM as a working tenant.

### Files changed

| Layer | File | Change |
|---|---|---|
| domains | `entities/generated/core/TenantBucketEntity.ts` | `get isPlatformBucket()` beside `isSystemBucket` |
| domains | `factories/generated/core/TenantBucketFactory.ts` | `CreatePlatformBucket(name, …)` — SYSTEM tenant, SYSTEM type, verbatim name |
| applications | `tenant-bucket.service.ts` | `assertPlatformBucketAdmin` (403), `assertUnscopedWriteAllowed` (404), `createPlatformOwnedRow`, `assertDerivedNameNotPlatform`; adopt/register/delete rewritten; the three object writes gated |
| applications | `tenant-bucket.dto.mapper.ts`, `dto/tenant-bucket.response.ts` | `platform: boolean` on the wire |
| api | `tenant-bucket.controller.ts` | `scope: 'super-admin'` on all seven id-addressed handlers; the delete decorator note rewritten |
| api | `storage.controller.ts` | create-a-platform-name now points at the adopt route |
| console | `all-tenants-panel.tsx` | Platform rows get Browse **and** Register (`&platform=1`); `browsingBucket` keys on the name |
| console | `tenant-storage-screen.tsx` | adopt dialog locks the owner to System for a platform bucket; `deleteBlockedReason` takes `elevated` and exempts SYSTEM rows |

Regenerated together: `route-manifest.json`, `openapi.json`, both portal files, `vox-node`
`src/resources/admin`.

### Live evidence (running dev stack, unscoped `super_admin`, 2026-09-13)

| Act | Result |
|---|---|
| `POST …/buckets/register` `hope-models` → SYSTEM | **201** `tenantId=00000000-…`, `bucketType=SYSTEM`, `platform=true` |
| same, → customer tenant `5000…001` | **400** *"cannot be owned by a customer tenant. Register it to the System tenant (00000000-…) instead."* |
| `POST /storage/buckets` `task967-scratch` unscoped (G-3) | **201**, and the row appears in the tier-14 listing as `CUSTOM`, SYSTEM-owned — previously an orphan |
| `GET …/buckets/<hope-models>/objects` | **200**, real weights listed |
| `DELETE …/buckets/<task967-scratch>` unscoped | **200** — a platform-owned row deletes |
| `DELETE …/buckets/<hope-models>` unscoped | **400** *"Could not remove the physical bucket 'hope-models': … You must delete all versions… The bucket record was left in place"* — provider wins, row survives |
| `DELETE …/buckets/<customer CUSTOM row>` unscoped | **404** — the boundary holds |
| same, with `X-Tenant-Id` set | **200** — scoped delete still works |
| console `/storage` | nine Platform-badged rows, each with Browse + Register; `hope-models` browses into its folders |
| console `/tenants/storage?register=mlflow&platform=1` | owner locked to **System**, helper text shown, Register succeeds; the row's Delete is **enabled** with no reason text |

### One regression found and fixed during verification

Computing `platform` in the DTO mapper with `import { isPlatformBucket } from '@arcaai/domains'`
turned a **type-only** import into a **value** import. The mapper had been a leaf module — the
type import was elided at runtime — so this dragged the entire domains barrel (Prisma included)
into every module importing the mapper, and
`services/__tests__/audit-correlation.test.ts > TenantService.updateTenantConfigs` began timing
out at 30 s on `await import('../tenant/tenant.service')`.

Confirmed by reverting to HEAD (test passed) and re-applying the mapper alone (test failed), so
this was measured, not guessed. Fixed by moving the predicate onto `TenantBucketEntity` as a
derived getter — where `isPlatformBucket` is already local, and where "is this a platform bucket"
belongs anyway, exactly like `isSystemBucket` beside it. The mapper's entity import is now
`import type`, with a comment saying why it must stay that way.

### Gates

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains test` | 1976 passed, 2 skipped, 9 todo (170 files) |
| `pnpm --filter @arcaai/applications test` | 13781 passed, 10 skipped; 2 failures out of scope (below) |
| `pnpm --filter @arcaai/admin-console test` | 3052 passed (332 files) |
| `pnpm --filter @arcaai/admin-console build lint typecheck` | exit 0, `--max-warnings 0` |
| `pnpm gen:entity:check` / `gen:factory:check` / `gen:model:check` | no drift; schema coverage OK |
| `pnpm api:openapi:check` / `api:portal:check` / `vox-node gen:admin:check` | no drift |
| boot smoke `GET /api/v1/health` | healthy — the widened decorators pass the deny-by-default boot audit |

Out of scope, both unrelated to buckets and neither caused here:
- `agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` — needs the
  isolated test database, which is unavailable on this host (ports 5433/6380 are held by another
  project's containers). Excluded from the root workspace config entirely.
- `consultation/live-documentation/__tests__/live-documentation.realtime-budgets.task940.test.ts` —
  timing-sensitive under full-suite parallelism; **passes in isolation** (8/8).

## Change History

| Date | Change |
|---|---|
| 2026-09-13 | Ticket opened from the owner directive; OD-1 (SYSTEM owns platform rows) and OD-2 (delete allowed) recorded; plan drafted. |
| 2026-09-13 | Implemented across all four layers and verified live. One regression found and fixed during verification (DTO-mapper barrel import — see Implementation Summary). Status → Review. |
