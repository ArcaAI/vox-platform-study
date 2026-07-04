# TASK-379 — Page-based Tenant Detail + App-Shell Upgrades

| | |
|---|---|
| **Ticket** | TASK-379 |
| **Name** | Page-based Tenant Detail + App-Shell Upgrades |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Review — implementation shipped & green; **design + traceability + E2E artifacts added** (E2E authored; run pending a seeded stack). See [DESIGN-SPEC](../../designs/admin/tenant-detail.md) · [TRACEABILITY-MATRIX](../../qa/traceability/tenant-detail.md) · [MANUAL-E2E-TESTS](../../qa/manual-tests/04-tenant-detail.md) |
| **App** | `apps/admin` (consumes already-built `@arcaai/ui` foundations from TASK-377/378) |
| **Supersedes** | The blade navigation model in TASK-371 PHASE-2 (replaced by the page-based model, README §5.12/§5.13) |

---

## 1. Requirement Analysis

### Description
Replace the tenant **detail Sheet** with a **page-based tenant detail** surface (`/tenants/$tenantId/*`) and add the cross-cutting **app-shell upgrades** the multi-tenant console needs: role-tiered navigation, a working-tenant switcher, an "Acting on: «Tenant»" banner, a NoTenant empty state, and a breadcrumb trail. Build the §5.13 page set (Overview, Users, Configuration, Storage, Departments + Department Detail) and the §5.13 dialogs (Add/Edit Tenant, Assign Departments, Add Members, New Agent Instruction, Disable Tenant), reusing the shipped `@arcaai/ui` components.

### Business context
The admin console manages many tenants. Today the only tenant detail is a read-only Sheet; there is no way for a super-admin to "act on" a tenant, no breadcrumb context, no role-tiered nav, and tenant-scoped pages silently show cross-tenant data (GAP-ADM-001). This ticket makes tenant administration a first-class, navigable, role-aware surface.

### Acceptance criteria
- Nested route `/tenants/$tenantId/{overview,users,configuration,storage,departments}` + `/departments/$departmentId`, with `/tenants` remaining the list; row-click navigates to the detail.
- App shell: role-tiered (RBAC default-deny) nav; working-tenant switcher wired to `auth-store.setTenant()` (drives the SDK tenant header); "Acting on" banner on tenant-scoped mutation surfaces; NoTenant empty state; breadcrumb `Home / Platform / Tenants / «Tenant»`.
- Pages match the approved screenshots, reuse `StatCard`/`CardGrid`/`EntityCard`/`ItemList`/`VirtualizedDataGrid`/`StatusBadge`.
- Dialogs replace nested pickers/sheets; Add/Edit Tenant keeps the case-insensitive key-uniqueness validator + key immutability-on-edit; Disable Tenant is a recoverable-archive AlertDialog.
- Permissions mirror the server (super-admin → can-create-tenant; system-tenant protection; 404-over-403); OCC on every mutation; loading/empty/error/saving states throughout.
- New app-level Vitest pure-logic suites pass; the 8 existing suites keep passing; `generate-routes` + `type-check` + `test` + `lint` + `build` are all green.

### Out of scope (separate tickets)
- Operational Tenant **Dashboard (18d)** beyond a basic Overview.
- 7-tab **User Detail** / Create User / bulk / export.
- Full **Agent management** editor/diff/playground (the Departments → Agent-instructions sub-tab is a simple list + the New-Agent-Instruction dialog only).
- No changes to `@arcaai/ui`, the SDK, or other packages; no token-source refactor; no commit/push.

---

## 2. Current State Evaluation

