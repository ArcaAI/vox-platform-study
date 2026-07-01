# TASK-390 — Super-Admin Tier Backend Backlog (§3a Group E)

| | |
|---|---|
| **Ticket** | TASK-390 |
| **Title** | CASL policy-rules editing (system-lockout guard) · API-key rotate endpoint · global-settings CRUD · audit-trail Excel/PDF export |
| **Type** | `feature` (backend + SDK) — **#22 is authorization-sensitive** |
| **Created** | 2026-07-01 |
| **Updated** | 2026-07-01 |
| **Status** | Completed (backend + SDK + tests; FE surfaces largely UNBUILT per review §3b — a separate effort) |
| **Owner** | Backend / Platform (super-admin tier) |
| **Source review** | `docs/admin-console-open-items-review.md` §3a items **#22, #23, #24, #25** (read-only reference) |
| **Depends on** | TASK-386/387/388 (uncommitted; built **on top**) — reuses the **TASK-388 export utility** for #25 (shared, not duplicated) |
| **Unblocks** | TASK-371 Roles & Policies builder (R3), API Keys (K5), Settings (ST1), Audit export (AU2) — FE is out of scope here |

> **Ticket-number check:** `docs/implementation/` highest existing is **TASK-388** (+ TASK-389 created in the same pass); **TASK-390** is the next free number (confirmed by directory listing 2026-07-01).

---

## 1. Requirement Analysis

Implements **§3a backlog Group E** (the "super-admin tier" cluster) — four items behind the (largely unbuilt) super-admin FE surfaces.

| # | Item | Review ref | Layer surface |
|---|---|---|---|
| 22 | CASL policy-rules editing via `policies.controller.ts` — **AUTH-SENSITIVE** | R3 | applications guard on existing CRUD |
| 23 | API-key **rotate** endpoint | K5 | API controller route + SDK (service method pre-exists) |
| 24 | Global-settings CRUD `admin/settings` | ST1 | new API module/controller wiring the existing service + SDK (already wired) |
| 25 | Audit-trail **Excel / PDF** export (CSV exists) | AU2 | shared export utility (reused from TASK-388) + API |

### Acceptance criteria

- **#22** — Policy rules are editable through `PoliciesController` (create/update/patch/**softDelete**), and the platform is protected from the classic RBAC foot-gun: an admin **cannot** delete, scope-change, disable, or strip `manage:all` from the **system-critical GLOBAL policies** (`system-full-access`, `rbac-system-manage`) that grant super-admins access — doing so would lock every super-admin out. All other policies stay fully editable. Thorough tests; the exact protected surface is FLAGGED for review.
- **#23** — `POST /admin/api-keys/:id/rotate` mints a new raw key (returned **once**), links old→new, and is tenant-scoped + CASL-gated. The SDK exposes `rotate(id)`.
- **#24** — CRUD on global settings (`GET/POST` list+create, `GET/PATCH/DELETE :id`, `GET tenant/:tenantId`) reusing the existing `GlobalSetting` model + `GlobalSettingService`; OCC-enforced PATCH (`If-Match`). No schema change.
- **#25** — `GET /admin/audit-logs/export?format=csv|xlsx|pdf` streams the filtered, tenant-scoped audit set in the requested format, reusing the **TASK-388 export utility** (factored to a shared location; the TASK-388 user-export callsite kept working).

**Net: zero database / migration changes.** Every model / column / enum / CASL subject already exists.

---

## 2. Current State Evaluation

