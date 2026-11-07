# API Gateway B02a — Tenant Core & Config

Companion explainer for `api-gateway-b02a-tenant-core-config.html`.

## Scope
`B02a`: `tenant`, `tenant-allowed-origin`, `tenant-frontend-config`, `tenant-storage-config` (~34 routes est.). Part of B02 split (B02b bucket/checkpoint, B02c settings/entitlements pending). `tenant-idp-config` excluded (B01). Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups
- **Admin tenant** (`/admin/tenants`): lifecycle/admin routes including usage, suspend/archive/restore, tags, reference-set sync, provisioning (`tenant.controller.ts`, `tenant-reference-set.controller.ts`, `tenant-provision.controller.ts`).
- **Self tenant** (`/tenants/me`): `GET /tenants/me`, `GET/PATCH /tenants/me/config` (`my-tenant.controller.ts`).
- **Allowed origins** (6): posture + CRUD (`tenant-allowed-origin.controller.ts`).
- **Frontend/storage config**: tenant frontend config GET/PUT; tenant storage config tenant/platform/effective CRUD (`tenant-frontend-config-admin.controller.ts`, `tenant-storage-config-admin.controller.ts`).

## Services / downstream
- `TenantService` (`packages/applications/.../tenant.service.ts:73`)
- `TenantAllowedOriginService` (`tenant-allowed-origin.service.ts:43`)
- `TenantFrontendConfigService` (`tenant-frontend-config.service.ts:46`), `TenantStorageConfigService` (`tenant-storage-config.service.ts:67`)
- Downstream: tenant/config data store (Postgres/Prisma), origin enforcement posture/registry, storage backend effective config.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested. Advisory detours only.
- Grouped endpoint nodes; reconcile tenant base CRUD/shared decorator routes against catalog/OpenAPI for strict 1:1 coverage. Example I/O summarized from route contracts.
