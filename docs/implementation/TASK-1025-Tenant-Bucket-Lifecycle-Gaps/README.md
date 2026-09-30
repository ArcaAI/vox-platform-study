# TASK-1025: Tenant bucket lifecycle gaps — silent provision failures, no cleanup on tenant delete, quota not enforced

**Status:** Review — merged into `dev-2.2` (`d16ff8ec5`), post-merge gates run; not pushed; cluster needs a `minio-bootstrap` re-run for `s3:DeleteBucket`
**Type:** bugfix
**Branch:** `task-1025-tenant-bucket-lifecycle` (worktree `hope-v2-task-1025`), based on `dev-2.2` @ `14b7eb776`; target `dev-2.2`
**Related:** TASK-1024 (found while scoping), TASK-847 (`hope-platform` identity + tenant-bucket policy)

## Requirement Analysis

Owner request (2026-09-30): fix three gaps in how the two per-tenant buckets (`hope-attachments-<tenantKey>`, `hope-recordings-<tenantKey>`) are managed.

| # | Gap | Evidence |
|---|---|---|
| G1 | **Provisioning failures are hidden.** Physical create and bucket-policy errors are caught and logged as warnings, so a `TenantBucket` row can point at a bucket that does not exist, and later reads fail with `NoSuchBucket`. The seed step `05b` also warns and skips on any S3 error. Only the lazy `ensureProviderBucket` path repairs this. | `tenant.service.ts:156` (try/catch around `provisionSystemBuckets`), `tenant-bucket.service.ts:314-378` (~330-360 swallowed), `05b-tenant-bucket-provision.ts:72-74`, `minio-bootstrap.yaml` 326-331 (deployment repo) |
| G2 | **Deleting a tenant leaves its buckets and objects behind**, including PHI audio. `TenantService.deleteById` only soft-deletes the tenant row and broadcasts an event. | `tenant.service.ts:~712-722`; bucket delete path `tenant-bucket.service.ts:705-765` refuses SYSTEM buckets (403) |
| G3 | **The plan storage quota is not enforced.** `applyPlanStorageQuota` copies `storageQuotaBytes` onto the recordings bucket row as metadata only; MinIO has no quota on tenant buckets (the bootstrap quotas cover platform buckets only). | `tenant-bucket.service.ts:392-410`, `tenant.service.ts:~683` |

## Owner Decisions (final, 2026-09-30)

| # | Decision |
|---|---|
| OD-1 (G1) | **Fail and roll back.** If either system bucket cannot be created, tenant creation fails with a clear error and nothing is left behind (no tenant row, no `TenantBucket` rows, buckets created by the attempt removed — best effort, logged). The admin repair route `POST admin/tenant-buckets/provision/:tenantId` keeps working. The seed step may keep going but must report failures. |
| OD-2 (G2) | **Retain, then purge on schedule.** Tenant soft-delete cuts bucket access immediately and keeps the objects; a platform setting (default **30 days**, bounded) sets the retention; a scheduled job purges objects + buckets afterwards and marks the rows DELETED. Restore inside the window restores access; after the purge, restore must not pretend the data exists. Disable/suspend: keep what access control already does. |
| OD-3 (G3) | **App-side check across BOTH buckets.** Before each upload (and presigned PUT) into a tenant's system buckets, the tenant's usage across attachments + recordings is checked against the plan `storageQuotaBytes`; over → `QuotaExceededException` (409). No quota = unlimited. `applyPlanStorageQuota` aligned to both buckets. |

### OD-1 — the bucket policy stays best effort (decision recorded here, not silently changed)

`provisionSystemBuckets` also sets an S3 bucket policy (`aws:PrincipalTag/tenantId` condition). That step is **kept best effort**, deliberately:

- the in-cluster `hope-platform` MinIO identity is **not granted `s3:PutBucketPolicy`** on `hope-attachments-*` / `hope-recordings-*` (deployment repo `deployment/k8s/out-of-band/minio-bootstrap.yaml`, statement `TenantBucketsCreateAndUse` grants `CreateBucket`, `ListBucket`, `GetBucketLocation`, `ListBucketMultipartUploads` only), so the call is refused in every real environment;
- the `aws:PrincipalTag` condition has no effect in MinIO (recorded as finding F-19 of the archived storage review);
- tenant isolation is enforced by the gateway (tenant-scoped bucket rows, 404-over-403) and the `hope-platform` prefix policy.

