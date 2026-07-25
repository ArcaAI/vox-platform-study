# TASK-279 — R-05 ROLE_ENDPOINTS Split (User-Self vs Admin)

| | |
|---|---|
| Ticket Number | TASK-279 |
| Parent Ticket | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Sibling | [TASK-265 — SDK Endpoint Drift](../TASK-265-SDK-Endpoint-Drift/README.md) |
| Sibling | [TASK-263 — Backend API Drift](../TASK-263-Backend-API-Drift/README.md) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | Bugfix (SDK ↔ API drift remediation) |
| Owner | B6 (Wave 1A) |
| Scope | `packages/agentic-sdk-v2` — `core/constants.ts` + `hooks/useRoles.ts` (+ tests) |
| Wave | TASK-262 Wave 1A (R-05) |
| Branch | `fix/2605-review` |

---

## 1. Requirement Analysis

### 1.1 Description

The SDK exposed user-role assignment URLs only via `ROLE_ENDPOINTS.USER_ROLES(userId)` /
`ROLE_ENDPOINTS.USER_ROLE(userId, roleId)`, both rooted at `/users/:userId/roles[/:roleId]`.
This routing was broken on two axes simultaneously:

1. **Wrong root** — the backend never exposed `/users/:userId/roles` for either administrator
   role-assignment management or end-user "my roles". The real admin path is
   `/admin/users/:id/roles[/:assignmentId]` (see `apps/api/src/modules/user/user.controller.ts`
   `@Controller('admin/users')`). The end-user "my roles" surface is served by `GET /auth/me`
   (which returns `roles: string[]`).
2. **Wrong path parameter** — the SDK delete builder was `USER_ROLE(userId, roleId)`. The
   backend deletes by **assignmentId** (a join-table row id), not by roleId. Calling the SDK
   with a roleId would 404 even if the prefix were correct.

The user-locked decision (TASK-279 brief §1.4) is to surface the two semantically distinct
API surfaces explicitly:

- **`USER_ROLES` / `USER_ROLE` on `ROLE_ENDPOINTS`** — kept at the canonical end-user path
  `/users/:id/roles[/:assignmentId]` as a forward-looking placeholder. Backend currently
  lacks this route (see TASK-282 follow-up).
- **`ADMIN_USER_ROLES_ENDPOINTS` (new)** — admin RBAC user-role assignment surface at
  `/admin/users/:id/roles[/:assignmentId]`. This is what `useRoles.assignRoleToUser` /
  `removeUserRoleAssignment` / `listUserRoleAssignments` actually call.

### 1.2 Business context

This blocks every administrator workflow that needs to assign or revoke roles for a user.
Any consuming app calling `useRoles.assignRole(userId, roleId)` today receives a 404
(SDK calls `/users/:id/roles`, which does not exist on the API). Fixing it unblocks RBAC
operations for the admin surface and clarifies the contract for any future end-user
"my roles" view.

### 1.3 Acceptance criteria

1. `ROLE_ENDPOINTS.USER_ROLES(userId)` and `USER_ROLE(userId, assignmentId)` remain at
   the user-self path `/users/:userId/roles[/:assignmentId]`. The second arg of `USER_ROLE`
   is renamed to `assignmentId` to match join-table semantics.
2. A new `ADMIN_USER_ROLES_ENDPOINTS` block exposes `LIST(userId)` / `ASSIGN(userId)` /
   `REMOVE(userId, assignmentId)` rooted at `/admin/users/:id/roles`.
3. `useRoles` exposes three new methods: `listUserRoleAssignments`, `assignRoleToUser`,
   `removeUserRoleAssignment` (admin scope, calling `ADMIN_USER_ROLES_ENDPOINTS.*`).
4. `useRoles` keeps the pre-existing names `getUserRoles`, `assignRole`, `removeRole` as
   `@deprecated` aliases that delegate to the new methods, with a one-time per-instance
   `console.warn`. The deprecated `removeRole` second-arg type is renamed `assignmentId`.