- **#22 — CRUD already exists; the GUARD is the gap.** `PoliciesController` (`@Controller('admin/rbac/policies')`, `@CanManage('Policy')`) already exposes `POST` (create), `PUT`/`PATCH` (update), `DELETE` (softDelete), `POST /validate`. `PolicyService` (applications) validates rules, invalidates the policy-engine cache, broadcasts SysEvents, and soft-deletes via `PolicyRepository`. **What is missing is any protection** — nothing stops an admin from `DELETE`-ing or gutting the seeded GLOBAL `system-full-access` (`{ action:'manage', subject:'all' }`, id `00000000-0000-0000-0001-000000000001`) or `rbac-system-manage` (id `…010`), which back the super-admin `manage:all` grant. Removing them locks out **every** super-admin platform-wide. Seed: `packages/database/src/prisma/db_main/seed/01-policy.ts`.
- **#23 — service exists; controller route missing.** `ApiKeyService.rotateKey(apiKeyId)` is **already fully implemented** (`packages/applications/.../apiKey/apikey.service.ts`) and on `IApiKeyService`: it generates a new secure key inheriting the old key's config, links them (`rotatedFromKeyId`/`rotatedToKeyId`), sets a **24-hour overlap window** (`rotationExpiresAt`), blocks cross-tenant / revoked / expired rotation, and returns `{ newRawKey, newApiKey }`. But `ApiKeyController` exposes only create/list/get/update/delete/revoke/usage — **no `rotate` route**. The SDK `useApiKeys` likewise has no `rotate`.
- **#24 — model + domain + service + SDK hook exist; API controller missing.** The `GlobalSetting` Prisma model + full domain (entity/factory/mapper/model/repository) + `GlobalSettingService` (full CRUD incl. OCC `updateWithVersion` + `locked`-row guard + soft delete) + DTOs + the SDK `useGlobalSettings` hook all exist. But **no controller serves `/admin/settings`** (verified: no `@Controller('admin/settings'|'admin/global-settings'|'settings')` anywhere; the `GlobalSettingServiceModule` is not imported by any API module). The SDK hook targets `GLOBAL_SETTINGS_ENDPOINTS = { LIST/GET/CREATE/UPDATE/DELETE '/admin/settings…', BY_TENANT '/admin/settings/tenant/:id' }` — currently 404. CASL subject `GlobalSetting` is seeded (`global-settings-manage` + `tenant-full-access`).
- **#25 — CSV only.** `AuditLogController.exportCsv` (`GET /admin/audit-logs/export`) streams CSV via `AuditLogDtoMapper.ToCsv` (12 columns + optional `tenantId`), tenant-scoped (super-admin cross-tenant when unscoped). No xlsx/pdf. The TASK-388 `UserExportService` (`apps/api/.../user/user-export.service.ts`) already builds csv/xlsx/pdf via `exceljs` + `pdfkit` (both already in `apps/api` deps) — the reusable engine for this item.

---

## 3. Product / AUTH decisions (made + FLAGGED)

> Reasonable, documented defaults so implementation isn't blocked. **#22 is authorization-sensitive — flagged prominently for review.**

1. **#22 — Protected editable surface (RATIFIED — user, 2026-07-01).** The chosen guard, enforced in `PolicyService` (service layer, so it holds for every caller/route):
   - **Protected set = the seeded system-critical GLOBAL policies, by name:** `system-full-access` and `rbac-system-manage`. (Identified by name — stable, explicit, matches the seed; the two policies that, if removed, break super-admin/RBAC administration platform-wide.)
   - On a protected policy, the service **refuses**: `softDelete` (409/400), any `update`/`patch` that would (a) change `scope` away from `GLOBAL`, (b) set `resourceStatus` to anything other than `ENABLED` (i.e. disable it), or (c) remove the load-bearing rule — `manage:all` for `system-full-access`; the `manage:Role`/`manage:Policy`/`manage:RolePolicy`/`manage:UserRoleAssignment` set for `rbac-system-manage`. Renaming/description/adding rules is still allowed (non-destructive).
   - **Everything else is fully editable** — all TENANT policies and any non-protected GLOBAL policy: full create / update / patch / softDelete, exactly as before.
   - **No weakening of existing behaviour:** the guard only *adds* refusals; the seed is never mutated by this change; CASL gating (`@CanManage('Policy')`, super-admin `manage:all`) is unchanged. A dedicated error message names the reason ("… is a protected system policy and cannot be deleted/…").
   - **RATIFIED (user, 2026-07-01):** Confirmed — **absolute** protection of the seeded system-critical GLOBAL policies `system-full-access` + `rbac-system-manage` (even SUPER_ADMIN cannot delete/disable them or strip their load-bearing rules); this is intentional anti-lockout, not a bug. Residual (non-blocking) notes: (a) the protected set is name-based — if a deployment renames these seeded policies the guard must be updated; (b) an alternative "require a second confirmation / break-glass" flow is a possible future refinement.
