# TASK-430 — Global-Admin Cross-Tenant Admin Surfaces

| | |
|---|---|
| **Status** | Review |
| **Type** | feature + bugfix |
| **Packages** | `packages/domains`, `packages/applications`, `apps/api`, `apps/admin-console` |
| **Related** | TASK-415 (admin console), TASK-417 (GLOBAL_ADMIN consolidation), TASK-423 (data grids), TASK-401 (impersonation) |

## Requirement Analysis

When a GLOBAL_ADMIN uses the Administration pages (`/users`, `/api-keys`, `/settings`, `/tenant-profile`, `/account`) **without selecting a working tenant**:

1. `/users` must list all users with columns **User, Role, Tenant, Status, Type, Last Login**, offer a **filter by tenant**, and opening a user must show the detail instead of `Tenant ID is required`. Additionally, **service accounts must not be allowed to use any interface except calling APIs**.
2. `/api-keys` must list all keys with columns **Name, Prefix, Tenant, Scope, Status, Last used, Expires, Created, Action** and a **filter by tenant**.
3. `/settings` must list all settings/secrets of all tenants with a **Tenant column** and a **filter by tenant**.

`/tenant-profile` (renders a "No working tenant selected" empty state) and `/account` (self-service) already behave correctly with no tenant selected — no changes.

**Scope addition (2026-07-06):**

4. `/tenants/storage` must list **all buckets of all tenants** for an unscoped GLOBAL_ADMIN (no working tenant required), with a **Tenant column** and **filters** on the data table.

## Current State Evaluation

- `GET /admin/users`, `GET /admin/api-keys`, `GET /admin/settings` already return cross-tenant data for an unscoped GLOBAL_ADMIN.
- The `Tenant ID is required` error on user detail comes from the **Departments tab**: `GET /admin/users/:id/departments` → `UserDepartmentService.getByUser()` → `requireTenant()` throws `BadRequestException('Tenant ID is required')` when CLS carries no tenant (`packages/applications/src/services/user/userDepartment/user-department.service.ts`).
- `/users` list rows already include `UserRoleAssignments[]` (with `tenantId`, `roleName`); no Tenant/Last-Login columns are rendered and there is no tenant filter. `GET /admin/users/tenant/:tenantId` exists and merges CSV filters with the tenant scope.
- `ApiKeyResponse` already exposes `tenantId`; `GlobalSettingResponse` does **not**.
- The grid select filters serialize to the gateway CSV grammar (`tenantId[equals]:<uuid>`), which `formatFindAllProps` merges into the Prisma where — so a `tenantId` grid filter needs **no backend change** for api-keys/settings.
- Service accounts are only exempted from the department check at login (`auth.controller.ts`) — they **can** sign in interactively and **can** be impersonated.

## Implementation Plan

### Backend

1. **`UserDepartmentService.getByUser`** — allow an unscoped GLOBAL_ADMIN to read a user's department memberships cross-tenant (no `tenantId` predicate); all other callers keep the `Tenant ID is required` contract. TDD in `user-department.service.test.ts`.
2. **`GlobalSettingResponse.tenantId`** — expose the owning tenant on the settings DTO (list/get) so the console can render/filter a Tenant column. Mapper test.
3. **Service-account interface lockout**:
   - `POST /auth/login` rejects `isServiceAccount` users after password verification (401, explicit message).
   - Impersonation of a service-account target is rejected on both mint routes (`/auth/impersonate`, `/admin/users/:id/impersonate`) with a new audited denial reason `TARGET_IS_SERVICE_ACCOUNT`.
4. **`GET /admin/users/export`** — accept an optional `tenantId` query param (GLOBAL_ADMIN path) so the export honours the console's tenant filter.

### Frontend (`apps/admin-console`)

5. **`/users`**: add **Tenant** column (derived from `UserRoleAssignments` tenant ids; names via the tenant catalog; "Global" badge for system-tenant/global assignments) with a tenant select filter; replace **Last active** with **Last login** (`lastLoginAt`, sortable). The tenant filter re-routes the list to `GET /admin/users/tenant/:tenantId` (and threads `tenantId` to the export). Hide **Impersonate** for service accounts on the detail header.
6. **`/users/:id` Departments tab**: works with no working tenant (backend fix); add a Tenant column so cross-tenant memberships are attributable.
7. **`/api-keys`**: add **Tenant** column + tenant select filter (CSV `tenantId[equals]:` — no backend change).
8. **`/settings`**: add **Tenant** column + tenant select filter (uses the new DTO field).
9. Shared: `useTenantOptions()` select-options helper in `src/shared/catalog`.

### Verification

- `pnpm --filter @arcaai/applications test` + build
- `apps/api` unit tests (`pnpm test:unit` targeted)
- `pnpm --filter @arcaai/admin-console build lint test`
- Runtime pass as GLOBAL_ADMIN without a working tenant.

## Implementation Summary

### Backend (`packages/applications`, `apps/api`)

