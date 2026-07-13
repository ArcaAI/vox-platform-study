# TASK-501 — RBAC: SYSTEM-role editing, policy assign/revoke, and role cloning

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix + feature |
| **Area** | `@arcaai/domains`, `@arcaai/applications`, `apps/api`, `apps/admin-console` |
| **Reported by** | Manual test — admin app, `super_admin`, issue #2 |
| **Related** | TASK-307 (role service + cross-tenant), TASK-409 (break-glass), TASK-417 (GLOBAL_ADMIN consolidation) |

## Requirement Analysis

Three distinct requirements, plus one confirmed authorization decision.

1. **Bug — global admin cannot create/update a SYSTEM role.** Expectation: **only** a global
   admin (`GLOBAL_ADMIN`) may create or update a SYSTEM-type role; tenant admins cannot.
2. **Bug — nobody can assign/revoke permissions on a SYSTEM role.** The admin UI hard-locks
   the policy tab for every caller. **Confirmed decision (2026-07-12):** SYSTEM-role policy
   assign/revoke = **`GLOBAL_ADMIN` only** (mirrors requirement 1). Tenant admins operate on
   CUSTOM roles only. Rationale: SYSTEM roles are seed-managed and shared across all tenants;
   letting a tenant admin edit one is a cross-tenant privilege-escalation risk.
3. **Enhancement — clone a role.** Any admin may clone a role (SYSTEM **or** CUSTOM) into a
   **new CUSTOM role** that copies the source's policy set. Clones are always
   `isSystemRole: false` and scoped to the caller's tenant.

Domain vocabulary note: in this codebase "permission" = **`Policy`** (CASL rule sets), attached
to a `Role` through the **`RolePolicy`** join. "SYSTEM vs CUSTOM" is the boolean
`Role.isSystemRole` (there is **no** `RoleType` enum). "Assign/revoke permission" =
`assignPolicy` / `removePolicy`.

## Current State Evaluation

Live service: `packages/applications/src/services/rbac/role/role.service.ts` (`IRbacRoleService`),
controller `apps/api/src/modules/rbac/roles.controller.ts` (`@Controller('admin/rbac/roles')`).
(There is a legacy, unused `services/security/role/role.service.ts` — ignore it.)

**Requirement 1 — two independent defects, both unconditional (no caller-identity check anywhere):**

- **Create can never produce a SYSTEM role, for anyone.**
  `packages/domains/src/repositories/role/RbacRoleFactory.ts:66` hardcodes `isSystemRole: false`
  in `buildCreateInput`, and neither `CreateRoleDto` (`apps/api/src/modules/rbac/dto/role.dto.ts`)
  nor `CreateRbacRoleRequest` (`IRoleService.ts`) carries any `isSystemRole` field — there is no
  wire path to request one.
- **Update/patch reject any SYSTEM role, for everyone.**
  `role.service.ts` `update()` (≈176-178) and `patch()` (≈212-214):
  ```ts
  if (existing.isSystemRole) {
    throw new BadRequestException(`Cannot modify system role '${existing.name}'. ...`);
  }
  ```
  No `isSuperAdmin` carve-out. `softDelete()` (≈250-252) has the same pattern. This is **not** a
  CASL problem — the HTTP guard is a bare `@CanManage('Role')`, and the seeded `GLOBAL_ADMIN`
  policy `system-full-access` already grants `{ action: 'manage', subject: 'Role' }` unconditionally.

**Requirement 2 — the block is entirely client-side.**
Backend `assignPolicy()` (≈283-321) has **no** `isSystemRole` check; `removePolicy()` (≈323-366)
only guards `PROTECTED_SYSTEM_POLICY_NAMES` (anti-lockout), never `role.isSystemRole`. The lock
is `apps/admin-console/src/features/rbac/components/role-detail.tsx:310`:
```ts
const locked = role.isSystemRole; // hides attach/detach + AttachPolicyRow for ALL callers
```
There is **no** `useCurrentUser`/`isSuperAdmin` check — global and tenant admin see the same
`LockNotice`. The hooks `useAssignPolicyToRole` / `useDetachPolicyFromRole`
(`features/rbac/api/hooks.ts`) already hit the correct endpoints; they are simply unreachable.

**Requirement 3 — no clone anywhere.** `grep -i clone` across the RBAC surface returns zero
hits (only unrelated tenant-provisioning code).