2. **#23 — Rotation semantics = 24-hour grace window (FLAG).** The pre-existing `ApiKeyService.rotateKey` keeps **both** the old and new key valid for a 24 h overlap (`rotationExpiresAt = now + 24h`) rather than immediately invalidating the old key. This is the intentional zero-downtime rotation posture (clients cut over before the old key lapses). This ticket **exposes** that behaviour unchanged; it does **not** switch to immediate invalidation. **FLAG:** if an immediate-invalidation (revoke-on-rotate) option is wanted, that's an additive service flag + a controller query param. The new raw key is returned exactly once (same contract as create).
   - **RESOLVED (auth posture — owner-scope enforced; TASK-390 follow-up).** The by-id api-key operations now enforce **owner-scope** on top of tenant isolation. `ApiKeyService` gained two private helpers alongside `assertTenantOwnership`: `callerCanManageAllKeys()` — true for SUPER_ADMIN, or any caller whose compiled CASL ability (pinned to CLS as `userAbility` by `AuthorizationGuard`) can `manage:ApiKey` (a tenant admin via `tenant-full-access`); and `assertKeyAccess(key, id)` — runs `assertTenantOwnership` first, then, for owner-only callers **lacking** the broad `manage:ApiKey` grant, additionally requires `key.userId === caller.userId`, else throws `NotFoundException`. All five by-id paths (`fetchById`/`update`/`deleteById`/`revokeKey`/`rotateKey`) now call `assertKeyAccess`. **No seeded rule/policy edit and no migration** — enforcement is in code; delete still uses the domain `softDelete`; `404` (not `403`) preserves the module's existing not-authorized convention (never leak that another user's key exists). Before/after authz matrix (× rotate / revoke / delete / fetch by-id):

     | Caller | Own key | Peer's key (same tenant) | Cross-tenant key |
     |---|---|---|---|
     | **owner-only** (`api-key-own-manage`) | ✅ before & after | ⚠️ allowed *before* → **404 after (FIXED)** | 404 before & after |
     | **tenant-admin** (`manage:ApiKey`) | ✅ | ✅ tenant-scoped — unchanged | 404 — unchanged |
     | **SUPER_ADMIN** (`manage:all`) | ✅ | ✅ | ✅ broad — unchanged |

     Coverage: service unit tests (`apikey.service.test.ts` → "Owner-scope enforcement (TASK-390 follow-up)") + live E2E `apps/api/tests/e2e/task-390b-api-key-owner-scope.spec.ts` (owner own-key fetch/rotate/revoke/delete ✓; same-tenant peer → 404 ✓; tenant-admin + super-admin retain their scope ✓; out-of-scope id → 404 ✓).
