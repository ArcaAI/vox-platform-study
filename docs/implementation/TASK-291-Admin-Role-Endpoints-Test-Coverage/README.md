# TASK-291 — Admin Role Endpoints Test Coverage

| Field       | Value                              |
|-------------|-------------------------------------|
| Ticket      | TASK-291                           |
| Type        | Test Coverage                      |
| Status      | Completed                          |
| Created     | 2026-05-24                         |
| Updated     | 2026-05-24                         |
| Branch      | `fix/2605-review`                  |
| Parent      | [TASK-262](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| D1 (surfaced gap) | [TASK-287](../TASK-287-User-Controller-Test-Mock-Cleanup/README.md) |
| Sibling     | [TASK-282](../TASK-282-UserRoles-Backend-Routes/README.md) |

---

## Requirement Analysis

### Description

TASK-287 (D1 mock-cleanup pass) renamed stale mock keys in `createMockUserRoleAssignmentService` (`assignRole` → `create`, `removeRole` → `deleteById`) and explicitly documented that neither `POST /admin/users/:id/roles` nor `DELETE /admin/users/:id/roles/:assignmentId` had any `expect(...)` assertions in `user.controller.test.ts`. This ticket fills that coverage gap.

### Business Context

Two admin mutation endpoints — assigning a role to a user and removing a role assignment — were shipping without any controller-unit-test coverage. Any regression in how the controller composes the service call arguments (e.g. merging `:id` into the create request) would go undetected.

### Acceptance Criteria

- `describe` block added for `POST /admin/users/:id/roles` with ≥2 `it` blocks covering the happy path and service argument shape.
- `describe` block added for `DELETE /admin/users/:id/roles/:assignmentId` with ≥2 `it` blocks covering the happy path and `void` return.
- File test count: 36 → 41 (+5).
- Full package: 1040 → 1045 (+5).
- No new lint errors.

---

## Current State Evaluation

### Controller Methods Verified

File: `apps/api/src/modules/user/user.controller.ts`

| Handler method | HTTP method | Full path | Calls service method | Return type |
|---|---|---|---|---|
| `assignRole` | `POST` | `POST /admin/users/:id/roles` | `userRoleAssignmentService.create({ ...body, userId: id })` | `UserRoleAssignmentResponse` (mapped via `UserRoleAssignmentDtoMapper.ToResponse`) |
| `removeRole` | `DELETE` | `DELETE /admin/users/:id/roles/:assignmentId` | `userRoleAssignmentService.deleteById(assignmentId)` | `void` (HTTP 204, `@HttpCode(HttpStatus.NO_CONTENT)`) |

**Key observation — `removeRole` ignores `:id`**: The `@Param` binding on `removeRole` is `@Param('assignmentId') assignmentId: string` only. The user ID path parameter (`:id`) is accepted in the route but not bound to any argument and not forwarded to the service. This is intentional: the assignment is uniquely identified by its own `assignmentId` and deletion is performed directly by that ID without cross-validating the parent user.

### Contradictions / Follow-ups

**Stale handler names**: The controller methods are named `assignRole` and `removeRole`, while the underlying service methods they call are `create` and `deleteById`. This is a naming inconsistency that TASK-287 documented. It is intentionally NOT corrected here — source files are out of scope for this ticket. Suggested follow-up: rename `assignRole` → `createUserRoleAssignment` and `removeRole` → `deleteUserRoleAssignment` for clarity, in a dedicated refactoring ticket.

**No `:id` validation in `removeRole`**: The controller does not validate that the assignment's `userId` matches the `:id` path parameter. Any authenticated admin can delete any assignment regardless of the `:id` segment. This may be intentional for an admin-only endpoint, but is worth reviewing for authorization consistency.

---

## Implementation Plan

1. Capture baseline (36 tests in file, 1040 in package). ✓
2. Confirm no existing `describe` blocks for POST/DELETE role mutation routes. ✓
3. Read controller source to verify exact handler signatures and service call shapes. ✓
4. Add `describe('POST /admin/users/:id/roles (assignRole)', ...)` block with 3 `it` cases. ✓
5. Add `describe('DELETE /admin/users/:id/roles/:assignmentId (removeRole)', ...)` block with 2 `it` cases. ✓
6. Re-run targeted test (41/41), full package (1045/1045), lint (no errors). ✓
7. ReadLints on modified file. ✓

---

## Implementation Summary

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/modules/user/__tests__/user.controller.test.ts` | Added 2 `describe` blocks (POST: 3 `it` cases, DELETE: 2 `it` cases) before the existing `GET /admin/users/:id/api-keys` block |

### Handler Method Names Found

| Controller method | Full HTTP path |
|---|---|
| `assignRole` | `POST /api/v1/admin/users/:id/roles` |
| `removeRole` | `DELETE /api/v1/admin/users/:id/roles/:assignmentId` |

*(Global prefix `/api/v1` is applied by the NestJS bootstrap, `@Controller('admin/users')` provides the rest.)*

### Service Call Shapes Verified

```typescript
// POST — assignRole calls:
userRoleAssignmentService.create({ ...body, userId: id })
// body type: CreateUserRoleAssignmentRequest; userId injected from :id path param

// DELETE — removeRole calls:
userRoleAssignmentService.deleteById(assignmentId)
// assignmentId from :assignmentId path param; :id is NOT forwarded
```

### Test Cases Added

**`describe('POST /admin/users/:id/roles (assignRole)')`** — 3 cases:
1. `should call userRoleAssignmentService.create with body merged with userId` — verifies `create` called with `{ roleId: 'role-1', userId: 'user-1' }` exactly once.
2. `should return a mapped UserRoleAssignmentResponse` — verifies the `UserRoleAssignmentDtoMapper` result has correct `userId` and `roleId`.
3. `should propagate errors thrown by the service` — verifies service errors bubble up (consistent with existing `POST /admin/users (create)` block style).

**`describe('DELETE /admin/users/:id/roles/:assignmentId (removeRole)')`** — 2 cases:
1. `should call userRoleAssignmentService.deleteById with assignmentId` — verifies `deleteById('assignment-1')` called exactly once.
2. `should return void (no response body)` — verifies the method returns `undefined` (no mapped DTO; HTTP 204).

### Diff Stats

- **Lines added**: ~50
- **`it` blocks added**: POST: 3, DELETE: 2 (total: 5)
- **Source files modified**: 0

### Verification Output

```
# Targeted file (before)
Tests  36 passed (36)

# Targeted file (after)
Tests  41 passed (41)
Duration  920ms

# Full package (before)
Tests  1040 passed (1040)

# Full package (after)
Test Files  44 passed (44)
     Tests  1045 passed (1045)
  Duration  10.67s

# Lint
ESLint: 0 errors, 0 warnings (deprecation warnings are pre-existing, unrelated)

# ReadLints
No linter errors found.
```

---

## Change History

| Date       | Description                                             | Files Modified |
|------------|---------------------------------------------------------|----------------|
| 2026-05-24 | Initial implementation: add POST and DELETE role mutation test coverage | `apps/api/src/modules/user/__tests__/user.controller.test.ts` |