Making it fatal would fail every tenant creation without protecting anything. A physical create failure and an existence-check failure (store unreachable, credential refused) ARE fatal.

### Seed 05b — chosen behaviour

The seed step still **does not throw** (a storage outage must not wedge a seed run or deploy), but it now tries every bucket independently, treats only a HeadBucket **404** as "missing" (any other HeadBucket error is a failure, not a CreateBucket attempt), returns `{ created, existing, failed[] }`, and prints each failed bucket by name on stderr with the repair route. It does not roll anything back (out of scope per OD-1).

## Current State Evaluation (verified 2026-09-30 against `14b7eb776`)

| Area | Verified state before this ticket |
|---|---|
| `TenantBucketService.provisionSystemBuckets` | Per bucket: `createBucket` error logged "may already exist, continuing"; policy error logged; the row was written regardless. |
| `TenantService.create` | try/catch around `provisionSystemBuckets`, warn only; tenant creation always succeeded. |
| `TenantService.purgeFailedProvisioning` (W2-8) | Swept reference-set + department clones and the tenant row; left `TenantBucket` rows behind (their globally unique `name` then blocked an identical retry). |
| Seed `05b` | One try/catch around the whole loop: the first S3 error skipped every remaining bucket with a single warning; any HeadBucket error triggered a CreateBucket. |
| `TenantService.deleteById` | Soft-deleted the tenant row only. Bucket rows stayed ENABLED; objects stayed reachable. |
| `TenantService.restore` | `findById` — a soft-DELETED tenant was invisible, so a deleted tenant could not be restored at all (404). |
| Data-plane access | `TenantBucketService` object routes look buckets up by id (`findById` returns every non-DELETED status) and never checked status; `BlobStorageService` (the chokepoint for the storage controller, transcription upload and tenant-bucket service) did no row check at all. `TenantBucketRepository.findByName` answers ENABLED rows only. |
| Quota | `applyPlanStorageQuota` stamped `PLAN_ENTITLEMENT_DEFAULTS[plan].storageQuotaBytes` onto the AUDIO (recordings) row only, and only when unset — a plan change never reached a stamped row. Nothing enforced it. `evaluateStorageSoftWarn` (media upload) is a soft warning over `SUM(Media.size)`. |
| Entitlements kill-switch | `entitlements.enabled`, default **ON** (`ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT = true`). |
| Scheduling precedent | `AuditRetentionService`: self-scheduling `SchedulerRegistry` + `CronJob`, cron from a `global-kv` setting, re-synced on `app-settings.cache-refreshed`. Tenant-less cron work runs per tenant in `clsService.run` with `createWorkerSession`. |
| `IEntitlementsService` | Cannot be injected into the storage path: `EntitlementsServiceModule` → `TenantServiceModule` / `TenantBucketServiceModule` → `IBlobStorageService` (provider cycle). |

## Implementation Plan

No schema change: every new state is expressed with the existing `resourceStatus` column.

**Bucket row lifecycle (G2):**

```
ENABLED ──tenant delete──▶ ARCHIVED (retained: access cut, objects kept)
ARCHIVED ──tenant restore──▶ ENABLED
ARCHIVED / DISABLED ──purge job starts──▶ SUSPENDED (purge in progress; never restorable)
SUSPENDED ──objects + bucket removed──▶ DELETED
```