**Canonical "is global admin" check:** `packages/applications/src/common/tenant-guards.ts` →
`isSuperAdmin(user)` (returns true iff caller has `GLOBAL_ADMIN`; `ELEVATED_ROLES = ['GLOBAL_ADMIN']`).
`RbacRoleService` does not currently import it — this is the missing piece for reqs 1 and 2.

## Implementation Plan

Follow the layer chain: domain → application service → API → admin-console. TDD throughout;
update the existing tests that lock in the current (buggy) behavior.

### Requirement 1 — create/update SYSTEM roles (global admin only)

1. **Domain** — `RbacRoleFactory.buildCreateInput`: accept an optional `isSystemRole` prop
   (default `false`) instead of hardcoding it.
2. **DTO** — add optional `isSystemRole?: boolean` to `CreateRoleDto` and `UpdateRoleDto`
   (`@ApiPropertyOptional`, `@IsBoolean`, `@IsOptional`) and to `CreateRbacRoleRequest`.
3. **Service** — `role.service.ts`:
   - `create()`: if `dto.isSystemRole === true` and `!isSuperAdmin(this.requestUser)` → throw
     `ForbiddenException` (tenant admin may not mint SYSTEM roles). Pass the flag to the factory.
   - `update()` / `patch()` / `softDelete()`: replace the unconditional `if (existing.isSystemRole) throw`
     with `if (existing.isSystemRole && !isSuperAdmin(this.requestUser)) throw` — global admin passes,
     tenant admin still blocked. Keep the anti-lockout `PROTECTED_SYSTEM_POLICY_NAMES` guards intact.
4. **API** — `roles.controller.ts`: no route change; `@CanManage('Role')` stays (CASL already allows
   global admin). The finer SYSTEM-role gate lives in the service where the caller identity is known.

### Requirement 2 — policy assign/revoke on SYSTEM roles (global admin only)

5. **Service** — `assignPolicy()` and `removePolicy()`: add
   `if (role.isSystemRole && !isSuperAdmin(this.requestUser)) throw new ForbiddenException(...)`
   (defense in depth — the UI already scopes it, but the server must enforce it since the endpoints exist).
6. **Admin-console** — `role-detail.tsx`: replace `const locked = role.isSystemRole` with
   `const locked = role.isSystemRole && !currentUserIsGlobalAdmin`, sourcing the current user's
   elevation from the session hook (add a `useCurrentUser`/session selector if absent). Global admin
   sees attach/detach + `AttachPolicyRow`; tenant admin keeps the `LockNotice` on SYSTEM roles.

### Requirement 3 — clone role → new CUSTOM role

7. **Service** — `IRbacRoleService.clone(sourceId, { name })`: read source role + its `RolePolicies`,
   `RbacRoleFactory.buildCreateInput({ ...source, name, isSystemRole: false, tenantId: this.tenantId })`,
   create the row, then loop `rolePolicyRepository.create(RolePolicyFactory.buildCreateInput({ roleId, policyId, priority }))`
   for each source policy (mirrors `assignPolicy`'s write). `broadcastSysEvent(ResourceCreated, ...)`.
8. **API** — `roles.controller.ts`: `@Post(':id/clone') @CanManage('Role')` + `CloneRoleDto { name }`.
9. **Admin-console** — `features/rbac/api/{client,hooks,types}.ts`: `cloneRole` call + mutation hook.
   Add a **"Clone"** action in `role-detail.tsx`'s `RoleDetailActions` (and/or `roles-screen.tsx` row
   actions) — this action must be visible for SYSTEM roles too (cloning a SYSTEM role is the point).

### TDD test list (RED first)

- `role.service.task307.test.ts` — **update** these existing assertions (they currently lock the buggy behavior):
  - "refuses to modify a system role" → split into: global admin **succeeds**; tenant admin **rejected (Forbidden)**.
  - create-with-`isSystemRole:true`: global admin succeeds; tenant admin rejected.
- New: `assignPolicy`/`removePolicy` on a SYSTEM role — global admin succeeds; tenant admin Forbidden.
- New: `clone()` — copies policy set, produces `isSystemRole: false`, tenant-scoped, broadcasts `ResourceCreated`.
- `apps/api/src/modules/rbac/__tests__/rbac-permissions.test.ts` + `apps/api/tests/e2e/rbac.spec.ts` — clone route, SYSTEM-role gate.
- Admin-console: `features/rbac/components/__tests__/roles-screen.test.tsx` — global-admin session unlocks policy tab on a SYSTEM role; tenant-admin session keeps it locked; Clone action present.

