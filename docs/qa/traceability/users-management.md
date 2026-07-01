> _Relocated from `docs/implementation/TASK-381-Users-Management/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-381 — Users Management Traceability Matrix

> **What this is:** the row-level **use-case → design → backend API (`file:line`)
> → test → status** map for the tenant **Users** surface (frames **20u** + **38u**
> panels a–g). Mirrors the legend/columns of
> [TASK-371 `TRACEABILITY-MATRIX.md`](./README.md)
> and **cross-links its rows U1–U13** (§1.C). It refines those rows with the
> as-shipped detail (TASK-381) and **corrects** three stale TASK-371 cells
> (verified live 2026-06-30 — see §Verification notes).

| | |
|---|---|
| **Ticket** | TASK-381 |
| **Created** | 2026-06-30 |
| **Status** | Review — design/traceability/test artifacts added |
| **Sources** | Designs = README §1 node ids + [TASK-371 §5.14](../../implementation/TASK-371-Admin-Console-Redesign/README.md); API = live `apps/api` / `packages/applications` (verified 2026-06-30); Tests = `apps/api/tests/e2e`, `apps/admin/e2e`, `apps/admin/src/features/users/__tests__`, `docs/qa/manual-tests` |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end |
| 🟡 | **Built, partial test** — code exists but only negative/RBAC E2E, frontend-unit (mocked), or manual coverage |
| 🔴 | **Gap** — designed, but **no backend endpoint** and/or **no test** |
| 🎯 | **Target** — design-only flow with no backend yet (intentional, README §2) |
| 🔒 | endpoint is **strictly super-admin-only** |

**Conventions (apply to every API cell):**
- All paths are under the global prefix **`/api/v1`** (`apps/api/src/main.ts`). `file:line` = the controller **handler method** line (verified live 2026-06-30).
- Authz is CASL (`@CanManage`/`@CanRead`/`@Authorize`) via a global `UnifiedAuthGuard`. User-management endpoints are **shared with `TENANT_ADMIN`** (tenant-scoped); super-admins get cross-tenant reach via inline `isSuperAdmin(user)` checks.
- User by-id routes are **not** Prisma-tenant-scoped, so the controller asserts scope explicitly via `assertUserInScope` (`user.controller.ts:213`) → **404-over-403** for an out-of-tenant target (X1).

## Coverage snapshot

- **13 primary use cases** (U1–U13) + the Create-User sub-flows, mapped to the **20u** grid and **38u** 7-tab detail.
- **REAL & now backed by automated backend E2E** (new `task-381-users-management.spec.ts`): list/sort/filter/search/paginate, **create**, status enable/disable, **department assign + setPrimary OCC**, roles list/assign, audit-by-user, admin user-settings, soft-delete (X2), tenant isolation (X1 404-over-403).
- **Frontend Playwright** (new, authored — run pending stack): grid (search/facets/View/card-list+FAB), Create-User dialog open, 7-tab detail switching (Select on mobile).
- **TARGET (un-backed, drawn disabled):** reset-password, Excel/PDF export, bulk server endpoint, per-user prompt scope, admin-edit-another preferences, cross-user DNA generate, profile name/phone.
- **Two former runtime gaps — RESOLVED + E2E-validated** (`task-381` §V1/V2 block): `PATCH /admin/users/:id/departments` now has a `setDepartments` handler (`user.controller.ts:103`) backing the Create-dialog initial-departments + bulk Assign-department path; `email` is now whitelisted on `CreateUserRequest` (`createUser.request.ts:18`) and upserted onto the user profile. See §Verification notes.

---

# 1. Users management (`20u` · `38u` + panels a–g) — cross-links TASK-371 §1.C U1–U13

| ID | Use case / user story | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| **U1** ↔ T371-U1 | Users data grid — search / filter / sort / paginate (US 26) | `20u · Data Grid` `120:9015`; states `120:10134` | `GET /admin/users` `user.controller.ts:100` → `fetchAll` (tenant-scoped via `assertCanReadTenant`/CLS) | `task-381-users-management.spec.ts` (list/sort/filter/search/paginate) · `task-375-admin-features.spec.ts` (sort/filter/bool/paging) · `task-326…cross-tenant.spec.ts` (X1) · FE `task-381` (grid renders) · unit `user-query.test.ts` | 🟢 |
| **U2** ↔ T371-U2 | Create user (US 27) | `Dlg · Create User` `120:10354` | `POST /admin/users` `user.controller.ts:89` (atomic `roleId`/`departmentId` membership optional; `email` whitelisted → upserted onto profile, §V1) | `task-381-users-management.spec.ts` (create username+password, appears in list, soft-deleted in cleanup; **§V1** create-with-`email` → persists on profile) · FE `task-381` (dialog opens) · unit `user-draft.test.ts` · manual `UAC-01` | 🟢 (email-on-create resolved — §V1) |
| **U3** ↔ T371-U3 | View / edit user detail — profile (US 28) | `38u · User Detail` `120:10575` + `38u-a · Profile` `121:11980` | `GET /admin/users/:id` `:157`; `PATCH /admin/users/:id` `:236`; profile `GET :id/profile` `:429` / `PATCH :id/profile` `:439` | `task-381` BE (update username/status round-trip) · FE `task-381` (detail header + Profile tab) · unit `user-draft.test.ts` (`toUpdateUserInput`) · manual `UAC-02` | 🟢 (name/phone = 🎯) |
| **U4** ↔ T371-U4 | Enable / disable (deactivate) user (US 30) | `20u` quick-disable · `38u` ⋯ | `PATCH /admin/users/:id` `:236` (`{resourceStatus}`, used by `useUsers.enable/disable`); dedicated `PATCH /admin/users/:id/status` `:251` also exists | `task-381` BE (disable→enable round-trip) · manual `UAC-04` (X7 confirm) | 🟢 |
| **U5** ↔ T371-U5 | Reset user password (US 31) | `20u` row action · `38u` header/Profile | 🔴 **no endpoint** (link-reset **and** admin-temp-password both TARGET, README §2) | drawn disabled + `Target`; manual `UAC` (NA) | 🎯 |
| **U6** ↔ T371-U6 | Bulk actions — disable / assign-dept / export (US 26) | `20u · Bulk Selected` `120:9913` | ⚠️ client loop (`Promise.allSettled`) over per-id `PATCH /admin/users/:id` (disable) — **no bulk-disable endpoint**; only `DELETE /admin/users/bulk` `:300` exists; bulk **assign-dept** → `PATCH /admin/users/:id/departments` **now has a handler** (`setDepartments` `:103`, §V2) | unit `bulk-selection.test.ts` · FE `task-381` (selection bar) · `task-381` BE (§V2 bulk reconcile) | 🟡 · 🎯 (server bulk-disable) |
| **U7** ↔ T371-U7 | Export users CSV / Excel / PDF (US 26) | `20u` Export ▾ | client-side **CSV** (`toUserCsv` + `download.ts`); **no server export endpoint** — Excel/PDF TARGET | unit `user-export.test.ts` (header, RFC-4180 escaping) · FE `task-381` (Export menu) | 🟡 (CSV) · 🎯 (Excel/PDF) |
| **U8** ↔ T371-U8 | View/update user preferences (US 28) | `38u-b · Preferences` `121:11981` | `GET /admin/users/:id/settings` `:351`; `PATCH /admin/users/:id/settings/:namespace/:key` `:364` **exist** — but the UI panel is TARGET (SDK hook is self-only) | `task-381` BE (admin GET+PATCH `:id/settings` round-trip on a throwaway user) | 🟡 (backend REAL · UI 🎯) |
| **U9** ↔ T371-U9 | Personalized agent instructions, per dept (US 117–126) | `38u-c` `121:11982` | `GET /admin/prompt-templates` `prompt-management.controller.ts:66` (filter `departmentId`); assign `POST …/assign-department :282` | FE `task-381` (Agent-instructions tab) · (no backend E2E in this ticket) | 🟡 (per-user scope = 🎯) |
| **U10** ↔ T371-U10 | DNA writing-style instructions (US 117–126) | `38u-d` `121:11983` | `GET /dna-writing-styles/doctor/:doctorId` `dna-writing-style.controller.ts:163` (**self-only — 403 for another doctor**); admin list `admin/dna-writing-styles` `dna-writing-style-admin.controller.ts:76` | FE `task-381` (DNA Style tab renders/degrades to empty) | 🟡 (self) · 🎯 (edit + cross-user — §V3) |
| **U11** ↔ T371-U11 | Department assignment (US 28, 111) | `38u-e` `121:11984`; `Dlg · Assign Departments` `110:7981` | `GET/POST /admin/users/:id/departments` `user-departments.controller.ts:32`/`:41`; **setPrimary** `PATCH :id/departments/:assignmentId` `:60` (OCC `If-Match`); `DELETE :assignmentId` `:76` | `task-381` BE (assign 2 depts → setPrimary OCC: 428 missing / 412 stale / 200 correct) · FE `task-381` (Departments tab) · manual `UAC-02.2` | 🟢 |
| **U12** ↔ T371-U12 | DNA reports + versions + diff (US 117–126) | `38u-f` `121:11985` | `GET /dna-writing-styles/doctor/:doctorId` `:163` + `:reportId/versions` `:242` (**self-only**); `generate` `:94` (self/impersonation); `setDefault` `:229`. Admin: list `:76` · `generate/:doctorId` `:139` · versions `:151` | FE `task-381` (DNA Reports tab) · SDK unit `useDnaStyle.*` | 🟡 (self) · 🎯 (cross-user generate — §V3) |
| **U13** ↔ T371-U13 | User activity history (US 42) | `38u-g` `121:11986` | `GET /admin/audit-logs/user/:userId` `audit-log.controller.ts:237`; CSV `GET /admin/audit-logs/export :106` | `task-381` BE (byUser returns rows, tenant-guarded) · `audit-log.spec.ts` (Fetch by User) · FE `task-381` (Activity tab) | 🟢 |

## 1.x — Create-User sub-flows & supporting endpoints

| ID | Use case | Design | Backend API (`file:line`) | Test | Status |
|---|---|---|---|---|---|
| U2a | Assign **role** on create / detail (US 27) | `Dlg · Create User` role select; `38u-a` role badges | `GET /admin/rbac/roles` `roles.controller.ts:39`; `POST /admin/users/:id/roles` `user.controller.ts:405` (`@CanManage('UserRoleAssignment')`); list `:385`; remove `:417` | `task-381` BE (list roles; assign role to new user; list assignments) · manual `UAC-03` | 🟢 |
| U2b | Assign **initial department(s)** on create | `Dlg · Create User` dept picker | atomic `POST /admin/users {departmentId}` `:89`; **or** post-create `useUsers.assignDepartments` → `PATCH /admin/users/:id/departments` (`setDepartments` `:103`, §V2 — now REAL) | `task-381` BE (atomic `POST :id/departments`; **§V2** bulk reconcile to exact set + primary) | 🟢 (atomic + PATCH path REAL) |
| X1 | Tenant isolation — out-of-tenant user (US 91) | n/a (cross-cutting) | `assertUserInScope` `user.controller.ts:213` → **404** (not 403) | `task-381` BE (arcaai_admin `GET /admin/users/{global-user}` → 404; TENANT_ADMIN list ⊂ SUPER_ADMIN) · `task-326…spec.ts` | 🟢 |
| X2 | Soft-delete (archive), not hard-delete | `38u` ⋯ / `20u` | `DELETE /admin/users/:id` `:267` → `softDelete` (record retained) | `task-381` BE (create → delete → absent from active list / 404 on re-read) | 🟢 |
| X6 | Auditability of mutations | `38u-g` feed | audit entries created by the service on create/update/assign; read via `:237` | `task-381` BE (CREATE entry for the new user via byUser) | 🟡 |

---

## Verification notes (corrections + gaps, verified live 2026-06-30)

**Corrections to [TASK-371 matrix](./README.md):**

- **(V3) U12 "no DNA-report endpoint found"** is **inaccurate** — DNA endpoints **exist**: self-scoped `dna-writing-style.controller.ts` (`getByDoctor :163`, `getVersions :242`, `generate :94`, `setDefault :229`, `my-style :105`, `mine :151`) **and** admin `dna-writing-style-admin.controller.ts` (`list :76`, `generate/:doctorId :139`, `getVersions :151`, `update :118` OCC, `dashboard :60`). The real limitation is **scope**: `getByDoctor`/`getVersions` are **self-only (403 for another doctor)**, so the `38u-d`/`38u-f` panels show REAL data only for a self-view and **degrade to empty** for another clinician. `getVersionDiff` is **composed client-side** from `getVersions` (no diff endpoint).
- **U8 "no admin-for-other settings endpoint"** is **inaccurate** — `GET /admin/users/:id/settings :351` and `PATCH /admin/users/:id/settings/:namespace/:key :364` **exist** (TASK-245). The Preferences panel is TARGET because the **SDK hook / UI** doesn't wire them, not because the backend lacks them.

**Former runtime gaps — RESOLVED + E2E-validated (landed; reconciled 2026-07-01 — see [README §3](../../implementation/TASK-381-Users-Management/README.md)):**

- **(V1) `email` on create — RESOLVED.** `CreateUserRequest` now whitelists `email?` (`createUser.request.ts:18`) and the service upserts it onto the user **profile** (`email` lives on `UserProfile`, not `User`), so a human create no longer 400s under `forbidNonWhitelisted` (`main.ts:124`). Pinned by `task-381` §V1 (`POST /admin/users {email}` → profile `email` round-trips).
- **(V2) `PATCH /admin/users/:id/departments` — RESOLVED.** The `setDepartments` handler now exists (`user.controller.ts:103`) and **bulk-reconciles** a user's memberships to exactly the requested `{departmentIds, primaryDepartmentId}` set, backing both the Create-dialog initial-departments and the bulk **Assign department** path (`useUsers.assignDepartments`). The per-assignment `POST/PATCH/DELETE :id/departments/:assignmentId` routes (detail Departments tab) are unchanged. Pinned by `task-381` §V2 (reconcile up to {d1,d2}, then down to {d2}; primary tracked).

> Both former SDK/admin-vs-backend contract mismatches are now closed in code
> and asserted by the live backend E2E (`task-381` §V1/V2 block) — no longer
> backlog.
