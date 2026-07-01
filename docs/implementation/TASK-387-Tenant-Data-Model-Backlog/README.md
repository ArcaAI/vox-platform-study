# TASK-387 — Tenant Data-Model + Department Backlog (§3a Group B)

| | |
|---|---|
| **Ticket** | TASK-387 |
| **Title** | Tenant lifecycle / tags / plan + Department→users listing + per-dept DNA writing-style slot |
| **Created** | 2026-07-01 |
| **Updated** | 2026-07-01 |
| **Status** | Completed (backend + SDK + Admin Console FE wiring) |
| **Depends on** | TASK-386 (Platform Metrics Backend — uncommitted, built on top of) |
| **Unblocks** | TASK-379 (Tenant Detail), TASK-381 (Users Mgmt), TASK-382 (Agents) FE surfaces |

---

## 1. Requirement Analysis

Implements **§3a backlog Group B** from `docs/admin-console-open-items-review.md` — the tenant data-model + department items that currently have no backend and are therefore drawn disabled / em-dash in the Admin Console. Five items:

| # | Item | Review ref | Layer surface |
|---|---|---|---|
| 1 | Tenant lifecycle `SUSPENDED` / `ARCHIVED` + restore; block system tenant on archive/delete | F6 / DEF-ADM-002 | enum + entity + service + controller + SDK |
| 2 | Tenant `tags` read/set endpoint | F9 | DTO + service + controller + SDK |
| 3 | Tenant `plan` enum field exposed in DTO | (plan badge) | schema + domain + DTO + SDK |
| 6 | `GET /admin/departments/:id/users` reverse listing | D2 | service + controller + SDK |
| 7 | Per-dept DNA writing-style default slot `dnaWritingStylePromptId` | D3 / U10 / AG13 | schema + domain + DTO + service + SDK |

### Acceptance criteria

- **#1** — Tenant can be moved to `SUSPENDED` / `ARCHIVED` and restored to `ENABLED` via dedicated endpoints. The system/default tenant (`__GLOBAL__` key, case-insensitive, or the reserved `00000000-…` id) is **blocked** from suspend/archive/delete (DEF-ADM-002). SUSPENDED is a first-class `ResourceStatusType`.
- **#2** — A tenant's `tags` are readable in the tenant DTO and settable via a dedicated endpoint. Tenant-scoped + CASL-gated.
- **#3** — `plan` is one of `ENTERPRISE | PRO | TRIAL | STARTER` (nullable), surfaced in the tenant DTO and settable on create/update.
- **#6** — Listing users of a department is tenant-scoped, CASL-gated (`manage:Department`), and paginated with the house `PaginatedQuery` / `PaginatedResponse` shape.
- **#7** — A department carries a nullable `dnaWritingStylePromptId`, get via the department DTO and set via the existing `prompt-config` PATCH.

---

## 2. Current State Evaluation

- **Tenant status** — `Tenant.resourceStatus` is a `ResourceStatusType` (`ENABLED | DISABLED | ARCHIVED | DELETED`). `enable`/`disable` are done via the OCC `PATCH /admin/tenants/:id { resourceStatus }`. There is **no** `SUSPENDED` and **no** dedicated lifecycle endpoints. `deleteById` soft-deletes with **no** system-tenant guard.
- **Tenant tags** — `Tenant.tags String[] @default([])` **already exists** in `tenant.prisma` and on `TenantEntity` (via `BaseTaggedEntity`). It is simply **not exposed** in `TenantResponse` and has no set endpoint. (A separate polymorphic `Tag` model exists for resource-level tagging but is **not** a relation to `Tenant`.)
- **Tenant plan** — does not exist.
- **Dept→users** — no server endpoint; the FE derives it client-side from `GET /admin/users/:id/departments`. The `UserDepartment` join table (`userId`, `departmentId`, `tenantId`, `resourceStatus`) is the source of truth.
- **Per-dept DNA slot** — `Department` has `preSummaryPromptId` / `newPatientPromptId` / `revisitPromptId` (loose `String?` prompt refs) but no `dnaWritingStylePromptId`.

