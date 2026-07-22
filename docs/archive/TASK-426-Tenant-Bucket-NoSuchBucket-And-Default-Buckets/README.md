# TASK-426 — Tenant Storage: `NoSuchBucket` 500 on Object Listing + Two Default Buckets (attachments, recordings)

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix + refactor (default-bucket policy change) |
| **Severity** | High — admin storage screens unusable for seeded tenants (500 on every object listing) |
| **Reported** | 2026-07-05 |
| **Affected surface** | `packages/applications` (TenantBucketService), `packages/domains` (TenantBucketFactory), `packages/database` (seed 05a), `apps/api` (streaming controller, e2e specs) |

## Requirement Analysis

1. **Bug**: Admin console → tenant storage → "Couldn't list the objects / Internal server error".
   Gateway log: `GET /api/v1/admin/tenants/storage/buckets/019f27a0-…3d59/objects` → 500
   `NoSuchBucket: The specified bucket does not exist`, thrown from
   `S3BlobProvider.listObjects` ← `TenantBucketService.listObjects`.
2. **Default-bucket policy**: every tenant must have exactly **two** default system buckets:
   - `attachments` — files uploaded by users while working (consultation documents, lab
     results, any files). Purpose `ATTACHMENTS`.
   - `recordings` — audio recordings captured during live transcription, both raw
     (pre-normalization) and processed (denoised, silence-removed). Purpose `AUDIO`
     (kept so existing purpose-based bucket resolution is unchanged).
   This replaces the previous three defaults `{audio, attachments, misc}`.
3. Both the **DB seed** and the **global-admin "create tenant" flow** must produce these
   two buckets.

## Root Cause (systematic-debugging Phases 1–3)

**Evidence chain:**

1. The failing bucket id `019f27a0-bf58-73bf-9c69-6b858df73d59` is the DB row
   `hope-attachments-global` (slug `attachments`, tenant `__GLOBAL__`).
2. The seed `packages/database/src/prisma/db_main/seed/05a-tenant-bucket.ts` creates
   **DB rows only** — its header explicitly defers physical bucket creation to "the
   storage flow".
3. The runtime flow that creates physical buckets is
   `TenantBucketService.provisionSystemBuckets` — called only from
   `TenantService.create` (new tenants) and the admin provision endpoint. It also
   short-circuits (`toCreate.length === 0 → return []`) when the DB rows already exist,
   so it never repairs a seeded tenant.
4. Data-plane methods (`listObjects`, `getBucketTree`, `uploadObject`, `deleteObject`)
   called the S3 provider directly with no existence check.

**Root cause:** seeded tenants have TenantBucket DB rows with no corresponding physical
MinIO/S3 bucket, and no code path ever materializes the physical bucket for them, so the
first data-plane call fails with `NoSuchBucket`.

(Confirmed in dev: MinIO bucket listing showed no `hope-attachments-global` /
`hope-recordings-global` before the fix, while both DB rows existed.)

## Implementation Plan

1. **Domains** — `TenantBucketFactory`: default system buckets = `attachments` +
   `recordings` (drop `audio`, `misc`); `recordings` keeps purpose `AUDIO`. TDD via
   `packages/domains/src/__tests__/tenant-bucket.test.ts`.
2. **Applications** — `TenantBucketService`: add private `ensureProviderBucket(name)`
   (bucketExists → createBucket, tolerant of lost create races and storage-down) and call
   it before the S3 operation in `listObjects`, `getBucketTree`, `uploadObject`,
   `deleteObject`. TDD via `tenant-bucket.service.test.ts`.
3. **Database seed 05a** — seed the two new defaults; converge legacy environments:
   rename `audio` row → `recordings` in place (id preserved so `Media.bucketId` stays
   valid), or soft-delete the redundant `audio` row if `recordings` already exists;
   soft-delete legacy `misc` SYSTEM rows; revive soft-deleted default rows on re-seed.
4. **API** — streaming `TranscriptionJobController` slug fallback becomes
   purpose `AUDIO` → slug `recordings` → legacy slug `audio`; update task-307 e2e specs
   and the task-376 media-seed script to the new bucket names.

## Implementation Summary

### Fix 1 — self-healing physical buckets (the 500)

`packages/applications/src/services/tenant-bucket/tenant-bucket.service.ts`

- New private `ensureProviderBucket(bucketName)`:
  - `bucketExists` errors (storage down/credentials) → skip creation and let the
    data-plane call surface the real error;
  - missing bucket → `createBucket`, logging success; a lost create race
    ("already exists/owned") is logged and ignored.