3. **#24 — Mount path = `admin/settings`; schema reused (RATIFIED — user, 2026-07-01).** The controller is mounted at `@Controller('admin/settings')` to match the **existing, tested SDK contract** (`GLOBAL_SETTINGS_ENDPOINTS`), making `useGlobalSettings` work end-to-end. The review labels the item `admin/global-settings`; the shipped route is `admin/settings` (SDK-driven) — **RATIFIED (user, 2026-07-01): keep `admin/settings`** (an `admin/global-settings` alias may still be added later if desired, but is not required). **Schema decision:** the existing `GlobalSetting` model (key/value/`dataType`/namespace/`locked`/tenantId + OCC `version`) is **reused as-is — no additive table** (it already matches the key/value/type shape TASK-386 referenced). CASL `@CanManage('GlobalSetting')` (writes) / `@CanAny(['read','GlobalSetting'],['manage','GlobalSetting'])` (reads); tenant-scoped by the Prisma tenant extension + super-admin bypass; OCC PATCH via `@RequiresIfMatch()`. The `locked`-row super-admin guard in the service is preserved. **Scope note:** the `TENANT_CONFIG` SDK route (`/admin/settings/tenant/:id/config`, a resolved-config concern) is **out of scope** here (separate tenant-frontend-config feature) — documented follow-up.
4. **#25 — Reuse the TASK-388 exporter via a shared module (FLAG).** The generic table→csv/xlsx/pdf builder is factored out of `UserExportService` into a shared `apps/api/src/shared/table-export.ts` (pure, column-driven). `UserExportService` is refactored to **delegate** to it — its public API + unit test are unchanged (TASK-388 callsite keeps working). The audit export reuses the same shared builder with the audit column set (mirrors `AuditLogDtoMapper.ToCsv`: 12 columns + optional `tenantId`, `data` JSON stringified). The existing `GET /admin/audit-logs/export` gains a `?format=csv|xlsx|pdf` param (default `csv` → **back-compatible**), streamed via `StreamableFile`. No new deps (`exceljs`/`pdfkit` already present). **FLAG:** CSV output is byte-identical to today; xlsx/pdf mirror the same columns/scope/row-cap.

---

## 4. Implementation Plan (STRICT layer chain + TDD)

**Applications → API → SDK**, RED test first per behaviour. No DB / Domain / migration for any item.

- **#22** — `PolicyService`: add `PROTECTED_SYSTEM_POLICY_NAMES` + a private `assertNotProtectedMutation()` / `assertNotProtectedDelete()`; call from `update`/`patch`/`softDelete`. Unit tests (`__tests__/policy.service.system-guard.test.ts`): delete/disable/scope-change/rule-strip of each protected policy → throws; safe rename/add-rule → allowed; non-protected policy → unaffected. Controller maps the new error to a 4xx.
- **#23** — `ApiKeyController`: `POST :id/rotate` → `apiKeyService.rotateKey(id)` → `CreateApiKeyResponse { apiKey, rawKey }`, `@CanUpdate('ApiKey')` (mirrors `revoke`). SDK `useApiKeys.rotate(id)` + `API_KEY_ENDPOINTS.ROTATE(id)`. Tests: API controller unit, SDK hook unit.
- **#24** — new `apps/api/src/modules/global-setting/{global-setting.controller.ts, global-setting.module.ts, index.ts}` wiring `IGlobalSettingService` + `GlobalSettingDtoMapper`; register in `app.module.ts`. CRUD + OCC (`@RequiresIfMatch()` PATCH + `@ExpectedVersion()`), ETag auto-emitted by the global `ETagInterceptor` (response carries `version`). Tests: controller unit (CRUD + super-admin/tenant scope + OCC fold).
- **#25** — `apps/api/src/shared/table-export.ts` (pure csv/xlsx/pdf builders, column-driven); refactor `UserExportService` to delegate; add `AuditLogController` `?format` branch (+ a small `auditRowsToExport` shaping helper). Tests: `table-export` unit, keep `user-export.service.test.ts` green, audit export unit.
- **E2E** — `apps/api/tests/e2e/task-390-super-admin-tier.spec.ts`: **#22** super_admin can CRUD a throwaway policy incl. softDelete; DELETE/disable/scope-change/`manage:all`-strip of `system-full-access` → 4xx and the seeded policy is **unchanged** (re-GET asserts intact); tenant_admin cannot mutate policies (403). **#23** rotate a throwaway key → new `rawKey` returned, old key linked; cross-tenant/404 guard. **#24** create→get(ETag)→patch(If-Match)→list→delete a throwaway setting; 428 without If-Match; 412 on stale version. **#25** csv/xlsx/pdf magic bytes + content-type + attachment disposition; doctor → 403.

---

## 5. Implementation Summary

All four items shipped **backend + SDK + tests**, per plan — **zero DB / migration changes** (every model/column/enum/CASL subject pre-existed; no seed edits).

