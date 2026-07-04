# TASK-331 · Admin — Identity & Org (Tenant / User / Department) — Production Review


| Field        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent       | TASK-331 (Admin Console + Vox SDK Production Review)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Scope (code) | `apps/ui-playground/src/features/admin/{tenants,users,departments,api}/**`, `apps/ui-playground/src/routes/_authenticated/admin/{tenants,users,departments}.tsx`, `apps/ui-playground/src/store/auth-store.ts`, `apps/ui-playground/src/components/admin-route-guard.tsx`, `apps/api/src/modules/{tenant,user,department}/**`, `apps/api/src/interceptors/context.interceptor.ts`, `apps/api/src/database/tenant-context.provider.ts`, `packages/applications/src/services/{tenant,user,department,prompt-management}/**`, `packages/applications/src/common/{base.service.ts,tenant-guards.ts}`, `packages/database/src/extensions/tenant-scope.ts`, `packages/database/src/prisma/db_main/seed/{03-role,04-department,05-tenant,91-user}.ts` |
| Reviewed     | `fix/2605-review` @ e91fc450 · 2026-06-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Verdict      | **Not-ready** (2 Critical, 2 High)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |


## 1. Scope & Business Context

The "Identity & Org" cluster is the multi-tenant hospital control plane: a platform operator (**SUPER_ADMIN**, global scope) stands up customer tenants (hospitals), and each tenant's **TENANT_ADMIN** manages that hospital's users and departments. The core lifecycle is:

```
create tenant → create departments → create users → assign role (UserRoleAssignment) + department (UserDepartment) → user can log in
```

The login-time **membership invariant** (TASK-305 Phase F) makes the last two steps mandatory: a non-exempt user needs **both** a role assignment and a department assignment *within a tenant* or they are rejected at login.

Two admin scopes must both work:

- **Super/Global admin** — cross-tenant; per TASK-327 ("scope, not visibility") reaches the full console and "manages as" a chosen tenant via the `setTenant` → `X-Tenant-Id` header mechanism (TASK-328 A2).
- **Tenant admin** — locked to their own tenant for tenants/users/departments.

The headline result of this review: the admin **UI** is well-built, but the **server-side tenant-scoping contract the UI depends on for super-admins was never wired** — the `X-Tenant-Id` header was hardened into a *validate-only* signal (TASK-295 C-2 / TASK-307 W5.3) and no longer sets the request's tenant context. Every CLS-tenant-scoped admin surface therefore breaks for the super-admin persona, which is the persona that owns tenant/department/onboarding lifecycle.

## 2. Metrics Scorecard