---

## 3. Product decisions (made + FLAGGED)

> These are the reasonable, clearly-documented defaults chosen so implementation is not blocked. Flagged for product review.

1. **`plan` enum values** — `ENTERPRISE | PRO | TRIAL | STARTER` (verbatim from the review). Stored **nullable with no DB default** so existing tenants read `NULL` (= "unspecified / —") and no destructive backfill is implied. **FLAG:** whether new tenants should auto-default to `TRIAL`, and any billing/entitlement semantics attached to a plan, are product decisions — deliberately **not** wired to avoid implying entitlement behavior that does not exist yet.
2. **`tags` representation** — reuse the **existing `Tenant.tags String[]` scalar** rather than the polymorphic `Tag` model. The `Tag` model is designed for cross-resource tagging with its own lifecycle; the scalar is already present, already round-trips through `BaseTaggedEntity`, and matches how the FE expects a simple string list. No new table / relation.
3. **`SUSPENDED` / `ARCHIVED` semantics** —
   - `suspend` → `SUSPENDED` (reversible operator hold; distinct from `DISABLED` which is the routine on/off toggle).
   - `archive` → `ARCHIVED` (recoverable cold-storage state).
   - `restore` → `ENABLED` (single restore target from either SUSPENDED or ARCHIVED; simpler than status-dependent restore and matches the FE "Restore" affordance).
   - The lifecycle endpoints are **`POST` actions, non-OCC** (deliberate operator state-machine transitions), and **SUPER_ADMIN-only** (`@CanManage('Tenant')`, consistent with tenant create/delete). Routine `enable`/`disable` stays on the OCC `PATCH`.
4. **DEF-ADM-002 system-tenant guard** — the guard blocks a tenant whose `key` equals `__GLOBAL__` (compared **case-insensitively**, mirroring DEF-ADM-001) **or** whose id equals the reserved `SYSTEM_TENANT_ID` (`00000000-0000-0000-0000-000000000000`). Applied to `suspend` / `archive` / `deleteById`.
5. **`dnaWritingStylePromptId` shape** — a **loose nullable `String?` reference** to a `PromptTemplate` id, consistent with the sibling `*PromptId` columns (which are also loose refs, not hard FKs). No cross-table existence/category validation is added (keeps parity with siblings + keeps the change surgical). **FLAG:** if product wants a hard FK + `DNA_ANALYSIS`-category enforcement, that is a follow-up.
6. **Domain generated files were hand-edited** (additive fields only) rather than regenerated via `gen:*`. Rationale: `TenantEntity` / `DepartmentEntity` carry custom domain code (validate overrides, the `tenantId === id` trick, `isRootDepartment`/`hasChildren`); a blind regen risks clobbering it. The auto-mappers (`AutoClassMapper` / `AutoEntityChangeMapper`) are **name-based**, so adding a matching field to entity + model is sufficient — no mapper regen needed. Verified via `pnpm db:generate` + package build + unit tests.

---

## 4. Implementation Plan (STRICT layer chain + TDD)

**Database → Domain → Applications → API → SDK**, failing test first per behavior.

