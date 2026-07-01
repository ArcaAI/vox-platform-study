> _Relocated from `docs/implementation/TASK-379-Tenant-Detail-Pages/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-379 — Tenant Detail + App-Shell Traceability Matrix

> **What this is:** the **use-case → design frame → backend API (`file:line`) → test → status**
> map for the page-based Tenant Detail surface + app-shell upgrades shipped in TASK-379. It
> mirrors [`TASK-371/TRACEABILITY-MATRIX.md`](./README.md)
> (same legend + columns) and **cross-links** the matching TASK-371 rows (the `↔ T371 Fx`
> note in each ID cell). TASK-379 is the **frontend build** of these surfaces — the backends
> already existed (verified `file:line` live, 2026-06-30), so most rows move from "design-only /
> FE-not-built" toward built + tested.

| | |
|---|---|
| **Ticket** | TASK-379 — Page-based Tenant Detail + App-Shell Upgrades |
| **Created** | 2026-06-30 |
| **Status** | FE built (Review); backend `file:line` re-verified live; FE pure-logic Vitest green; backend + frontend E2E **authored — run pending stack** |
| **Sources** | Design = `HOPE-Admin-Console` §5.12/§5.13 + [DESIGN-SPEC.md](../../designs/admin/tenant-detail.md); API = live source (`apps/api`, `packages/applications`); Tests = `apps/api/tests/e2e`, `apps/admin/e2e`, `apps/admin/src/**/__tests__`, `docs/qa/manual-tests` + [MANUAL-E2E-TESTS.md](../manual-tests/04-tenant-detail.md) |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end |
| 🟡 | **Built, partial test** — exists in code but only negative/RBAC E2E, frontend-unit (mocked/pure-logic), authored-not-run E2E, or manual coverage |
| 🔴 | **Gap** — designed, but **no backend endpoint** and/or **no test** |
| 🎯 | **Target** — design-only metric/flow with no backend yet (intentional; README §4.6) |
| 🔒 | endpoint is **strictly super-admin-only** (tenant-admin lacks the CASL permission) |

**Conventions (apply to every API cell):**

- All paths are under the global prefix **`/api/v1`** (`apps/api/src/main.ts`). No further URI versioning.
- Tenant-management routes are **shared with `TENANT_ADMIN`** (class-level `@CanAny(['manage','Tenant'],['update','Tenant'])`); super-admins get **cross-tenant** reach via inline `isSuperAdmin(user)` checks + `assertTenantInScope`/`assertConfigInScope`. Only 🔒 rows are super-admin-exclusive (`@CanManage('Tenant')`).
- **OCC**: `PATCH /admin/tenants/:id`, `PATCH /admin/departments/:id`, `PATCH /admin/users/:id/departments/:assignmentId` and `PATCH /tenant/me/config` are **`@RequiresIfMatch()`** (428 without a strong `If-Match`). `PATCH /admin/tenants/configs/:identifier` + `PUT /admin/tenant-frontend-config` take the body-field `expectedVersion` (header optional/preferred).
- 404-over-403 (X1): cross-tenant reads a tenant-admin can't see resolve to **404** (no existence leak), not 403; the console detail layout mirrors this (`Tenant not found` empty state).

## Coverage snapshot

- **18 use cases** mapped (the requested F1–F9 · C1 · S1–S3 · D1–D4 · O2 · AU1) + the app-shell upgrades (SH1–SH5).
- **Backends are REAL** for all but the four product **TARGET**s carried from TASK-371: tenant **tags** (F9), tenant **SUSPENDED/ARCHIVED archive** (F6), storage **quota/usage** (S3), and aggregate **usage roll-ups** (Overview). These are drawn disabled/em-dash, never fabricated.
- **TASK-379 added the frontend** for every row + **6 pure-logic Vitest suites** (34 tests: `permissions`, `tenant-key`, `tenant-user-query`, `department-draft`, `agent-instruction-draft`, `occ`) and **two E2E specs** (`apps/api/tests/e2e/task-379-tenant-detail.spec.ts`, `apps/admin/e2e/task-379-tenant-detail.spec.ts`) — **authored; run pending a seeded stack**.
- The biggest residual **test debt** is the same as TASK-371: tenant **update happy-path** + **enable/disable** and the **department/user-department write** flows had no backend E2E — the new `task-379-tenant-detail.spec.ts` is authored to close exactly those (flips 🟡→🟢 once run green).

---

# 1. Tenant fleet & detail (`13` + `18p`)

## 1.A — Tenant fleet & lifecycle

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| F1 ↔ T371 F1 | List + search/filter/sort/paginate tenants; row → detail | `13 · Tenant Management` `69:1416`; list `routes/.../tenants/index.tsx` | `GET /admin/tenants` `tenant.controller.ts:113` → `TenantService.fetchAll` | `tenants.spec.ts` (401 + list + pagination); `task-326-…cross-tenant.spec.ts` (isolation); **`task-379` BE** (list + isolation, authored); **`task-379` FE** (list→detail nav) | 🟢 |
| F2 ↔ T371 F2 | View one tenant (detail layout) | `18p · Overview` `95:6164` | `GET /admin/tenants/:id` `tenant.controller.ts:168`; `…/code-name/:code-name :180` | `tenants.spec.ts` (401); **`task-379` BE** (get-by-id happy-path, authored); **`task-379` FE** (detail header renders) | 🟡 |
| F3 ↔ T371 F3 | Create tenant (key uniqueness + immutability) | `Dlg · Add Tenant` `110:7669` | 🔒 `POST /admin/tenants` `tenant.controller.ts:102` (`@CanManage('Tenant')`) | `tenant-access-control.spec.ts` (super create→delete; doctor 403); **`task-379` BE** (create→cleanup, authored); FE pure-logic `tenant-key.test.ts` (uniqueness/validate) | 🟡 |
| F4 ↔ T371 F4 | Edit tenant (name/description; key immutable on edit; OCC) | `Dlg · Add Tenant` `110:7669` (reused) | `PATCH /admin/tenants/:id` `tenant.controller.ts:218` (`@RequiresIfMatch`) | **`task-379` BE** (update happy-path **with `If-Match`** + 428-without, authored — closes T371 F4 gap); FE pure-logic `occ.test.ts` | 🟡 (was 🔴 in T371) |
| F5 ↔ T371 F5 | Enable / disable tenant | `Dlg · Disable Tenant` `110:8662` (AlertDialog) | `PATCH /admin/tenants/:id {resourceStatus}` `tenant.controller.ts:218` — DTO **`ENABLED\|DISABLED` only** | **`task-379` BE** (enable/disable round-trip, authored — closes T371 F5 test gap); FE: `route.tsx` `handleToggleStatus` + ConfirmDelete (X7) | 🟡 (was 🔴 test in T371) |
| F6 ↔ T371 F6 | Archive / recoverable-disable framing (X2/X7) | `Dlg · Disable Tenant` `110:8662` ("recoverable archive") | 🔴 **no `SUSPENDED`/`ARCHIVED` status** (DTO limited to ENABLED/DISABLED); 🔒 `DELETE /admin/tenants/:id :244` is the only removal | FE ships disable=recoverable-archive copy only; archive backend = gap | 🎯 (status) · 🟡 (disable) |
| F7 ↔ T371 F7 | Tenant usage stats (Overview KPIs) | `18p`/`18d` KPI tiles `120:8843` | `GET /admin/tenants/:id/usage` `tenant.controller.ts:156` → `getUsageStats` | `task-219-gaps.spec.ts` **A8** (`totalUsers`,`totalDepartments`) | 🟢 (BE) · 🎯 (roll-ups) |
| F9 ↔ T371 F9 | Tenant tags | tag chips on `Dlg · Add Tenant` `110:7669` | 🔴 **no `tags` field/endpoint** on tenant DTO | drawn-not-shipped (TARGET) | 🎯 |

## 1.B — Working-tenant context / app shell (`06 · Multi-Tenancy & Impersonation 61:985`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| F8 ↔ T371 F8 | Working-tenant switch + "Acting on" context | `06 · Multi-Tenancy & Impersonation` `61:985` + banner across detail pages | `GET /tenant/me` `my-tenant.controller.ts:42`; cross-tenant via `X-Tenant-Id` header + `isSuperAdmin` | `tenant-access-control.spec.ts` (super-admin no-tenant → 400 on `/tenant/me`); **`task-379` BE** (`/tenant/me` 400-no-context, authored); **`task-379` FE** (switcher writes context, banner shows) | 🟡 |
| SH1 | Role-tiered nav (RBAC default-deny X5) | `06` + shell tiers (`12-design-workflow.mdc`) | n/a (client gate mirrors server CASL) | FE pure-logic `permissions.test.ts` (`isSuperAdmin`/`canCreateTenant`/`isSystemTenant`/`canModifyTenant`); **`task-379` FE** (tenant-admin nav scoped) | 🟡 |
| SH2 | Working-tenant switcher → `auth-store.setTenant()` → SDK header | `06` switcher | drives `X-Tenant-Id` on every tenant-scoped call (no dedicated endpoint) | **`task-379` FE** (switch re-scopes a grid), authored | 🟡 |
| SH3 | "Acting on: «Tenant»" banner on mutation surfaces | `06` banner | n/a | **`task-379` FE** (banner visible on Config/Users/Storage) | 🟡 |
| SH4 | NoTenant empty state (GAP-ADM-001) on top-level `/users`+`/departments` | `06` NoTenant | n/a (cross-tenant fetch skipped) | **`task-379` FE** (super-admin no-tenant → NoTenant on `/users`), authored | 🟡 |
| SH5 | Breadcrumb `Home / Platform / Tenants / «Tenant»` | `18p` breadcrumb (README §5.12) | n/a (`useMatches()` + `staticData.crumb` + store) | **`task-379` FE** (crumb trail on detail), authored | 🟡 |

---

# 2. Tenant Overview activity (`18p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| O2 ↔ T371 O2 | Recent-activity feed (Overview) | `18p`/`18d` audit feed | `GET /admin/audit-logs` `audit-log.controller.ts:65` | `audit-log.spec.ts` (full); FE `overview.tsx` scopes to tenant via `scopeToTenant` | 🟢 |

