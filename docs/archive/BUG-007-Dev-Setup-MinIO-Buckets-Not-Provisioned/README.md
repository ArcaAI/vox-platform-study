# BUG-007 — `pnpm dev:setup` seeds tenant-bucket rows but never creates the physical MinIO buckets

| Field | Value |
|---|---|
| **Type** | bugfix (dev tooling) |
| **Status** | Pending |
| **Severity** | Medium — blocks every storage read/write on a fresh dev environment |
| **Area** | `scripts/dev-setup.sh`, `packages/database` seed, `packages/applications` storage service, `apps/api` storage controller, `infrastructure/docker` |
| **Reported** | 2026-07-13 |
| **Related** | TASK-376 (media seed / storage helpers), tenant-bucket service |

---

## Requirement Analysis

### Symptom

After `pnpm dev:setup`, storage routes fail because the buckets don't physically exist in MinIO:

```
GET /api/v1/storage/buckets/hope-attachments-global/files  → 500
NoSuchBucket: The specified bucket does not exist
  at S3BlobProvider.listObjects (packages/applications/src/services/baseServices/storage/providers/s3-blob.provider.ts:102)
```

### Expected behavior

`pnpm dev:setup` must leave a working environment: the physical MinIO buckets the seeded tenant-bucket rows point at must exist. Re-running `dev:setup` must (re-)create any missing buckets idempotently, in sync with seed data.

---

## Current State Evaluation

### Root cause

`dev:setup` seeds **DB rows** for tenant buckets but nothing provisions the matching **physical MinIO buckets**. Two compounding gaps:

1. The seed step writes rows only and explicitly defers physical bucket creation.
2. The failing read route hits the provider directly without the lazy "ensure bucket" that the admin path uses, so the missing bucket surfaces as a raw `NoSuchBucket`.

### Bucket names are seed-derived, not env-driven

- `packages/database/src/prisma/db_main/seed/05a-tenant-bucket.ts:61` — `buildBucketName(tenantKey, slug)` → `` `hope-${sanitize(slug)}-${sanitize(tenantKey)}` ``.
- Slugs (`05a-tenant-bucket.ts:29-32`): `attachments`, `recordings`.
- Tenants (`seed/05-tenant.ts:8-31`): keys `__SYSTEM__`, `__GLOBAL__`, `ARCAAI` → sanitized `system`, `global`, `arcaai`.

So the app expects **6 physical buckets** (2 slugs × 3 tenants):
`hope-attachments-global`, `hope-recordings-global`, `hope-attachments-arcaai`, `hope-recordings-arcaai`, `hope-attachments-system`, `hope-recordings-system`. The failing one (`hope-attachments-global`) confirms the `__GLOBAL__ → global` derivation.

There is **no** `STORAGE_BUCKET`/`S3_BUCKET` env var driving these. (Unrelated env buckets exist for other services: `STT_MINIO_BUCKET=recordings`, `HARNESS_CLAIM_CHECK_BUCKET=harness-claim-check` — not this path.)

### The dev docker init creates a *different, legacy* bucket set

`infrastructure/docker/docker-compose.yml:118` `minio-setup` (`minio/mc:latest`) entrypoint (`:138-142`) creates only:

```
mc mb minio/mlflow ; mc mb minio/recordings ; mc mb minio/generated-audio ;
mc mb minio/documents ; mc mb minio/backups   (all --ignore-existing)
```

None match the app's `hope-<slug>-<tenantKey>` names. `minio-setup` has no `profiles:` gate and runs on `dev-infra.sh up`, so it does run — it just makes the wrong buckets.

### What `pnpm dev:setup` does (`scripts/dev-setup.sh`)

1. `:49` — `dev-infra.sh up` (postgres/redis/**minio + minio-setup**/qdrant/vault/temporal)
2. `:53-67` — wait for Postgres + Vault AppRole
3. `:70` — `pnpm db:all` → `gen:prisma push … && generate … && db:seed`; `db:seed` runs `seedTenantBucket` (`seed/index.ts:85`)
4. `:73` — `refresh-vault-creds.sh`
5. `:76` — `setup-dev-vault-db.sh`

**No step creates the app's MinIO buckets.** `seedTenantBucket` is DB-rows-only by design (`05a-tenant-bucket.ts:13-16`: "Only the DB rows are created here. The underlying provider buckets are created lazily …"). `dev:setup` does **not** run `task-376-media-seed` (that would create physical buckets) — it's wired only into `test:db:seed` (`package.json:96-97`).

### Bucket-creation primitives already exist (just not on this path)

