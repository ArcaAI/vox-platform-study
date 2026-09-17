# TASK-984 — Public download endpoint for presigned storage URLs

| Field | Value |
|---|---|
| **Status** | In Progress |
| **Type** | bugfix (full stack: `packages/database`, `packages/domains`, `packages/applications`, `apps/api` artifacts, `apps/admin-console`) + infrastructure (`arca/hope-v2-deployment`) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-17 |
| **Ticket number** | TASK-984 — next after TASK-983 (`docs/archive/**` could not be listed this sprint) |
| **Reported by** | Owner, 2026-09-17: downloading a bucket file opens a link whose host is the in-cluster MinIO service name |

## 1. Requirement

1. On the cluster, "Download" in the admin console opens `https://hope-minio:9000/<bucket>/<key>?X-Amz-…`, which no browser can resolve.
2. There must be a configuration for the domain those links use, aligned with the admin-console domain, so an admin's download works.
3. **Owner, 2026-09-17: a PLATFORM ADMIN configures that domain. It is NOT an environment variable.**

Classification: bugfix, full stack + one deployment manifest.

## 2. Current state (verified 2026-09-17)

### 2.1 Why the link is wrong

- Every browser-facing presigned URL is signed by ONE function, `S3BlobProvider.presignGet` (`packages/applications/src/services/baseServices/storage/providers/s3-blob.provider.ts`), with the SAME `S3Client` the gateway uses to talk to MinIO. That client's endpoint comes from the platform `TenantStorageConfig` SYSTEM row (else `MINIO_ENDPOINT`), which on the cluster is `https://hope-minio:9000` (`hope-v2-deployment: deployment/k8s/base/config/api.env:43`).
- SigV4 signs the `host` header, so the URL cannot be rewritten after signing — it has to be SIGNED for the public host.
- There is no public counterpart of the storage endpoint anywhere (contrast MLflow's `MLFLOW_URL` vs `MLFLOW_UI_URL`).

### 2.2 Every leak (read-only sweep, sonnet)

| Surface | Route / field | Visible today |
|---|---|---|
| Storage browser Download | `GET storage/buckets/:name/files/:key` → `url` (`storage.controller.ts#getFileInfo`) → `window.open` in `object-actions-panel.tsx` | yes — the reported break |
| Tenant bucket presign | `GET admin/tenants/storage/buckets/:id/presigned-url` (`tenant-bucket.service.ts#getPresignedUrl`) | API/SDK only (console hook has no consumer) |
| Consultation context media | `ContextItemResponse.url` / `thumbnailUrl` (`context.service.ts`) | API/SDK (`@arcaai/vox`, `@arcaai/vox-node`) |
| `S3Service.signUrl`, `apps/stt` `get_presigned_url` | health self-test / dead code | no |

All three live leaks go through `S3BlobProvider.presignGet`, so one fix covers them.

### 2.3 Why a path on the console domain cannot simply proxy MinIO

- `minio.taphuynh.dev` routes to MinIO's web console (`:9001`), not the S3 API (`:9000`).
- MinIO's S3 API cannot be served under a sub-path, and the signature covers the path, so `https://admin…/s3/<bucket>/<key>` cannot verify.
- Traefik (cluster: `rancher/mirrored-library-traefik:3.6.9`) CAN route by query string, and the tunnel's catch-all forwards the `Host` header intact (`hope-v2-deployment: docs/cloudflare-tunnel.md` §4). A presigned URL signed for `https://admin.taphuynh.dev` is `https://admin.taphuynh.dev/<bucket>/<key>?X-Amz-Algorithm=AWS4-HMAC-SHA256&…`; routing requests carrying that query parameter to `hope-minio:9000` delivers exactly the host and path MinIO verifies.
- `allow-kube-system-probes` (`components/network-policies/default-deny.yaml`) already admits Traefik (`kube-system`) to every pod port, so no policy change is needed.

### 2.4 Who can edit the platform storage row today

- `GET`/`PUT admin/tenants/storage/config/platform` (super-admin only, If-Match OCC) is the dedicated service for `storage.platformDefault.*`; the settings-registry lane refuses `db-config` writes by design.
- **The console has no editor for it.** On `/tenants/storage`, an unscoped platform admin sees "Select a working tenant" on the Configs tab.

## 3. Decisions taken (owner approved the recommendation and said go, 2026-09-17)

| # | Decision | Why |
|---|---|---|
| D-1 | Keep presigned, direct-to-store downloads; do not stream bytes through the gateway and BFF | `hope-models` holds multi-GB weights; the BFF strips `Content-Disposition`/`Range`; the code's stated intent is direct fetch |
| D-2 | New nullable column `TenantStorageConfig.publicEndpoint` — the ORIGIN presigned URLs are signed for. It travels with the row that owns `endpoint`, so it cascades bucket → tenant → SYSTEM exactly like the endpoint it pairs with | A `GlobalSetting` would keep rewriting URLs after the platform row moved to AWS S3; the resolver's own rule is "a value with no home on `TenantStorageConfig` does not belong here" |
| D-3 | **No env var, no AppSettings key, no seed value.** The bootstrap env tier yields `publicEndpoint = null` | Owner directive. Null = sign with `endpoint` — today's behaviour, correct wherever the endpoint is already browser-reachable (local dev, real AWS S3) |
| D-4 | Value must be an origin: `http(s)://host[:port]`, no path, query, fragment or credentials; refused on `AZURE_BLOB` rows (SAS URLs are already public) | MinIO cannot serve its API under a sub-path and the signature covers the path |
| D-5 | Signing uses a second, never-connecting `S3Client` built for the public origin; all real I/O keeps the internal client | Presigning is offline; the internal hop stays in-cluster |
| D-6 | Presigned GETs carry `response-cache-control: private, no-store` | The links now traverse Cloudflare; without it an edge could keep serving a PHI object after the 60-min signature expired |
| D-7 | Descriptor `storage.platformDefault.publicEndpoint` (`db-config`, `globalOnly`, `maxScope: system`) + resolver entry | Keeps the settings catalog complete; writes still go through the dedicated route |
| D-8 | Console: on `/tenants/storage` → Configs, an unscoped platform admin gets a "Platform storage default" panel (read-only summary + editable **Public download endpoint**, If-Match). The tenant config dialog gains the same field for S3/MinIO rows. The panel does not CREATE a missing SYSTEM row | Owner rule: the working tenant decides scope (none + elevated → SYSTEM), no scope toggle. A half-filled SYSTEM row would win wholesale over the env tier and break storage |
| D-9 | Deployment: a Traefik `IngressRoute` on the admin host routes `Query(X-Amz-Algorithm=AWS4-HMAC-SHA256)` to `hope-minio:9000`; host lives in the overlay, base ships `.invalid` | Aligns download links with the admin-console domain with no new DNS record; base stays portable |

## 4. Implementation plan

### 4.1 TDD test list (RED first, each file individually)

| # | Test file | Asserts |
|---|---|---|
| T1 | `packages/applications/.../providers/__tests__/s3-blob.provider.test.ts` | with `publicEndpoint` the presigned GET/PUT URL's origin is the public one and verifies as SigV4 for that host; without it the endpoint origin is used; GET carries `response-cache-control=private, no-store` |
| T2 | `packages/applications/src/services/tenant-storage-config/__tests__/platform-storage-config.test.ts` | SYSTEM row `publicEndpoint` flows; app-settings and env tiers yield `null` even when env holds a look-alike var |
| T3 | `.../providers/__tests__/blob-storage.provider.factory.test.ts` + `.tenant.test.ts` | platform provider and a DEDICATED tenant provider presign against the row's `publicEndpoint` |
| T4 | `packages/domains/src/entities/**/__tests__` (TenantStorageConfig) | `validate()` accepts an origin, rejects a path/query/credentials/non-http scheme, rejects any value on `AZURE_BLOB` |
| T5 | `.../tenant-storage-config/__tests__/tenant-storage-config.service.test.ts` | platform PUT and tenant PUT persist + return `publicEndpoint`; `''` clears to `null`; a path is a 400 |
| T6 | `.../tenant-storage-config/__tests__/platform-storage-settings.resolver.test.ts` + registry governance | `storage.platformDefault.publicEndpoint` resolves from the SYSTEM row |
| T7 | `apps/admin-console/src/features/storage/api/__tests__/storage-api.test.ts` | platform default GET + PUT with `If-Match` |
| T8 | `apps/admin-console/src/features/storage/components/__tests__/tenant-storage-screen.test.tsx` | unscoped platform admin sees the panel and saves the public endpoint with the row's ETag; scoped tenant form sends `publicEndpoint` |

### 4.2 Order

1. Prisma column + migration (shadow-DB recipe, rule 02) → `db:generate` → `gen:model`.
2. Entity / factory (hand) → `gen:entity` + `gen:factory` coverage.
3. Resolver + provider + factory + service + DTOs + descriptor.
4. Five API artifacts (`api:build`, `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin`).
5. Console api + panel + dialog field.
6. Deployment repo: `IngressRoute` in base (`.invalid` host) + dev overlay host patch; `kustomize build overlays/dev`.
7. One gate pass after everything is on `dev-2.2`; local runtime proof; cluster proof after deploy.

### 4.3 Verification criteria

- All test files above green; affected packages build; no new lint warnings.
- Local: platform admin sets the public endpoint in the console → the storage browser's Download URL carries that origin and MinIO answers 200 for it.
- Cluster (after deploy): the SYSTEM row's `publicEndpoint = https://admin.taphuynh.dev`, a Download from `admin.taphuynh.dev` returns the object.

## 5. Implementation summary

_Pending._

## 6. Change history

| Date | Change |
|---|---|
| 2026-09-17 | Ticket opened; root cause + leak sweep recorded; owner approved the recommendation ("platform admin configures the domain, not an env var") and said go |