1. **DB** — `enums.prisma`: add `SUSPENDED` to `ResourceStatusType`; add `enum TenantPlan`. `tenant.prisma`: add `plan TenantPlan?`. `department.prisma`: add `dnaWritingStylePromptId String?`. Two additive migration folders (enum-value add split from the rest for Postgres transaction safety). `db:generate`.
2. **Domain** — enum `TenantPlan` + `SUSPENDED`; `Tenant` model `plan`; `Department` model `dnaWritingStylePromptId`; `TenantEntity` `plan` + `suspend()`; `DepartmentEntity` `dnaWritingStylePromptId`; factories. Mappers auto.
3. **Applications** — DTOs (`TenantResponse.tags/plan`, `Create/UpdateTenantRequest`, new `SetTenantTagsRequest`, `DepartmentResponse.dnaWritingStylePromptId`, `UpdateDepartmentPromptConfigRequest.dnaWritingStylePromptId`); `ITenantService` + `TenantService` (`suspend`/`archive`/`restore`/`setTags` + system-tenant guard); `IDepartmentService` + `DepartmentService` (`getDepartmentUsers` + wire `dnaWritingStylePromptId`). Unit tests first.
4. **API** — `TenantController` (`POST :id/suspend|archive|restore`, `PUT :id/tags`); `DepartmentController` (`GET :id/users`).
5. **SDK** — `useTenants` (`suspend`/`archive`/`restore`/`setTags` + endpoints); `useDepartments` (`getUsers` + `dnaWritingStylePromptId` + endpoint).
6. **E2E** — `apps/api/tests/e2e/task-387-*.spec.ts` run live against the TEST DB.

---

## 5. Implementation Summary

Delivered the full layer chain **Database → Domain → Applications → API → SDK + tests** for all five items. Files by layer:

