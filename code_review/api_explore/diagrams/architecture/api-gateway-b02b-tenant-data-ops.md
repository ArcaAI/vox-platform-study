# API Gateway B02b — Tenant Bucket & Checkpoint

Companion explainer for `api-gateway-b02b-tenant-data-ops.html`.

## Scope
`B02b`: `tenant-bucket` (13 routes), `tenant-checkpoint` (12 routes), ~25 routes est. Part of B02 split (B02a done, B02c settings/entitlements pending). Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Routes | Controller | Service | Downstream |
|---|---|---|---|---|
| Tenant bucket | GET/PUT defaults, list/get/create/register/delete buckets, GET tree, GET/POST/DELETE `:id/objects`, GET presigned-url, POST `provision/:tenantId` | `TenantBucketController` (`apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts:37,45+`) | `TenantBucketService` (`packages/applications/src/services/tenant-bucket/tenant-bucket.service.ts:66`) | Bucket/object metadata store; object storage blobs |
| Tenant checkpoint | list/get restores, upload init/complete/abort, create/list/get/cancel/delete checkpoint, POST download-url, POST restore | `TenantCheckpointController` (`apps/api/src/modules/tenant-checkpoint/tenant-checkpoint.controller.ts:40,53+`) | `TenantCheckpointService` (`packages/applications/src/services/tenant-checkpoint/tenant-checkpoint.service.ts:111`) | Checkpoint/restore metadata store; checkpoint blobs/uploads/download URLs |

## Example input/output (representative)
- **Bucket create/register:** bucket DTO/name -> bucket record; defaults PUT accepts purpose/default mapping.
- **Object ops:** POST `:id/objects` (upload/object request per implementation) -> object metadata; presigned-url returns time-limited URL.
- **Checkpoint create/upload:** POST checkpoint/upload -> upload session/URL metadata; complete/abort finalize/cancel upload; download-url returns access URL.
- **Restore:** POST `:id/restore` with restore request/options -> restore job/result metadata. Verify async worker involvement.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 crossing (`svc_ckpt→data_meta` vs `svc_bucket→ext_blob`) and 1 detour (`svc_bucket→ext_blob`, 3 bends). Gates pass; position-only repair not required unless visual quality is a concern.
- Limitations: grouped endpoint nodes; example I/O summarized from route contracts; async checkpoint worker/process details not expanded as separate microservice nodes without additional verified sources.
