# TASK-393 — Decouple `TenantConfigResponse` from `GlobalSettingResponse`

- **Ticket:** TASK-393
- **Type:** refactor (DTO / mapper cast-safety)
- **Created:** 2026-07-01
- **Updated:** 2026-07-01
- **Status:** Completed

## 1. Requirement Analysis

### Description

The tenant-config endpoints reused the `GlobalSetting` mapper and cast the result
to the tenant-config DTO:

```ts
return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
```

This is a fragile **superset cast**: it only compiles while `GlobalSettingResponse`
stays structurally assignable-into `TenantConfigResponse`. Any future *required*
field added to `GlobalSettingResponse` that isn't also on `TenantConfigResponse`
breaks `build:api` with `TS2352`. It already forced `GlobalSettingResponse.locked`
to be declared **optional** during TASK-391 (D2) purely to keep the cast compiling.

This is the residual note flagged in **TASK-391 §7.2** ("Owned by the tenant/api
layer, not TASK-391").

### Business context

Pure compile-time / type-safety hardening. No schema, DB, or runtime-contract
change is intended — the same tenant-config data continues to flow to the SDK
`ConfigManager` and the admin console; the fields are simply produced with a
correct, standalone type.

### Acceptance criteria

- [x] No `as PaginatedTenantConfigResponse` / `as TenantConfigResponse` cast remains in the tenant controllers.
- [x] A dedicated, type-safe `TenantConfigDtoMapper` maps the underlying `GlobalSetting` entity → `TenantConfigResponse` / `PaginatedTenantConfigResponse` explicitly (field-by-field).
- [x] `TenantConfigResponse` is a standalone DTO, not implicitly coupled to `GlobalSettingResponse`'s shape.
- [x] `GlobalSettingResponse.locked` restored to its intended required shape (the cast is gone).
- [x] Unit tests for the new mapper (shape + representative row set).
- [x] `@arcaai/applications` type-check clean; new tests green.

## 2. Current State Evaluation

Cast sites found (`as PaginatedTenantConfigResponse` off `GlobalSettingDtoMapper`):

| File | Method | Site |
|---|---|---|
| `apps/api/src/modules/tenant/tenant.controller.ts` | `fetchTenantConfigs` | `... as PaginatedTenantConfigResponse` |
| `apps/api/src/modules/tenant/tenant.controller.ts` | `updateTenantConfigs` | `... as PaginatedTenantConfigResponse` |
| `apps/api/src/modules/tenant/my-tenant.controller.ts` | `myConfig` | `... as PaginatedTenantConfigResponse` (× 2 — mapper cast + object-literal cast) |
| `apps/api/src/modules/tenant/my-tenant.controller.ts` | `updateMyConfig` | `... as PaginatedTenantConfigResponse` |

Both `TenantService.fetchTenantConfigs` and `updateTenantConfigs` already return
`FetchResponse<GlobalSettingEntity>` (`ITenantService`), so the underlying rows are
tenant-scoped `GlobalSettingEntity` instances.

**Key finding — the old cast silently dropped fields.** `GlobalSettingDtoMapper`
builds a `GlobalSettingResponse` via `AutoClassMapper` (→ `AutoEntityMapper`), which
copies only keys present on **both** the entity and a `new GlobalSettingResponse({})`
instance. `GlobalSettingResponse` has no `tenantId` / `tenantCode` / `defaultValue`,
so those were **never populated at runtime** for tenant configs; conversely the
`GlobalSettingResponse.locked` field *was* emitted. Consumers depend on some of these:

- `locked` — the SDK maps locked tenant-config rows into `ConfigManager.lockedPaths` (TASK-244); the admin console renders the lock affordance. **Must be preserved.**
- `defaultValue` — the tenant-config editor's "Restore default" action reads `cfg.defaultValue` (previously always `undefined` → button never shown). Populating it is an additive fix.
- `tenantId` — declared on the DTO contract; previously `undefined`. Additive.
- `tenantCode` — the `GlobalSetting` entity carries no tenant code, so it was (and stays) unset for entity-backed rows.

The admin API client (`apps/ui-playground/.../admin/api/tenants.ts`) types every one
of these as optional with an index signature, so both presence and absence are
tolerated by consumers.

## 3. Implementation Plan

`Database (none) → Domain (none) → Applications (DTO + mapper) → API (controllers)`

1. Refactor `TenantConfigResponse` to a dedicated `TenantConfigResponseProps extends BaseResponseProps` constructor (mirrors `ApiKeyResponse`) so it can be built directly from a `GlobalSettingEntity`'s `Date` timestamps; add `locked?`; make `tenantCode?` optional.
2. Add `TenantConfigDtoMapper` (`ToResponse` / `ToPaginatedResponse`) — explicit field-by-field, no reflection, no `GlobalSettingResponse` involvement.
3. Export it from the tenant barrel.
4. Replace all cast sites in both controllers; `myConfig` builds `new PaginatedTenantConfigResponse({...})` for the synthetic-row append.
5. Restore `GlobalSettingResponse.locked` to required and delete the cast-only NOTE.
6. Unit tests for the mapper.
7. **Verify by type-check only** (no `build:api`, no `dev:api:test` restart — the live `:8868` stack is owned by a parallel worker; `tsc --noEmit` does not touch `dist`).

## 4. Implementation Summary

### Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/tenant/dto/tenantConfig.response.ts` | Added `TenantConfigResponseProps extends BaseResponseProps`; new `constructor(props)`; added `locked?: boolean`; `tenantCode?` now optional; optional string fields allow `null` (matches entity + consumer). |
| `packages/applications/src/services/tenant/tenantConfig.dto.mapper.ts` | **New.** `TenantConfigDtoMapper.ToResponse` / `.ToPaginatedResponse` — explicit field-by-field mapping of `GlobalSettingEntity` → `TenantConfigResponse`. |
| `packages/applications/src/services/tenant/index.ts` | Export the new mapper. |
| `packages/applications/src/services/tenant/__tests__/tenantConfig.dto.mapper.test.ts` | **New.** 16 cases — shape, base-field/timestamp normalisation, the tenantId/defaultValue/locked the old cast dropped, null handling, data types, and a representative paginated row set. |
| `packages/applications/src/services/globalSetting/dto/globalSetting.response.ts` | `locked` restored to required (`locked!: boolean`); removed the cast-only optional NOTE. |
| `apps/api/src/modules/tenant/tenant.controller.ts` | Import `TenantConfigDtoMapper` (was `GlobalSettingDtoMapper`); both config endpoints return `TenantConfigDtoMapper.ToPaginatedResponse(result)` — casts removed. |
| `apps/api/src/modules/tenant/my-tenant.controller.ts` | Same import swap; `myConfig` maps via `TenantConfigDtoMapper` and appends the synthetic raw-capture row via `new PaginatedTenantConfigResponse({...})`; `updateMyConfig` returns the mapper result — all three casts removed. |

### Design decisions & deviations

- **Scope — both tenant controllers.** The ticket names `tenant.controller.ts`, but `my-tenant.controller.ts` carried the same fragile cast (× 3, incl. an object-literal cast). Leaving it would defeat the goal ("no unsafe cast remains"), and it is squarely on the tenant-config controller surface (not in the DO-NOT-TOUCH set). Both were fixed.
- **`locked` kept on the tenant-config response.** It is load-bearing (SDK `ConfigManager.lockedPaths`, TASK-244), so the standalone DTO declares it independently (sourced from the entity, not from `GlobalSettingResponse`) — decoupled, not re-coupled.
- **`GlobalSettingResponse.locked` → required.** Verified only the mapper + its unit test construct `GlobalSettingResponse` (the generic `new target(...)` path is untyped, and the test always supplies `locked`); the `/admin/settings` consumer already guards it. Restoring it is the intended shape now that the cast is gone.
- **Runtime delta (additive).** vs. the old cast, entity-backed rows now additionally carry `tenantId` and `defaultValue` (previously dropped); `locked` is retained; `tenantCode` stays unset. Consumers treat all as optional (index signature), so this is a superset — no consumer loses a field, and "Restore default" is fixed. A runtime E2E is **deferred to a consolidated pass** (the live stack is owned by a parallel worker; not rebuilt here).

### Verification (type-check only — no `build:api`, no stack restart)

- `pnpm --filter @arcaai/applications typecheck` (`tsc --noEmit`) → **clean (exit 0)**. This is the core compile-time verification for the cast-safety fix (the DTO + mapper live here).
- Tenant controllers type-checked read-only against fresh `@arcaai/applications` **source** (temporary `noEmit` tsconfig with a `paths` override, since the api otherwise resolves `@arcaai/applications` from stale `dist` which must not be rebuilt) → **0 errors** in both controllers. Temp config removed.
- `vitest run` (applications) for `tenantConfig.dto.mapper.test.ts` + `globalSetting.dto.mapper.test.ts` → **45 passed / 0 failed** (new mapper green; `globalSetting` mapper unaffected by the `locked`-required change).

> Not run (by constraint): `pnpm build:api`, `dev:api:test` restart, and the api-side controller unit tests (they import `@arcaai/applications` from `dist`, which is intentionally not rebuilt). Runtime E2E deferred to a consolidated pass.

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-01 | Ticket created and completed. Introduced `TenantConfigDtoMapper`, decoupled `TenantConfigResponse` from `GlobalSettingResponse`, removed all 4 fragile casts across both tenant controllers, restored `GlobalSettingResponse.locked` to required, added mapper unit tests. Resolves the TASK-391 §7.2 residual note. | see §4 |
