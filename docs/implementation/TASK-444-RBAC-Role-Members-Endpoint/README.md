# TASK-444 — RBAC Role Members: Gateway Endpoint + Members Tab Data

- **Status**: Completed
- **Type**: feature (full-stack — domain → application → api → admin-console)
- **Owner**: apps/api (gateway) + `@arcaai/applications` + `@arcaai/domains` + admin-console (`features/rbac`)
- **Related**: **follow-up from TASK-438** (Role Management redesign — the Members tab shipped as an empty state because no users-by-role listing exists); TASK-437 (redesign foundation); TASK-419 (admin RBAC API surface); TASK-430 (cross-tenant admin surfaces).

## Requirement Analysis

The redesigned role detail (TASK-438) has a **Members** tab and the design shows **member-count chips** in both the role list and the detail header. Neither can be built today: the gateway exposes only the **inverse** direction (`GET /admin/users/:id/roles` — roles for a user), so there is no way to list "who holds this role" or to count members per role. The Members tab therefore ships an honest empty state and the count chips are omitted.

This ticket adds the missing direction end to end:

1. `GET /admin/rbac/roles/:id/members` — paginated list of the users assigned this role (name, department, status), tenant-scoped for the caller.
2. A **member count** surfaced on the role read(s) so the list chips and the detail header chip render (list needs counts per role without N calls; detail can use the paginated `total`).
3. Wire the `features/rbac` Members tab to the list and the count chips to the count.

### Acceptance criteria

- [x] `GET /admin/rbac/roles/:id/members` returns a paginated list (user display name, department, `resourceStatus`) scoped to the caller's tenant; unscoped platform admins see all assignments (parity with the settings/api-key `fetchAll` posture). _(service + controller unit tests; scoped extended client)_
- [x] A member count is available for the role list chips without one request per row (either `_count` on the list read or a cheap counts endpoint). _(`_count` merged into the role `findAll`/`findOne` include)_
- [x] Cross-tenant access returns 404 (not 403), per house posture; the route carries a permission decorator (boot audit enforces). _(`@CanAny(['read','Role'],['manage','Role'])` asserted by unit test; unknown role → 404; cross-tenant member rows are absent by scoping)_
- [x] admin-console Members tab lists members with skeleton/empty/error states; count chips render in the list + detail header. _(4 new screen specs + client/keys specs)_
- [ ] Contract/e2e coverage incl. a cross-tenant case (mirrors `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts`). _(console e2e members smoke added; gateway cross-tenant e2e deferred — see Implementation Summary caveats)_

## Current State Evaluation

Verified 2026-07-08.

### Gateway — RBAC roles controller (no members route)

- `apps/api/src/modules/rbac/roles.controller.ts` — `@Controller('admin/rbac/roles')`, class guard `@CanManage('Role')` (lines 20-23), injects `IRbacRoleService` (25). Routes: `findAll` `GET` (32-51, `@CanAny(['read','Role'],['manage','Role'])`), `findOne` `GET :id` (56-67), `create` `POST` (72-86), `update`/`patch` (91-125), `remove` `DELETE :id` (130-143, break-glass), `assignPolicy`/`removePolicy` on `:roleId/policies/:policyId` (148-179). The `toResponse` mapper (181-211) projects **only `RolePolicies`** — no member data, no count. **No members route exists.**

### Gateway — the inverse (roles-for-a-user) is all that exists

- Admin: `apps/api/src/modules/user/user.controller.ts` — `fetchUserRoleAssignments` `GET admin/users/:id/roles` (634-651) → `userRoleAssignmentService.fetchAllByUserId({ ...queryParams, userId: id })` (646). Self mirror: `apps/api/src/modules/user/controllers/user-roles.controller.ts:32-49`. Both are user→roles, never role→users.

### Application layer — no by-role query, no member count