1. G1 — `provisionSystemBuckets`: check existence → create (tolerate `BucketAlreadyOwnedByYou`) for every bucket BEFORE any row; policy best effort; on failure hard-delete rows written, remove buckets created, raise 503. `TenantService.create`: on failure hard-purge the tenant (`purgeFailedProvisioning`, now also sweeping `TenantBucket` rows) and re-raise. Seed 05b per-bucket reporting. → tests: `tenant-bucket.service.provision-rollback.task1025.test.ts`, `tenant.service.provision-failure.task1025.test.ts`, `seed/__tests__/tenant-bucket-provision.task1025.test.ts`.
2. G2 — `retainForTenantDeletion` / `releaseTenantDeletionRetention` on `TenantBucketService`; `deleteById` retains first (and releases if the soft delete fails); `restore` accepts a DELETED tenant; ARCHIVED/SUSPENDED refused (404) in `TenantBucketService` object routes and in `BlobStorageService` via `TenantBucketStorageGate`; provider factory finds a retained row's per-bucket override; settings + `TenantStoragePurgeService`. → tests: `tenant-bucket.service.tenant-deletion.task1025.test.ts`, `tenant.service.tenant-deletion.task1025.test.ts`, `blob-storage.service.tenant-bucket-gate.task1025.test.ts`, `blob-storage.provider.factory.retained-bucket.task1025.test.ts`, `tenant-storage-purge.service.task1025.test.ts`, `tenant-storage-lifecycle.descriptors.task1025.test.ts`.
3. G3 — quota in `TenantBucketStorageGate` (kill-switch, resolver, `wouldExceedLimit`, `QuotaExceededException`, quota-blocked event), Redis usage cache + setting; `applyPlanStorageQuota` both rows + re-derive; readers MAX not SUM. → tests: `blob-storage.service.tenant-quota.task1025.test.ts`, `tenant-bucket.service.plan-quota.task1025.test.ts`, `TenantBucketRepository.quota.task1025.test.ts` (domains), getUsageStats cases in `tenant.service.test.ts`.

Verification: each test file RED then GREEN (owner test policy: only the authored/modified files), one targeted `tsc --noEmit -p packages/applications`. The package-wide gates run once after merge.

## Implementation Summary

### G1 — fail and roll back (commit `0263e7088`)

- `packages/applications/src/services/tenant-bucket/tenant-bucket.service.ts` — `provisionSystemBuckets` creates all physical buckets first (`ensurePhysicalSystemBucket`: existence check, create, `BucketAlreadyOwnedByYou` = adopted), policy via `applyTenantIsolationPolicyBestEffort`, rows last; any failure → `rollbackSystemBucketProvisioning` (hard `delete` of rows written, `deleteBucket` of buckets THIS attempt created, all logged) → `ServiceUnavailableException` (503) naming the buckets and cause.
- `packages/applications/src/services/tenant/tenant.service.ts` — `create`: provisioning failure → `purgeFailedProvisioning(tenant.id, reason)` (its own failure logged; the ORIGINAL error is raised). `purgeFailedProvisioning` takes an optional `purgeReason` (default = the W2-8 text) and now `tx.tenantBucket.deleteMany({ where: { tenantId } })` before the tenant row.
- `packages/database/src/prisma/db_main/seed/05b-tenant-bucket-provision.ts` — per-bucket try/catch, 404-only "missing", returns `TenantBucketProvisionResult`, stderr summary; never throws.
- Tests updated for the reversed behaviour: `tenant.service.test.ts` (old "does not block tenant creation when bucket provisioning fails" → now expects rejection; purge tx double gains `tenantBucket`), `tenant-bucket.service.test.ts` (provision cases set `bucketExists → false`).

### G2 — retain, then purge on schedule (commit `490bf9d4e`)