## Enhancement / Improvement

- Consider surfacing an explicit `RoleType` display (SYSTEM/CUSTOM badge) and a Dev-Mode note in
  the UI so the lock/unlock reason is visible.
- Clone UX: prefill the new name as `"{source.name} (copy)"` and land on the new role's detail drawer.

## Verification Criteria

- [x] `pnpm --filter @arcaai/domains build test` green (111 files / 1339 tests).
- [x] `pnpm --filter @arcaai/applications build test` green (294 files / 6160 tests).
- [x] `pnpm build:api` green; `apps/api` RBAC module tests green in isolation (3 files / 20 tests). Full-suite `apps/api` run is flaky in this environment on unrelated files (`env-port-standardization.test.ts`, `my-tenant-config-authorization.controller.test.ts`) — confirmed pre-existing via `git stash`, not touched by this ticket.
- [ ] `pnpm test:e2e` (new clone/SYSTEM-role-authoring cases added to `apps/api/tests/e2e/rbac.spec.ts`) — **not run**: the e2e API server binds the same port (8868) as an already-running dev API process in this environment; starting it would have required stopping that process, which was out of scope to do unilaterally. Spec parses cleanly (`playwright test --list`, 3 new cases). Run manually with `pnpm test:api:up` (separate terminal) + `pnpm test:e2e`.
- [x] `pnpm --filter @arcaai/admin-console lint` green; `features/rbac` suite green in isolation (5 files / 54 tests, up from 51 baseline: Policies-tab + Edit unlock for global admin, Edit-dialog PATCH flow on a SYSTEM role, clone dialog submit + navigation, `cloneRole` client call). `next build`/`tsc --noEmit` intermittently fail in this environment on unrelated files (`tenant-tts-config`, `playground-consultation`, `nav-config` route count) — another session is concurrently editing the same working directory; confirmed the rbac feature files typecheck/build clean in isolation each time. Both themes/axe not separately re-verified (no new component; conditional visibility on existing markup already covered by the a11y baseline); no live browser walkthrough performed (needs full docker stack + seeded auth, not booted this session) — jsdom component tests exercise the exact DOM assertions (button presence/absence, lock notice, Edit-dialog PATCH body, clone dialog submit + navigation).
- [x] Global admin can create/update SYSTEM roles and assign/revoke their policies; tenant admin cannot (`ForbiddenException`/`BadRequestException` per existing exception shape, not 404 — these are platform-global resources, not tenant-scoped, so the 404-over-403 posture doesn't apply here).
- [x] Any admin can clone SYSTEM or CUSTOM → new CUSTOM role with copied policies.
- [x] SYSTEM-role **delete** stays hard-blocked for everyone, including global admin (explicit scope decision — see Change History; deviates from the original plan's step 3 which also carved `softDelete`).

## Implementation Summary

TDD, layer-by-layer (domain → application service → API → admin-console), all RED confirmed before GREEN.

**Domain** (`packages/domains`):
- `RbacRoleFactory.buildCreateInput` accepts an optional `isSystemRole` prop (default `false`); `RbacRoleCreateInputShape.isSystemRole` widened from the `false` literal to `boolean`.

**Application service** (`packages/applications`):
- `IRbacRoleService`: `CreateRbacRoleRequest.isSystemRole?`, new `CloneRbacRoleRequest { name }`, new `clone(sourceId, request)` method.
- `RbacRoleService.create()`: `isSystemRole: true` from a non-`isSuperAdmin` caller → `ForbiddenException`.
- `update()` / `patch()`: `existing.isSystemRole` guard now carries `&& !isSuperAdmin(this.requestUser)` — global admin passes, tenant admin still blocked (same `BadRequestException` message/type as before).
- `softDelete()`: **unchanged** — stays unconditionally blocked for every caller (explicit decision, see Change History).
- `assignPolicy()` / `removePolicy()`: both now pre-fetch the role via `findByIdGuardSelect` (404 if missing) and reject a non-`isSuperAdmin` caller on a SYSTEM role with `ForbiddenException`, checked *before* the break-glass/protected-policy logic in `removePolicy` so no step-up prompt leaks for an operation that will be refused anyway.
- `clone(sourceId, { name })`: loads the source role + its `RolePolicies`, builds a new CUSTOM role via `RbacRoleFactory.buildCreateInput` (no `isSystemRole` override → defaults `false`), replays each source policy through `RolePolicyRepository.create` (mirrors `assignPolicy`'s write), composes the response from the created row + copied policy refs (no extra read round-trip), and broadcasts `ResourceCreated`. No `isSuperAdmin` gate — any admin holding `manage:Role` may clone, including cloning a SYSTEM role.
- **Plan deviation (forced by schema):** `Role` has no `tenantId` column (`packages/database/src/prisma/db_main/rbac.prisma` — confirmed a global, not tenant-scoped, resource; matches `RolesController`'s own "role is a global resource" comment). The plan's step 7 mention of `tenantId: this.tenantId` on the clone's create input is not implementable without a schema migration, which was out of scope; omitted.

**API** (`apps/api`):
- `CreateRoleDto.isSystemRole?: boolean` (`@IsOptional @IsBoolean`); new `CloneRoleDto { name: string }`.
- `RolesController`: `create()` forwards `dto.isSystemRole`; new `POST :id/clone` (`@CanManage('Role')`, same gate as every other mutation).

**Admin console** (`apps/admin-console`):
- `features/rbac/api/{types,client,hooks}.ts`: `CreateRoleRequest.isSystemRole?`, `CloneRoleRequest`, `cloneRole()`, `useCloneRole()`.
- `role-detail.tsx`: new `useIsGlobalAdmin()` (reads `useSession().data?.effectiveIsElevated` — the BFF's impersonation-aware effective identity, BUG-005). `PoliciesTabPanel`'s `locked` and the header/tab `LockNotice` conditions become `role.isSystemRole && !isGlobalAdmin`. New `CloneRoleDialog` (prefills `"{name} (copy)"`) wired into `RoleDetailActions`, which now **always** renders a Clone button (even for SYSTEM roles — that's the point). `RoleDetailActions` also computes `canEdit = !role.isSystemRole || isGlobalAdmin` — Edit unlocks for a global admin on a SYSTEM role (mirrors the service-layer `isSuperAdmin` carve-out on `update`/`patch`); Delete stays hidden for **every** caller on a SYSTEM role, since `softDelete()` is intentionally still hard-blocked platform-wide.
- `roles-screen.tsx`: threads `onCloned={(role) => setSelectedId(role.id)}` into both the desktop pane and the compact drawer, so a successful clone lands the caller on the new role's detail.
- Requirement 1's UI surface is now complete: a global admin can rename/update a SYSTEM role through the same `EditRoleDialog` used for CUSTOM roles (no dialog changes needed — the PUT/PATCH request shape is identical, only the button's visibility gate changed).

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | Ticket created from manual-test issue #2; root causes mapped (create hardcodes `isSystemRole:false`; update unconditionally blocks SYSTEM; policy lock is client-side). Authz decision confirmed: SYSTEM-role edits = GLOBAL_ADMIN only. |
| 2026-07-12 | **Scope decision during implementation:** the approved plan's step 3 also added an `isSuperAdmin` carve-out to `softDelete()`, but requirement 1's own title/expectation is scoped to "create/update" only, and the existing code comment frames SYSTEM-role delete as deliberately impossible (safety, not a bug) — deleting a seed-managed role shared across every tenant is irreversible and a much larger blast radius than a rename or policy-edit. Confirmed with the user: `softDelete()` stays hard-blocked for everyone, including global admin. Implemented requirements 1–3 otherwise per plan; TDD RED→GREEN at every layer (domain/application/API/admin-console); full verification evidence above. |
| 2026-07-13 | Closed the remaining UI gap for requirement 1: `RoleDetailActions` Edit now unlocks for a global admin on a SYSTEM role (`canEdit = !role.isSystemRole \|\| isGlobalAdmin`), reusing the existing `EditRoleDialog`. Delete stays hidden for every caller on every SYSTEM role, consistent with the hard-blocked `softDelete()`. Added an end-to-end test verifying the Edit dialog's PATCH body for a global admin renaming a SYSTEM role. |