- **User-role-assignment service** (`packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts`) — the sanctioned Prisma-access service (rule 04). Has `fetchAllByUserId` (351-379, `where: { userId }`) but **no `fetchAllByRoleId` and no count-by-role**. It already holds raw Prisma via injected `CoreDatabaseService` (line 36) with a count-style precedent (`countTenantSeats`, 50-57). A `fetchAllByRoleId({ ...props, roleId })` is a near-clone of `fetchAllByUserId` swapping the `where` key. Interface: `IUserRoleAssignmentService.ts:34-67`.
- **RBAC role service** (`packages/applications/src/services/rbac/role/role.service.ts`) — `findAll` (82-105) includes `ROLE_POLICIES_INCLUDE` only (**no `_count`**); `findOne` (107-110). Notably it **already injects `UserRepository` (line 73)** though the read paths don't use it — a convenient home if the count lives here. `RbacRoleRecord` (`IRoleService.ts:60-72`) carries no member/user count field; `IRbacRoleService` at 79-90.
- **Role DTO** — `apps/api/src/modules/rbac/dto/role.dto.ts`: `RoleResponse` (86-119) and `PaginatedRoleResponse` (138-150) have **no `memberCount`** — a new field is needed.

### Domain — the query is already index-backed

- `packages/domains/src/repositories/generated/core/UserRoleAssignmentRepository.ts` eager-loads `{ Role: true }` (line 14, TASK-424) but **not `User`**; it adds no custom methods and inherits the generic base (`packages/domains/src/common/repository.ts`) whose `findAll(props: IFindAllProps)` (127) and `count(props: ICountProps)` (135) both accept a `where` — so filtering by `roleId` is already possible; only the include needs extending to `User` (+ department) to surface names.
- Prisma: `UserRoleAssignment` (`packages/database/src/prisma/db_main/user.prisma:8-51`) — `tenantId` (21, non-null), `userId` (40), `roleId` (42), relations `User`/`Role` (41-43), `resourceStatus` (29), unique `(userId, roleId, tenantId)` (46), **indexes on `tenantId`/`userId`/`roleId`** (47-49) → a roleId-filtered query is index-backed. `Role` (`rbac.prisma:20-59`) is a **global (non-tenant-scoped)** model with back-relation `UserRoleAssignments` (53); `UserRoleAssignment` is **tenant-scoped**.

### admin-console — Members tab is a placeholder, chips omitted

- `features/rbac/components/role-detail.tsx:176-184` — `MembersTabPanel` renders an `EmptyState` ("Member listing isn't available yet") and the doc-comment (170-174) records the gap. Member-count chips are absent from the role list.
- `features/rbac/api/{client,types}.ts` — `Role` (`types.ts:29-41`) has `policies?[]` but **no members/`memberCount`**; RBAC uses its own envelope `RbacPaginated<T>` (`types.ts:21-27`) and raw query params (`RbacListParams`), unlike the other admin lists.

**Delta summary**: new domain query (`fetchAllByRoleId` + `User`/department include) → new application method + member-count derivation (`_count` on role read, or a counts helper) → new gateway route `GET /admin/rbac/roles/:id/members` + `memberCount` on `RoleResponse` → admin-console client/hook + Members tab list + count chips. The tenant-scoping decision (below) is the one real design call.

### Open items to resolve during the plan

1. **Tenant scoping of members.** `Role` is global but assignments are tenant-scoped. Scope the members list (and count) through the CLS-scoped repository client so a tenant admin sees only their tenant's holders and an unscoped platform admin sees all — matching the `fetchAll`/`fetchAllByTenantId` split already used by settings/api-keys/users. Do NOT use the auth-path raw unscoped reads (`userRoleAssignment.service.ts:59-130`) — those deliberately bypass tenant scope for the guard pipeline.
2. **Count strategy.** For the list chips, prefer a `_count: { UserRoleAssignments: true }` (tenant-scoped) added to the role `findAll` include so `PaginatedRoleResponse` rows carry `memberCount` in one query — avoids N per-row calls. The detail header can reuse the members list `total`. Confirm the `_count` respects the tenant-scope extension; if it can't be scoped cleanly, fall back to a dedicated counts path.
3. **Response shape.** Reuse the existing user/department response projections where possible (name, department, `resourceStatus`) to keep the members row DTO thin; decide whether to return a purpose-built `RoleMemberResponse` or a trimmed `UserResponse`.