- **#22 — policy anti-lockout guard (AUTH-SENSITIVE).** `PolicyService` gained a name-based `PROTECTED_SYSTEM_POLICIES` map (`system-full-access` → `manage:all`; `rbac-system-manage` → `manage:Role`/`manage:Policy`/`manage:RolePolicy`) and two private guards (`assertProtectedDeletionAllowed`, `assertProtectedMutationAllowed`) called from `update`/`patch`/`softDelete`. A protected policy now **refuses** (`ForbiddenException`) deletion, GLOBAL→other scope change, disable (`resourceStatus != ENABLED`), and removal/inversion of any load-bearing rule. Everything else (all TENANT policies, non-protected GLOBAL, rename/description/add-rule) stays fully editable. The guard only **adds** refusals — no seed mutation, no CASL change. **Editable surface flagged in §3.1.**
- **#23 — api-key rotate.** `POST /admin/api-keys/:id/rotate` (`@CanUpdate('ApiKey')`) delegates to the **pre-existing** `ApiKeyService.rotateKey` (24 h grace window) and returns `{ apiKey, rawKey }` (new secret once). SDK `useApiKeys.rotate(id)` + `API_KEY_ENDPOINTS.ROTATE`. **Rotation semantics + a newly-surfaced ownership-scoping nuance are flagged in §3.2.**
- **#24 — global-settings CRUD.** New `apps/api/src/modules/global-setting` module (controller/module/index) mounted at `@Controller('admin/settings')`, wiring the existing `IGlobalSettingService` + `GlobalSettingDtoMapper` (CRUD + `tenant/:tenantId`), registered in `app.module.ts`. OCC PATCH via `@RequiresIfMatch()` + `@ExpectedVersion()` (ETag from the global interceptor). One tiny applications DTO fix: `UpdateGlobalSettingRequest.expectedVersion` made optional (folded from the `If-Match` header). **Path/schema decision flagged in §3.3.**
- **#25 — audit xlsx/pdf export.** Extracted a shared, column-driven `apps/api/src/shared/table-export.ts` (csv/xlsx/pdf) out of the TASK-388 `UserExportService` (which now **delegates** — its API + tests unchanged). `AuditLogDtoMapper` gained `ToExportRows` (structured rows via a shared `buildExportCells`, so `ToCsv` stays byte-identical). `GET /admin/audit-logs/export?format=csv|xlsx|pdf` (default `csv`, back-compatible) now streams a `StreamableFile`. SDK `useAuditLog.exportFile(format, filters)` fetches the binary formats. **Reuse-not-duplicate flagged in §3.4.**

---

## 6. Files by layer

**#22 — policy guard** (`packages/applications`)
- `src/services/rbac/policy/policy.service.ts` — **M**: `PROTECTED_SYSTEM_POLICIES` + `assertProtectedDeletionAllowed`/`assertProtectedMutationAllowed`, wired into `update`/`patch`/`softDelete`.
- `src/services/rbac/policy/__tests__/policy.service.system-guard.test.ts` — **NEW**: RED→GREEN guard tests (delete/disable/scope/rule-strip refused; safe edits + non-protected unaffected).

