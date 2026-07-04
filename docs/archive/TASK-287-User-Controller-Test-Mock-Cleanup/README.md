# TASK-287 — User Controller Test Mock Cleanup

| Field       | Value                              |
|-------------|-------------------------------------|
| Ticket      | TASK-287                           |
| Type        | Bugfix / Test Hygiene              |
| Status      | Completed                          |
| Created     | 2026-05-24                         |
| Updated     | 2026-05-24                         |
| Branch      | `fix/2605-review`                  |
| Parent      | [TASK-262](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Sibling     | [TASK-282](../TASK-282-UserRoles-Backend-Routes/README.md) |

---

## Requirement Analysis

### Description

Follow-up cleanup surfaced by C2 / TASK-282 during Wave-2A of the TASK-262 Vox SDK assessment cycle.

`apps/api/src/modules/user/__tests__/user.controller.test.ts` contained a mock factory for `IUserRoleAssignmentService` that returned two keys (`assignRole`, `removeRole`) which **do not exist on the real service interface**. The canonical method names on `IUserRoleAssignmentService` are `create` and `deleteById`. The stale keys were created when the controller's internal helper methods were named `assignRole`/`removeRole`, and the mock was never updated when the service interface was settled.

### Business Context

Stale mock keys create a silent divergence: if the controller is exercised via `this.userRoleAssignmentService.create(...)` or `this.userRoleAssignmentService.deleteById(...)` and the mock only has `assignRole`/`removeRole`, any test that references these calls will resolve `undefined` (since the mock key doesn't exist), causing false-positive passes or no-op assertions.

### Acceptance Criteria

- `assignRole: vi.fn()` renamed to `create: vi.fn()` in the mock factory.
- `removeRole: vi.fn()` renamed to `deleteById: vi.fn()` in the mock factory.
- All in-test references to the stale keys updated (or confirmed absent).
- Test suite: 1040/1040 passing (unchanged).
- No new lint errors.
- Dead-mock evidence documented (see below).

---

## Current State Evaluation

### Confirmed Service Interface

File: `packages/applications/src/services/user/userRoleAssignment/IUserRoleAssignmentService.ts`

```typescript
export interface IUserRoleAssignmentService extends IBaseService {
  create(request: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>>;
  fetchById(id: EntityId): Promise<UserRoleAssignmentEntity>;
  update(id: EntityId, request: UpdateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity>;
  deleteById(id: EntityId): Promise<UserRoleAssignmentEntity>;
}
```

Canonical mutation method names: **`create`** and **`deleteById`**.

### Controller Methods Verified

`apps/api/src/modules/user/user.controller.ts` calls:
- `this.userRoleAssignmentService.fetchAllByUserId(...)` — line 214 (method `fetchUserRoleAssignments`)
- `this.userRoleAssignmentService.create(...)` — line 227 (method `assignRole`)
- `this.userRoleAssignmentService.deleteById(...)` — line 239 (method `removeRole`)

### Stale Mock Keys

Before fix:

```typescript
const createMockUserRoleAssignmentService = () => ({
    assignRole: vi.fn(),   // stale — not on IUserRoleAssignmentService
    removeRole: vi.fn(),   // stale — not on IUserRoleAssignmentService
    fetchAll: vi.fn(),
    fetchAllByUserId: vi.fn(),
});
```

### Dead-Mock Evidence

An `rg` scan of all `mockUserRoleAssignmentService.` call sites in the test file returned:

```
line 278: mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(...)
line 282: expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledWith(...)
line 285: expect(mockUserRoleAssignmentService.fetchAllByUserId).toHaveBeenCalledTimes(1)
line 289: mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(...)
line 302: mockUserRoleAssignmentService.fetchAllByUserId.mockResolvedValue(...)
line 306: expect(mockUserRoleAssignmentService.fetchAll).not.toHaveBeenCalled()
```

**Neither `assignRole` nor `removeRole` (nor their correct-name counterparts `create`/`deleteById`) appear in any `expect(...)` or `mockResolvedValue(...)` call.** The controller methods `POST :id/roles` (`assignRole` in the controller) and `DELETE :id/roles/:assignmentId` (`removeRole` in the controller) have **zero test coverage** in this file.

This is a test coverage gap, not a silent false-positive: since no assertion references the stale keys, the rename has no behavioural effect on existing tests. The gap (missing tests for assign/remove role endpoints) is noted here for future work; per TASK-287 scope it is intentionally not filled.

---

## Implementation Plan

1. Read and confirm `IUserRoleAssignmentService` canonical method names. ✓
2. Capture baseline (36 tests in file, 1040 in package). ✓
3. `rg` all `mockUserRoleAssignmentService.` call sites to enumerate coverage. ✓
4. Rename `assignRole` → `create`, `removeRole` → `deleteById` in mock factory. ✓
5. Confirm zero in-test references to stale key names remain. ✓
6. Re-run targeted test (36/36), full package (1040/1040), lint (no errors). ✓
7. Document dead-mock evidence and coverage gap. ✓

---

## Implementation Summary

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/modules/user/__tests__/user.controller.test.ts` | Lines 27–28: `assignRole` → `create`, `removeRole` → `deleteById` in mock factory |

### Diff Stats

- **Lines changed**: 2 (lines 27 and 28 in the mock factory)
- **In-test references updated**: 0 (stale keys were never referenced in any assertion or setup call)
- **Tests added**: 0 (coverage gap documented; out of scope for this ticket)

### Dead-Mock Evidence

Confirmed: stale keys `assignRole` and `removeRole` had no corresponding `expect(...)` or `mockResolvedValue(...)` call sites anywhere in the test file. The rename is purely a correctness / alignment fix that prevents future false-positive silences if a test is ever added for these controller methods.

### Coverage Gap Noted

The controller exposes two endpoints that remain untested:
- `POST /admin/users/:id/roles` → `userRoleAssignmentService.create(...)`
- `DELETE /admin/users/:id/roles/:assignmentId` → `userRoleAssignmentService.deleteById(...)`

These should be addressed in a future ticket (suggest TASK-288 or appended to a broader user-controller test expansion task).

### Verification Output

```
# Targeted file
Test Files  1 passed (1)
     Tests  36 passed (36)
  Duration  914ms

# Full package suite
Test Files  44 passed (44)
     Tests  1040 passed (1040)
  Duration  10.70s

# Lint
ESLint: 0 errors, 0 warnings (deprecation warnings are pre-existing, unrelated)

# ReadLints
No linter errors found.
```

---

## Change History

| Date       | Description                                             | Files Modified |
|------------|---------------------------------------------------------|----------------|
| 2026-05-24 | Initial implementation: rename stale mock keys; document dead-mock evidence | `apps/api/src/modules/user/__tests__/user.controller.test.ts` |
