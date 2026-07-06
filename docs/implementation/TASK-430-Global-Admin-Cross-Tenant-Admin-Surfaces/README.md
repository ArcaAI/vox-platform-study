# TASK-430 — Global-Admin Cross-Tenant Admin Surfaces

| | |
|---|---|
| **Status** | In Progress |
| **Type** | feature + bugfix |
| **Packages** | `packages/applications`, `apps/api`, `apps/admin-console` |
| **Related** | TASK-415 (admin console), TASK-417 (GLOBAL_ADMIN consolidation), TASK-423 (data grids), TASK-401 (impersonation) |

## Requirement Analysis

When a GLOBAL_ADMIN uses the Administration pages (`/users`, `/api-keys`, `/settings`, `/tenant-profile`, `/account`) **without selecting a working tenant**:

1. `/users` must list all users with columns **User, Role, Tenant, Status, Type, Last Login**, offer a **filter by tenant**, and opening a user must show the detail instead of `Tenant ID is required`. Additionally, **service accounts must not be allowed to use any interface except calling APIs**.
2. `/api-keys` must list all keys with columns **Name, Prefix, Tenant, Scope, Status, Last used, Expires, Created, Action** and a **filter by tenant**.
3. `/settings` must list all settings/secrets of all tenants with a **Tenant column** and a **filter by tenant**.

`/tenant-profile` (renders a "No working tenant selected" empty state) and `/account` (self-service) already behave correctly with no tenant selected — no changes.

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

_(completed below — see Change History)_

## Change History

- 2026-07-06 — Ticket opened; exploration + plan recorded.