**#23 — api-key rotate** (API + SDK; service pre-existing, unchanged)
- `apps/api/src/modules/api-key/api-key.controller.ts` — **M**: `POST :id/rotate`.
- `apps/api/src/modules/api-key/__tests__/api-key.controller.test.ts` — **M**: rotate unit test.
- `packages/agentic-sdk-v2/src/hooks/useApiKeys.ts` — **M**: `rotate(id)`.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useApiKeys.test.ts` — **M**.
- `packages/agentic-sdk-v2/src/core/constants.ts` — **M**: `API_KEY_ENDPOINTS.ROTATE`.

**#24 — global-settings CRUD** (API + applications DTO; model/domain/service/SDK-hook pre-existing)
- `apps/api/src/modules/global-setting/global-setting.controller.ts` — **NEW**.
- `apps/api/src/modules/global-setting/global-setting.module.ts` — **NEW**.
- `apps/api/src/modules/global-setting/index.ts` — **NEW**.
- `apps/api/src/modules/global-setting/__tests__/global-setting.controller.test.ts` — **NEW**.
- `apps/api/src/app.module.ts` — **M**: register `GlobalSettingModule`.
- `packages/applications/src/services/globalSetting/dto/updateGlobalSetting.request.ts` — **M**: `expectedVersion?` optional (OCC header fold).

**#25 — audit xlsx/pdf export** (API + applications + SDK; shared refactor of TASK-388 exporter)
- `apps/api/src/shared/table-export.ts` — **NEW**: pure column-driven csv/xlsx/pdf builder.
- `apps/api/src/shared/__tests__/table-export.test.ts` — **NEW**.
- `apps/api/src/modules/user/user-export.service.ts` — **M** (TASK-388 file): refactored to **delegate** to the shared builder — public API + `user-export.service.test.ts` unchanged (callsite preserved).
- `apps/api/src/modules/audit-log/audit-log.controller.ts` — **M**: `?format` branch → `StreamableFile`.
- `apps/api/src/modules/audit-log/__tests__/audit-log.controller.test.ts` — **M**: csv (stream) + xlsx/pdf magic bytes.
- `packages/applications/src/services/auditLog/auditLog.dto.mapper.ts` — **M**: `ToExportRows` + shared `buildExportCells`.
- `packages/applications/src/services/auditLog/__tests__/auditLog.dto.mapper.test.ts` — **M**.
- `packages/applications/src/services/auditLog/dto/auditLogQuery.query.ts` — **M**: `format?` param.
- `packages/agentic-sdk-v2/src/hooks/useAuditLog.ts` — **M**: `exportFile(format, filters)`.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useAuditLog.test.ts` — **M**.

**E2E**
- `apps/api/tests/e2e/task-390-super-admin-backend.spec.ts` — **NEW**: #22 CRUD round-trip + 4 anti-lockout guards + doctor-403; #23 rotate (new key/secret, old survives) + unknown-id 404; #24 create→GET→OCC-PATCH→delete + 428 + doctor-403; #25 csv/xlsx/pdf magic bytes + cross-tenant `tenantId` column + doctor-403.

> Migration name(s): **none** (no schema change for any item).

## 7. Verification evidence