---

# 3. Configuration (`22p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| C1 ↔ T371 C1 | Tenant config — feature flags / ASR pipeline / engine; OCC | `22p · Configuration` `109:6768` | `GET/PATCH /admin/tenants/configs/:identifier` `tenant.controller.ts:257`/`:275`; `GET/PUT /admin/tenant-frontend-config` `tenant-frontend-config-admin.controller.ts:36`/`:61` | `optimistic-locking.spec.ts` (OCC/412 on `configs/:id`); `tenant-access-control.spec.ts` (403); **`task-379` BE** (frontend-config GET/PUT + OCC `expectedVersion`, authored); FE pure-logic `occ.test.ts`; FE `configuration.tsx` (system-tenant lock) | 🟡 |

---

# 4. Storage (`37p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| S1 ↔ T371 S1 | Storage buckets — list / manage | `37p · Storage` `110:6976` | `GET /admin/tenants/storage/buckets` `tenant-bucket.controller.ts:47`; CRUD `:94…:176` | `task-307-*` (cross-tenant isolation), `task-219-gaps` A7 (CRUD); **`task-379` BE** (list buckets for seeded tenant, authored) | 🟢 |
| S2 ↔ T371 S2 | Provision system buckets | `37p` (implied) | 🔒 `POST /admin/tenants/storage/buckets/provision/:tenantId` `tenant-bucket.controller.ts:165` | none (not exercised by FE — provision is ops-only) | 🟡 BE · 🔴 test |
| S3 ↔ T371 S3 | Storage quota / usage | `37p` quota meter | ⚠️ **no quota endpoint**; objects/size **not on `TenantBucket`** | FE draws em-dash + explicit TARGET note (never fabricated) | 🎯 |

