# Traceability — Object Storage & Tenant Buckets

MinIO-backed object storage: the tenant-facing storage surface, per-tenant bucket / storage
config / access-key administration, and the console storage-browser data plane. Migrates
legacy matrix row **27** and adds the `storage-browser` console feature (the Wave-1 P2
unmapped-feature gap).

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Architecture: MinIO is fronted by the applications-layer `BlobStorageModule`
(`packages/applications/src/services/baseServices/storage/`); tenants get isolated buckets
provisioned + governed by the admin surfaces below. Consultation recordings / media
persistence (the `Media` producer side) is documented in
[`consultation.md`](./consultation.md); this file owns the bucket / config / key control plane
and the object browser.

## Capabilities

### S1 — Tenant object storage (buckets + files) — legacy row 27 (data plane)

| Field | Value |
|---|---|
| App / service | `apps/api` + MinIO |
| Key modules | `apps/api/src/modules/storage` (`storage.controller.ts`); `packages/applications/src/services/baseServices/storage` (`blob-storage.module.ts`, `providers/blob-storage.provider.factory.ts`) |
| Prisma models | `Media` (`db_main/media.prisma`), `TenantBucket` (`db_main/tenant-bucket.prisma`) |
| Key API endpoints | `@Controller('storage')`: `GET buckets` (`@CanRead('Storage')`), `POST buckets` (`@CanCreate`), `GET buckets/:name` (`@CanRead`), `PATCH buckets/:name` (`@CanUpdate`), `DELETE buckets/:name` (`@CanDelete`), `GET buckets/:name/files` (`@CanRead`), `POST buckets/:name/files` (`@CanCreate`), `GET buckets/:name/files/:key` (`@CanRead`), `DELETE buckets/:name/files/:key` (`@CanDelete`), `GET health` (`@CanRead`) |
| Console | consumed by the storage-browser feature (S3 below) |
| Tests | unit(api): `storage/__tests__/*`; e2e: `task-307-storage-cross-tenant.spec.ts` |

### S2 — Tenant bucket / storage config / access-key administration — legacy row 27 (control plane)

| Field | Value |
|---|---|
| App / service | `apps/api` + MinIO |
| Key modules | `apps/api/src/modules/tenant-bucket` (`tenant-bucket.controller.ts`), `apps/api/src/modules/tenant-storage-config` (`tenant-storage-config-admin.controller.ts`), `apps/api/src/modules/storage-access-key` (`storage-access-key.controller.ts`); `packages/applications/src/services/{tenant-bucket,tenant-storage-config,storage-access-key}` |
| Prisma models | `TenantBucket`, `StorageAccessKey`, `TenantStorageConfig` (`db_main/tenant-bucket.prisma`) |
| Key API endpoints | `@Controller('admin/tenants/storage/buckets')` (class `@CanManage('Tenant')`): `GET ''`, `GET defaults`, `PUT defaults`, `GET :id`, `GET :id/tree`, `POST ''`, `DELETE :id`, `GET :id/objects`, `POST :id/objects`, `DELETE :id/objects`, `POST provision/:tenantId`, `GET :id/presigned-url` (per-route `@Can*('Storage')`). `@Controller('admin/tenants/storage/config')` (`@CanAny(['manage','Tenant'],['update','Tenant'])`): `GET ''`, `GET effective`, `PUT ''`, `DELETE :id`. `@Controller('admin/tenants/storage/keys')` (`@CanManage('Tenant')`): `GET ''`, `POST ''`, `DELETE :id` |
| Console | `apps/admin-console` feature `storage` (`tenant-storage-screen` + `access-keys-tab`, `bucket-defaults-tab`, `storage-configs-tab`, `bucket-browser-sheet`); route `/tenants/storage` (tier 10–19, global) |
| Tests | unit(app): `tenant-bucket/__tests__/{tenant-bucket.service,tenant-bucket.dto.mapper}.test.ts`, `tenant-storage-config/__tests__/tenant-storage-config.service.test.ts`, `storage-access-key/__tests__/{storage-access-key.service,storage-access-key.service.module}.test.ts`; unit(console): `storage/components/__tests__/tenant-storage-screen.test.tsx`, `storage/api/__tests__/storage-api.test.ts`; e2e: `task-307-tenant-bucket-cross-tenant.spec.ts` |

### S3 — Storage-browser console (object data plane)

| Field | Value |
|---|---|
| App / service | `apps/admin-console` (over the S1 `storage` gateway surface) |
| Key modules | `apps/admin-console/src/features/storage-browser` (`storage-browser-screen`, `object-browser-panel`, `object-actions-panel`, `object-detail`; `api/{client,hooks,keys}.ts`) |
| Prisma models | — (console; reads/writes via the `@Controller('storage')` gateway routes in S1) |
| Console | route `/storage` (tier 30–49, tenant-scoped, "Frame 31 — tenant Storage browser") |
| Tests | unit(console): `storage-browser/components/__tests__/storage-browser-screen.test.tsx`, `storage-browser/api/__tests__/storage-browser-api.test.ts` |

## Honest notes / gaps

- **Two distinct console features front storage.** `storage` (`tenant-storage-screen`, tier 10–19 global) is the bucket / config / key *administration* surface; `storage-browser` (`storage-browser-screen`, tier 30–49 tenant) is the object *data plane*. They are separate features on separate routes — not a duplication.
- **Media persistence is documented elsewhere.** The `Media` / `AudioRecording` producer path (recording capture) lives in [`consultation.md`](./consultation.md); this file records the storage control/data plane, so `Media` appears here only as the object model the buckets hold.
- **No storage-browser e2e.** S3 has unit(console) coverage only; the cross-tenant storage e2e specs (`task-307-storage-*`) exercise the gateway routes (S1/S2), not the browser UI.

Last verified: 2026-07-21