- `tenant-bucket/tenant-bucket-lifecycle.constants.ts` (new) — status constants, setting keys/defaults/bounds, job name.
- `tenant-bucket.service.ts` + `ITenantBucketService.ts` — `retainForTenantDeletion(tenantId)` (ENABLED → ARCHIVED, `ResourceUpdated` per row, DISABLED rows untouched), `releaseTenantDeletionRetention(tenantId)` (ARCHIVED → ENABLED; returns `{ restored, purged }` counting SUSPENDED rows and DELETED system rows), `assertBucketAccessible` on `getBucketTree` / `listObjects` / `uploadObject` / `deleteObject` / `getPresignedUrl` (404, before any storage call).
- `baseServices/storage/tenant-bucket-storage.gate.ts` (new, provided + exported by `BlobStorageModule`, barrel-exported) — status-agnostic row lookup by name (`findAll({ filters: { name } })`), 404 for ARCHIVED/SUSPENDED; lookup failure = not gated (logged, bucket name only). `blob-storage.service.ts` calls it on `putObject`, `getObject`, `getObjectStream`, `deleteObject`, `listObjects`, `presignGet`, `presignPut` (optional 3rd ctor arg).
- `providers/blob-storage.provider.factory.ts` — `resolveConfig` falls back to a status-agnostic lookup when `findByName` (ENABLED-only) misses, so the purge resolves a retained bucket's per-bucket DEDICATED override instead of emptying the wrong store.
- `tenant/tenant.service.ts` — `deleteById`: `runForTenant(id, retainForTenantDeletion)` BEFORE `softDelete`; if the soft delete fails the retention is released; `ResourceDeleted` carries `storageRetainedBuckets`. `restore`: a `DataNotFoundException` from `findById` falls back to the explicit DELETED lookup → `tenantRepository.restore` + `releaseTenantDeletionRetention`; `ResourceUpdated` carries `restoredFromDeletion`, `storageRestoredBuckets`, `storagePurged`.
- `tenant-bucket/retention/tenant-storage-purge.service.ts` + `.module.ts` (new) — `TenantStoragePurgeService`, registered in `apps/api/src/app.module.ts`. SchedulerRegistry job **`tenant-storage-purge`**, cron from `storage.tenantDeletion.purgeCron` (default **`15 4 * * *`**, re-synced on settings refresh). Per run: refuse an out-of-bounds window (skip, never clamp) → Redis lock `tenant-storage-purge:lock` (SET NX EX 6 h; without Redis runs unlocked — every step is idempotent) → tenants `DELETED` with `resourceStatusUpdatedAt < now − retentionDays` → per tenant in `clsService.run` with `createWorkerSession({ kind: 'tenant-storage-purge' })` → each ARCHIVED/SUSPENDED/DISABLED row (never ENABLED): SUSPENDED (`ResourceUpdated`), list+delete every object through the provider factory (not `BlobStorageService`, which refuses these buckets), `deleteBucket` (gone = ok; refusal logged, `bucketRemoved: false`), `softDelete` row, `ResourceDeleted` `{ reason: 'tenant-deletion-retention-expired', tenantDeletedAt, retentionDays, objectsDeleted, bucketRemoved }`. A failure leaves the row SUSPENDED for the next run. Logs carry counts, bucket names and error CLASSES only — never object keys or provider messages.
- `common/worker-session.ts` — `WorkerSessionKind` gains `'tenant-storage-purge'`.
- `settings-registry/descriptors/tenant-storage-lifecycle.descriptors.ts` (new, registered in `registry.ts`).
- `apps/api/src/modules/tenant/tenant.controller.ts` — `POST admin/tenants/:id/restore` `@ApiOperation` summary/description updated (a deleted tenant is now restorable).
- Existing test mocks updated: `tenant.service.test.ts`, `tenant.service.lifecycle.test.ts` (bucket-service mock gains the two methods).

### G3 — app-side quota across both buckets (commit `013951b86`)

- `tenant-bucket-storage.gate.ts` — `assertCanWrite(bucket, bytes)` (G2 check + quota for SYSTEM-type rows), `recordWrite`, `recordDelete`. Quota = `resolveEntitlements(effectivePlan(..), planRow, override).limits.storageQuotaBytes` (the same three layers `EntitlementsService.resolveForTenant` merges), gated by `entitlements.enabled`, decided by `wouldExceedLimit`, blocked with `ENTITLEMENTS_QUOTA_BLOCKED_EVENT` + `QuotaExceededException` (409) `{ capability: 'storageQuotaBytes', limit, used, requested, tenantId }`. `null` limit = unlimited (never measured). Custom buckets are not covered. Presigned PUT checks with 1 byte (refused once AT quota).
- Usage choice (why a cache, not a list per upload): listing two buckets is O(objects) requests; a busy recording tenant would pay it on every chunk. Usage is measured by listing both system buckets once, cached in Redis at `tenant-storage-usage:<tenantId>` for `storage.tenantQuota.usageCacheSeconds` (default 300; 0 = measure every time), incremented atomically (Lua `INCRBY` only if cached) after each gateway upload, dropped on each gateway delete. A maintained DB counter was rejected: objects are also written outside the gateway (STT worker), so only a listing is authoritative; the TTL bounds how late those bytes are seen. Fails OPEN (logged) when usage/quota cannot be read, the `assertMeterQuota` posture — a storage hiccup must not block a clinical upload.
- `blob-storage.service.ts` — `putObject` → `assertCanWrite` / put / `recordWrite`; `presignPut` → `assertCanWrite(bucket, 1)`; `deleteObject` → `recordDelete`.
- `tenant-bucket.service.ts` — `applyPlanStorageQuota` stamps the plan ceiling on BOTH system rows and re-derives every call (stale stamp rewritten, unlimited plan clears); display only.
- Readers take MAX, not SUM (the shared ceiling is stamped twice): `TenantService.getUsageStats` (`aggregate _max`), `packages/domains/.../TenantBucketRepository.sumConfiguredQuotaBytes` (per-tenant `groupBy _max`, summed; `null` when none). `ConsumptionRollupResponse.storageQuotaBytes` `@ApiProperty` description updated.
- Also: prettier applied to the TASK-1025 files of the two earlier commits.