- Invoked at the top of the provider-touching paths in `getBucketTree`, `listObjects`,
  `uploadObject`, `deleteObject`. First access to a seeded bucket now materializes it and
  returns an empty listing instead of a 500.

### Fix 2 — two default buckets everywhere

- `packages/domains/src/factories/generated/core/TenantBucketFactory.ts`
  `SYSTEM_BUCKET_SLUGS = { ATTACHMENTS: 'attachments', RECORDINGS: 'recordings' }`,
  matching descriptions/path-patterns/purposes; `CreateDefaultSystemBuckets` returns
  exactly these two. (Generator check unaffected — the generator does not own these
  constants; the pre-existing `generate-factory:check` drift on `UserFactory.passwordChangedAt`
  belongs to other in-flight work on this branch.)
- `packages/database/src/prisma/db_main/seed/05a-tenant-bucket.ts` — seeds the two
  defaults per tenant + `convergeLegacyBuckets` (audio→recordings in-place rename
  preserving ids, soft-delete redundant `audio`/legacy `misc`, re-enable soft-deleted
  default rows). Idempotent.
- `TenantService.create` already calls `provisionSystemBuckets` (non-blocking on
  failure); via the factory change, new tenants now get exactly `attachments` +
  `recordings` — DB rows *and* physical buckets.
- `apps/api/src/modules/streaming/transcription-job.controller.ts` — audio-bucket
  resolution order: purpose `AUDIO` → slug `recordings` → legacy slug `audio`.
- E2E/spec/script renames: `task-307-tenant-bucket-cross-tenant.spec.ts`,
  `task-307-storage-cross-tenant.spec.ts`, `task-307-w3-aggregate.spec.ts`,
  `packages/applications/scripts/media-seed.ts` (`hope-recordings-global`).

### Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/tenant-bucket/tenant-bucket.service.ts` | `ensureProviderBucket` + 4 call sites |
| `packages/applications/src/services/tenant-bucket/__tests__/tenant-bucket.service.test.ts` | on-demand provisioning suite (create-when-missing, skip-when-exists, race tolerated, real errors propagate); 2-bucket expectations |
| `packages/domains/src/factories/generated/core/TenantBucketFactory.ts` | defaults = attachments + recordings |
| `packages/domains/src/__tests__/tenant-bucket.test.ts` | 2-bucket expectations |
| `packages/database/src/prisma/db_main/seed/05a-tenant-bucket.ts` | 2 defaults + legacy convergence |
| `apps/api/src/modules/streaming/transcription-job.controller.ts` | recordings-first slug fallback |
| `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts` | slug mock → recordings |
| `apps/api/tests/e2e/task-307-{tenant-bucket,storage}-cross-tenant.spec.ts`, `task-307-w3-aggregate.spec.ts` | bucket-name renames |
| `packages/applications/scripts/media-seed.ts` | `hope-recordings-global` |

No schema migration: slugs/names are data, `TenantBucketPurpose.AUDIO` enum retained.

## Verification Evidence (2026-07-05 dev)

- Unit: `@arcaai/domains` tenant-bucket — **8 passed**; `@arcaai/applications`
  tenant-bucket + tenant service — **156 passed (3 files)**; `@arcaai/api`
  transcription-job + tenant-bucket controllers — **74 passed (2 files)**.
- Lint: touched `apps/api/src` files clean; packages files clean (test/generated files
  are eslint-ignored by config; task-307 e2e prettier noise pre-exists at HEAD).
- Dev DB re-seeded; live checks against `pnpm dev:api`:
  - Original failing call `GET /admin/tenants/storage/buckets/019f27a0-…3d59/objects`
    (tenant `__GLOBAL__`) → **HTTP 200 `[]`**, and `hope-attachments-global` /
    `hope-recordings-global` now exist in MinIO (self-heal proven).
  - Same for the ARCAAI tenant's buckets → **HTTP 200**.
  - `POST /admin/tenants` (`verify_task421` scratch tenant) → rows
    `attachments → hope-attachments-verify-task421 (ATTACHMENTS)` and
    `recordings → hope-recordings-verify-task421 (AUDIO)` **and both physical buckets
    created**; scratch tenant then soft-deleted via the API.
- Seeded tenants (`__GLOBAL__`, `ARCAAI`, `__SYSTEM__`) converged to the 2-bucket set.
  Pre-existing runtime QA tenants (e.g. `qa_tenant_a`) keep their legacy
  `audio`/`misc` rows + physical buckets by design — the seed only converges seeded
  tenants, and purpose-based resolution plus the legacy-slug fallback keep them working.

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Initial fix + default-bucket policy change implemented and verified. |
