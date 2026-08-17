# Traceability — Tenancy, Provisioning, Entitlements & Settings Control Plane

Tenant lifecycle and provisioning, the SDK-facing tenant frontend config, plan
entitlements + usage metering, users / profiles / departments, and the TASK-504 **settings
control plane** (the typed catalog / registry / effective-config facade layered over the raw
`GlobalSetting` store). Migrates legacy matrix rows **4**, **5**, **6**, **7**, and adds the
settings-control-plane row that never had a legacy home (the Wave-1 P1 gap: `settings-catalog`
shares `/admin/settings` with row-30 `global-setting` and needed its own row + disambiguation).

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

The raw global-settings store + secrets (legacy row **30**, `global-setting`) is migrated in
[`platform-ops.md`](./platform-ops.md) (PO2); TP6 below documents the typed control plane over
it and disambiguates the shared `/admin/settings` base. The tenant pipeline-template resync
route (`admin/tenants/:id/pipelines/resync`, physically on the `tenant` module) is a
transcription concern and is migrated in [`transcription.md`](./transcription.md).

## Capabilities

### TP1 — Tenant management & platform plans — legacy row 4

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/tenant` (`tenant.controller.ts`, `my-tenant.controller.ts`, `tenant-provision.controller.ts`); `packages/applications/src/services/tenant` (`tenant.service.ts`) |
| Prisma models | `Tenant` (`db_main/tenant.prisma`); `Tag` (`db_main/tag.prisma`, via `:id/tags`) |
| Key API endpoints | `@Controller('admin/tenants')` (class `@CanAny(['manage','Tenant'],['update','Tenant'])`): `POST ''`, `GET ''`, `GET user/:userId`, `GET :id`, `GET code-name/:code-name`, `PATCH :id`, `DELETE :id`, `GET :id/usage`, `POST :id/{suspend,archive,restore}` (each `@CanManage('Tenant')`), `GET/PUT :id/tags`, `GET configs/:identifier`, `PATCH configs/:identifier`. `@Controller('admin/tenants')` `TenantProvisionController`: `POST provision` (`@CanManage('Tenant')`). Self-service `@Controller('tenant')` (`@Authorize()`): `GET me`, `GET me/config`, `PATCH me/config` (`@Authorize(['update','Tenant'])`) |
| Console | `apps/admin-console` feature `tenants` (`tenants-list-screen`, `tenant-detail-screen`, `create-tenant-dialog`, `tenant-lifecycle-dialogs`, `tenant-usage-tab`, `tenant-tags-tab`); routes `/tenants`, `/tenants/[id]` (tier 10–19, global) |
| Tests | unit(app): `tenant/__tests__/*` (`tenant.service`, `tenant.service.lifecycle`, `tenant.service.mass-assignment`, `tenant.service.audit-scrub*`, `tenant.service.locked-runtime`, `tenantKey`, `createTenant.request`); unit(api): `tenant/__tests__/tenant-provision.controller.test.ts`; unit(console): `tenants/components/__tests__/{tenants-list-screen,tenant-detail-screen,create-tenant-dialog}.test.tsx`, `tenants/api/__tests__/*`; e2e: `tenants.spec.ts`, `tenant-detail-contract.spec.ts`, `tenant-dashboard-sources.spec.ts`, `tenant-data-model-contract.spec.ts`, `tenant-access-control.spec.ts` |

### TP2 — Tenant frontend / pipeline config (SDK defaults) — legacy row 5

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/tenant-frontend-config` (`tenant-frontend-config-admin.controller.ts`); `packages/applications/src/services/tenant-frontend-config` (`tenant-frontend-config.service.ts`) |
| Prisma models | `TenantFrontendConfig` (`db_main/tenant.prisma`) |
| Key API endpoints | `@Controller('admin/tenant-frontend-config')` (`@CanAny(['manage','Tenant'],['update','Tenant'])`): `GET ''`, `PUT ''`. Effective config resolved into `GET /tenant/me/config` (TP1) |
| Console | surfaced inside the tenants detail screen (`tenants/components/tenant-frontend-config-tab.tsx`); no standalone route |
| Tests | unit(app): `tenant-frontend-config/__tests__/*` (`tenant-frontend-config.service`, `tenant-frontend-config.dto.mapper`, `capture-mode.translation`, `upsert-tenant-frontend-config.request`); e2e: `admin-features-contract.spec.ts` (partial) |

### TP3 — Entitlements & usage metering — legacy row 6

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/entitlements` (`entitlements-admin.controller.ts`, `my-entitlements.controller.ts`); `packages/applications/src/services/entitlements` (`entitlements.service.ts`, `entitlements-lifecycle.service.ts`, `enforcement.ts`, `resolve-entitlements.ts`, `model-access.ts`), `packages/applications/src/services/metering` (`metering.service.ts`) |
| Prisma models | `PlanEntitlement`, `TenantEntitlement`, `TenantUsageMeter` (`db_main/entitlement.prisma`) |
| Key API endpoints | `@Controller('admin/entitlements')` (class `@Authorize(['manage','all'])` — SUPER_ADMIN): `GET/PUT enabled`, `GET plans`, `GET plans/:plan`, `PATCH plans/:plan`, `GET tenants/:tenantId`, `GET/PUT/DELETE tenants/:tenantId/override`, `POST tenants/:tenantId/downgrade`, `POST trial-expiry/run`. `@Controller('entitlements')`: `GET me` (`@Authorize(['read','Tenant'])`) |
| Console | `apps/admin-console` feature `entitlements` (`entitlements-screen`, `plan-edit-dialog`, `tenant-override-panel`); route `/entitlements` (tier 10–19, global) |
| Tests | unit(app): `entitlements/__tests__/*` (`entitlements.service`, `entitlements-lifecycle.service`, `enforcement`, `resolve-entitlements`, `model-access`, `rate-limit-plan`), `metering/__tests__/{metering.service,metering-window}.test.ts`; unit(console): `entitlements/components/__tests__/entitlements-screen.test.tsx`; e2e: `super-admin-backend-backlog.spec.ts` (partial) |

### TP4 — Users & profiles — legacy row 7 (user half)

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/user` (`user.controller.ts`; `controllers/{user-roles,user-departments,user-departments-me,user-settings,user-preferences}.controller.ts`; `user-export.service.ts`); `packages/applications/src/services/user` |
| Prisma models | `User`, `UserSettings`, `UserProfile`, `UserMedia`, `UserDepartment` (`db_main/user.prisma`) |
| Key API endpoints | `@Controller('admin/users')`: `POST ''`, `GET ''`, `GET export`, `GET :id`, `GET tenant/:tenantId`, `PATCH :id`, `PATCH :id/status`, `DELETE :id`, `DELETE bulk`, `POST bulk-actions`, `GET :id/api-keys`, `GET :id/settings`, `PATCH :id/settings/:namespace/:key`, `POST :id/reset-password`, `GET/POST :id/roles`, `DELETE :id/roles/:assignmentId`, `GET/PATCH :id/profile`, `GET :id/voice-profiles`, `PATCH :id/departments`. Self-service `@Controller('user/me/settings')`, `@Controller('user/me/preferences')`, `@Controller('user/me/departments')` |
| Console | `apps/admin-console` feature `users` (`users-list-screen`, `user-detail-screen` + `user-{roles,departments,settings,profile,security}-tab`, `create-user-dialog`, `user-action-dialogs`); routes `/users`, `/users/[id]` (tier 20–29, shared) |
| Tests | unit(app): `user/__tests__/*` (user service suite); unit(api): `user/__tests__/{user.controller,user-export.service}.test.ts`, `user/controllers/__tests__/{user-roles,user-departments-me,user-settings}.controller.test.ts`; unit(console): `users/components/__tests__/{users-list-screen,user-detail-screen}.test.tsx`; e2e: `users-management-contract.spec.ts`, `users-backend-backlog.spec.ts`, `users-bulk-role-export.spec.ts` |

### TP5 — Departments — legacy row 7 (department half)

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/department` (`department.controller.ts`); `packages/applications/src/services/department` (`department.service.ts`, `department-prompt-config.service.ts`, `department-users.service.ts`) |
| Prisma models | `Department` (`db_main/department.prisma`); `UserDepartment` (membership) |
| Key API endpoints | `@Controller('admin/departments')` (class `@CanManage('Department')`): `POST ''`, `GET ''`, `GET roots`, `GET :id`, `GET code/:code`, `GET :id/children`, `PATCH :id`, `PATCH :id/prompt-config` (`@Authorize(['manage','Department'])`), `DELETE :id`, `GET :id/users`. `PATCH :id/prompt-config` binds a department's prompt configuration — the prompt-template side is documented in [`summarization.md`](./summarization.md) |
| Console | `apps/admin-console` feature `departments` (`departments-screen`, `department-detail`, `department-hierarchy-panel`, `department-members-panel`, `department-prompt-config-panel`); route `/departments` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `department/__tests__/*` (`department.service`, `department-prompt-config.service`, `department-users.service`, `department.dto.mapper`); unit(console): `departments/components/__tests__/departments-screen.test.tsx`, `departments/api/__tests__/departments-api.test.ts`; e2e: covered incidentally by tenant / users suites — no dedicated `department` e2e spec |

### TP6 — Settings control plane (typed catalog / registry / effective-config, TASK-504)

The TASK-504 control plane: a **code-defined** settings registry (feature descriptor arrays) that
catalogs the admin-controllable settings across tiers, resolves an effective value per scope, and
persists overrides into `GlobalSetting`. It shares the `/admin/settings` base with the raw
`global-setting` store (PO2 in [`platform-ops.md`](./platform-ops.md)) — see the disambiguation note.

| Field | Value |
|---|---|
| App / service | `apps/api` (+ internal effective-config route consumed by Python services) |
| Key modules | `apps/api/src/modules/settings-catalog` (`settings-catalog.controller.ts`, `settings-registry-write.controller.ts`); `apps/api/src/modules/internal` (`effective-config.controller.ts`, `internal-service-token.guard.ts`); `packages/applications/src/services/settings-registry` (`registry.ts` = `HOPE_SETTINGS_REGISTRY`, `descriptors/*`, `settings-registry-write.service.ts`, `effective-settings.service.ts`, `scope-cascade.ts`), `packages/applications/src/services/effective-config` (`effective-config.service.ts`), `packages/applications/src/services/config-resolver` (`config-resolver.service.ts`) |
| Prisma models | `GlobalSetting` (`db_main/globalSetting.prisma`) — override values persist here; the descriptor catalog is code (`settings-registry`), not a table |
| Key API endpoints | `@Controller('admin/settings')` `SettingsCatalogController`: `GET catalog`, `GET effective` (both `@CanRead('GlobalSetting')`). `@Controller('admin/settings')` `SettingsRegistryWriteController`: `GET registry/:key` (`@CanRead('GlobalSetting')`), `PUT registry/:key` (`@CanManage('GlobalSetting')`; If-Match precondition handled manually in the handler — deliberately NOT `@RequiresIfMatch()`). `@Controller('internal/effective-config')`: `GET ''` (internal service token — Python-service consumer of resolved settings) |
| Console | `apps/admin-console` feature `settings` (`settings-screen`, `setting-drawer`, `value-editor-pane`, `setting-history-tab`); route `/settings` (tier 20–29, shared) |
| Tests | unit(app): `settings-registry/__tests__/*` (`settings-registry`, `effective-settings.service`, `scope-cascade`, `settings-registry-write.service`, `settings-registry-write.occ`, `model-retention.descriptors`), `effective-config/__tests__/effective-config.service.test.ts`, `config-resolver/__tests__/config-resolver.service.test.ts`; unit(api): `settings-catalog/__tests__/settings-catalog.controller.test.ts`, `internal/__tests__/effective-config.controller.test.ts`; unit(console): `settings/components/__tests__/{settings-screen,setting-drawer,value-editor-pane}.test.tsx`; e2e: `settings-list-faceting.spec.ts` (list faceting; no dedicated end-to-end registry-write spec) |

## Honest notes / gaps

- **`/admin/settings` is shared by two capabilities.** The raw KV + secrets store (`global-setting`, legacy row 30) lives in [`platform-ops.md`](./platform-ops.md) (PO2); the TASK-504 typed control plane (`settings-catalog` + `settings-registry-write` + effective-config) is TP6 here. They mount on the same base path but are distinct controllers; overrides written through the registry persist into `GlobalSetting`.
- **Password reset is NOT in this domain.** The `user` module also hosts `forgot-password.controller.ts` (`@Controller('auth')`) and `password-reset.controller.ts` (`@Controller('users/password-reset')`), plus `admin/users/:id/reset-password`; the forgot-password / reset flow is legacy row 8, migrated in [`auth-identity.md`](./auth-identity.md). TP4 records the user-management surface only.
- **Tenant pipeline resync is a transcription concern.** `tenant-pipeline-resync.controller.ts` (`POST admin/tenants/:id/pipelines/resync`, TASK-531) sits on the `tenant` module physically but governs ASR pipeline-template propagation — migrated in [`transcription.md`](./transcription.md).
- **Department prompt-config crosses into summarization.** `PATCH admin/departments/:id/prompt-config` is on the department controller (TP5) but binds prompt templates; the template governance side is in [`summarization.md`](./summarization.md).
- **No dedicated department e2e.** TP5 relies on unit(app) + unit(console); department behavior is exercised only incidentally by the tenant/users e2e suites.

Last verified: 2026-07-22
