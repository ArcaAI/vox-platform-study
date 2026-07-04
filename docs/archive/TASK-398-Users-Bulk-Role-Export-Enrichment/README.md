# TASK-398 — Users: bulk `assign-role` + export email/dept-name enrichment

| | |
|---|---|
| **Ticket** | TASK-398 |
| **Title** | Server bulk `assign-role` action (P1-6) · Export email + department-NAME enrichment (P1-7) |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Source** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` P1-6 + P1-7 (both deferred out of TASK-388) |
| **Depends on** | TASK-388 (users backend: bulk actions + export), TASK-394 (FE wiring: bulk bar, export menu) — both on the uncommitted tree |
| **Classification** | feature (additive; no schema change) |

---

## 1. Requirement Analysis

Finish the users cluster: the two items TASK-388 explicitly deferred.

### P1-6 — Server bulk `assign-role` (TASK-388 decision #6)

- Add the deferred `assign-role` arm to `POST /admin/users/bulk-actions` (enum + DTO + controller `switch` arm), mirroring the **single-user** route's semantics/permissions (`POST /admin/users/:id/roles`, AC-02: `manage:UserRoleAssignment`, tenant-scoped roles, service-level tier + cross-tenant-target guards).
- FE: an **Assign role** action on the Users bulk bar with a role picker mirroring the assign-departments dialog pattern.
- SDK: extend `useUsers.bulkAction` input types minimally (`'assign-role'` + `roleId?`).

**Acceptance criteria**
- `POST /admin/users/bulk-actions { action:'assign-role', ids, roleId }` assigns `roleId` to every id with the same per-item partial-failure envelope as the other arms; every id passes the by-id tenant-scope guard.
- The arm carries the **same CASL posture as the single-user route**: a caller with `manage:User` but **without** `manage:UserRoleAssignment` is 403 (request-level), mirroring AC-02.
- `roleId` missing ⇒ 400 (request-level, before any mutation).
- Service-level AC-02 guards still apply per item (non-super-admin cannot grant SUPER_ADMIN; cannot target a foreign-tenant user; tenant pinned to CLS).
- FE bulk bar exposes **Assign role** (canManage only) → single-select role picker → one `bulkAction` round-trip → per-item toast.

### P1-7 — Export email + department-NAME enrichment (TASK-388 deviation/flag)

- `UserResponse` carries neither `email` (a `UserProfile` field) nor department **names** (via `UserDepartment`→`Department`), so the TASK-388 export renders those columns blank. Add **read-only enrichment to the export path only** — batch-fetched, **no N+1**.

**Acceptance criteria**
- `GET /admin/users/export?format=csv|xlsx|pdf` rows carry the user's profile email and comma-joined department **names**.
- Enrichment = exactly **two grouped queries** for the whole export set (one `UserProfile IN(...)`, one `UserDepartment IN(...) + join Department.name`) + an in-memory join — never per-row queries.
- Department names are scoped to the caller's effective tenant when a tenant context exists (mirrors the row-collection scoping; a tenant export never leaks a user's other-tenant department names). Cross-tenant super-admin export (no tenant selected) enriches across tenants.
- The regular list DTO (`UserResponse`) is **unchanged**.

---

## 2. Current State Evaluation

- **Bulk endpoint** — `user.controller.ts` `bulkActions` (TASK-388 #9): per-id `assertUserInScope` + `applyBulkAction` switch over `enable|disable|delete|assign-departments`; DTO `BulkUserActionRequest` (`@IsIn(BULK_USER_ACTIONS)`).
- **Single-user role route** — `POST :id/roles` = method-level `@CanManage('UserRoleAssignment')` (AC-02 override of class-level `manage:User`) → `userRoleAssignmentService.create({ roleId, userId })`. The service enforces: only SUPER_ADMIN may grant SUPER_ADMIN; non-super-admin cannot target a foreign-tenant user; tenantId pinned to CLS; restore-or-create on the `[userId,roleId,tenantId]` unique key; seat-quota gate (kill-switch OFF).
- **CASL imperative check** — `UnifiedAuthGuard` sets `request.ability` (CASL `AppAbility`) after authorizing the route; the `@UserAbility()` param decorator exposes it, enabling a per-action `ability.can('manage','UserRoleAssignment')` check inside the single bulk handler.
- **Export path** — `collectExportRows` materialises the tenant-scoped set (≤10 000) → `toExportRow` reads `email`/`departments` defensively (blank today) → shared `table-export` renders csv/xlsx/pdf. Columns (`Email`, `Departments`) already exist.
- **Data model** — `UserProfile.email` (1:1, indexed), `UserDepartment` (tenant-scoped join, `Department.name`). `UserService` already injects `CORE_DATABASE_SERVICE` (`baseClient`) — the established precedent for grouped read-model queries (`countTenantSeats`, `findActiveTenantIdsForUser`).
- **SDK** — `useUsers.bulkAction` posts `BulkUserActionInput` (`action` union typed); FE derives its types from the hook (`features/users/sdk-types.ts`), so the SDK union change flows through.
- **FE** — `users-bulk-bar.tsx` (TASK-394) + `CheckboxPickerDialog` (multi-select; assign-departments). Roles list already loaded on the page (`useRoles().listRoles`).

**Net: zero DB/Domain changes.** Applications + API + SDK + FE only.

## 3. Decisions

1. **Bulk assign-role CASL posture = imperative request-level check.** The bulk route is class-gated `manage:User`; a method-level `@CanManage('UserRoleAssignment')` would wrongly gate the other four arms. Instead the handler reads `@UserAbility()` and rejects `action='assign-role'` with 403 unless `ability.can('manage','UserRoleAssignment')` — the exact permission the single-user route declares (AC-02). Service-level guards remain as defense-in-depth per item.
2. **One `roleId` for all ids** (mirrors `assign-departments` applying one department set to all ids). Missing `roleId` ⇒ request-level 400.
3. **Enrichment lives on `IUserService.getExportEnrichment(userIds, tenantId?)`** — a read-model (no entity), two grouped `baseClient` queries + in-memory join, following the service's existing raw-client precedent. No `SysEvent` (auxiliary read; the export already broadcasts `ResourceViewed` via fetchAll).
4. **Dept-name ordering**: primary first, then assignment age — stable, human-meaningful.
5. **FE role picker = single-select sibling of `CheckboxPickerDialog`** (`assign-role-dialog.tsx`): same search + rows + footer layout, radio-semantics selection (one role).

## 4. Implementation Plan (layer order + TDD)

| # | Step | Verify |
|---|---|---|
| 1 | **Applications (P1-7)** — RED: `user.service.task398.test.ts` (grouped-query shape: exactly one `findMany` per model for N ids; email+names join; missing-profile tolerance; tenant filter passthrough; empty-ids short-circuit) → GREEN: `IUserService.getExportEnrichment` + `UserService` impl | `vitest run user.service.task398` + applications build |
| 2 | **API (P1-6)** — RED: controller tests (assign-role happy per-item create; 400 no roleId; 403 ability-denied; other arms unaffected; cross-tenant id → failed item) → GREEN: DTO enum + `roleId?` + handler ability check + switch arm | `vitest run user.controller` |
| 3 | **API (P1-7)** — RED: export test (single `getExportEnrichment` call w/ all ids; enriched rows to `build`) → GREEN: `collectExportRows`/`toExportRow` wiring | `vitest run user.controller user-export` |
| 4 | **SDK** — types `'assign-role'` + `roleId?`; test posts roleId; rebuild dist | `vitest run useUsers` + `pnpm --filter @arcaai/vox build` |
| 5 | **FE** — `assign-role-dialog.tsx` (single-select picker), bulk-bar button, route wiring (`BULK_LABELS`, handler, dialog) | `pnpm --filter @arcaai/admin type-check && build` |
| 6 | **Rebuild protocol** — stop `dev:api:test` → `pnpm build:api` → restart (rate-limit OFF, entitlements OFF) → `:8868/api/v1/health` 200; SDK dist rebuilt → restart `:5174` | health 200; Vite serves rebuilt SDK |
| 7 | **Live E2E** — `apps/api/tests/e2e/task-398-users-bulk-role-export.spec.ts` (bulk assign-role happy incl. re-login proof + doctor-403 + no-roleId-400; export csv/xlsx/pdf content-type + email/dept-NAME spot-check incl. xlsx cell parse) · `apps/admin/e2e/task-398-users-bulk-role.spec.ts` (bulk-bar Assign-role flow; real assignment on a throwaway user, desktop; dialog/list assertions on tablet; mobile skipped — no selection surface) | green, `SKIP_DB_PRECHECK=true`, non-destructive |
| 8 | **Regression** — users-related unit suites (api users module, applications user services, SDK useUsers, admin users features) | all green |

## 5. Implementation Summary

Both items landed exactly per plan (TDD RED→GREEN at each layer; no schema change; list DTO untouched).

### P1-6 — bulk `assign-role`

- **DTO** — `apps/api/src/modules/user/dto/bulk-action.request.ts`: `'assign-role'` joins `BulkUserAction`/`BULK_USER_ACTIONS`; optional `roleId` field.
- **Controller** — `apps/api/src/modules/user/user.controller.ts`:
  - `bulkActions` now takes `@UserAbility() ability` and, **only for `action='assign-role'`**, requires `ability.can('manage','UserRoleAssignment')` (403) then a present `roleId` (400) — both before any mutation. A method-level `@CanManage` decorator was deliberately NOT used since it would re-gate the other four arms (Decision #1).
  - `applyBulkAction` gained the `assign-role` arm → `userRoleAssignmentService.create({ roleId, userId })` — the **identical call the single-user `POST :id/roles` route makes**, so the AC-02 service guards (SUPER_ADMIN tier ceiling, cross-tenant-target rejection, CLS tenant pinning, restore-or-create) run per item and surface as per-id failures.
  - Per-id `assertUserInScope` continues to gate every id (cross-tenant target ⇒ failed item, never mutated).
- **SDK** — `packages/agentic-sdk-v2/src/hooks/useUsers.ts`: `BulkUserActionType` + `'assign-role'`, `BulkUserActionInput.roleId?`. Dist rebuilt. (FE types flow through `features/users/sdk-types.ts` automatically.)
- **FE** — `apps/admin/src/features/users/assign-role-dialog.tsx` (NEW): single-select radio picker (search + rows + footer, sibling of `CheckboxPickerDialog`). `users-bulk-bar.tsx`: **Assign role** button (canManage section). Users route: `assignRoleIds` state, `handleAssignRoleConfirm` → one `bulkAction` round-trip → per-item toast; `BULK_LABELS['assign-role']`.

### P1-7 — export enrichment (how N+1 was avoided)

- **Applications** — `IUserService.getExportEnrichment(userIds, tenantId?)` (+`UserExportEnrichment`) implemented in `UserService`: exactly **two grouped `baseClient.findMany` calls for the whole id set** — `userProfile` (`userId IN`, non-deleted, `select email`) and `userDepartment` (`userId IN`, ENABLED, optional `tenantId` filter, `include Department.name`, ordered primary-first then age) — joined **in memory** into `Record<userId, {email, departmentNames[]}>`. Empty input short-circuits (0 queries). The unit suite asserts the one-call-per-model shape, so an N+1 regression fails RED.
- **API** — `collectExportRows` calls `getExportEnrichment(allIds, callerTenantId)` **once** and threads the record into `toExportRow`; `email` + comma-joined department **names** now populate the existing `Email`/`Departments` columns in csv/xlsx/pdf. `UserExportRow` docs updated.

### Files changed

| Layer | File | Change |
|---|---|---|
| applications | `services/user/user/IUserService.ts` | +`UserExportEnrichment`, +`getExportEnrichment` |
| applications | `services/user/user/user.service.ts` | +`getExportEnrichment` impl (2 grouped queries + join) |
| applications | `services/user/user/__tests__/user.service.task398.test.ts` | NEW — 6 unit tests (grouped shape, join, tenant filter, tolerance) |
| api | `modules/user/dto/bulk-action.request.ts` | +`assign-role`, +`roleId?` |
| api | `modules/user/user.controller.ts` | assign-role gate + arm; export enrichment wiring |
| api | `modules/user/user-export.service.ts` | row-shape docs (email / dept NAMES) |
| api | `modules/user/__tests__/user.controller.test.ts` | +9 tests (6 assign-role incl. 403/400/tier/cross-tenant; 3 export enrichment incl. single-call + tenant threading) |
| sdk | `hooks/useUsers.ts` | union + `roleId?` |
| sdk | `hooks/__tests__/useUsers.task398.test.ts` | NEW — payload contract (typed literal = type-level RED) |
| admin | `features/users/assign-role-dialog.tsx` | NEW — single-select role picker |
| admin | `features/users/users-bulk-bar.tsx` | +Assign role button |
| admin | `routes/_authenticated/tenants/$tenantId/users/index.tsx` | dialog state/handler/wiring |
| e2e | `apps/api/tests/e2e/task-398-users-bulk-role-export.spec.ts` | NEW — 7 live API tests |
| e2e | `apps/admin/e2e/task-398-users-bulk-assign-role.spec.ts` | NEW — bulk-bar flow, 3 viewports |

### Evidence (all live, `SKIP_DB_PRECHECK=true`, non-destructive)

- **Unit**: applications user services **360 passed (18 files)** incl. the 6 new `getExportEnrichment` tests · api `user.controller` **90 passed** (7 new RED→GREEN) · api user module **111 passed (4 files)** · SDK `useUsers*` **79 passed (6 files)** (type-level RED proven: `TS2322 '"assign-role"' not assignable` before the union change) · admin users features **30 passed (4 files)**.
- **Builds**: `pnpm build:api` (turbo, 8 tasks) ✓ · `@arcaai/vox` dist ✓ · admin `type-check` ✓ + `vite build` ✓.
- **API E2E** (`task-398-users-bulk-role-export.spec.ts`): **7 passed** — assign-role happy (2 throwaway users, envelope `{succeeded:2}`, assignment verified via `GET :id/roles`); missing roleId → 400; TENANT_ADMIN×SUPER_ADMIN-role → 200 envelope with per-item tier-guard error + no assignment created; doctor → 403; csv contains `doctor.smith@example.com` + `General Practice`; xlsx parsed via exceljs (header row + doctor row cells exact); pdf FlateDecode streams inflated + hex-decoded text contains both. `task-388` spec re-run: **19 passed** (no regression).
- **FE E2E** (`task-398-users-bulk-assign-role.spec.ts`): **4 passed + 2 mobile skips** (no row-selection surface on the card list — the TASK-384/394 model) — bulk bar exposes Assign role alongside all TASK-394 actions; picker lists seeded roles, search filters, confirm arms on selection, dismissed uncommitted. `task-394-users-wiring` re-run: **11 passed + 1 skip** (no regression).
- **Stack hand-off**: `:8868` rebuilt + healthy (`/api/v1/health` 200, `.env.test` posture: `RATE_LIMIT_ENABLED=false`, entitlements enforcement OFF — kill-switch untouched), `:5174` restarted serving the rebuilt SDK dist.

### Deviations

- FE E2E commits no real bulk assignment (dialog exercised to enabled-confirm then dismissed) — the established non-destructive posture of `task-394-users-wiring.spec.ts`; the live mutation path is fully proven API-side (plan step 7's "real assignment on a throwaway user, desktop" was folded into the API spec where throwaway setup/teardown is first-class).
- Plan named the FE spec `task-398-users-bulk-role.spec.ts`; landed as `task-398-users-bulk-assign-role.spec.ts`.

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Ticket created; analysis + plan for P1-6/P1-7. | this README |
| 2026-07-02 | P1-6 + P1-7 implemented (TDD), verified live (unit + API/FE E2E), stack handed off healthy. Status → Completed. | see §5 |