| Metric                                  | Super/Global admin | Tenant admin | Evidence                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usability (no errors/defects/confusion) | 🔴                 | 🟡           | Super-admin Departments/Prompts/Storage tabs + user↔dept assignment all 400 (`department.service.ts:26,111`; `prompt-management.service.ts:78`; `user-departments.controller.ts:14-17`). Tenant-admin own-tenant flows work, but cross-tenant user enumeration via `fetchByTenant` (`user.controller.ts:119-125`).                            |
| Clean & friendly UX/UI                  | 🟡                 | 🟢           | Skeletons, per-mutation toasts, fixed-dim dialogs, icon+title+desc empty states present (`departments/index.tsx:888,952-953`; `users/index.tsx:1022,1030,1095`). Super-admin sees error states on broken flows, dragging the score down.                                                                                                      |
| Production-ready + seed data            | 🔴                 | 🟢           | Only the Global tenant has the realistic 18-dept catalog (`04-department.ts:13-302`); ArcaAI/4bits/Mumbai get one bare `GEN` each (`:313-362`); new console-created tenants get **0** departments (`tenant.service.ts:59-91`). Each customer tenant *does* ship a seeded admin + GEN dept, so tenant-admin demos work (`91-user.ts:491-530`). |
| Core-business / workflow fit            | 🔴                 | 🟡           | Super-admin cannot create departments, assign user↔dept, or onboard a new tenant through the console (blocked by #1). Tenant-admin can manage own tenant but new-user creation can't complete role+dept membership in one flow (#3).                                                                                                          |


**Overall: Not-ready.** The primary admin persona (super-admin) cannot perform the cluster's core jobs through the console.

## 3. Current State (with file:line evidence)

### 3.1 Tenant-context resolution (the linchpin)

1. **JWT is the sole source of CLS `tenantId`.** `JwtAuthGuard.validate` sets `clsService.set('tenantId', payload.tenantId)` (`apps/api/src/guards/jwtauth.guard.ts`). For a super-admin the issued token carries `tenantId: ''` — confirmed authoritative by the provider comment "super-admins authenticate without a tenant binding, so their JWT/CLS carries `tenantId: ''`" (`apps/api/src/database/tenant-context.provider.ts:42-44`).
2. `**X-Tenant-Id` is validate-only and never sets context.** `ContextInterceptor` only throws when the header *diverges* from a *truthy* JWT tenant; it does not write CLS (`apps/api/src/interceptors/context.interceptor.ts:65-81`). Because a super-admin's JWT tenant is empty/falsy, the header passes validation **but is ignored**.
3. `**BaseService.tenantId` reads CLS only.** `get tenantId() { return this.clsService.get('tenantId') || null; }` (`packages/applications/src/common/base.service.ts:84-86`) → `null` for super-admins.
4. **The only non-test reader of the header is the interceptor + CORS list** (`rg x-tenant-id` → `context.interceptor.ts:71`, `main.ts:172`). There is no header→CLS path anywhere.

Net: a super-admin who picks a tenant in the UI sets only the *frontend* store/header; the *backend* request tenant stays empty.

### 3.2 Department management

- Service hard-requires CLS tenant on every method: `getAll` (`department.service.ts:26`), `create` (`:111`), `update` (`:167`), `delete` (`:243,284`) each do `const tenantId = this.tenantId; if (!tenantId) throw new BadRequestException('Tenant ID is required')`. Soft-delete + audit are correct: `softDelete` (`:305`) and `broadcastSysEvent(ResourceDeleted)` (`:307`); Created/Updated/Viewed broadcast throughout.
- Controller guard mirrors this for non-super-admins and **lets SUPER_ADMIN through to the service** (`apps/api/src/modules/department/department.controller.ts` `fetchAll`; test `…/__tests__/department.controller.test.ts:160-167`). The test mocks `getAll`, so it proves the controller pass-through but **never exercises the real service**, which throws for the super-admin's empty tenant — masking the drift.
- UI standalone page: super-admin gets a tenant picker (`departments/index.tsx:736,748`), `effectiveTenantId = tenantKey || selectedTenantId` (`:751`), selecting calls `setTenantKey(...)` (`:763`) → `X-Tenant-Id`; then `useTenantDepartments(effectiveTenantId)` (`:775`), `useCreateTenantDepartment` (`:822`), toggle/delete (`:823-824`). All resolve server-side to empty tenant → **400**.

### 3.3 Prompt + storage (tenant-detail tabs)

- Tenant detail renders 4 tabs — Users, Departments, Prompts, Storage (`tenants/index.tsx:2523-2553`); Departments uses `useTenantDepartments(tenantId)` and Prompts uses `usePromptTemplates(tenantId)` (`:1913-1914`); Prompts/Storage embed `PromptManagementPage`/`StorageManagementPage` with `scopedTenantId={tenantId}` (`:2549-2553`) — i.e. the same header mechanism.
- `prompt-management.service.ts` rejects empty CLS tenant in 7+ methods: `:78-80, :125-127, :258-259, :283-284, :305-306, :321-323, :397-398`. → **400** for super-admins. (Storage shares the header-scope pattern; same failure mode expected — verify.)
- The "Manage as tenant" pivot is `isGlobalScope`-gated and calls `setTenant(tenant.id, …)` (`tenants/index.tsx:2325-2332, 2383, 2445-2448`) — frontend-only.

### 3.4 User management

- `**fetchAll` (X2 fix verified):** non-super-admins are re-routed to `fetchAllByTenantId(callerTenantId)` from CLS; missing tenant → `ForbiddenException`; SUPER_ADMIN keeps cross-tenant read (`apps/api/src/modules/user/user.controller.ts:75-98`). ✅
- `**fetchByTenant` (NOT fixed):** `GET /admin/users/tenant/:tenantId` passes the **path param** straight to `fetchAllByTenantId({ tenantId })` with **no** `isSuperAdmin`/`assertTenantInScope`/CLS comparison — only the class-level `@CanManage('User')` (`:112-125`). `UserService.fetchAllByTenantId` filters by `UserRoleAssignments.some.tenantId = <param>` (`user.service.ts:88-110`); `User` is **not** in the tenant-scoped model set (`packages/database/src/extensions/tenant-scope.ts`), so no auto-filter compensates. → any admin with `manage:User` (e.g. a TENANT_ADMIN) can enumerate **any** tenant's users by UUID. **IDOR.**
- **Create flow:** `useCreateUser` (`users/index.tsx:1464`) → `POST /admin/users` → `UserService.create` builds a tenant-less identity + `broadcastSysEvent(ResourceCreated)` (`user.service.ts:23-43`); no role and no department are attached. user↔department assignment exists but lives in the detail dialog (`useAssignUserDepartment`, `users/index.tsx:74,990`; section `:989-1106`) and depends on a tenant context → broken for super-admins (#1). Soft-delete (`user.service.ts:198`) + audit (`:200`) correct.
- **Impersonation:** `startImpersonation` exists in the store (`auth-store.ts:39,106`) and is wired in the playground overview, but `rg -i impersonat` in `features/admin/users/index.tsx` returns **nothing** — the admin user list/detail exposes no Impersonate action.

### 3.5 Tenant management

- `fetchAll` restricts non-super-admins to their own tenant; per-row `fetchById/update/delete` use `assertTenantInScope` (super-admin bypass) (`apps/api/src/modules/tenant/tenant.controller.ts`). ✅ Tenant isolation here is correct.
- `TenantService.create` provisions **system buckets** (`tenant.service.ts:78`) and **configs copied from Global** (`:88`, `provisionTenantConfigs` `:120-160`) and broadcasts `ResourceCreated` (`:71`) — but provisions **no department**. Soft-delete (`:424`) + audit (`:426`) correct.
- Config reads use the **path identifier**, not CLS (`GET /admin/tenants/configs/:id` → service receives `tenantId: identifier`), so configs *do* work cross-tenant for super-admins — the deliberate exception called out at `tenant-context.provider.ts:47`.

### 3.6 Roles / scope predicates

- Seeded roles: SUPER_ADMIN, TENANT_ADMIN, DOCTOR, NURSE, SERVICE_ACCOUNT, DEPARTMENT_HEAD, SENIOR_NURSE (`03-role.ts:31-103`). **No `GLOBAL_ADMIN`.**
- Frontend predicates reference a non-existent role: `isGlobalScope` → `roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN')` (`auth-store.ts:140-143`); `isAdmin` adds `GLOBAL_ADMIN` (`:153-156`). The `GLOBAL_ADMIN` arm is dead.
- Route gate `RequireAdmin` admits SUPER_ADMIN∪GLOBAL_ADMIN∪TENANT_ADMIN and its comment asserts "per-tenant … scoping is enforced server-side (X-Tenant-Id + CASL)" (`admin-route-guard.tsx:11-14`) — the precise statement that is **false** for CLS-scoped surfaces.

## 4. Findings (severity-ranked)


| #   | Sev          | Area                    | Issue                                                                                                                                                                                                                                                                                     | Evidence (file:line)                                                                                                                                                                                                                                                                                                                               | Metric                              |
| --- | ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | **Critical** | RBAC / multi-tenancy    | Super-admin "manage as tenant" is non-functional for every CLS-scoped surface (Departments CRUD, Prompts, Storage, user↔dept assignment). `X-Tenant-Id` is validate-only and never sets CLS tenant; super-admin CLS tenant is `''`, so services throw `400 "Tenant ID is required"`.      | `context.interceptor.ts:65-81`; `tenant-context.provider.ts:42-49`; `base.service.ts:84-86`; `department.service.ts:26,111,167,243`; `prompt-management.service.ts:78-80,125-127,258-259`; `user-departments.controller.ts:14-17`; `departments/index.tsx:751,763,775,822`; `tenants/index.tsx:2325-2332,2549-2553`; `admin-route-guard.tsx:11-14` | Usability, Core-workflow            |
| 2   | **Critical** | Tenant isolation (IDOR) | `GET /admin/users/tenant/:tenantId` has no tenant-scope guard; any `manage:User` holder (TENANT_ADMIN) can enumerate any tenant's users. The X2 fix patched only `fetchAll`.                                                                                                              | `user.controller.ts:112-125` (vs guarded `:75-98`); `user.service.ts:88-110`; `tenant-scope.ts` (User not scoped)                                                                                                                                                                                                                                  | Usability (security/data-integrity) |
| 3   | **High**     | Membership invariant    | Console-created users can't satisfy login membership: create is tenant-less with no role/dept (`useCreateUser`), and the only dept-assignment UI is the detail dialog, which is broken for super-admins (#1). Result: orphaned users who fail TASK-305 Phase F login check.               | `users/index.tsx:1464,989-1106`; `user.service.ts:23-43`; `user-departments.controller.ts:14-17`                                                                                                                                                                                                                                                   | Core-workflow                       |
| 4   | **High**     | Tenant lifecycle        | New-tenant onboarding is blocked end-to-end for the super-admin: `TenantService.create` provisions configs+buckets but **no department**, and super-admin can neither create a department nor assign users (#1) → a console-created tenant cannot be onboarded without direct DB seeding. | `tenant.service.ts:59-91`; `04-department.ts:313-362`; (blocked by #1)                                                                                                                                                                                                                                                                             | Core-workflow, Production-ready     |
| 5   | **Medium**   | Capability gap          | Admin user list/detail exposes no Impersonate entry point, though `startImpersonation` exists and is used in the playground overview.                                                                                                                                                     | `users/index.tsx` (no `impersonat` match); `auth-store.ts:39,106`                                                                                                                                                                                                                                                                                  | Usability, Core-workflow            |
| 6   | **Medium**   | Seed realism            | Realistic 18-dept catalog exists only for the Global tenant; the 3 "real" customer tenants each have a single bare `GEN`; cross-tenant demos are thin and super-admin can't enrich them via console (#1).                                                                                 | `04-department.ts:13-302` vs `:313-362`                                                                                                                                                                                                                                                                                                            | Production-ready                    |
| 7   | **Low**      | Drift                   | `GLOBAL_ADMIN` is referenced in scope predicates but is not a seeded role, so the "GLOBAL_ADMIN ≡ SUPER_ADMIN" (TASK-327) equivalence can never trigger — dead code.                                                                                                                      | `auth-store.ts:140-143,153-156`; `03-role.ts:31-103`                                                                                                                                                                                                                                                                                               | Usability (drift)                   |
| 8   | **Low**      | Test/comment drift      | A passing test and two code comments assert super-admin/header scoping that the runtime does not honor, masking #1.                                                                                                                                                                       | `department.controller.test.ts:160-167`; `user-departments.controller.ts:14-17`; `admin-route-guard.tsx:11-14`                                                                                                                                                                                                                                     | Usability (drift)                   |


## 5. Solutions & Actionable Plan

> Layer chain notation: Database → Domain → Service → API → UI. Verify commands assume repo test scripts.

### Finding 1 — Super-admin tenant scoping (Critical) — **the keystone fix**

- **Root cause:** an architectural contract mismatch. The console (TASK-327/328) was designed for header-based super-admin scoping (`setTenant` → `X-Tenant-Id`), but the security hardening (TASK-295 C-2 / TASK-307 W5.3) made `X-Tenant-Id` *validate-only*. Nothing translates a super-admin's chosen tenant into the request's CLS tenant, and the CLS-scoped services hard-require it.
- **Solution (recommended — Option A, smallest systemic fix):** in `ContextInterceptor`, perform an **explicit, role-gated elevation**: when `isSuperAdmin(clsUser)` **and** the JWT tenant is empty **and** a syntactically valid `X-Tenant-Id` is present, set `clsService.set('tenantId', headerTenant)` (and audit the elevation). Non-super-admins keep the existing reject-on-mismatch path. This makes all CLS-scoped services work for the chosen tenant with no service changes, and keeps tenant isolation intact (only a super-admin can elevate, and only into an explicitly named tenant).
  - **Option B (defensive, additive):** add path-param endpoints mirroring users (`GET/POST /admin/departments/tenant/:tenantId`, prompts likewise) guarded by `assertTenantInScope`. More surface area; prefer A.
- **TDD plan:**
  - RED — `context.interceptor` spec: super-admin + empty JWT tenant + `X-Tenant-Id: <T>` ⇒ CLS `tenantId === T`; non-super-admin + divergent header ⇒ still `BadRequestException`; super-admin + **no** header ⇒ CLS tenant stays empty (pass-through).
  - RED — `department.controller.test`: replace the mocked-service "allows SUPER_ADMIN" case with one that drives the **real** service path and asserts the elevated tenant's rows are returned (kills the masking test in #8).
  - GREEN — implement the elevation branch.
  - REFACTOR — extract a `resolveActiveTenant(clsUser, header)` helper; reuse in tests; emit a `SysEvent` for the elevation.
- **Layer chain:** API (interceptor) → (Service/UI unchanged). 
- **Verify:** `pnpm test:unit --filter @arcaai/api` then `pnpm test:e2e` (super-admin lists/creates a department under a selected tenant).

### Finding 2 — `fetchByTenant` IDOR (Critical) — **quick-win**

- **Root cause:** the X2 hardening was applied to `fetchAll` only; the sibling path-param route was left with the bare `@CanManage('User')` action check, which does not constrain *which* tenant.
- **Solution:** in `fetchByTenant`, if `!isSuperAdmin(cls.user)` require `cls.tenantId === tenantId` else `ForbiddenException` (mirror `fetchAll` `:83-86` and the tenant controller's `assertTenantInScope`).
- **TDD plan:** RED — controller test: TENANT_ADMIN of tenant A calling `fetchByTenant('B')` ⇒ `ForbiddenException`, service untouched; SUPER_ADMIN ⇒ allowed; tenant-admin for own tenant ⇒ allowed. GREEN — add the guard. REFACTOR — factor a shared `assertCanReadTenant(cls, tenantId)`.
- **Layer chain:** API (controller).
- **Verify:** `pnpm test:unit --filter @arcaai/api` (+ a focused e2e enumerating users with a tenant-admin token).

### Finding 3 — Membership can't be completed in the console (High)

- **Root cause:** create is identity-only; role + department are separate post-hoc steps, and the dept step inherits #1.
- **Solution:** (a) land #1 so the dept step works for super-admins; (b) add an optional "tenant + role + department" group to the create dialog and have the API create the `UserRoleAssignment` + `UserDepartment` transactionally when supplied; (c) optionally surface a "membership incomplete — cannot log in" badge in the user list to make orphaned users visible.
- **TDD plan:** RED — service test: `createUserWithMembership({tenantId, roleId, departmentId})` persists user + role + dept atomically and rolls back on partial failure; user fails login if either is missing (assert against the Phase F guard). GREEN — implement the orchestration. REFACTOR — reuse `UserDepartmentService.assign` / `UserRoleAssignmentService`.
- **Layer chain:** Service (`user.service` orchestration) → API (`UserController.create` accepts optional membership) → UI (create dialog fields + toast).
- **Verify:** `pnpm test:unit --filter @arcaai/applications` then `pnpm test:e2e` (create user → log in succeeds).

### Finding 4 — New-tenant onboarding blocked (High)

- **Root cause:** `TenantService.create` provisions configs+buckets but no department; combined with #1 the super-admin has no console path to add one.
- **Solution:** in `create`, after config provisioning, also create a default `GEN` department for the new tenant (mirror `CUSTOMER_TENANT_GEN_DEPARTMENTS`), so the tenant is immediately onboardable; with #1 fixed the super-admin can then add the first admin user + membership.
- **TDD plan:** RED — service test: `create` yields ≥1 department for the new tenant and a `ResourceCreated` for it. GREEN — provision the department. REFACTOR — share the GEN template with the seed constant.
- **Layer chain:** Service (`tenant.service.create`) → (depends on #1 for UI completion).
- **Verify:** `pnpm test:unit --filter @arcaai/applications`.

### Finding 5 — Impersonation entry point (Medium) — **quick-win**

- **Root cause:** the action was wired in the playground overview list but not ported to the admin users feature.
- **Solution:** add an "Impersonate" item to the admin user row/detail menu calling the existing `startImpersonation` (reuse the playground component's handler); gate on `isGlobalScope`.
- **TDD plan:** RED — render the admin user row, assert an Impersonate action appears for a global-scope admin and is absent otherwise. GREEN — add the menu item. 
- **Layer chain:** UI only.
- **Verify:** `pnpm test --filter @arcaai/ui-playground` (component test).

### Finding 6 — Seed realism (Medium)

- **Root cause:** the rich catalog was seeded only for the Global tenant.
- **Solution:** give each customer tenant a small, realistic department set (e.g. GEN, CARD, ER) so all four tenants demo well; keep prompt IDs null where they reference Global templates.
- **Layer chain:** Database (seed `04-department.ts`).
- **Verify:** re-seed in a scratch DB and confirm counts (no destructive ops on shared DBs).

### Finding 7 — `GLOBAL_ADMIN` dead predicate (Low) — **quick-win**

- **Solution:** either drop the `GLOBAL_ADMIN` arm from `isGlobalScope`/`isAdmin` (simplest, matches seed reality) **or** seed a `GLOBAL_ADMIN` role aliased to SUPER_ADMIN policies if the equivalence is intended. Pick one and make code + seed agree.
- **Layer chain:** UI store (or Database seed).
- **Verify:** `pnpm test --filter @arcaai/ui-playground`.

### Finding 8 — Misleading test/comments (Low)

- **Solution:** addressed by the #1 RED step (real-service department test) + correct the `user-departments.controller.ts:14-17` and `admin-route-guard.tsx:11-14` comments to describe the elevation contract that actually ships.
- **Layer chain:** API + UI comments / tests.

**Quick-wins:** #2 (controller guard), #5 (menu item), #7 (predicate cleanup) are isolated and low-risk; #1 is the keystone that unblocks #3 and #4.

## 6. Seed Data Assessment

- **Tenants (`05-tenant.ts`):** 5 rows — `__SYSTEM_`_, `__GLOBAL__`, ArcaAI, 4bits, Mumbai General Hospital (`:6-42`). SYSTEM/GLOBAL are internal but will appear in the super-admin tenant list; consider flagging them as non-customer in the UI.
- **Departments (`04-department.ts`):** 18 rich departments — all under the **Global** tenant (`:13-302`); ArcaAI/4bits/Mumbai get exactly one bare `GEN` each (`:313-362`). Demonstrable variety exists for one tenant only.
- **Roles (`03-role.ts`):** 5 system + 2 extendable roles, no `GLOBAL_ADMIN` (drives Finding 7).
- **Users (`91-user.ts`):** SUPER_ADMIN under SYSTEM tenant (`:122-127`), TENANT_ADMIN under Global (`:139-144`), ARCAAI/FOURBITS/MUMBAI admins under their tenants (`:491-530`); the seeder creates **both** `userRoleAssignment` (`:613-627`) and `userDepartment` (`:645-656`) per user, so seeded users satisfy the membership invariant and can log in. This is exactly the path the *console* cannot reproduce for super-admins (Findings 1/3/4) — the seed compensates for a broken UI workflow.
- **Verdict:** good enough to **demo the tenant-admin persona per tenant**; insufficient to demo the **super-admin cross-tenant** persona, and the gaps can't be filled through the console.

## 7. UX/UI Notes (rules 07/10/11)

Positives (the UI layer is genuinely solid):

- **Skeletons over spinners** and empty states with title+description: `departments/index.tsx:888,952-953` ("No tenant selected" / "Select a tenant to view departments.").
- **Toast on every mutation:** primary/remove dept assignment toasts (`users/index.tsx:1022,1030`); pervasive across mutations.
- **Multi-column master/detail** with super-admin tenant column composed in conditionally (`departments/index.tsx:1076-1077`).
- **Tabbed tenant detail** (Users/Departments/Prompts/Storage) via composition with `embedded` + `scopedTenantId` rather than forks (`tenants/index.tsx:2523-2553`).

Issues:

- **Broken-flow error surfacing (Usability):** for super-admins, Departments/Prompts/Storage tabs will render error/empty states driven by 400s (Finding 1) — confusing, since the UI implies success is possible.
- **Disabled affordances without explanation:** "Create" is disabled when `!hasTenantContext` (`departments/index.tsx:932`) — fine — but once a tenant *is* selected, create still fails server-side for super-admins, with no inline reason.
- `**GLOBAL_ADMIN` dead arm** (Finding 7) is latent UX drift if anyone later seeds that string expecting parity.

## 8. Open Questions / Assumptions

1. **Intended super-admin contract:** is header-based elevation (Option A) the desired model, or should super-admins be required to impersonate a tenant admin (re-minted, tenant-bound token) to manage tenant-scoped resources? The fix differs accordingly; this review recommends Option A as the least invasive.  
Answer: the Super/Global admin should have a dedicated interface for managing tenants - it should be a separate route/path/menu with submenu. For managing tenant-scoped resources, the super/global admin must select the tenant from dropdown list to see the side bar menu before working. No need to impersonate any tenant admins
2. **Tenant-admin login without a tenant key:** the login field is optional ("Leave empty for global admin access", `credentials-form.tsx:91`). I did not read the server login resolver; if a tenant-admin who omits the key is issued an empty tenant, their CLS-scoped views would silently break like a super-admin's. Worth a targeted check of the auth/login service.  
Anwer: Incase of no tenant id or key provided, it should not log the tenant admin in. The tenant information only be empty for when super/global logging in.
3. **Storage tab:** assumed to share the header-scope failure with Departments/Prompts (same `scopedTenantId` mechanism, `tenants/index.tsx:2553`); not separately traced to the bucket service's tenant requirement — verify.  
Answer: Yes
4. **Severity of #2 vs CASL conditions:** I assumed `@CanManage('User')` performs an action-level check that passes for list endpoints without instance conditions. If a route-level CASL condition on `tenantId` is actually enforced for `fetchByTenant`, the IDOR is mitigated — but no such guard is present in the controller; please confirm against the CASL ability factory.  
Answer: Following best practice, suggest the solution that fit to our architecture

## 9. Implementation Summary (r2605)

**Status: Fixed — all 8 findings resolved.** Implemented in 4 non-overlapping worktrees off `fix/2605-review` and merged back; the full build/test/typecheck gate is green (evidence in §9.3).

### 9.1 Findings → resolution

| #   | Sev      | Resolution                                                                                                                                                                                                                                                                                                                                                       | Key files / commit                                                                                                                                                                                                                                                                                                  |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | **Option A** — `ContextInterceptor` performs a **role-gated elevation**: only when `isSuperAdmin(clsUser)` **and** the JWT tenant is empty **and** a syntactically valid `X-Tenant-Id` is present is it promoted into CLS `tenantId`. Non-super-admins keep reject-on-mismatch; the header can never override a tenant-bound JWT. Logic extracted to a pure `resolveActiveTenant()` helper. **UI:** tenant-scoped admin nav (Departments, Prompts, Storage, Configurations, DNA Reports, Audio Pipelines, Audit Logs) is **disabled until a tenant is selected** in the header ScopeSwitcher (Open-Q1); `setTenant` now keeps `tenantId`/`tenantKey` in lockstep so the selection is honoured everywhere. | `context.interceptor.ts`, `resolve-active-tenant.ts` (`286adfe2`); `admin-nav-items.tsx`, `app-sidebar.tsx`, `nav-group.tsx`, `draggable-nav-group.tsx`, `auth-store.ts` (`02d9c4a1`) |
| 2   | Critical | `fetchByTenant` now calls a shared `assertCanReadTenant(tenantId)` guard: SUPER_ADMIN reads any tenant; every other `manage:User` holder is confined to their CLS tenant (`ForbiddenException` otherwise) — mirrors the `fetchAll` X2 fix and the tenant controller's `assertTenantInScope`.                                                                       | `user.controller.ts` (`a13910d3`)                                                                                                                                                                                                                                                                                   |
| 3   | High     | **Backend:** `UserService.create` accepts optional `roleId`/`departmentId`/`isPrimaryDepartment` and provisions the `UserRoleAssignment` + `UserDepartment` **atomically** with the user via `$transaction` (active tenant from CLS, never the body); base `Repository.create` gained an optional `tx` param to enlist in the transaction. **UI:** the Create User dialog has an optional "Membership" section (Role + Department + primary) scoped to the active tenant; supplied fields ride the create POST so the account is login-ready (Phase F) in one step. | `createUser.request.ts`, `user.service.ts`, `repository.ts` (`a13910d3`); `users/index.tsx` (`9f0b1b48`)                                                                                                                                                                                                            |
| 4   | High     | `TenantService.create` now provisions a default `GEN` department (shared `DEFAULT_GEN_DEPARTMENT` template) after config/bucket provisioning and broadcasts `ResourceCreated` for it, so a console-created tenant is immediately onboardable.                                                                                                                     | `tenant.service.ts`, `departmentDefaults.ts` (`7bee7d9c`)                                                                                                                                                                                                                                                           |
| 5   | Medium   | Admin user rows gained an **Impersonate** action (gated on `isGlobalScope`) reusing the SDK `impersonate` → store `startImpersonation` path from the playground, with the same "select a tenant first" guard.                                                                                                                                                    | `users/index.tsx` (`9f0b1b48`)                                                                                                                                                                                                                                                                                      |
| 6   | Medium   | Each customer tenant (ArcaAI/4bits/Mumbai) now seeds a small realistic department set (specialty departments) alongside `GEN`; deterministic IDs added to constants; new seed test asserts counts.                                                                                                                                                               | `04-department.ts`, `00-constants.ts`, `seed.test.ts` (`7bee7d9c`)                                                                                                                                                                                                                                                  |
| 7   | Low      | Removed the dead `GLOBAL_ADMIN` predicate arm (never a seeded role) from `isGlobalScope`/`isAdmin` and every caller (`configurations`, `dna-reports`, `storage`, `introduction`, `user-list`, `use-doctor-context`). "Global scope" is SUPER_ADMIN only.                                                                                                          | `auth-store.ts` + callers (`02d9c4a1`)                                                                                                                                                                                                                                                                              |
| 8   | Low      | Replaced the masking mocked-service department test with one driving the real service path under an elevated tenant; corrected the `user-departments.controller.ts`, `admin-route-guard.tsx`, and `scope-switcher.tsx` comments to describe the elevation contract that actually ships.                                                                           | `department.controller.test.ts` (`286adfe2`); `user-departments.controller.ts` (`a13910d3`); `admin-route-guard.tsx`, `scope-switcher.tsx` (`02d9c4a1`)                                                                                                                                                              |

### 9.2 Open questions — disposition

- **Q1 (super-admin contract):** Adopted **Option A** (role-gated `X-Tenant-Id` → CLS elevation, no impersonation required). UI enforces "select a tenant first": tenant-scoped admin pages are disabled in the sidebar until a tenant is picked; cross-tenant surfaces (Overview, Tenants, Users directory, Prisma Studio) stay enabled so the picker is reachable.
- **Q2 (tenant-admin login without a key):** Verified the auth/login resolver already **rejects** a tenant-admin login with no tenant key (only super/global may have an empty tenant) — no code change required.
- **Q3 (storage tab):** Confirmed it shared the header-scope failure; fixed transitively by the #1 elevation (no per-service change).
- **Q4 (#2 vs CASL):** Implemented the controller-level `assertCanReadTenant` guard (best-practice, matches the existing `fetchAll`/`assertTenantInScope` pattern) rather than relying on CASL instance conditions.

### 9.3 Verification evidence (merged `fix/2605-review`)

- **Builds (typecheck):** `@arcaai/database`, `@arcaai/domains`, `@arcaai/applications`, `@arcaai/api` (nest), and `@arcaai/ui-playground` (`tsc --noEmit`) — all clean.
- **Unit tests:** applications **4626 passed** / 4 skipped · domains **1126 passed** / 2 skipped / 9 todo · database **642 passed** · api **1551 passed** / 4 skipped · ui-playground **871 passed**.
- **Merge:** 4 branches merged with **zero conflicts** (disjoint file sets). E2E (`pnpm test:e2e`) not run in this pass — recommended before release.

## 10. Change History

| Date       | Change                                                                                                                                                                                                       | Branches → merge                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-03 | Implemented all 8 findings (r2605). Parallel worktrees A (interceptor/elevation + #8 test), B (IDOR + atomic create-with-membership + repository tx), C (tenant GEN dept + seed realism), D (UI gating, create-dialog membership, impersonate, GLOBAL_ADMIN cleanup, #8 comments). Merged into `fix/2605-review`; full build/test/typecheck gate green. | `286adfe2`, `a13910d3`, `7bee7d9c`, `02d9c4a1`, `9f0b1b48` |