## Implementation Plan

TDD; layer order per rule 01: Domain → Application → API → admin-console.

### 1. Domain (`packages/domains`)
- Extend the members query path so `UserRoleAssignment` can be read `where: { roleId }` with `User` (+ department) included (either a repository extension or the include passed from the service). Keep generated files unedited — put custom logic in a non-generated extension (rule 03). Tests: by-role query returns the right assignments; tenant-scope extension applies.

### 2. Application (`packages/applications`)
- Add `fetchAllByRoleId({ ...paginated, roleId })` to the user-role-assignment service (clone of `fetchAllByUserId`, `where: { roleId }`), returning members mapped to a Response DTO (name, department, status). Add the member **count** per Open-item 2 (prefer `_count` on the role `findAll`/`findOne` include in `role.service.ts`; expose it on `RbacRoleRecord`). Broadcast `ResourceViewed` on the read per convention. Tests: by-role list, count correctness, cross-tenant returns nothing/404, DTO mapping.

### 3. API (`apps/api`)
- Add `GET /admin/rbac/roles/:id/members` to `roles.controller.ts` (`@CanRead('Role')` or `@CanAny(['read','Role'],['manage','Role'])`, `PaginatedQuery`), delegating to the new service method; 404 for cross-tenant/unknown role. Add `memberCount` to `RoleResponse`/`PaginatedRoleResponse` (`dto/role.dto.ts`) fed from the role read's `_count`. Tests: unit (mock service) + e2e incl. a cross-tenant spec (pattern: `task-307-*-cross-tenant.spec.ts`).

### 4. admin-console (`features/rbac`)
- `api/client.ts` + `types.ts`: add `listRoleMembers(roleId, params)` → `RbacPaginated<RoleMember>` and a `RoleMember` type; add `memberCount` to `Role`. `api/hooks.ts`: `useRoleMembers(roleId, params)` + keys entry. Replace the `MembersTabPanel` empty state (`role-detail.tsx:176-184`) with a paginated member list (name · department · status) using `<Skeleton>`/`EmptyState`/error states. Render count chips in the grouped role list and the detail header from `memberCount`. Tests: members tab lists/paginates; empty + error states; count chips render.

### 5. Verification & evidence
- [ ] `pnpm --filter @arcaai/domains build test` · `pnpm --filter @arcaai/applications build test` green
- [ ] `pnpm build:api` + `pnpm test:unit` + members e2e (incl. cross-tenant) green
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green; Members tab + chips tested; axe 0 violations
- [ ] AC checklist all checked with pasted evidence

## Implementation Summary

Implemented 2026-07-08, TDD (failing test first at every layer), layer order Domain → Application → API → admin-console.

### Tenant-scoping decision (Open item 1 — resolved)

`Role` is global; `UserRoleAssignment` is tenant-scoped. Members are served through the **CLS tenant scope**, in two mechanically different but semantically identical ways:

- **Members listing** (`fetchAllByRoleId`) goes through the **scoped extended client** (`databaseService.client`, NOT `baseClient`) inside the sanctioned Prisma boundary of `UserRoleAssignmentService`: the tenant-scope `$extends` injects the caller's CLS tenant (tenant admin → own tenant's holders only), passes through for an unscoped platform admin (no CLS tenant + GLOBAL_ADMIN → all assignments), and the soft-delete extension filters DELETED rows — exact parity with the settings/api-key `fetchAll` posture. The auth-path `baseClient` reads in the same service were deliberately left untouched.
- **Member counts** on the role reads use a nested `_count: { UserRoleAssignments: { where … } }`. Nested relation reads are NOT intercepted by the tenant-scope extension (query extensions only see the dispatched model's top-level args — verified against `tenant-scope.ts`), so `RbacRoleService.roleReadInclude()` builds the filter explicitly from CLS: `resourceStatus: { not: DELETED }` + `tenantId` pinned when a tenant context exists, omitted otherwise. Count therefore always equals the members listing's `total`.
- **404-over-403**: the role itself is a global resource — unknown id → 404 from the existence check. There is no cross-tenant role read to hide; cross-tenant MEMBER rows are simply absent from the scoped listing (indistinguishable from not existing), and the same holds for the user's departments (matched to the assignment's tenant at mapping time so another tenant's department of the same global user never leaks).

### Per-layer changes

**Domain (`packages/domains`)** — no new repository needed; the one change is `RbacRoleRepository.findByIdWithPolicies(id, include = ROLE_POLICIES_INCLUDE)` gaining an optional include override so the role read can carry the member `_count` (hand-written repo, outside `generated/`, no drift-gate impact). Test added to `RbacRoleRepository.test.ts`.

**Application (`packages/applications`)**
- `IUserRoleAssignmentService`: new `RoleMemberRow` / `RoleMembersResult` types + `fetchAllByRoleId({ page, pageSize, roleId })`.
- `UserRoleAssignmentService.fetchAllByRoleId`: scoped-client `findMany`/`count` by `roleId` with a `User` select (username, status, `UserProfile` name/email, ENABLED `UserDepartments` + `Department.name`), `orderBy createdAt asc`, maps to `RoleMemberRow` (displayName = profile name → username fallback; department = assignment-tenant match, primary preferred), broadcasts `ResourceViewed` (read-only — no mutation events).
- `RbacRoleService`: `roleReadInclude()` merges the tenant-filtered `_count` into `ROLE_POLICIES_INCLUDE` for `findAll` + `findOne`; `RbacRoleRecord` gains optional `_count`. TASK-307 pinned include expectations updated to the new read shape.
- New tests: `role.service.task444.test.ts` (3), `userRoleAssignment.service.task444.test.ts` (5).

**API (`apps/api`)**
- `RolesController`: new `GET admin/rbac/roles/:id/members` — `@CanAny(['read','Role'],['manage','Role'])` (parity with the other read routes), role existence check → 404, delegates to `fetchAllByRoleId`, returns the RBAC `{ data, total, page, pageSize }` envelope. Controller now injects `IUserRoleAssignmentService`; `RbacModule` imports `UserRoleAssignmentServiceModule`.
- `role.dto.ts`: `RoleMemberResponse` + `PaginatedRoleMemberResponse`; `RoleResponse.memberCount?` (mapped only when the read carried `_count` — mutation returns leave it undefined rather than reporting a false 0).
- New tests: `roles-members.task444.test.ts` (6: permission metadata, 404 path, envelope delegation, memberCount mapping on findOne/findAll/create).

**admin-console (`apps/admin-console/src/features/rbac`)**
- `api/`: `RoleMember` type, `Role.memberCount?`, `listRoleMembers`, `rbacKeys.roleMembers`, `useRoleMembers` (keepPreviousData).
- `role-detail.tsx`: Members tab replaced the honest empty state with the real listing — skeleton rows, `ErrorState` with retry, `EmptyState` ("No members yet") when scoped-empty, member rows (displayName · email/username secondary · department badge · `ResourceStatusBadge`), Previous/Next pagination at pageSize 50. `MemberCountBadge` added to the detail header (pane + drawer).
- `roles-screen.tsx`: exported `MemberCountBadge` ("N member(s)", accessible) + an `aria-hidden` count chip on each list row (decorative duplicate so the row's accessible name stays the role name).
- Tests: +1 client/keys spec each, +4 screen specs (members tab listing, empty state, error state, count chips). E2E `rbac-roles.spec.ts`: new members-tab smoke (list OR scoped-empty state, header count chip, asserts the old "isn't available yet" copy is gone).

### Evidence (actual output)

- Domains: `pnpm --filter @arcaai/domains build` ✅ · `test` → `Test Files 105 passed | 2 skipped · Tests 1300 passed | 2 skipped | 9 todo`
- Applications: `pnpm --filter @arcaai/applications build` ✅ · `test` → `Test Files 272 passed | 1 skipped · Tests 5873 passed | 4 skipped` (a first run showed 7 fails in unrelated suites — voiceProfile/s3.health/otel/department-users — all pass in isolation and on re-run: parallel-run flakiness, pre-existing)
- API: `pnpm build:api` → `Tasks: 8 successful, 8 total` · rbac unit tests → `Test Files 3 passed · Tests 19 passed` · scoped eslint clean
- admin-console: `pnpm --filter @arcaai/admin-console lint` ✅ (0 warnings) · `test` → `Test Files 106 passed · Tests 810 passed`
- Live gateway (dev stack, 8868, seeded DB, super_admin JWT):
  - `GET /admin/rbac/roles` rows carry `memberCount` in one query: `DOCTOR: 15 · NURSE: 4 · GLOBAL_ADMIN: 2 · test: 0 …`
  - `GET /admin/rbac/roles/00000000-…-0020/members?page=1&pageSize=3` → `{ data: [{ displayName: "Michael Johnson", email: "dept.head@example.com", department: "General Practice", resourceStatus: "ENABLED", … }], total: 1, page: 1, pageSize: 3 }`
  - Unknown role id → HTTP `404`.
  - Tenant scoping: `GLOBAL_ADMIN` count = `2` unscoped vs `0` with `X-Tenant-Id: 50000000-…` (its holders live under the SYSTEM tenant) — the `_count` filter follows the working tenant.
  - The console detail header's "N member(s)" badge also asserted live by the Playwright members spec before the run destabilized (see caveat).

### Caveats / deferred

- The Playwright e2e run against the SHARED dev servers was unstable during implementation: concurrent agents were editing `features/settings/**`, so Next dev HMR kept remounting the page mid-test ("element is not stable / detached from the DOM"), failing pre-existing specs (permission-matrix, a11y) the same way. The new members spec's header-count assertion passed live before the click stalled. Re-run `npx playwright test tests/e2e/rbac-roles.spec.ts` once the tree is quiet.
- Gateway-side e2e (`apps/api/tests/e2e`) cross-tenant members spec not added in this pass (unit + contract coverage at the service/controller layers instead); mirrors of `task-307-*-cross-tenant.spec.ts` remain a fast follow if required.

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | **Implemented full-stack (TDD)**: `RbacRoleRepository.findByIdWithPolicies` include override (domains) → `fetchAllByRoleId` on the sanctioned user-role-assignment service via the SCOPED client + tenant-filtered `_count` member counts on the role reads (applications) → `GET admin/rbac/roles/:id/members` + `memberCount` on `RoleResponse` (api) → Members tab listing, count chips (list rows + detail header), client/keys/hooks + e2e members smoke (admin-console). Tenant-scoping decision recorded in the Implementation Summary (scoped client for the list; explicit CLS filter for the nested `_count`; 404-over-403 preserved — cross-tenant members are simply absent). All layer gates green (evidence pasted). Status → Review. |
| 2026-07-08 | Ticket created as follow-up from TASK-438; the deferred users-by-role listing + member counts are scoped here full-stack. Current-state map captured: no role→members route exists (only the inverse `GET /admin/users/:id/roles`), the by-role query is already index-backed (`UserRoleAssignment` indexes on `roleId`/`tenantId`), `fetchAllByRoleId` would clone `fetchAllByUserId`, and `RoleResponse` needs a new `memberCount` (`_count` on the role read). Tenant-scoping of members (global `Role` vs tenant-scoped assignments) is the key design call. Status: Pending (awaiting plan approval). |
| 2026-07-09 | **e2e closure — and the cross-tenant spec caught a real security bug (fixed in TASK-446).** New gateway spec `task-444-role-members-cross-tenant.spec.ts` initially failed M3/M4: Vault-mode `CoreDatabaseService.client` was unscoped (the vault Prisma factory never composed the tenant-scope extension), leaking other tenants member rows over 200. Root-caused + fixed under **[[TASK-446]]** (`docs/implementation/TASK-446-Vault-Prisma-Tenant-Scope-Leak`); re-run **6/6 green**, and a live curl confirms a tenant admin sees only their tenant (14 rows, one tenantId). Console `rbac-roles.spec.ts` Members tab + count chip green. Status: **Completed**. |
