# TASK-282 — Backend Role-Listing Routes (admin + end-user self)

| Field        | Value                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| Ticket       | TASK-282                                                               |
| Status       | Completed                                                              |
| Created      | 2026-05-24                                                             |
| Updated      | 2026-05-24                                                             |
| Branch       | `fix/2605-review`                                                      |
| Wave         | Wave-2A — Implementer Agent C2                                         |
| Parent       | [TASK-262 Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Sibling      | [TASK-279 ROLE Endpoints Split](../TASK-279-ROLE-Endpoints-Split/README.md) |
| Author       | Implementer Agent C2                                                   |

---

## 1. Requirement Analysis

### 1.1 Description

TASK-279 (Wave-1B B6) split the SDK's role endpoints into two scoped constants:

- `ADMIN_USER_ROLES_ENDPOINTS.LIST(userId)` → `GET /admin/users/:id/roles`
- `ROLE_ENDPOINTS.USER_ROLES(userId)`       → `GET /users/:id/roles`

However, the matching **backend** routes did not exist. Today the admin path only
exposes `POST` (assign) and `DELETE` (remove) for `/admin/users/:id/roles`, and
there is no `/users/:id/roles` route at all — end-user "my roles" was only
served implicitly via `GET /auth/me.roles` (a flat `string[]` of role names).

### 1.2 Business Context

Without these listing routes:

- The admin dashboard cannot render a user's role assignments page.
- The SDK / playground cannot read the calling user's own role assignments as
  join-table rows (it could only see flat role-name strings via `/auth/me`).
- Any consumer that imported `ADMIN_USER_ROLES_ENDPOINTS.LIST` or
  `ROLE_ENDPOINTS.USER_ROLES` from `@arcaai/vox` would 404.

### 1.3 Acceptance Criteria

- `GET /api/v1/admin/users/:id/roles` returns `PaginatedUserRoleAssignmentResponse`.
- `GET /api/v1/users/:id/roles` returns the same shape, but only when `:id`
  equals the current user — otherwise responds with **403 Forbidden**
  (`"Cannot list roles for a different user"`).
- Both routes accept `page` and `pageSize` query parameters.
- Both routes are protected by `@Authorize()` (JWT/OIDC/API-Key auth).
- No new database migration, repository method, or service method — the
  application-layer service `IUserRoleAssignmentService.fetchAllByUserId`
  already exists and is reused.

### 1.4 User Decision (locked) — "mirror_admin"

> Both routes return join-table assignment rows
> (`UserRoleAssignmentResponse[]`, consistent with admin), and the end-user
> route is constrained to **self-id** (`:id` must equal current user).
> Reject with 403 otherwise.

Convention deviation: the end-user route is `/users/:id/roles` (explicit-id,
self-only-enforced), **not** the existing `/user/me/roles` "implicit-me"
convention used by `/user/me/settings` and `/user/me/preferences`. This is a
deliberate choice from TASK-279's SDK split so that the URL is symmetric with
the admin path — see §7 for the deviation note.

---

## 2. Current State Evaluation

### 2.1 Existing application-layer surface

`packages/applications/src/services/user/userRoleAssignment/IUserRoleAssignmentService.ts`
already exposes the method used by both new routes:

```ts
fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
```

DTOs and mappers are already in place:

- `UserRoleAssignmentResponse`
- `PaginatedUserRoleAssignmentResponse`
- `UserRoleAssignmentDtoMapper.ToPaginatedResponse(...)`

### 2.2 Existing controller patterns

| Pattern | File | Notes |
|---|---|---|
| Admin listing with pagination + DTO mapper | `apps/api/src/modules/user/user.controller.ts` — `fetchUserApiKeys` | Uses `@ApiEndpoint({ multi: true })` |
| End-user self-context controller | `apps/api/src/modules/user/controllers/user-settings.controller.ts` | Resolves `userId` from `ClsService<IActiveUserContext>` |
| Class-level `@Authorize()` + `ClsService` injection | `apps/api/src/modules/tenant/my-tenant.controller.ts` and its test | Used as reference for the 403/missing-context unit-test pattern |

### 2.3 What was missing

- No `GET /admin/users/:id/roles` (only `POST` and `DELETE` on that path).
- No `/users/:id/roles` (no controller bound to that path at all).

### 2.4 Impact areas

| Area | Touched by this ticket? |
|---|---|
| `apps/api/src/modules/user` controllers | Yes |
| `apps/api/src/modules/user/user.module.ts` | Yes — new controller registration |
| `packages/applications/**` | No — service surface already exists |
| `packages/domains/**` | No |
| `packages/database/**` | No — no migration |
| SDK / playground / admin UI | No — TASK-279 endpoint constants already point at the new URLs |

---

## 3. Implementation Plan

### 3.1 Test list (RED first)

| # | Test                                                                         | File                                                                       |
| - | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1 | `fetchUserRoleAssignments` calls `fetchAllByUserId` with `{ userId, page, pageSize }` | `apps/api/src/modules/user/__tests__/user.controller.test.ts` |
| 2 | `fetchUserRoleAssignments` returns mapped `PaginatedUserRoleAssignmentResponse` | same                                                                      |
| 3 | `fetchUserRoleAssignments` does NOT call `fetchAll`                          | same                                                                       |
| 4 | `listMyRoleAssignments` happy path (self-id match)                           | `apps/api/src/modules/user/controllers/__tests__/user-roles.controller.test.ts` |
| 5 | `listMyRoleAssignments` returns mapped paginated response                    | same                                                                       |
| 6 | `listMyRoleAssignments` cross-user → `ForbiddenException` (403)              | same                                                                       |
| 7 | `listMyRoleAssignments` missing CLS user → `ForbiddenException` (403)        | same                                                                       |
| 8 | Swagger metadata (class tags, bearer auth, `@ApiOperation`, `@ApiParam` for `id`, `@ApiResponse` for 403) | same |

### 3.2 File creation / modification order

1. Extend `user.controller.test.ts` with the admin-route tests → run → confirm RED.
2. Create `user-roles.controller.test.ts` → run → confirm RED.
3. Add the admin route to `user.controller.ts` → run → confirm GREEN.
4. Create `controllers/user-roles.controller.ts` → run → confirm GREEN.
5. Register `UserRolesController` in `user.module.ts`.
6. Run full `@arcaai/api` test suite + lint + build.
7. Run `@arcaai/applications` regression to make sure shared types are still happy.

### 3.3 Verification criteria

- All new tests pass and all previously-passing API tests still pass.
- `pnpm --filter @arcaai/api lint` clean.
- `pnpm --filter @arcaai/api build` succeeds.
- `ReadLints` clean on every modified/created file.
- Cross-package gate: `@arcaai/applications` vitest still green.

---

## 4. Implementation Summary

### 4.1 Admin route

Added `fetchUserRoleAssignments(id, queryParams)` to `UserController`
(`apps/api/src/modules/user/user.controller.ts`), placed immediately above the
existing `assignRole` (`POST`) handler. It mirrors the established pattern of
`fetchUserApiKeys`:

- `@ApiEndpoint({ returnedModel: UserRoleAssignmentResponse, path: ':id/roles', by: ['userId'], multi: true })`
  — expands to `@Get(':id/roles')` plus Swagger metadata.
- `@ApiParam`, `@ApiQuery(page)`, `@ApiQuery(pageSize)`, `@ApiResponse(200, PaginatedUserRoleAssignmentResponse)` decorators for OpenAPI.
- Calls `IUserRoleAssignmentService.fetchAllByUserId({ ...queryParams, userId: id })`.
- Returns `UserRoleAssignmentDtoMapper.ToPaginatedResponse(result)`.
- Imported `PaginatedUserRoleAssignmentResponse` from `@arcaai/applications`.

### 4.2 End-user route

Created `UserRolesController`
(`apps/api/src/modules/user/controllers/user-roles.controller.ts`):

- `@Controller('users')` — pairs with the global `/api/v1` prefix from
  `apps/api/src/main.ts` → actual path is `GET /api/v1/users/:id/roles`.
- `@Authorize()` at the class level (JWT/OIDC/API-Key, **not**
  role-restricted — runtime self-id check supplies the authorization signal).
- Injects `IUserRoleAssignmentService` and `ClsService<IActiveUserContext>`.
- `listMyRoleAssignments(id, queryParams)`:
  - Reads `currentUser = clsService.get('user')`.
  - If `!currentUser?.id || currentUser.id !== id`, throws
    `new ForbiddenException('Cannot list roles for a different user')`.
  - Otherwise delegates to `fetchAllByUserId` and maps via
    `UserRoleAssignmentDtoMapper.ToPaginatedResponse`.
- Swagger: `@ApiBearerAuth`, `@ApiTags('user')`, `@ApiOperation`,
  `@ApiParam(id)`, `@ApiQuery(page,pageSize)`, `@ApiResponse(200,…)`,
  `@ApiResponse(403, 'Cannot list roles for a different user')`.

A single `null`-check covers both the explicit "no user context" case (test 7)
and the cross-user case (test 6) by using
`!currentUser?.id || currentUser.id !== id` — concise enough to match the
"minimal GREEN" rule.

### 4.3 Module registration

`UserRolesController` added to `controllers: [...]` in
`apps/api/src/modules/user/user.module.ts`. No new service module import was
needed because `UserRoleAssignmentServiceModule` was already imported for the
existing assign/remove routes.

### 4.4 Tests

Added admin-route tests inline in `user.controller.test.ts`
(group: `GET /admin/users/:id/roles (fetchUserRoleAssignments)`). The pre-existing
`createMockUserRoleAssignmentService` mock factory was extended with
`fetchAll: vi.fn()` so the "should NOT call fetchAll" guard can run.

Created `apps/api/src/modules/user/controllers/__tests__/user-roles.controller.test.ts`
with eight assertions covering happy path, 403 on cross-user, 403 on missing
CLS user, and full Swagger metadata (class tags, bearer auth, `@ApiOperation`,
`@ApiParam`, `@ApiResponse(403)`).

The mock `ClsService` follows the same `vi.fn((key) => …)` shape used by
`my-tenant.controller.test.ts`.

---

## 5. Verification

### 5.1 RED → GREEN evidence

**Admin route — RED** (`pnpm --filter @arcaai/api test src/modules/user/__tests__/user.controller.test.ts`):

```
❯ src/modules/user/__tests__/user.controller.test.ts (36 tests | 3 failed) 12ms
  × should call userRoleAssignmentService.fetchAllByUserId with userId and query params
  × should return a paginated UserRoleAssignmentResponse mapped from service result
  × should NOT call fetchAll (which ignores userId)

FAIL  …user.controller.test.ts > UserController > GET /admin/users/:id/roles
TypeError: controller.fetchUserRoleAssignments is not a function
```

**Public route — RED** (`pnpm --filter @arcaai/api test src/modules/user/controllers/__tests__/user-roles.controller.test.ts`):

```
FAIL  …user-roles.controller.test.ts
Error: Cannot find module '../user-roles.controller'
```

**Both routes — GREEN** (after implementation):

```
Test Files  2 passed (2)
     Tests  45 passed (45)
```

### 5.2 Full API suite

`pnpm --filter @arcaai/api test`:

```
Test Files  44 passed (44)
     Tests  1040 passed (1040)
  Duration  10.70s
```

### 5.3 Lint

`pnpm --filter @arcaai/api lint`:

```
> @arcaai/api@0.1.0 lint
> ESLINT_USE_FLAT_CONFIG=false eslint "{src,apps,libs,test}/**/*.ts" --fix
(exit 0)
```

### 5.4 Build

`pnpm --filter @arcaai/api build`:

```
> @arcaai/api@0.1.0 build
> rimraf dist && nest build && tsc-alias
(exit 0)
```

### 5.5 Cross-package regression — `@arcaai/applications`

The package has no `test` / `test:unit` script, so vitest was invoked at the
workspace root scoped to the package source tree:

`pnpm exec vitest run packages/applications/src`:

```
Test Files  136 passed (136)
     Tests  3741 passed (3741)
  Duration  6.07s
```

### 5.6 ReadLints

`ReadLints` on all modified/created files — **no linter errors**.

### 5.7 Self-id enforcement evidence

The 403 contract is exercised by these test names in
`user-roles.controller.test.ts`:

- `should throw ForbiddenException when :id does not match current user`
  (asserts the message `/Cannot list roles for a different user/`).
- `should throw ForbiddenException when CLS user context is missing`.

Both routes return the **same** `PaginatedUserRoleAssignmentResponse` DTO via
the same `UserRoleAssignmentDtoMapper.ToPaginatedResponse` mapper — verified
by the assertions on `result.data[0].userId`, `result.data[0].roleId`, and
`result.count` in both the admin and public test files.

---

## 6. Files Changed

| File | Action | Purpose |
|---|---|---|
| `apps/api/src/modules/user/user.controller.ts` | Modified | Added `fetchUserRoleAssignments` (`GET /admin/users/:id/roles`); imported `PaginatedUserRoleAssignmentResponse`. |
| `apps/api/src/modules/user/controllers/user-roles.controller.ts` | Created | New `@Controller('users')` exposing `GET /users/:id/roles` with self-id 403 enforcement. |
| `apps/api/src/modules/user/user.module.ts` | Modified | Registered `UserRolesController` in `controllers: [...]`. |
| `apps/api/src/modules/user/__tests__/user.controller.test.ts` | Modified | Added admin-route tests (3 assertions) + extended `createMockUserRoleAssignmentService` with `fetchAll: vi.fn()`. |
| `apps/api/src/modules/user/controllers/__tests__/user-roles.controller.test.ts` | Created | New unit-test file covering happy path, 403 cross-user, 403 missing context, and Swagger metadata. |
| `docs/implementation/TASK-282-UserRoles-Backend-Routes/README.md` | Created | This document. |

No database migrations. No domain/applications/database/SDK changes.

---

## 7. Deviations

- **Convention deviation (intentional, locked by user)**: the end-user route
  is `/users/:id/roles` rather than the prevailing `/user/me/roles`
  "implicit-me" convention used by `/user/me/settings` and
  `/user/me/preferences`. Justification: TASK-279 split the SDK constants so
  the admin (`/admin/users/:id/roles`) and end-user (`/users/:id/roles`) URLs
  are structurally symmetric. The same self-id-enforcement pattern can be
  applied to any future `/users/:id/...` end-user route.
- **403, not 404, on cross-user mismatch**: the spec is explicit — 404 would
  leak "user exists vs not"; 403 is the correct security signal.
- **Single-line auth check**: combined the "no user context" and
  "cross-user" branches into one `if (!currentUser?.id || currentUser.id !== id)`
  guard. Both behaviors are still independently covered by tests 6 and 7.
- **Mock-completeness fix in `user.controller.test.ts`**: added `fetchAll:
  vi.fn()` to `createMockUserRoleAssignmentService` so the new "should NOT
  call fetchAll" assertion can run. The pre-existing `assignRole` /
  `removeRole` mock keys were left untouched (they don't correspond to actual
  service methods — the controller uses `create` / `deleteById` — but fixing
  that is out of scope for this ticket).

---

## 8. Newly-Discovered Issues (log only, not fixed)

- `createMockUserRoleAssignmentService` in `user.controller.test.ts` declares
  `assignRole` and `removeRole`, but the actual `IUserRoleAssignmentService`
  exposes `create` and `deleteById`. The current admin `assignRole` /
  `removeRole` handler tests therefore wouldn't catch a service-call rename.
  Out of scope for TASK-282; should be tightened in a follow-up.
- The `@arcaai/applications` package has no `test` or `test:unit` script of
  its own; the workspace rule `01-development-workflow.mdc` says to run
  `pnpm test:unit --filter @arcaai/applications`, which currently fails with
  `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. The workaround in this ticket was
  `pnpm exec vitest run packages/applications/src` from the workspace root.
  A follow-up should either add the script or update the rule.

---

## 9. Change History

| Date       | Author              | Change |
| ---------- | ------------------- | ------ |
| 2026-05-24 | Implementer Agent C2 | Initial implementation — admin `GET /admin/users/:id/roles` + end-user `GET /users/:id/roles` (self-only, 403 on mismatch). All gates green. |