| Primitive / helper | Location | Used by |
|---|---|---|
| `createBucket` (`CreateBucketCommand`), `bucketExists` (`HeadBucketCommand`) | `packages/applications/.../storage/providers/s3-blob.provider.ts:136,144` | provider-level |
| `ensureProviderBucket` (exists → create) | `packages/applications/.../tenant-bucket/tenant-bucket.service.ts:566` | **admin** routes only (`getBucketTree`, `listObjects`, `uploadObject`, `deleteObject`) |
| `provisionSystemBuckets` (bulk physical create) | `tenant-bucket.service.ts:229` | tenant-create + admin `POST …/provision/:tenantId` only |
| `ensureBucket` (HeadBucket → CreateBucket, idempotent) + `makeS3Client` (reads `MINIO_*`) | `packages/applications/scripts/task-376-storage.ts:65,35` | test media seed only |

### Why the failing route errors instead of auto-creating

`apps/api/src/modules/storage/storage.controller.ts:145` `listFiles` (and `:131` `getBucket`) call `this.blobStorage.listObjects({ bucket: name })` **directly** — no `ensureProviderBucket`. The parallel **admin** controller (`apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts:34`) auto-creates; this public storage controller does not.

---

## Implementation Plan

> Primary fix: provision physical buckets as part of `dev:setup`, driven by the seeded rows (not a hardcoded list) so it stays in sync. Secondary: make the read path resilient (defense-in-depth).

### Step 1 — Add a `db:seed:buckets` provisioning script (primary)

- New tsx script under `packages/applications/scripts/` (or `packages/database/scripts/`) that:
  - builds an S3 client via the existing `makeS3Client` (`task-376-storage.ts:35`, reads `MINIO_*`);
  - derives the bucket list from seed truth — reuse `buildBucketName` over `ALL_TENANTS` × `SYSTEM_BUCKET_SLUGS` (`05a-tenant-bucket.ts`), or read the seeded `TenantBucket.name` rows from Postgres;
  - calls the idempotent `ensureBucket` (`task-376-storage.ts:65`) for each.
- Wire a root `package.json` script `db:seed:buckets` (parallel to `test:db:seed:media` at `package.json:97`).
- **Test / verify:** running twice is a no-op the second time; all 6 buckets present via `mc ls` / `listBuckets`.

### Step 2 — Invoke it from `dev:setup`

- Add a step in `scripts/dev-setup.sh` immediately **after** `pnpm db:all` (`:70`) — bucket rows exist and MinIO is already up. Call `pnpm db:seed:buckets`.
- **Verify:** fresh `pnpm dev:setup` → `GET /api/v1/storage/buckets/hope-attachments-global/files` returns 200 (empty list), no `NoSuchBucket`.

### Step 3 — Make the public storage read path resilient (defense-in-depth)

- In `storage.controller.ts` `listFiles`/`getBucket` (or the service they call), treat a missing bucket as an empty result (or lazily ensure it) instead of a 500 — matching the admin path's `ensureProviderBucket` behavior. Decide product-side: auto-create vs. return empty-with-warning. Recommend: if the bucket row exists in DB, ensure the physical bucket; otherwise 404.
- **Test (RED):** listing a DB-known bucket whose physical bucket is missing does not 500.

### Step 4 (optional) — Stop the misleading legacy compose init

- Either update `infrastructure/docker/docker-compose.yml:138-142` to note it's service-scoped legacy buckets, or remove the stale names, so it doesn't imply it provisions app buckets. Do **not** hardcode tenant buckets there (would duplicate `buildBucketName` and drift from seed).

### Files expected to change

| File | Change |
|---|---|
| `packages/applications/scripts/` (new) | `db-seed-buckets.ts` provisioner using `makeS3Client` + `ensureBucket` |
| root `package.json` | add `db:seed:buckets` script |
| `scripts/dev-setup.sh` | invoke `db:seed:buckets` after `db:all` |
| `apps/api/src/modules/storage/storage.controller.ts` (or its service) | resilient missing-bucket handling |
| `infrastructure/docker/docker-compose.yml` (optional) | clarify/trim legacy `minio-setup` buckets |

### Verification criteria

- Fresh `pnpm dev:setup` on a wiped MinIO volume yields all 6 `hope-*` buckets; storage list routes return 200.
- Re-running `dev:setup` is idempotent (no errors on existing buckets).
- Resilience test green; `pnpm lint` clean.

---

## Implementation Summary

_Pending — no code written yet._

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-13 | Tap Huynh | Ticket created. Root cause traced: seed writes tenant-bucket rows only; no `dev:setup` step provisions physical MinIO buckets; legacy `minio-setup` makes a different name set; public `storage.controller.listFiles` lacks the admin path's lazy `ensureProviderBucket`. Solution plan drafted (seed-driven `db:seed:buckets` + resilient read path, no coding yet). |