### Settings added (all `global-kv`, `maxScope: 'system'`, `globalOnly`, `editableBy: 'all'`, `open-to-default`, category Storage, no `consumedBy`)

| Key | Default | Bounds (write lane refuses outside) |
|---|---|---|
| `storage.tenantDeletion.retentionDays` | 30 | whole days 1–3650 (job also skips its run outside) |
| `storage.tenantDeletion.purgeCron` | `15 4 * * *` | — |
| `storage.tenantQuota.usageCacheSeconds` | 300 | whole seconds 0–86400 (out of bounds → default) |

### Route / schema changes

- **No new route. No schema change, no migration.**
- Behaviour change on an existing route: `POST admin/tenants/:id/restore` now restores a soft-DELETED tenant (previously 404). Its `@ApiOperation` text changed, and `ConsumptionRollupResponse.storageQuotaBytes`'s description changed → regenerate `openapi.json`, the portal and `vox-node gen:admin` (doc comments) after merge; the route manifest should not change.
- Upload / presigned-PUT paths through `BlobStorageService` can now answer 409 `QUOTA_EXCEEDED`; object paths on a retained/purging bucket answer 404.

### Disable / suspend (OD-2 note)

Unchanged by design: `suspend` / `archive` of a TENANT do not touch its bucket rows; a suspended tenant's access is governed by the existing auth / tenant-status checks. Only DELETE retains, and only ARCHIVED/SUSPENDED bucket rows are refused (an admin-DISABLED bucket keeps today's behaviour).

### Open risks / follow-ups

1. **Deployment repo (not changed here):** `hope-platform` lacks `s3:DeleteBucket` (and `s3:PutBucketPolicy`) on `hope-attachments-*` / `hope-recordings-*`. Consequences: G1 rollback cannot remove a bucket it created (it stays empty and is adopted on retry — harmless); the G2 purge deletes every object but cannot remove the empty bucket (row still marked DELETED, event `bucketRemoved: false`, the bucket shows as unregistered in the storage browser). Add `s3:DeleteBucket` to statement `TenantBucketsCreateAndUse` in `hope-v2-deployment/deployment/k8s/out-of-band/minio-bootstrap.yaml` (hand-applied out-of-band Job).
2. **Enforcement is live on merge:** `entitlements.enabled` defaults ON and STARTER = 5 GiB. A dev/cluster tenant already holding more than its plan across the two buckets will get 409 on new gateway uploads (recordings included) until its override/plan is raised.
3. **Writes outside the gateway** (the STT worker writing recordings directly) are neither blocked by the quota nor by the access cut; they are only counted at the next measurement. A deleted tenant cannot start new sessions through the gateway, but an in-flight session's worker could still write.
4. **Two usage figures:** enforcement lists the buckets; the soft warning and the console tile still use `SUM(Media.size)`.
5. **Restore after purge** restores the tenant with no system buckets. Re-provisioning is blocked by the purged rows still holding the unique bucket `name` (the provision now fails loudly with 503 rather than silently). Whether a post-purge restore should revive the rows with fresh empty buckets needs an owner decision.
6. Restore racing the purge: a row the job already moved to SUSPENDED stays with the job and is reported as purged; ENABLED rows are never purged.
7. Quota check cost with enforcement ON: one indexed row lookup + three entitlement reads per system-bucket upload, plus a listing per tenant per cache window (every upload when Redis is absent).
8. Not run by this lane (owner test policy — only authored/modified files): the settings-registry governance suites (`registry.ts` gained a descriptor file), `blob-storage.service.test.ts`, the provider-factory suites, `platform-metrics` and `entitlements-lifecycle` suites, the api unit/e2e suites. The worktree's `@arcaai/domains` resolves to the primary checkout's `dist`, so the domains change is proven only by the domains-package test.