---

# 5. Departments (`34p` · `36p`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| D1 ↔ T371 D1 | Department card-grid + create | `34p · Departments` `110:7195`; foundation `08 · Card-Grid` `82:2231` | `GET /admin/departments` `department.controller.ts:44`; `POST :35` | **`task-379` BE** (list + create→update→soft-delete with `If-Match`, authored — closes T371 D1 gap); FE pure-logic `department-draft.test.ts` (trim/omit-empties) | 🟡 (was 🔴 test in T371) |
| D2 ↔ T371 D2 | Department detail — members + agent instructions | `36p · Department Detail` `110:7414` | `GET /admin/departments/:id` `department.controller.ts:77`. 🔴 **no `GET /admin/departments/:id/users`** | **`task-379` BE** (get dept by id, authored); FE derives members from tenant-user list + filter (noted) | 🟡 · 🔴 (reverse listing) |
| D3 ↔ T371 D3 | Default agents per dept (prompt-config) | `36p` / `Dlg · New Agent Instruction` `110:8440` | `PATCH /admin/departments/:id/prompt-config` `department.controller.ts:162`; prompt create `POST /admin/prompt-templates` (see T371 §1.G A2) | FE pure-logic `agent-instruction-draft.test.ts` (`serviceToCategory`/`toCreatePromptInput`); dialog scope-locked DEPARTMENT_DEFAULT | 🟡 · 🎯 (DNA slot) |
| D4 ↔ T371 D4 | Add members to dept (both directions) | `Dlg · Add Members` `110:8201`; `Dlg · Assign Departments` `110:7981` | `POST /admin/users/:id/departments` `user-departments.controller.ts:41` (list `:32`, update `:60`, unassign `:76`) | **`task-379` BE** (assign → list → unassign round-trip, authored — closes T371 D4 gap); FE `CheckboxPickerDialog` | 🟡 (was 🔴 test in T371) |