| Change | File(s) |
|---|---|
| `getByUser` reads memberships cross-tenant for an unscoped GLOBAL_ADMIN (fixes `Tenant ID is required` on the user-detail Departments tab); all other callers keep the strict tenant requirement | `packages/applications/src/services/user/userDepartment/user-department.service.ts` + tests |
| `GlobalSettingResponse.tenantId` exposed (list/get) so the console can render/filter a Tenant column | `packages/applications/src/services/globalSetting/dto/globalSetting.response.ts` + mapper test |
| Service accounts refused interactive login (401 AFTER password check — no account-type oracle) | `apps/api/src/modules/auth/auth.controller.ts` |
| Impersonating a service account refused on BOTH mint routes, audited with new `TARGET_IS_SERVICE_ACCOUNT` denial reason | `auth.controller.ts`, `admin-impersonation.controller.ts`, `impersonation-events.ts` + `__tests__/auth.service-account.task430.test.ts` |
| `GET /admin/users/export` accepts optional `tenantId` (validated via `assertCanReadTenant`) so exports honour the console tenant filter | `apps/api/src/modules/user/dto/export-users.query.ts`, `user.controller.ts` |
| `TenantBucketService.listBuckets` lists buckets CROSS-TENANT for an unscoped GLOBAL_ADMIN (was: unconditional `Tenant ID is required`); new `TenantBucketRepository.findAllCrossTenant` (sorted tenantId → slug, ENABLED unless `includeDisabled`) | `packages/applications/src/services/tenant-bucket/tenant-bucket.service.ts` + tests, `packages/domains/src/repositories/generated/core/TenantBucketRepository.ts` |

### Frontend (`apps/admin-console`)

| Screen | Change |
|---|---|
| `/users` | Tenant column (badges from `UserRoleAssignments`, catalog names, +N overflow) with select filter; the filter re-routes the list to `GET /admin/users/tenant/:id` and threads `tenantId` to the export; **Last active → Last login** (`lastLoginAt`); Impersonate hidden for service accounts on the detail header. The Tenant column uses an `accessorFn` so TanStack `getCanFilter()` is true and the faceted filter renders. |
| `/users/:id` Departments tab | Works unscoped (backend fix) + new Tenant column attributing each membership. |
| `/api-keys` | Tenant column (`tenantId`, catalog names, dash for platform keys) + select filter via CSV `tenantId[equals]:…` — no backend change. |
| `/settings` | Tenant column (new DTO field) + select filter via the same CSV grammar. |
| `/tenants/storage` | Buckets tab no longer gated on a working tenant: an unscoped elevated session lists every tenant's buckets with a new **Tenant** column (catalog names) and client-side faceted filters (**Tenant / Purpose / Type**, `facetedFilters: true`). The **Defaults / Configs / Access keys** tabs stay per-tenant and show the "Select a working tenant" empty state when unscoped. |

### Verification evidence (2026-07-06)

- `pnpm --filter @arcaai/applications build` ✅ · `test` ✅ 5841 passed | 4 skipped (269 files)
- `pnpm build:api` ✅ (8 tasks) · API unit tests (auth/user/global-setting modules) ✅ 291 passed (16 files)
- `pnpm --filter admin-console build` ✅ · `lint` ✅ (0 errors/0 warnings) · feature tests (users/api-keys/settings) ✅ 72 passed (7 files)
- Runtime pass (unscoped GLOBAL_ADMIN, dev servers): `/users` cross-tenant list with all mandated columns + working tenant filter (48 → 1 on QA Tenant A); user detail Departments tab loads (no `Tenant ID is required`); `/api-keys` shows 11 keys with Tenant column; `/settings` shows 286 settings cross-tenant, tenant filter narrows to 22 (System).

`/tenant-profile` and `/account` needed no changes (verified empty-state / self-service behaviour).

### Verification evidence — `/tenants/storage` addition (2026-07-06)

- `pnpm --filter @arcaai/domains build` ✅ · `test` ✅ 1299 passed | 2 skipped (107 files)
- `pnpm --filter @arcaai/applications build` ✅ · `tenant-bucket.service.test.ts` ✅ 48 passed (incl. 2 new cross-tenant tests, TDD RED→GREEN)
- `pnpm --filter admin-console` `tenant-storage-screen.test.tsx` ✅ 17 passed (3 new: cross-tenant list, tenant faceted filter, per-tenant tab gating) · eslint ✅ 0 errors
- Runtime pass (unscoped GLOBAL_ADMIN): `/tenants/storage` lists 17 buckets across 7 tenants with Tenant column (names + ids); tenant filter narrows 17 → 3 (QA Tenant A); Defaults tab shows "Select a working tenant".

## Change History

- 2026-07-06 — Ticket opened; exploration + plan recorded.
- 2026-07-06 — Backend + frontend implemented and verified (see Implementation Summary). Fix during runtime pass: the `/users` Tenant column needed an `accessorFn` for the faceted filter to render (display-only columns fail TanStack's `getCanFilter()`).
- 2026-07-06 — Scope addition: `/tenants/storage` cross-tenant buckets list (Tenant column + Tenant/Purpose/Type filters, no working tenant required); defaults/configs/keys tabs remain per-tenant behind the pick-tenant empty state.
