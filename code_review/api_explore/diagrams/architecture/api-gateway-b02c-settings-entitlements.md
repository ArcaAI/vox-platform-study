# API Gateway B02c — Settings & Entitlements

Companion explainer for `api-gateway-b02c-settings-entitlements.html`.

## Scope
`B02c` completes `B02` (tenancy/admin): `department`, `global-setting`, `settings-catalog`, `entitlements`, `resource-subscription` (~47 routes est., 11 controllers). Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Key routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| Department | `/admin/departments` + `GET :id/users` | `DepartmentController` (`department/department.controller.ts:24`) | `DepartmentService` (`packages/applications/.../department.service.ts:24`) | Config data store |
| Admin settings | `/admin/settings` tenant/global settings (incl. reveal/rotate), catalog/effective, features effective/matrix, action-confirmations, registry `GET/PUT/DELETE :key` | `GlobalSettingController` (`global-setting.controller.ts:58`), settings-catalog controllers (`settings-catalog.controller.ts:43`, `settings-features.controller.ts:32`, `settings-action-confirmations.controller.ts:27`, `settings-registry-write.controller.ts:43`) | `GlobalSettingService` (`globalSetting.service.ts:34`), `EffectiveSettingsService` (`settings-registry/effective-settings.service.ts`), `SettingsRegistryWriteService` (`settings-registry-write.service.ts:199`), `FeatureAvailabilityService` (policy/effective features) | Config data store; feature enforcement |
| Entitlements | `/admin/entitlements` enabled/plans/tenant overrides/downgrade/trial-expiry + `GET /tenants/me/entitlements` | `EntitlementsAdminController` (`entitlements-admin.controller.ts:37`), `MyEntitlementsController` (`my-entitlements.controller.ts:26`) | `EntitlementsService` (`entitlements.service.ts:140`), `EntitlementsLifecycleService` (`entitlements-lifecycle.service.ts:59`) | Entitlement/config data store; plan/feature enforcement |
| Resource subscriptions | `/admin/resource-subscriptions` CRUD + toggle (6 routes) | `ResourceSubscriptionController` (`resource-subscription.controller.ts:28`) | `ResourceSubscriptionService` (`resourceSubscription.service.ts:24`) | Config data store |

## Example input/output (representative)
- **Global setting reveal/rotate:** `POST :id/reveal` or `:id/rotate` -> revealed/rotated secret metadata (value exposure policy applies).
- **Settings registry/features:** GET effective/features/matrix or PUT matrix/registry key -> resolved/effective settings or updated registry/feature state.
- **Entitlements override/downgrade:** PUT/DELETE tenant override or POST downgrade -> effective plan/override state; `/tenants/me/entitlements` returns resolved entitlements.
- **Department/resource subscription:** CRUD DTOs -> records; toggle changes active state. Verify exact DTO schemas and secret handling.

## Validation / limitations
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 1 crossing (`svc_ent→data_cfg` vs `svc_settings→ext_policy`) and 1 detour (`svc_settings→ext_policy`, 3 bends). Gates pass.
- Limitations: grouped endpoint nodes across 5 modules/11 controllers; settings-catalog service layering summarized via EffectiveSettings/Registry/FeatureAvailability services; reconcile exact route contracts, base CRUD patterns, and secret redaction behavior for strict contracts.
