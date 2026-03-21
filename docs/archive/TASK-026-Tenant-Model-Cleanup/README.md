# TASK-026: Tenant Model Cleanup

| Field            | Value            |
| ---------------- | ---------------- |
| **Ticket Number** | TASK-026        |
| **Created Date**  | 2026-02-19      |
| **Last Updated**  | 2026-02-19      |
| **Status**        | Completed       |

---

## Requirement Analysis

### Description

Remove the `appName` field from the Tenant model and clean up the tenant seed data. The Tenant model represents a customer environment, and `appName` was an unnecessary field that created confusion between internal service identifiers and customer-facing concepts.

### Business Context

- A tenant represents a customer environment
- A customer can create many tenants as needed
- The `appName` field was not used by any downstream seed data or business logic beyond the Tenant CRUD itself
- Seed data is updated to reflect real customer environments: Global (system), ArcaAI, and 4bits

### Acceptance Criteria

- [x] `appName` field removed from Tenant Prisma schema
- [x] Tenant seed data updated to 3 tenants: Global, ArcaAI, 4bits
- [x] `appName` removed from domain layer (Entity, Model, Factory)
- [x] `appName` removed from application layer (DTOs, Service, Interface)
- [x] `fetchAllByAppName` API endpoint removed
- [x] All related tests updated
- [x] Documentation updated

---

## Current State Evaluation

### Before Changes

The Tenant model included an `appName` field with values like `__global__`, `flw`, `api`, `bot` that looked like internal service identifiers rather than customer-facing names. The field was exposed through:

- Prisma schema (`tenant.prisma`)
- Domain layer: `ITenantEntity`, `TenantEntity`, `TenantModel`, `TenantFactory`
- Application layer: `CreateTenantRequest`, `UpdateTenantRequest`, `TenantResponse`, `ITenantService`, `TenantService`
- API layer: `TenantController` with a dedicated `GET /tenants/app-name/:app-name` endpoint
- Tests: Unit tests and E2E tests

Additionally, the tenant seed had a bug where errors were silently swallowed (no `throw error` in the catch block).

---

## Implementation Plan

1. **Database**: Remove `appName` from `tenant.prisma` (migration required)
2. **Seed**: Rewrite `05-tenant.ts` with Global, ArcaAI, 4bits tenants
3. **Domain**: Remove `appName` from Entity, Model, Factory
4. **Application**: Remove `appName` from DTOs, Service interface, Service implementation
5. **API**: Remove `fetchAllByAppName` endpoint from controller
6. **Tests**: Update unit tests and E2E tests
7. **Docs**: Update ERD in `plan-01-prisma-changes.md`, create this document

---

## Implementation Summary

### Database Changes

**File**: `packages/database/src/prisma/db_main/tenant.prisma`
- Removed `appName String` field from Tenant model
- **Migration required**: `ALTER TABLE "Tenant" DROP COLUMN "appName"`

### Seed Data Changes

**File**: `packages/database/src/prisma/db_main/seed/05-tenant.ts`
- Replaced 4 tenants (Global, Marketing Agency, Customer Support, Development Team) with 3 tenants:
  - **Global** (`__GLOBAL__`) — system-wide default, structurally separated
  - **ArcaAI** (`ARCAAI`) — customer environment
  - **4bits** (`4BITS`) — customer environment
- Exported `DEFAULT_TENANT_ID` and `ALL_TENANTS` for reuse
- Fixed silent error swallowing: added `throw error` in catch block

### Domain Layer Changes

| File | Change |
| ---- | ------ |
| `packages/domains/src/entities/generated/core/TenantEntity.ts` | Removed `appName` from `ITenantEntity` interface and `TenantEntity` class (field, getter, setter, constructor) |
| `packages/domains/src/models/generated/core/TenantModel.ts` | Removed `appName` property and constructor assignment |
| `packages/domains/src/factories/generated/core/TenantFactory.ts` | Removed `appName` from `CreateTenantProps` interface and factory method |

### Application Layer Changes

| File | Change |
| ---- | ------ |
| `packages/applications/src/services/tenant/dto/createTenant.request.ts` | Removed `appName` field |
| `packages/applications/src/services/tenant/dto/updateTenant.request.ts` | Removed `appName` field |
| `packages/applications/src/services/tenant/dto/tenant.response.ts` | Removed `appName` field |
| `packages/applications/src/services/tenant/ITenantService.ts` | Removed `fetchAllByAppName` method |
| `packages/applications/src/services/tenant/tenant.service.ts` | Removed `fetchAllByAppName` implementation |

### API Layer Changes

| File | Change |
| ---- | ------ |
| `apps/api/src/modules/tenant/tenant.controller.ts` | Removed `GET /tenants/app-name/:app-name` endpoint |

### Test Changes

| File | Change |
| ---- | ------ |
| `packages/applications/src/services/tenant/__tests__/tenant.service.test.ts` | Removed `appName` from mock factory, removed `fetchAllByAppName` test block, updated all `create()` calls |
| `apps/api/tests/e2e/tenants.spec.ts` | Removed `GET /tenants/app-name/:appName` test block |

### Documentation Changes

| File | Change |
| ---- | ------ |
| `docs/implementation/SDK-200-Agentic-SDK-V2/plan-01-prisma-changes.md` | Removed `appName` from Tenant ERD |
| `docs/implementation/TASK-026-Tenant-Model-Cleanup/README.md` | This document |

---

## Deployment Notes

### Migration

After merging, run the Prisma migration to drop the `appName` column:

```bash
npx prisma migrate dev --name remove_tenant_appname
```

### Seed

Re-run the seed to update tenant records:

```bash
npx prisma db seed
```

### Breaking Changes

- **API**: The `GET /tenants/app-name/:app-name` endpoint is removed
- **Create Tenant**: The `appName` field is no longer accepted in create/update requests
- **Response**: The `appName` field is no longer returned in tenant responses