---

# 6. Audit log (`12`)

| ID | Use case / user story | Design (frame · node) | Backend API | Test | Status |
|---|---|---|---|---|---|
| AU1 ↔ T371 AU1 | Audit viewer — actor / resource / correlation + filters | `12 · Audit Log` `70:1843` | `GET /admin/audit-logs` `audit-log.controller.ts:65`, `…/cursor :144`, `…/:id :177`, `…/resource/:type/:id :205` | `audit-log.spec.ts` (auth/structure/actions/isolation) + `task-326`; consumed by Overview recent-activity | 🟢 |

---

## Test additions in this ticket

| Layer | File | Covers | Run state |
|---|---|---|---|
| FE unit (Vitest, pure-logic) | `apps/admin/src/features/tenants/__tests__/{permissions,tenant-key,tenant-user-query,department-draft,agent-instruction-draft}.test.ts` + `features/common/__tests__/occ.test.ts` | SH1/F3 (permissions·key), F1/F2 (member query), D1 (dept draft), D3 (agent draft), F4/C1 (OCC reducer) | ✅ green (part of the 14-file / 87-test app suite) |
| BE E2E (Playwright API) | `apps/api/tests/e2e/task-379-tenant-detail.spec.ts` | F1·F2·F3·F4(If-Match)·F5·F8·C1(OCC)·S1·D1·D4 + X1 isolation (404-over-403) | 🟡 authored — run pending seeded stack |
| FE E2E (Playwright UI) | `apps/admin/e2e/task-379-tenant-detail.spec.ts` | list→detail nav, tab switch (underline ↔ `Select`), working-tenant switcher, a dialog (full-screen mobile), NoTenant | 🟡 authored — run pending seeded stack |
| Manual (FE→BE) | [`MANUAL-E2E-TESTS.md`](../manual-tests/04-tenant-detail.md) | TD-01…TD-08 persona flows; cross-refs `docs/qa/manual-tests/01-multi-tenancy-management.md` | persona checklist |

> **Backend gaps carried forward** (unchanged from TASK-371 backlog; not introduced here): tenant **archive lifecycle** (F6), tenant **tags** (F9), **department→users** reverse listing (D2), **storage quota** (S3), **usage roll-ups** (Overview). These remain backend/test tickets — TASK-379 draws them as disabled/TARGET, never fabricated.