### Database (`packages/database`)
- `src/prisma/db_main/enums.prisma` — added `SUSPENDED` to `ResourceStatusType`; added `enum TenantPlan { ENTERPRISE PRO TRIAL STARTER }`.
- `src/prisma/db_main/tenant.prisma` — added `plan TenantPlan?` (`tags String[]` already existed).
- `src/prisma/db_main/department.prisma` — added `dnaWritingStylePromptId String?`.
- Migrations (additive, no drops/renames):
  - `migrations/20260701010000_task_387_add_suspended_status/migration.sql` — `ALTER TYPE "core"."ResourceStatusType" ADD VALUE IF NOT EXISTS 'SUSPENDED'` (isolated: Postgres can't add an enum value and use it in the same tx).
  - `migrations/20260701010001_task_387_tenant_plan_and_dept_dna/migration.sql` — `CREATE TYPE "core"."TenantPlan"`, `ALTER TABLE "core"."Tenant" ADD COLUMN "plan"`, `ALTER TABLE "core"."Department" ADD COLUMN "dnaWritingStylePromptId" TEXT`.

### Domain (`packages/domains`)
- `src/enums/generated/TenantPlan.ts` (new) + `ResourceStatusType.ts` (`SUSPENDED`) + `enums/generated/index.ts` barrel.
- `src/models/generated/core/TenantModel.ts` (`plan`), `DepartmentModel.ts` (`dnaWritingStylePromptId`).
- `src/entities/generated/core/TenantEntity.ts` (`plan` field + `suspend()` method), `DepartmentEntity.ts` (`dnaWritingStylePromptId`).
- `src/factories/generated/core/TenantFactory.ts` (`plan`), `DepartmentFactory.ts` (`dnaWritingStylePromptId`).
- Mappers unchanged (name-based `AutoClassMapper` / `AutoEntityChangeMapper`).
- Tests: `entities/__tests__/TenantEntity.lifecycle-plan.test.ts` (new), `entities/generated/core/__tests__/DepartmentEntity.dna-writing-style.test.ts` (new).

### Applications (`packages/applications`)
- Tenant DTOs: `tenant.response.ts` (`plan` + `tags`), `createTenant.request.ts` (`plan` + `tags`), `updateTenant.request.ts` (`plan`), `setTenantTags.request.ts` (new) + `dto/index.ts` barrel.
- `ITenantService.ts` + `tenant.service.ts` — `suspend` / `archive` / `restore` (shared `transitionLifecycle`, non-OCC), `setTags`, `assertNotSystemTenant` (DEF-ADM-002, also wired into `deleteById`).
- Department DTOs: `department.response.ts` (`dnaWritingStylePromptId`), `update-department-prompt-config.request.ts` (`dnaWritingStylePromptId`), `department.dto.mapper.ts` (map-through).
- `IDepartmentService.ts` + `department.service.ts` — `getDepartmentUsers(id, query)` (append-only `UserRepository` injection; `UserDepartments.some` relational filter; tenant scoping w/ super-admin bypass; excludes `DELETED` memberships), `updatePromptConfig` now applies `dnaWritingStylePromptId`.
- Tests: `services/tenant/__tests__/tenant.service.lifecycle.test.ts` (new), `services/department/__tests__/department-users.service.test.ts` (new), `services/department/__tests__/department-prompt-config.service.test.ts` (DNA case added).

### API (`apps/api`)
- `src/modules/tenant/tenant.controller.ts` — `POST :id/suspend|archive|restore` (`@HttpCode(200)`, `@CanManage('Tenant')`), `GET :id/tags`, `PUT :id/tags` (class `@CanAny(manage|update Tenant)` + `assertTenantInScope`).
- `src/modules/department/department.controller.ts` — `GET :id/users` (`PaginatedQuery` → `PaginatedUserResponse`).
- No CASL seed change needed: all routes reuse existing `Tenant` / `Department` subjects (SUPER_ADMIN `manage:all`; TENANT_ADMIN tenant-scoped `update:Tenant` / `manage:Department`).

### SDK (`packages/agentic-sdk-v2`)
- `src/core/constants.ts` — `TENANT_ENDPOINTS.{SUSPEND,ARCHIVE,RESTORE,TAGS}`, `DEPARTMENT_ENDPOINTS.USERS`.
- `src/hooks/useTenants.ts` — `TenantPlan` type, `plan`/`tags` on `Tenant`/inputs, `suspend`/`archive`/`restore`/`getTags`/`setTags`.
- `src/hooks/useDepartments.ts` — `dnaWritingStylePromptId` on `Department`, `DepartmentUser` type, `getUsers(id, pagination)`.

### E2E
- `apps/api/tests/e2e/task-387-tenant-data-model.spec.ts` (new) — 9 tests, all live-green.

### Verification evidence

| Check | Command | Result |
|---|---|---|
| Domain unit | `vitest run src/entities src/factories` (@arcaai/domains) | **730 passed** (49 files) |
| Applications unit | `vitest run src/services/tenant src/services/department` (@arcaai/applications) | **290 passed** (17 files) |
| API unit | `vitest run src/modules/tenant src/modules/department` (@arcaai/api) | **113 passed** (8 files) |
| Build + client | `pnpm build:api` (runs `db:generate`) | **8/8 tasks OK**, clean |
| SDK build | `pnpm build --filter @arcaai/vox` | **6/6 tasks OK**, clean |
| Backend E2E | `pnpm test:e2e task-387-…` (live TEST DB @ :8868) | **9 passed** |

E2E coverage: #3 plan create/read + OCC PATCH; #2 tags PUT/GET/clear; #1 suspend→archive→restore; #1 RBAC (tenant_admin/doctor 403); #1 DEF-ADM-002 (`__GLOBAL__` suspend/archive/delete → 403); #6 dept-users paginated + 404 + doctor 403; #7 `dnaWritingStylePromptId` OCC round-trip.

### FE follow-up — DONE (Admin Console wiring, 2026-07-01)
Backend + SDK were complete; the Admin Console now wires every now-backed field (view wiring only — no SDK/backend change):

- **Plan (#3)** — `TenantPlanBadge` on the tenant list column + detail header, and a plan `<Select>` in the create/edit tenant dialog. Unset reads em-dash (`—`). DISPLAY + set-enum only — no entitlement/feature-gating UI.
- **Tags (#2)** — chips on the tenant detail header + a `TenantTagsDialog` (add/remove, whole-set replace) via `getTags` / `setTags`.
- **Lifecycle (#1)** — `TenantLifecycleMenu` (suspend / archive / restore) with per-action confirm dialogs on both the list rows (kebab) and the detail header; availability is status-driven; **hidden for the DEF-ADM-002 system tenant** via a new `canManageTenantLifecycle` / `isLifecycleProtectedTenant` gate (mirrors `__GLOBAL__` key + reserved zero-UUID).
- **Dept members (#6)** — the members grid now reads `useDepartments().getUsers` (server-authoritative) instead of filtering the first *N* tenant users; the tenant user page is kept only to populate the "Add members" candidate picker.
- **DNA writing-style slot (#7)** — the 4th default-agent slot is no longer a TARGET; it is a real wireable slot bound to `Department.dnaWritingStylePromptId`, persisted via `updatePromptConfig` (the `assign-department` POST doesn't whitelist that field).

**Known SDK caveat (follow-up, not a FE bug):** the two OCC PATCH paths reachable from these surfaces — tenant `update` (plan edit) and department `updatePromptConfig` (DNA slot) — go through the SDK's plain `patch`, which does **not** attach the `If-Match` header the `@RequiresIfMatch()` routes require (only the SDK's `patchWithIfMatch` does). Until the hooks adopt `patchWithIfMatch`, those two writes can return `428 Precondition Required` live; the FE already surfaces OCC conflicts via `reduceOccConflict`. The summary-slot writes are unaffected (body-OCC `assign-department` POST). Fixing the SDK is out of this FE scope.

Verification: `apps/admin` `tsc --noEmit` clean · `vite build` clean · **234 unit tests pass** (33 files) · E2E specs `task-379` (plan selector, plan/tags meta, system-tenant lifecycle hidden) + `task-382` (DNA slot no longer TARGET) updated and **compile-checked** (`playwright --list` → 108 tests). The live full-stack FE E2E run was deliberately deferred (parallel backend worker owns the live stack).

### Constraints honored
No `git push`, no commits (working tree only). No `DELETE`/`DROP`/`TRUNCATE` or destructive SQL: migrations are additive; the TEST DB was updated with a **non-destructive** `prisma db push` (not `--force-reset`). Built on top of the uncommitted TASK-386 changes; no TASK-386 / `docs/qa/*` / `task-376-storage.ts` / `secrets-coverage.test.ts` edits.

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-01 | Ticket created; current-state review + product decisions recorded | this README |
| 2026-07-01 | Implemented all 5 items across DB→Domain→Applications→API→SDK + unit/e2e tests; all suites + live e2e green | see §5 |
| 2026-07-01 | FE wiring of all 5 now-backed fields in the Admin Console (plan badge + selector, tags editor, lifecycle menu, dept members via `getUsers`, DNA writing-style slot). Admin `tsc`/`vite build` clean, 234 unit tests green, E2E specs updated + compile-checked. Flagged the SDK `If-Match` gap on the tenant-`update` / `updatePromptConfig` OCC PATCH paths. | `apps/admin/src/features/tenants/{tenant-plan.tsx,tenant-tags.ts,tenant-tags-dialog.tsx,tenant-lifecycle-menu.tsx,tenant-form-dialog.tsx,permissions.ts}`, `apps/admin/src/features/data-grid/status.ts`, `apps/admin/src/features/agents/{slot-config.ts,default-agent-slots.tsx,assign-slot-dialog.tsx}`, `apps/admin/src/routes/_authenticated/tenants/**`, `apps/admin/e2e/{task-379,task-382}.spec.ts` + unit tests |
| 2026-07-01 | **SDK `If-Match` caveat (§5 FE follow-up) RESOLVED.** `useTenants().update` now reads the row ETag and replays it via `patchWithIfMatch` (getWithEtag→patchWithIfMatch); `useDepartments().updatePromptConfig` replays the caller's `expectedVersion` as `If-Match`. Both `@RequiresIfMatch()` PATCHes no longer `428` live. SDK rebuilt; 66 OCC unit tests green; live backend OCC round-trips (task-387 #3 plan, #7 DNA slot) pass. See `docs/qa/RUN-RESULTS-2026-07-01.md` §7. | `packages/agentic-sdk-v2/src/hooks/{useTenants,useDepartments}.ts` + `src/hooks/__tests__/{useTenants,useDepartments}.test.ts` |