### Evidence (RED → GREEN, per test file)

| Test file | RED | GREEN |
|---|---|---|
| `tenant-bucket/__tests__/tenant-bucket.service.provision-rollback.task1025.test.ts` | `Tests  7 failed \| 2 passed (9)` | `Tests  9 passed (9)` |
| `tenant/__tests__/tenant.service.provision-failure.task1025.test.ts` | `Tests  5 failed (5)` (promise resolved instead of rejecting) | `Tests  5 passed (5)` |
| `database/.../seed/__tests__/tenant-bucket-provision.task1025.test.ts` | `Tests  4 failed (4)` (`reading 'created'` of undefined) | `Tests  4 passed (4)` |
| `tenant-bucket/__tests__/tenant-bucket.service.test.ts` (modified, G1) | `Tests  2 failed \| 73 passed (75)` | `Tests  75 passed (75)` |
| `tenant/__tests__/tenant.service.test.ts` (modified, G1) | `Tests  9 failed \| 102 passed (111)` | `Tests  111 passed (111)` |
| `settings-registry/__tests__/tenant-storage-lifecycle.descriptors.task1025.test.ts` (G2) | `Cannot find module '../descriptors/tenant-storage-lifecycle.descriptors'` | `Tests  3 passed (3)` |
| `tenant-bucket/__tests__/tenant-bucket.service.tenant-deletion.task1025.test.ts` | `Tests  7 failed \| 1 passed (8)` | `Tests  8 passed (8)` |
| `baseServices/storage/__tests__/blob-storage.service.tenant-bucket-gate.task1025.test.ts` | `Cannot find module '../tenant-bucket-storage.gate'` | `Tests  6 passed (6)` |
| `baseServices/storage/providers/__tests__/blob-storage.provider.factory.retained-bucket.task1025.test.ts` | `Tests  1 failed \| 1 passed (2)` | `Tests  2 passed (2)` |
| `tenant/__tests__/tenant.service.tenant-deletion.task1025.test.ts` | `Tests  6 failed \| 2 passed (8)` | `Tests  8 passed (8)` |
| `tenant-bucket/retention/__tests__/tenant-storage-purge.service.task1025.test.ts` | `Cannot find module '../tenant-storage-purge.service'` | `Tests  16 passed (16)` |
| `tenant.service.lifecycle.test.ts` + `tenant.service.test.ts` (modified, G2) | `Tests  4 failed \| 117 passed (121)` | `Tests  121 passed (121)` |
| `baseServices/storage/__tests__/blob-storage.service.tenant-quota.task1025.test.ts` | `Tests  6 failed \| 6 passed (12)` | `Tests  12 passed` (18 with the gate suite) |
| descriptors test extended (G3) | `Tests  1 failed \| 3 passed (4)` | `Tests  4 passed (4)` |
| `tenant-bucket/__tests__/tenant-bucket.service.plan-quota.task1025.test.ts` | `Tests  3 failed \| 1 passed (4)` | `Tests  4 passed (4)` |
| `tenant-bucket.service.test.ts` (modified, G3) | `Tests  2 failed \| 77 passed (79)` | `Tests  79 passed (79)` (with plan-quota) |
| `tenant.service.test.ts` getUsageStats (modified, G3) | `Tests  3 failed \| 108 passed (111)` | `Tests  111 passed (111)` |
| `domains/.../TenantBucketRepository.quota.task1025.test.ts` | `Tests  3 failed` (`reading '_sum'` of undefined) | `Tests  3 passed (3)` |

Final re-run after formatting: applications 9 files `Tests  242 passed (242)`; domains `Tests  3 passed (3)`; database `Tests  4 passed (4)`. `npx tsc --noEmit -p packages/applications` → exit 0, no output.