| Area | Today | Change |
|---|---|---|
| Routing | Flat `routes/_authenticated/*.tsx`; `tenants.tsx` is a single list page with create/edit/detail **Sheets** | Convert to a folder `tenants/` (`route.tsx` layout + `index.tsx` list) + nested `$tenantId/*` detail pages |
| Nav | `nav.ts` = 5 flat, ungated sections; `app-shell.tsx` `SidebarNav` renders all | Role-tiered + RBAC-gated; design-aligned tier labels; existing routes stay reachable |
| Tenant switch | `auth-store.setTenant()` exists but is **never called from the UI** | Sidebar-footer working-tenant switcher calls it; the SDK provider already re-wires the tenant header from `auth-store.tenantId` |
| Tenant detail | `tenant-detail-sheet.tsx` (read-only Sheet) | Replaced by the page set; the Sheet file is removed once fully orphaned |
| Tenant create/edit | `tenant-form-sheet.tsx` (Sheet) | Refactored into a **Dialog** (`tenant-form-dialog.tsx`); key-uniqueness + immutability preserved |
| Breadcrumb | none (topbar shows a single active title) | `useMatches()` + `staticData.crumb` + a `tenant-detail-store` for dynamic tenant/dept names |
| Data flow | `@arcaai/vox` hooks in `useEffect` (no TanStack Query, no route loaders for data) | Same pattern; `$tenantId/route.tsx` fetches the tenant via `useTenants().get()` and publishes it to a small Zustand store the breadcrumb/tabs read |

### SDK surface available (no SDK changes)
`useTenants` (list/get/create/update/enable/disable/getConfigs/updateConfigs), `useUsers` (listPaginated/assignDepartments), `useDepartments` (list/get/create/update/updatePromptConfig/remove), `useUserDepartments` (list/assign/setPrimary[OCC]/unassign), `usePrompts` (create/list/...), `useTenantBuckets`, `useTenantFrontendConfig` (get/save[OCC `expectedVersion`]), `useMonitoring`.