- **Unit — applications** (`pnpm --filter @arcaai/applications test:unit`): **Test Files 248 passed | 1 skipped; Tests 5498 passed | 4 skipped** (incl. policy system-guard + auditLog `ToExportRows`).
- **Unit — API** (`pnpm --filter @arcaai/api test`): **Test Files 107 passed | 2 skipped; Tests 1867 passed | 4 skipped** (incl. api-key rotate, global-setting CRUD, audit multi-format, `table-export`, refactored user-export).
- **Unit — SDK (relevant files)** (`vitest run useApiKeys.test useAuditLog.test …`): green (part of the **5 files / 123 tests passed** batch shared with TASK-389).
- **Build**: `pnpm build:api` + `pnpm db:generate` + SDK build — clean (server stopped for the clean build, then restarted).
- **E2E (live, `:8868` seeded TEST DB)** — `SKIP_DB_PRECHECK=true pnpm test:e2e task-389-agents-backend task-390-super-admin-backend`: **19 passed** (task-390 = 16: 6×#22, 2×#23, 3×#24, 5×#25).
- **#23 E2E note:** the initial run flagged `doctor rotate → 201` (not 403). Root-caused as the **existing** tenant-scoped api-key posture (seeded clinician holds `api-key-own-manage`; `assertTenantOwnership` is tenant-level) — rotate mirrors `revoke`/`delete` and adds no new surface. The assertion was corrected to test the enforced boundary (out-of-scope id → 404) and the finding flagged in §3.2.
  - **Follow-up (RESOLVED 2026-07-01):** owner-scope is now enforced in `ApiKeyService.assertKeyAccess` across `fetchById`/`update`/`deleteById`/`revokeKey`/`rotateKey` — a same-tenant peer targeting **another user's** key is now **404**, while tenant-admin (tenant-scope) and SUPER_ADMIN (broad) access are unchanged. New live spec `apps/api/tests/e2e/task-390b-api-key-owner-scope.spec.ts` (**5/5 green**) + service unit block "Owner-scope enforcement (TASK-390 follow-up)". See §3.2.
- **Pre-existing ambient SDK failures (NOT this ticket):** `constants.ws4.test.ts` `DNA_STYLE`/`DEPARTMENT`/`TENANT` count assertions are red from uncommitted TASK-387/388 endpoint additions — outside this ticket's ownership; not touched. (The `PROMPT_TEMPLATE` count was updated under TASK-389 for its own `DIFF` key.)

## 8. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-01 | Ticket created; requirement analysis, current-state, product/AUTH decisions (incl. the FLAGGED #22 protected surface, #23 grace-window semantics, #24 path/schema decision), plan (§1–§4). | this README |
| 2026-07-01 | Implemented #22 (policy anti-lockout guard), #23 (api-key rotate route + SDK), #24 (global-settings `admin/settings` module + OCC), #25 (shared `table-export` + audit xlsx/pdf + SDK `exportFile`). Added E2E `task-390-super-admin-backend.spec.ts`. Surfaced + FLAGGED the #23 ownership-scoping nuance during E2E (§3.2). Unit/build/E2E green (§7). | §6 files |
| 2026-07-01 | **Follow-up — #23 api-key owner-scope RESOLVED (§3.2).** Enforced owner-scope in `ApiKeyService` via `callerCanManageAllKeys()` + `assertKeyAccess()` across `fetchById`/`update`/`deleteById`/`revokeKey`/`rotateKey` (owner-only callers confined to their own keys → `404`; tenant-admin tenant-scope + SUPER_ADMIN broad scope unchanged). No policy/rule/migration change; `softDelete` retained. Added service unit block + live E2E `task-390b-api-key-owner-scope.spec.ts`; updated the stale #23 note in `task-390-super-admin-backend.spec.ts`. Unit (applications 5511✓, api-key controller 11✓) + `build:api` + live E2E (390b 5/5, #23 2/2) green. | `packages/applications/.../apiKey/apikey.service.ts`, `.../apiKey/__tests__/apikey.service.test.ts`, `apps/api/tests/e2e/task-390b-api-key-owner-scope.spec.ts`, `apps/api/tests/e2e/task-390-super-admin-backend.spec.ts`, this README |
| 2026-07-01 | **Product decisions RATIFIED (user).** §3 decision 1 (**#22 protected policy set**) → confirmed **absolute** protection of `system-full-access` + `rbac-system-manage` (even SUPER_ADMIN cannot delete/disable). §3 decision 3 (**#24 settings path**) → keep `/admin/settings`. Flag wording changed to RATIFIED for these two; the #23 §3.2 item stays RESOLVED and all other flags untouched; no code/behaviour change. | this README |
| 2026-07-01 | **#24 DTO — expose `locked` on `GlobalSettingResponse` (TASK-391 D2 fix).** The admin console could not render the super-admin-only lock affordance because `GET /admin/settings` never returned `locked`. Added `locked` to `GlobalSettingResponse` (`@ApiProperty`); the `locked` column already exists on the entity/table → **no migration**, and the generic `AutoClassMapper` copies it automatically (mapper unchanged). Declared **optional (`?`)** on purpose: the tenant controllers reuse `GlobalSettingDtoMapper.ToPaginatedResponse(...) as PaginatedTenantConfigResponse` (superset cast), which only compiles while `GlobalSettingResponse` stays assignable-into `TenantConfigResponse` — a required field breaks `build:api` (4 `TS2352`); the runtime value is always populated (column is `@default(false)`, non-null). Rebuilt API (stop watcher → `build:api` → restart → health 200); `GET /admin/settings` now returns `locked`. Added 2 mapper unit cases (29✓). | `packages/applications/src/services/globalSetting/dto/globalSetting.response.ts`, `.../globalSetting/__tests__/globalSetting.dto.mapper.test.ts`, this README |