5. All changes are TDD: failing tests written first, then minimal code to GREEN.
6. SDK: full `pnpm --filter @arcaai/vox test` passes (excluding pre-existing TASK-280
   RED test, see §7), build is green, lint introduces 0 new errors.
7. API tests still pass (cross-package gate `pnpm --filter @arcaai/api test`).

---

## 2. Current State Evaluation

### 2.1 `packages/agentic-sdk-v2/src/core/constants.ts:485-497` (before)

```typescript
export const ROLE_ENDPOINTS = {
  // ... unchanged keys ...
  USER_ROLES: (userId: string) => `/users/${encodeURIComponent(userId)}/roles`,            // ← BROKEN: API has no such route
  USER_ROLE: (userId: string, roleId: string) =>                                           // ← param name wrong
    `/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
  // ...
} as const;
```

### 2.2 `packages/agentic-sdk-v2/src/hooks/useRoles.ts:131-152` (before)

`getUserRoles`, `assignRole` (POST), `removeRole` (DELETE) all called
`ROLE_ENDPOINTS.USER_ROLES(userId)` / `ROLE_ENDPOINTS.USER_ROLE(userId, roleId)`. The
`removeRole(userId, roleId)` parameter name was misleading — backend route is
`/admin/users/:id/roles/:assignmentId`.

### 2.3 Backend reality (`apps/api/src/modules/user/user.controller.ts`)

```typescript
@Controller('admin/users')
class UserController {
  @Post(':id/roles')                       async assignRole(@Param('id'), @Body() CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentResponse>;
  @Delete(':id/roles/:assignmentId')       async removeRole(@Param('assignmentId') assignmentId: string): Promise<void>;
  // No GET listing route exists.
}
```

End-user "my roles" lives at `GET /auth/me` (returns `roles: string[]`, plus permissions).
There is no `/users/:id/roles` GET on the API today (see TASK-282 follow-up).

### 2.4 Existing TASK-210 lock-in (`constants.task210.test.ts:307-312, 895-897`)

A prior TASK-210 lock pins `ROLE_ENDPOINTS.USER_ROLES('u-1') === '/users/u-1/roles'` and
`ROLE_ENDPOINTS.USER_ROLE('u-1', 'r-1') === '/users/u-1/roles/r-1'`. Our plan is **compatible**
with this lock — we keep both builders at the user-self path and only rename the second
parameter of `USER_ROLE` (the URL shape `'/users/u-1/roles/r-1'` is unchanged when called
with the same string argument).

### 2.5 Consumers

- `useRoles.ts` (in scope). Refactored.
- `useRoles.test.ts` (in scope). Updated.
- `apps/ui-playground/src/features/admin/api/roles.ts` defines its own `useRoles` (TanStack
  Query) and does **not** import the SDK's `ROLE_ENDPOINTS.USER_ROLES`/`USER_ROLE`. **Out of
  scope** for TASK-279.
- No other SDK file references `ROLE_ENDPOINTS.USER_ROLES` or `USER_ROLE`.

---

## 3. Implementation Plan

### 3.1 TDD test list (RED first)

| # | Test file | Assertion |
|---|---|---|
| T1 | `core/__tests__/constants.task279.test.ts` | `ROLE_ENDPOINTS.USER_ROLES('u-1') === '/users/u-1/roles'` (kept) |
| T2 | `core/__tests__/constants.task279.test.ts` | `ROLE_ENDPOINTS.USER_ROLE('u-1', 'a-9') === '/users/u-1/roles/a-9'` (param renamed) |
| T3 | `core/__tests__/constants.task279.test.ts` | special-char encoding for both `USER_ROLES` and `USER_ROLE` |
| T4 | `core/__tests__/constants.task279.test.ts` | `ADMIN_USER_ROLES_ENDPOINTS.LIST('u-1') === '/admin/users/u-1/roles'` |
| T5 | `core/__tests__/constants.task279.test.ts` | `ADMIN_USER_ROLES_ENDPOINTS.ASSIGN('u-1') === '/admin/users/u-1/roles'` |
| T6 | `core/__tests__/constants.task279.test.ts` | `ADMIN_USER_ROLES_ENDPOINTS.REMOVE('u-1', 'a-9') === '/admin/users/u-1/roles/a-9'` |
| T7 | `core/__tests__/constants.task279.test.ts` | special-char encoding for all three admin builders |
| T8 | `core/__tests__/constants.task279.test.ts` | exact key set is `{LIST, ASSIGN, REMOVE}` |
| T9 | `core/__tests__/constants.task279.test.ts` | admin path starts `/admin/users/`, user-self does not |
| H1–H3 | `hooks/__tests__/useRoles.test.ts` | `getUserRoles` (alias) → calls `/admin/users/:id/roles`, extracts paginated wrapper, returns `[]` on bad shape |
| H4–H6 | `hooks/__tests__/useRoles.test.ts` | `assignRole` (alias) → POST `/admin/users/:id/roles` with `{roleId}`, with `tenantId`, without `tenantId` |
| H7 | `hooks/__tests__/useRoles.test.ts` | `removeRole` (alias, second arg `assignmentId`) → DELETE `/admin/users/:id/roles/:assignmentId` |
| H8–H9 | `hooks/__tests__/useRoles.test.ts` | new `listUserRoleAssignments`: direct GET, paginated wrapper |
| H10–H11 | `hooks/__tests__/useRoles.test.ts` | new `assignRoleToUser`: POST `{roleId}`, POST `{roleId, tenantId}` |
| H12 | `hooks/__tests__/useRoles.test.ts` | new `removeUserRoleAssignment`: DELETE admin path |
| H13–H15 | `hooks/__tests__/useRoles.test.ts` | each deprecated alias `console.warn`s exactly once per hook instance |
| H16 | `hooks/__tests__/useRoles.test.ts` | new method names do **not** trigger any deprecation warning |

### 3.2 Implementation

1. `core/constants.ts` — keep `ROLE_ENDPOINTS.USER_ROLES`/`USER_ROLE`, rename second arg
   to `assignmentId`, add `ADMIN_USER_ROLES_ENDPOINTS` after `ROLE_ENDPOINTS`.
2. `hooks/useRoles.ts` — add `listUserRoleAssignments` / `assignRoleToUser` /
   `removeUserRoleAssignment`. Refactor `getUserRoles`/`assignRole`/`removeRole` into
   thin one-shot-`console.warn` aliases that delegate to the new methods. Use `useRef`
   (per-hook-instance) for the warned flag so StrictMode double-mounts don't double-warn
   and so multiple components each get their own warn lifecycle.
3. Update `UseRolesReturn` interface: add the three new methods, keep the three
   deprecated aliases (with `@deprecated` JSDoc).

---

## 4. Verification

All commands run with Zsh from the workspace root.

### 4.1 RED proof — `constants.task279.test.ts` BEFORE constants edit

```
 FAIL  src/core/__tests__/constants.task279.test.ts > TASK-279 R-05: ADMIN_USER_ROLES_ENDPOINTS admin RBAC surface > LIST(userId) returns /admin/users/:id/roles
TypeError: Cannot read properties of undefined (reading 'LIST')