### Known SDK gap (flag as TARGET, do NOT fabricate)
- **No `getUsageStats`** on `useTenants`/`useUsers` (the `GET /admin/tenants/:id/usage` endpoint isn't exposed as a hook). Overview KPI counts are **derived** from `useUsers().listPaginated` total + `useDepartments().list().length`; aggregate roll-ups (sessions/storage/usage trends) render as **TARGET** (em-dash / "Not yet available" note).
- **No tenant `tags` / SUSPENDED-archive / storage quota+usage** backend fields → drawn but disabled/empty-with-note + flagged.

---

## 3. Implementation Plan

### 3.1 TDD pure-logic test list (app-level Vitest; `@arcaai/ui`/`@arcaai/vox` are stubbed)
1. **`features/tenants/permissions.ts`** — `isSuperAdmin`, `isTenantAdmin`, `canCreateTenant`, `isSystemTenant`, `canModifyTenant` (super-admin → can-create; system-tenant protection blocks edit/disable even for super-admin).
2. **`features/tenants/tenant-key.ts`** — `normalizeTenantKey`, `isTenantKeyTaken` (case-insensitive), `validateTenantKey` (empty/taken/ok).
3. **`features/tenants/tenant-user-query.ts`** — `buildTenantUserListQuery` (0-based grid page → 1-based; search + `resourceStatus` filter CSV; omit empties).
4. **`features/tenants/department-draft.ts`** — `toCreateDepartmentRequest` (trim, omit empty `code`/`description`).
5. **`features/tenants/agent-instruction-draft.ts`** — `serviceToCategory` (Summarization→SUMMARY, DNA→DNA_ANALYSIS, else→CUSTOM) + `toCreatePromptInput` (scope=DEPARTMENT_DEFAULT via `departmentId`, status PUBLISHED, trim).
6. **`features/common/occ.ts`** — `isOccConflict` (409/412), `reduceOccConflict` (conflict + "changed since you loaded → refetch & retry" message).

### 3.2 Build order (skeleton-first, kept green throughout)
1. Pure-logic modules + tests (RED → GREEN).
2. Shell: `nav.ts` tiers + role-gated `SidebarNav`; `tenant-detail-store`; `Breadcrumbs`; `WorkingTenantSwitcher`; `ActingOnBanner` + `NoTenantState`; wire into `app-shell.tsx`.
3. Routing: `tenants/route.tsx` + `index.tsx` + `$tenantId/{route,index,overview,users,configuration,storage}.tsx` + `departments/{route,index,$departmentId}.tsx`; `generate-routes`; keep stubs type-checking.
4. Fill tab bodies + Department Detail.
5. Dialogs (Add/Edit Tenant → Dialog, Assign Departments, Add Members, New Agent Instruction, Disable Tenant).
6. Wire NoTenant into `/users` + `/departments` for super-admin-without-working-tenant (GAP-ADM-001).

### 3.3 Verification criteria
`pnpm --filter @arcaai/admin generate-routes` → `type-check` (clean `tsc --noEmit`) → `test` (new + 8 existing suites green) → `lint` (no new errors) → `build` (vite OK). Evidence pasted in §5.

### 3.4 Plan review (2026-06-30 verification pass — plan vs as-built)

The §3.1/§3.2 plan was executed as designed and re-verified against the shipped source. Findings:

- **Pure-logic suites, shell, routes, dialogs, OCC reducer — all present & green** (re-run §5.5). No in-scope gap; nothing was missing that needed closing in this pass.
- **Expected evolution (NOT a TASK-379 gap):** the plan/§4.3 list two surfaces as single files — `$tenantId/users.tsx` and `departments/$departmentId.tsx`. The as-built has since grown them into **folders** (`$tenantId/users/{route,index,$userId}.tsx` and `…/departments/$departmentId/{route,index,agents/**}.tsx`) because sibling tickets built **on top of** the TASK-379 scaffolding: TASK-380 (Tenant Dashboard 18d → `overview.tsx`), TASK-381 (Users 20u grid + 38u 7-tab detail), TASK-382 (Agent management editor/diff/playground under `…/agents/**`), TASK-383 (Platform dashboard/monitoring), TASK-384 (responsive `ResponsiveDataGrid`/`lib/responsive.ts`). The §4.3 list documents the **original TASK-379 set**; the deeper nesting is owned by those tickets and is out of TASK-379 scope. No remediation needed here.
- **Finding to flag (verified by reading source; NOT fabricated, NOT fixed in this pass):** the tenant-edit OCC contract. `PATCH /admin/tenants/:id` is `@RequiresIfMatch()` (`tenant.controller.ts:195`, method `update` at `:218`) — **428** when the `If-Match` header is missing — and the header value **overrides** the body `expectedVersion` (`tenant.controller.ts:229`; the DTO still marks the field required). §4.7's note that *"the SDK `useTenants` methods don't accept `expectedVersion`, so client-driven If-Match isn't possible"* is **imprecise**: OCC here is the canonical RFC 7232 **header** path — the `ETagInterceptor` stamps `ETag: "<version>"` on the GET and SDK clients echo it as `If-Match`. The authored backend spec pins **both** the 428 (missing header) and 200 (valid header) contracts, so the moment the stack runs we confirm whether the SDK echoes the ETag (expected) or tenant edit/enable/disable would 428 against the live API. **Action:** verify on first live E2E run; no code change made in this documentation pass.

---

## 4. Implementation Summary

All §5.13 pages + dialogs and all cross-cutting app-shell upgrades are built and green (type-check / test / lint / build). Data flows through `@arcaai/vox` hooks in `useEffect` (existing pattern); no SDK, `@arcaai/ui`, or token-source changes; no commit/push.

### 4.1 Pages & dialogs (§5.13) — status

| § | Surface | Status | Notes |
|---|---|:---:|---|
| 5.13 | **Tenant Overview** | ✅ Done | `StatCard` KPI tiles (Users + Departments = real counts; Agent-instructions = real `usePrompts` count; **Pipelines = TARGET** em-dash) + About panel + recent-activity via `ItemList`/`useAuditLog`. |
| 5.13 | **Tenant Users** | ✅ Done | `VirtualizedDataGrid` (server query via `buildTenantUserListQuery`), Department-name resolution, Status; **Assign Departments** dialog; **Add member = TARGET** (create-user is a separate ticket). |
| 5.13 | **Tenant Configuration** | ✅ Done | `useTenantFrontendConfig` get/save with **OCC** (`expectedVersion`) + 409 reducer; `Switch`/`Select` flags + ASR pipeline; **system-tenant lock**; Acting-on banner; Save/Discard. |
| 5.13 | **Tenant Storage** | ✅ Done | `TenantBucket` table (`useTenantBuckets.list`); **Usage/quota, Objects, Size, Rotate-keys, Manage-provider = TARGET** (no backend). |
| 5.13 | **Departments** | ✅ Done | `CardGrid`/`EntityCard` + client search; **New Department** dialog (permission-gated); card → Department Detail. |
| 5.13 | **Department Detail** | ✅ Done | Header + **Add Members** dialog; Members sub-tab (`VirtualizedDataGrid`, client-side filter by `departmentIds`) + Agent-instructions sub-tab (`ItemList` from `usePrompts`) + **New Agent Instruction** dialog. |
| 5.13 | **Add/Edit Tenant** dialog | ✅ Done | `tenant-form-dialog.tsx` (Sheet→**Dialog**); case-insensitive key-uniqueness validator + **key immutable on edit**. |
| 5.13 | **Assign Departments** dialog | ✅ Done | Generic `CheckboxPickerDialog` + `useUserDepartments.assign` (user-side). |
| 5.13 | **Add Members** dialog | ✅ Done | Same `CheckboxPickerDialog` + `useUsers.assignDepartments` (department-side bulk). |
| 5.13 | **New Agent Instruction** dialog | ✅ Done | `usePrompts.create`, scope **locked** to `DEPARTMENT_DEFAULT`, category derived from service. |
| 5.13 | **Disable Tenant** dialog | ✅ Done | `ConfirmDelete` **AlertDialog**, X7 recoverable-archive framing; Enable/Disable via `useTenants`; system-tenant protected. |

### 4.2 App-shell upgrades — status

| Upgrade | Status | Notes |
|---|:---:|---|
| Role-tiered nav (RBAC default-deny, X5) | ✅ Done | `nav.ts` `getNavSections(roles)`; **Platform** tier (`Tenants`) is super-admin-only; existing routes stay reachable. |
| Working-tenant switcher | ✅ Done | Sidebar-footer `Popover`+`Command`; "All tenants · Cross-tenant view", current ✓, "Manage tenants"; writes `auth-store.setTenant()` → SDK `X-Tenant-Id`. Tenant-admin sees a static workspace chip. |
| "Acting on: «Tenant»" banner | ✅ Done | `ActingOnBanner` on tenant-scoped pages (Overview/Users/Config/Storage/Departments/Dept-Detail). |
| NoTenant empty state (GAP-ADM-001) | ✅ Done | `NoTenantState` on top-level `/users` + `/departments` when a super-admin has no working tenant (cross-tenant fetch is skipped). Detail pages can't hit it (route always carries a tenant). |
| Breadcrumb builder | ✅ Done | `Breadcrumbs` from `useMatches()` + `staticData.crumb` + `tenant-detail-store`; resolves `$param` hrefs + dynamic tenant/dept names; active tab shown by in-page tab nav (not appended). |

### 4.3 Files created

| File | Purpose |
|---|---|
| `src/features/tenants/permissions.ts` | `isSuperAdmin`/`isTenantAdmin`/`canCreateTenant`/`isSystemTenant`/`canModifyTenant` (client gate mirroring server). |
| `src/features/tenants/tenant-key.ts` | `normalizeTenantKey`/`isTenantKeyTaken`/`validateTenantKey` (case-insensitive uniqueness). |
| `src/features/tenants/tenant-user-query.ts` | `buildTenantUserListQuery` (grid 0-based → backend 1-based, search + status CSV). |
| `src/features/tenants/department-draft.ts` | `toCreateDepartmentRequest` (trim, omit empties). |
| `src/features/tenants/agent-instruction-draft.ts` | `serviceToCategory` + `toCreatePromptInput` (scope/category derivation). |
| `src/features/common/occ.ts` | `isOccConflict`/`reduceOccConflict` (409/412, incl. `AgenticError` `context.status`). |
| `src/features/tenants/sdk-types.ts` | Local `Department` type derived from `UseDepartmentsReturn` (SDK doesn't re-export it). |
| `src/store/tenant-detail-store.ts` | Zustand store publishing the viewed tenant/department for the breadcrumb. |
| `src/components/layout/breadcrumbs.tsx` | Dynamic breadcrumb builder wired into the topbar. |
| `src/features/tenants/working-tenant-switcher.tsx` | Sidebar-footer working-tenant switcher. |
| `src/features/tenants/tenant-context.tsx` | `ActingOnBanner` + `NoTenantState`. |
| `src/features/tenants/tenant-form-dialog.tsx` | Add/Edit Tenant **Dialog** (replaces the Sheet). |
| `src/features/tenants/department-form-dialog.tsx` | New/Edit Department dialog. |
| `src/features/tenants/agent-instruction-dialog.tsx` | New Agent Instruction dialog (`usePrompts.create`). |
| `src/features/common/checkbox-picker-dialog.tsx` | Generic multi-select dialog (Assign Departments / Add Members). |
| `src/routes/_authenticated/tenants/route.tsx` | `/tenants` pathless layout (crumb "Platform / Tenants"). |
| `src/routes/_authenticated/tenants/index.tsx` | Tenants list (row → `$tenantId`); refactor of the old flat page. |
| `src/routes/_authenticated/tenants/$tenantId/route.tsx` | Tenant-detail layout: fetch + header + tab nav + `<Outlet/>` + Edit/Disable + working-tenant auto-set + OCC. |
| `src/routes/_authenticated/tenants/$tenantId/index.tsx` | Redirect → `overview`. |
| `src/routes/_authenticated/tenants/$tenantId/overview.tsx` | Overview page. |
| `src/routes/_authenticated/tenants/$tenantId/users.tsx` | Users page. |
| `src/routes/_authenticated/tenants/$tenantId/configuration.tsx` | Configuration page (OCC). |
| `src/routes/_authenticated/tenants/$tenantId/storage.tsx` | Storage page. |
| `src/routes/_authenticated/tenants/$tenantId/departments/route.tsx` | Departments pathless layout (`<Outlet/>`). |
| `src/routes/_authenticated/tenants/$tenantId/departments/index.tsx` | Departments `CardGrid` page. |
| `src/routes/_authenticated/tenants/$tenantId/departments/$departmentId.tsx` | Department Detail (Members + Agent-instructions). |
| `src/features/tenants/__tests__/{permissions,tenant-key,tenant-user-query,department-draft,agent-instruction-draft}.test.ts`, `src/features/common/__tests__/occ.test.ts` | 6 new app-level Vitest suites (34 tests). |

### 4.4 Files modified

| File | Change |
|---|---|
| `src/lib/nav.ts` | `NAV_SECTIONS` → `getNavSections(roles)` + `NAV_ITEMS` (role-tiered, RBAC-gated). |
| `src/components/layout/app-shell.tsx` | Render role-tiered nav + `WorkingTenantSwitcher` (footer) + `Breadcrumbs` (topbar). |
| `src/routes/_authenticated/users.tsx` | NoTenant gate (GAP-ADM-001): skip cross-tenant fetch + render `NoTenantState`; refetch on tenant switch. |
| `src/routes/_authenticated/departments.tsx` | NoTenant gate (GAP-ADM-001) around the tabs. |

### 4.5 Files deleted (orphaned by the page-based model — confirmed)

| File | Reason |
|---|---|
| `src/routes/_authenticated/tenants.tsx` | Split into `tenants/route.tsx` + `tenants/index.tsx`. |
| `src/features/tenants/tenant-detail-sheet.tsx` | Replaced by the `$tenantId` page set. |
| `src/features/tenants/tenant-form-sheet.tsx` | Replaced by `tenant-form-dialog.tsx`. |

### 4.6 TARGET fields flagged (drawn, wired disabled/empty-with-note — NOT fabricated)

- **Overview**: Pipelines KPI + any aggregate roll-up → em-dash / "Not yet available" (**no `getUsageStats` hook**; SDK gap, see §4.7).
- **Users**: "Add member" (create-user) → disabled/TARGET (separate ticket); reset-password / export / bulk not built.
- **Storage**: Usage/quota, per-bucket Objects & Size, "Rotate keys", "Manage provider" → TARGET (no backend fields/endpoints).
- **Tenant**: `tags`, `SUSPENDED`/`ARCHIVED` status (only ENABLED/DISABLED exist) → not drawn as live controls; disable = recoverable archive framing only.

### 4.7 Deviations & follow-ups

- **§5.12 breadcrumb**: "Departments" segment is contributed by the *Department-Detail* route (`Platform / Tenants / «Tenant» / Departments / «Dept»`), not by the Departments tab itself — the active tab is shown by the in-page tab nav per the design, so a redundant crumb on the tab list is intentionally omitted.
- **GAP-ADM-001 scope**: NoTenant is enforced on the **top-level** `/users` + `/departments` (the canonical "27 users cross-tenant" case). The nested tenant-detail pages always carry a tenant via the route param + working-tenant auto-set, so they satisfy the gate structurally. Cross-tenant viewing remains valid for platform observability (Dashboard/Monitoring/Audit), per the switcher's "All tenants · Cross-tenant view".
- **OCC on tenant update/enable/disable**: the SDK `useTenants` methods don't accept `expectedVersion`, so client-driven If-Match isn't possible there; 409/412 responses are still routed through `reduceOccConflict` (toast + refetch). True OCC is wired where the SDK supports it (`useTenantFrontendConfig`, `usePrompts`).
- **Department members**: no `listByDepartment` SDK method → members are derived by listing tenant users and filtering on `departmentIds` (client-side). Adequate for typical tenants; a server-side endpoint is the scale follow-up.
- **SDK gap (follow-up)**: expose `GET /admin/tenants/:id/usage` (`getUsageStats`) as a `useTenants` method so Overview KPI roll-ups (sessions, storage, usage trends) can be real instead of TARGET.
- **Lint**: 0 errors. The ~5.7k `prettier/prettier` warnings are **pre-existing & project-wide** (root `.prettierrc.js` `tabWidth:2` vs the app's de-facto 4-space style) and the `react-hooks/exhaustive-deps` "rule not found" warnings are a pre-existing flat-config gap — both present on untouched files too. New files match the established app style (4-space + the existing `eslint-disable` pattern); reformatting them would diverge from the rest of the app, so they're left as-is per the surgical-change constraint.

---

## 5. Verification Evidence

### `generate-routes` (after route changes) — clean
```
> tsr generate
```
`routeTree.gen.ts` regenerated (gitignored artifact); 86 references to `tenants/$tenantId` present.

### `type-check` (`tsc --noEmit`) — clean (exit 0)
```
> @arcaai/admin@0.1.0 type-check
> tsc --noEmit
```
(no diagnostics)

### `test` (vitest run) — 14 files / 87 tests pass (exit 0)
```
 Test Files  14 passed (14)
      Tests  87 passed (87)
```
6 new suites = 34 tests (`permissions` 8, `tenant-key` 7, `tenant-user-query` 4, `department-draft` 3, `agent-instruction-draft` 5, `occ` 7); 8 pre-existing suites (53 tests) unchanged.

### `lint` (eslint) — 0 errors (exit 0)
```
✖ 5709 problems (0 errors, 5709 warnings)
```
All warnings are pre-existing project-wide `prettier/prettier` (tabWidth) + `react-hooks/exhaustive-deps` "rule not found" noise — present on untouched files too (see §4.7). No new errors introduced.

### `build` (vite build) — succeeds (exit 0)
```
✓ 10924 modules transformed.
✓ built in ~11–12s
```
New chunks emitted: `tenant-detail-store`, `tenant-context`, `tenant-form-dialog`, `checkbox-picker-dialog`, `permissions`, etc. The >500 kB chunk warning is pre-existing vendor noise (whisper/onnx/shiki), unrelated to this ticket.

### 5.5 Review pass (2026-06-30) — design, traceability & E2E artifacts

This pass added the QA/design artifacts the convention (`docs/qa/E2E-AND-QA-CONVENTIONS.md`) requires and re-verified the build. **No app/SDK/UI code was changed** (only new docs + two new E2E specs).

**Artifacts created**

| Artifact | Path | Notes |
|---|---|---|
| Design spec | [`DESIGN-SPEC.md`](../../designs/admin/tenant-detail.md) | Desktop/Tablet/Mobile per frame (`06`/`18p`/`20p`/`22p`/`37p`/`34p`/`36p` + 5 dialogs), TASK-384 model, semantic tokens; "Figma frames to create later" |
| Traceability | [`TRACEABILITY-MATRIX.md`](../../qa/traceability/tenant-detail.md) | Mirrors TASK-371; backend `file:line` re-verified live; cross-links F1–F9·C1·S1–S3·D1–D4·O2·AU1 |
| Backend E2E | `apps/api/tests/e2e/task-379-tenant-detail.spec.ts` | 24 real-flow tests (list/get/create/edit·If-Match/enable·disable/configs OCC/buckets/departments CRUD/`/tenant/me`/404-over-403); TARGET flows not asserted |
| Frontend E2E | `apps/admin/e2e/task-379-tenant-detail.spec.ts` | 5 adaptive tests × 3 viewport projects (list→detail nav, tab switch, switcher, NoTenant, create dialog) |
| Manual E2E | [`MANUAL-E2E-TESTS.md`](../../qa/manual-tests/04-tenant-detail.md) | Persona-based TD-01…TD-08 (X1–X8); maps the `MT-xx` gaps TASK-379 closes |

**Gate results (re-run from repo root)**

| Gate | Command | Result |
|---|---|---|
| Type-check | `pnpm --filter @arcaai/admin type-check` | ✅ clean (`tsc --noEmit`, exit 0) |
| Unit (Vitest) | `pnpm --filter @arcaai/admin test` | ✅ **30 files / 215 tests passed** (whole admin suite incl. sibling tickets; no regressions) |
| FE E2E list | `pnpm exec playwright test --config apps/admin/playwright.config.ts --list` | ✅ the 5 `task-379` tests list under `[desktop]`/`[tablet]`/`[mobile]` |
| BE E2E list | `pnpm exec playwright test apps/api/tests/e2e/task-379-tenant-detail.spec.ts --list` | ✅ **24 tests in 1 file** compile/list |
| Live E2E | `curl -s localhost:8868/api/v1/health` | ⏸ **NO_STACK** (HTTP 000) → both E2E specs are **authored — run pending a seeded stack** |

> Both E2E specs use `tests/helpers` `SEEDED_USERS`/`loginUser` (BE) and `e2e/fixtures/auth` personas (FE); they LIST without a stack and will execute once `docker:test:up` + `dev:api:test` + `test:db:seed` are running. No frozen files were modified.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Ticket created; plan + TDD list approved (design-approved build) | this README |
| 2026-06-30 | Implemented full §5.13 page set + dialogs + app-shell upgrades; TDD pure-logic suites (34 tests) green; nested routing under `/tenants/$tenantId/*`; NoTenant (GAP-ADM-001) on top-level `/users` + `/departments`; OCC reducer handles `AgenticError context.status`. All gates green (type-check / 87 tests / 0 lint errors / build). | see §4.3–4.5 |
| 2026-06-30 | **Review-pass artifacts** added per `E2E-AND-QA-CONVENTIONS.md`: `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, backend + frontend `task-379-tenant-detail.spec.ts`, `MANUAL-E2E-TESTS.md`. Plan re-verified vs as-built (§3.4: file-list evolution owned by TASK-380–384; tenant-`PATCH` OCC is header/RFC-7232-driven — §4.7 wording flagged as imprecise in §3.4, not rewritten). Gates re-run: type-check clean, **215 Vitest tests pass**, FE (5) + BE (24) E2E specs list; live E2E pending stack (`NO_STACK`). No app/SDK/UI code changed. | `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, `MANUAL-E2E-TESTS.md`, `apps/api/tests/e2e/task-379-tenant-detail.spec.ts`, `apps/admin/e2e/task-379-tenant-detail.spec.ts`, this README §1/§3.4/§5.5/§6 |
