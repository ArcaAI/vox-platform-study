# TASK-236: Auth-Based Tenant APIs

| Field | Value |
|-------|-------|
| **Ticket** | TASK-236 |
| **Created** | 2026-03-07 |
| **Updated** | 2026-03-07 |
| **Status** | Completed |
| **Type** | Feature + Refactor |
| **Packages** | `apps/api`, `packages/agentic-sdk-v2` |

---

## Requirement Analysis

### Description

Create auth-based (non-admin) API endpoints for regular users to fetch their own tenant information and configuration, then update the `@arcaai/vox` SDK to use these endpoints instead of admin-scoped paths.

### Business Context

The `@arcaai/vox` SDK was calling admin-scoped endpoints (`/admin/settings/tenant/:tenantId/config`) to load tenant configuration. This is architecturally wrong for two reasons:

1. **Security**: Regular authenticated users (doctors, clinicians) should not hit `/admin/` routes.
2. **Coupling**: The client had to know the `tenantId` upfront and pass it in the URL, when the backend can resolve it directly from the JWT token.

This task builds on the previous refactoring (which replaced the defunct `/audio/ai-models` endpoint with `GlobalSetting`-based tenant configuration) by providing proper auth-based endpoints.

### Acceptance Criteria

- [x] `GET /api/v1/tenant/me` returns the authenticated user's tenant basic info
- [x] `GET /api/v1/tenant/me/config` returns the authenticated user's tenant configuration settings
- [x] Both endpoints resolve `tenantId` from the JWT token via CLS context
- [x] Both endpoints return 401 when no tenant context is available
- [x] SDK `ModelRegistry.loadTenantConfig()` uses the new auth-based endpoint (no `tenantId` argument)
- [x] SDK `AgenticProvider` calls `loadTenantConfig()` unconditionally (server handles scoping)
- [x] All existing tests pass with no regressions
- [x] OpenAPI/Swagger metadata is correct on both new endpoints

---

## Current State Evaluation

### Before This Change

- `ModelRegistry.loadTenantConfig(tenantId)` called `GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG(tenantId)` which resolved to `GET /admin/settings/tenant/:tenantId/config`
- `AgenticProvider` guarded the call with `if (cfg.api.tenantId)`, requiring the client to know and pass the tenant ID
- No non-admin tenant endpoints existed

### Dependencies

- `TenantService.fetchById()` and `TenantService.fetchTenantConfigs()` in `packages/applications`
- `UnifiedAuthGuard` / `@Authorize()` decorator for JWT authentication
- CLS context (`nestjs-cls`) for tenant ID resolution from JWT payload

---

## Implementation Plan

### Backend Changes

1. New `MyTenantController` at `apps/api/src/modules/tenant/my-tenant.controller.ts`
   - `@Controller('tenant')` prefix (becomes `/api/v1/tenant/...`)
   - `@Authorize()` class-level guard
   - Two methods: `me()` and `myConfig()`
2. Register in `TenantModule` alongside existing `TenantController`
3. TDD tests for all behaviors and Swagger metadata

### SDK Changes

1. New `MY_TENANT_ENDPOINTS` constant (`/tenant/me`, `/tenant/me/config`)
2. `ModelRegistry.loadTenantConfig()` — remove `tenantId` parameter, use `MY_TENANT_ENDPOINTS.CONFIG`
3. `AgenticProvider` — remove `if (cfg.api.tenantId)` guard, call unconditionally
4. Update all affected tests

---

## Implementation Summary

### New Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/v1/tenant/me` | Current user's tenant info | JWT / API Key |
| GET | `/api/v1/tenant/me/config` | Current user's tenant configuration | JWT / API Key |

### Files Created

| File | Purpose |
|------|---------|
| `apps/api/src/modules/tenant/my-tenant.controller.ts` | Auth-based tenant controller with `me()` and `myConfig()` |
| `apps/api/src/modules/tenant/__tests__/my-tenant.controller.test.ts` | 11 unit tests covering behavior and Swagger metadata |

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/modules/tenant/tenant.module.ts` | Registered `MyTenantController` in controllers array |
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added `MY_TENANT_ENDPOINTS` constant |
| `packages/agentic-sdk-v2/src/core/index.ts` | Exported `MY_TENANT_ENDPOINTS` |
| `packages/agentic-sdk-v2/src/core.ts` | Exported `MY_TENANT_ENDPOINTS` |
| `packages/agentic-sdk-v2/src/core/ModelRegistry.ts` | Changed `loadTenantConfig(tenantId)` to `loadTenantConfig()`, uses `MY_TENANT_ENDPOINTS.CONFIG` |
| `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` | Removed `if (cfg.api.tenantId)` guard; calls `loadTenantConfig()` unconditionally |
| `packages/agentic-sdk-v2/src/core/__tests__/ModelRegistry.test.ts` | Updated all `loadTenantConfig` tests for no-argument signature and new endpoint |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.test.ts` | Added 3 tests for `MY_TENANT_ENDPOINTS` |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task210.test.ts` | Added `MY_TENANT_ENDPOINTS` to expected exports and route alignment tests |

### Verification

- API tests: 801 passed (29 files)
- SDK tests: 2480 passed (102 files)
- API build: 7/7 tasks successful
- SDK build: All 5 bundles produced

---

## Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-07 | Initial implementation of auth-based tenant APIs and SDK refactoring | All files listed above |