## Post-merge verification (orchestrator, 2026-09-30)

Merged `task-1025-tenant-bucket-lifecycle` into `dev-2.2` as `d16ff8ec5` (clean). Then:
- `52c7119e9` regenerated OpenAPI, the portal specs and the vox-node admin SDK (restore-route and quota doc text). The route manifest did not change.
- `afee3fe67` updated `platform-consumption-aggregates.task414.test.ts`, which still asserted the old SUM aggregate.
- Deployment repo `0c62acb`: `s3:DeleteBucket` on `hope-attachments-*` / `hope-recordings-*` in `hope-platform-rw` (lane risk 1).

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains test` | 179 files / 2006 passed (after `afee3fe67`) |
| `pnpm --filter @arcaai/applications test` | 1065 files / 16052 passed, 4 skipped |
| `pnpm --filter @arcaai/database test` | 110 files / 2013 passed |
| `pnpm test:unit` (root workspace) | 28550 passed / 47 failed. **Pre-existing:** 46 are in `baseServices/logging/__tests__` (fail only in the full root run; pass in isolation and in the package run) and 1 is the env-sync bootstrap-size check. The same logging failures reproduce on the pre-change baseline `3e918afc8` (46 failed there). |
| lint domains / applications / api, `api` typecheck | exit 0 (`@arcaai/database` has no lint script) |
| `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check`, `env:sync:check` | exit 0 |
| `pnpm --filter @arcaai/api build` (turbo, 11 tasks) | exit 0 |

Not run: API e2e (needs the test stack) and a live check against a real MinIO.

**Owner decisions on the open items (2026-09-30):**
- **Quota at deploy:** enforce from deploy; no usage pre-check per tenant.
- **OD-4, restore after deletion:**
  - A deleted tenant's buckets and every object in them are destroyed 45 days after the deletion, so `storage.tenantDeletion.retentionDays` defaults to **45** (was 30).
  - Within those 45 days a platform admin can restore the tenant with all its data.
  - After 45 days there is no way to restore it.
  - Implemented in `TenantService.restoreDeletedTenant`. Before anything is written, it refuses with **409 `TENANT_RESTORE_WINDOW_EXPIRED`** when `now ≥ deletedAt + retentionDays`, even if the nightly purge has not run yet, or when any system bucket is already purging or purged. The purged count comes from `ITenantBucketService.countPurgedForTenantDeletion`.
  - The previous "restore without storage (`storagePurged: true`)" path is removed.
  - Tests:
    - `tenant.service.tenant-deletion.task1025.test.ts`: RED 3 failed / 7 passed → GREEN 10 passed.
    - `tenant-bucket.service.tenant-deletion.task1025.test.ts`: 10 passed, with 2 new cases.
    - Descriptor and purge tests updated to the 45-day default.
  - Re-gated:
    - `@arcaai/applications` test: 1065 files / 16056 passed.
    - applications and api lint: exit 0. api typecheck: exit 0.
    - `apps/api/src/modules/tenant`: 138 passed.
    - openapi, portal, `gen:admin` and env-sync checks: exit 0.
    - OpenAPI, portal specs and the vox-node SDK were regenerated (restore route: 409 plus description).

## Change History

| Date | Change |
|---|---|
| 2026-09-30 | Ticket opened from the TASK-1024 scoping (gaps 1–3). |
| 2026-09-30 | Owner decisions OD-1/2/3 recorded; G1 (`0263e7088`), G2 (`490bf9d4e`), G3 (`013951b86`) implemented on `task-1025-tenant-bucket-lifecycle`; status Review. |
| 2026-09-30 | Merged into `dev-2.2` (`d16ff8ec5`); artifacts regenerated (`52c7119e9`); TASK-414 aggregate test aligned (`afee3fe67`); deployment `s3:DeleteBucket` (`0c62acb`); post-merge gate evidence recorded. |
| 2026-09-30 | OD-4: 45-day retention default; a deleted tenant is restorable with all data only inside the window, 409 `TENANT_RESTORE_WINDOW_EXPIRED` after it or once any bucket is purged. Quota enforced from deploy (no pre-check). |