 Test Files  1 failed (1)
      Tests  6 failed | 4 passed (10)
```

(All 6 admin-block tests fail because `ADMIN_USER_ROLES_ENDPOINTS` does not yet exist. The
4 pre-existing `ROLE_ENDPOINTS.USER_ROLES`/`USER_ROLE` user-self assertions pass since the
constants are being kept at the user-self path.)

### 4.2 RED proof — `useRoles.test.ts` BEFORE hook refactor

```
 FAIL  src/hooks/__tests__/useRoles.test.ts > useRoles > deprecation warnings (TASK-279) > does NOT warn when calling the new method names directly
TypeError: result.current.listUserRoleAssignments is not a function

 Test Files  1 failed (1)
      Tests  14 failed | 30 passed (44)
```

(14 failures: URL mismatch for the deprecated aliases (now expected to call admin path),
the 5 new admin-method tests fail because the methods don't exist, and the 4 deprecation
warnings tests fail because the warn flow doesn't exist.)

### 4.3 GREEN — `constants.task279.test.ts`

```
 RUN  v4.1.1
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  728ms
```

### 4.4 GREEN — `useRoles.test.ts`

```
 RUN  v4.1.1
 Test Files  1 passed (1)
      Tests  44 passed (44)
   Duration  673ms
```

### 4.5 Full SDK test suite (`pnpm --filter @arcaai/vox test --exclude='**/CrossTabHmacKeyManager.test.ts'`)

```
 RUN  v4.1.1
 Test Files  116 passed (116)
      Tests  2763 passed (2763)
   Duration  20.74s
```

The exclusion is `src/core/__tests__/CrossTabHmacKeyManager.test.ts`, a pre-existing
TASK-280 RED test waiting for the `CrossTabHmacKeyManager` source file to be created.
That file is not part of TASK-279 scope (see §7).

### 4.6 SDK lint (`pnpm --filter @arcaai/vox lint`)

```
✖ 13 problems (0 errors, 13 warnings)
```

**0 errors, 0 new warnings.** All 13 remaining warnings are pre-existing prettier
warnings in files outside TASK-279 scope:

- `src/core/SttWebSocketClient.ts` (1 warning)
- `src/types/dna.ts` (1 warning)
- `src/types/index.ts` (1 warning)
- `src/core/SimpleCrossTabSync.ts`, `src/core/FileTranscriptionService.ts` (10 warnings, same as TASK-265 verification 6.4)

The 4 prettier warnings introduced by my initial edits (`constants.ts:511`, `:533`,
`useRoles.ts:176`, `:186`) were fixed by reformatting to match the surrounding style
(single-line arrow-fn body, consistent with neighbouring `ASSIGN_POLICY` / `REMOVE_POLICY`).

### 4.7 SDK build (`pnpm --filter @arcaai/vox build`)

```
ESM ⚡️ Build success in 9197ms
ESM dist/index.mjs     5.43 MB
CJS dist/index.js      5.43 MB
ESM dist/plugins.mjs   5.09 MB
CJS dist/plugins.js    5.09 MB
ESM dist/core.mjs      406.13 KB
CJS dist/core.js       412.12 KB
```

Build success — 0 errors. The bundled `dist/index.*` files now include the new
`ADMIN_USER_ROLES_ENDPOINTS` constant alongside the existing `ROLE_ENDPOINTS`.

### 4.8 Cross-package gate (`pnpm --filter @arcaai/api test`)

```
 Test Files  43 passed (43)
      Tests  1028 passed (1028)
   Duration  10.87s
```

### 4.9 ReadLints (every modified file)

```
No linter errors found.
```

Run on `core/constants.ts`, `core/__tests__/constants.task279.test.ts`,
`hooks/useRoles.ts`, `hooks/__tests__/useRoles.test.ts`. Clean.

---

## 5. Implementation Summary

### 5.1 What was built

1. **`core/constants.ts`** — `ROLE_ENDPOINTS.USER_ROLE` second-parameter renamed `roleId → assignmentId`.
   Inline JSDoc explains the user-self vs admin distinction. New `ADMIN_USER_ROLES_ENDPOINTS`
   block (`LIST` / `ASSIGN` / `REMOVE`) targets `/admin/users/:id/roles[/:assignmentId]`.
2. **`hooks/useRoles.ts`** — new admin-scope methods (`listUserRoleAssignments`,
   `assignRoleToUser`, `removeUserRoleAssignment`) using `ADMIN_USER_ROLES_ENDPOINTS`.
   Pre-existing `getUserRoles` / `assignRole` / `removeRole` retained as
   `@deprecated` aliases that delegate and emit one `console.warn` per hook instance
   (per-instance flag via `useRef`, not module state). `removeRole` second arg renamed
   `assignmentId` (typing-level rename — public-contract part of the parameter list).
3. **Tests** — RED-first for both files. 10 new constants tests + 14 new/updated hook
   tests; pre-existing CRUD tests (listRoles/getRole/createRole/updateRole/deleteRole/
   assignPolicy/removePolicy) untouched.

### 5.2 Files changed

| File | Action | Purpose |
|---|---|---|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Modify | Rename `USER_ROLE` second arg; add `ADMIN_USER_ROLES_ENDPOINTS` block |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task279.test.ts` | Create | Lock new constants shape (10 tests) |
| `packages/agentic-sdk-v2/src/hooks/useRoles.ts` | Modify | Add admin methods; keep deprecated aliases with one-shot warn |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useRoles.test.ts` | Modify | Update 7 alias tests to expect admin URLs; add 9 new tests for admin methods + deprecation warnings |
| `docs/implementation/TASK-279-ROLE-Endpoints-Split/README.md` | Create | This file |

### 5.3 Files explicitly NOT modified (boundary check)

- `apps/api/**` — no API endpoint added or removed.
- `apps/ui-playground/**`, `apps/admin/**` — separate playground/admin `useRoles` hooks
  use TanStack Query against their own paths; out of scope.
- `packages/agentic-sdk-v2/src/core.ts` — root barrel re-exports. The new
  `ADMIN_USER_ROLES_ENDPOINTS` is **not yet** re-exported at the package root. Logged as
  follow-up §7.
- All other SDK constants groups (`AUTH_ENDPOINTS`, `USER_ENDPOINTS`, etc.) — untouched.
- All other SDK hooks (`useUsers`, `useAuth`, `useTenants`, etc.) — untouched.

### 5.4 Backend route confirmation (§4 of the brief)

The new admin paths in the SDK match `apps/api/src/modules/user/user.controller.ts`
exactly (verified from `@Controller('admin/users')` + `@Post(':id/roles')` +
`@Delete(':id/roles/:assignmentId')`). The SDK strips the API global prefix `/api/v1`
because `AgenticClient` already prefixes that — so the SDK constants resolve to
`/admin/users/:id/roles[/:assignmentId]`, which becomes
`/api/v1/admin/users/:id/roles[/:assignmentId]` over the wire.

---

## 6. Deviations

None from the locked plan. All §3 contract items implemented as written, including:

- The `useRef`-backed one-shot warn flag (per-instance, not module-level).
- The deprecated alias retention (no API surface removal — preserves stability for
  in-flight consumers).
- Strict scope adherence — no edits to `apps/`, no edits to other constants groups, no
  edits to `core.ts` barrel, no edits to other hooks.

The 4 prettier warnings in my initial edits were fixed inline (single-line arrow-fn
bodies matching neighbouring `ASSIGN_POLICY`/`REMOVE_POLICY`); this is a stylistic
adjustment, not a contract change.

---

## 7. Newly-Discovered Issues / Follow-ups

### 7.1 TASK-282 (proposed) — backend `GET /admin/users/:id/roles` listing route missing

The admin SDK now calls `ADMIN_USER_ROLES_ENDPOINTS.LIST(userId)` →
`GET /admin/users/:id/roles`. The backend has `POST :id/roles` (assign) and
`DELETE :id/roles/:assignmentId` (remove) but **no `GET :id/roles` listing route**. The
SDK method `listUserRoleAssignments` will 404 against the current API. A backend ticket
should add the listing endpoint (returning `UserRoleAssignmentResponse[]` from
`apps/api/src/modules/user/user.controller.ts`). **Out of scope for TASK-279.**

### 7.2 TASK-282 (proposed, second leg) — backend `GET /users/:id/roles` end-user route missing

`ROLE_ENDPOINTS.USER_ROLES` and `USER_ROLE` are kept at the user-self path as a
forward-looking placeholder. Today, the only "my roles" end-user surface is `GET /auth/me`
(returns `roles: string[]`). If the product wants a dedicated user-self listing of
assignment rows (with role name, tenant, etc.), a new controller/route is needed. **Out
of scope for TASK-279.**

### 7.3 `core.ts` root re-export

`ADMIN_USER_ROLES_ENDPOINTS` is exported from `packages/agentic-sdk-v2/src/core/constants.ts`
but is **not** yet re-exported by `packages/agentic-sdk-v2/src/core.ts` (which would put it
on the package's public root surface alongside `ROLE_ENDPOINTS`, `USER_ENDPOINTS`, etc.).
The hook imports the constant directly, so all in-scope code works. Adding it to the
barrel is mechanical (one entry in the existing alphabetised export block) but `core.ts`
was outside the TASK-279 write scope. **Suggested follow-up**: include in the next SDK
constants barrel maintenance pass (or a small TASK-279 fix-up after this lands).

### 7.4 Pre-existing TASK-280 RED test (unrelated)

`packages/agentic-sdk-v2/src/core/__tests__/CrossTabHmacKeyManager.test.ts` was added by
prior wave work. It imports `../CrossTabHmacKeyManager`, which has not yet been written
(only the related `CrossTabHmacSharedWorker.ts` exists). This is a TASK-280 RED test
waiting for that source file. It is not affected by TASK-279 changes; verification §4.5
explicitly excludes it from the SDK test run, and the rest of the suite (2763 tests, 116
files) remains green.

---

## 8. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | B6 (TASK-279) | Initial plan + RED tests authored. Status set to **In Progress**. |
| 2026-05-23 | B6 (TASK-279) | Constants split (`USER_ROLES`/`USER_ROLE` retained at user-self path; new `ADMIN_USER_ROLES_ENDPOINTS` block added). Hook refactored: 3 new admin methods (`listUserRoleAssignments`, `assignRoleToUser`, `removeUserRoleAssignment`) + 3 `@deprecated` aliases with `useRef`-backed one-shot `console.warn`. 10/10 constants tests + 44/44 hook tests pass. Full SDK suite 2763/2763 (excluding pre-existing TASK-280 RED). API gate 1028/1028. Build green; lint 0 errors / 0 new warnings. ReadLints clean. Status set to **Completed**. |
| 2026-05-24 | Wave-2A C4 | Closed §7.3 follow-up: re-exported `ADMIN_USER_ROLES_ENDPOINTS` from package barrel `packages/agentic-sdk-v2/src/core.ts` (single-line addition in the alphabetised endpoints export block, immediately before `API_KEY_ENDPOINTS`) so external consumers can now `import { ADMIN_USER_ROLES_ENDPOINTS } from '@arcaai/vox/core'` alongside `ROLE_ENDPOINTS`. Added RED-first lock-in test `packages/agentic-sdk-v2/src/__tests__/exports.task279.test.ts` (4 tests: presence on barrel + `LIST`/`ASSIGN`/`REMOVE` URL shape). RED proof: all 4 failed pre-edit (`expected undefined to be defined`, `Cannot read properties of undefined (reading 'LIST'/'ASSIGN'/'REMOVE')`). Post-edit: focused 4/4 green. Full SDK suite 2783/2783 (118 files, includes +4 new). `pnpm --filter @arcaai/vox build` green (`dist/core.mjs` 412.39 KB / `dist/core.js` 418.42 KB). Lint 0 errors, 13 warnings — all pre-existing prettier-only warnings (no new). |
