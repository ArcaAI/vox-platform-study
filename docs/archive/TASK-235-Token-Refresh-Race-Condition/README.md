# TASK-235: Token Refresh Race Condition Fix

| Field | Value |
|-------|-------|
| **Ticket** | TASK-235 |
| **Type** | Bugfix |
| **Created** | 2026-03-03 |
| **Updated** | 2026-03-03 |
| **Status** | Completed |

---

## Requirement Analysis

### Description

When using `ui-playground` with credentials auth, the `/refresh` endpoint is called multiple times when the access token expires. Despite successful refresh calls, subsequent API requests still use the expired access token, causing cascading 401 errors and additional refresh attempts.

### Business Context

Token refresh is critical for uninterrupted user sessions. The race condition degrades UX by causing visible errors, redundant network traffic, and potential logout due to refresh token rotation invalidating earlier refresh attempts.

### Acceptance Criteria

1. When multiple concurrent requests receive 401, only **one** refresh call is made; others wait for its result
2. After a successful refresh via any path (SDK or direct client), **all** HTTP clients use the new token immediately
3. The `tryRefreshToken()` utility and `AgenticClient.onUnauthorizedHandler` share a single mutex
4. Existing tests continue to pass with no regressions

---

## Current State Evaluation

### Root Cause Analysis

Three interrelated issues cause the bug:

#### 1. No mutex in `AgenticClient`'s 401 handler

`AgenticClient.request()` (lines 227-241) calls `this.onUnauthorizedHandler()` on every 401 response independently. When N concurrent requests all get 401, N separate refresh calls are triggered.

#### 2. Two uncoordinated refresh paths

- **SDK path**: `handleUnauthorized` in `use-auto-refresh.ts` → `useAuth().refreshToken()` → `AgenticClient.post('/auth/refresh')`
- **Direct client path**: `admin-client.ts` / `smr-client.ts` → `tryRefreshToken()` → raw `fetch('/auth/refresh')`

These paths have no shared lock. `tryRefreshToken()` has its own `inflightRefresh` mutex, but the SDK path bypasses it entirely.

#### 3. `tryRefreshToken()` doesn't sync token to `AgenticClient`

After `admin-client` or `smr-client` refreshes via `tryRefreshToken()`, the new token is written to `useAuthStore` but **not** pushed to `AgenticClient.accessToken`. The SDK continues using the stale expired token, triggering more 401s.

### Impact Areas

| File | Role | Issue |
|------|------|-------|
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | SDK HTTP client | No refresh deduplication |
| `apps/ui-playground/src/hooks/use-auto-refresh.ts` | 401 handler + proactive refresh | Uses separate refresh path from direct clients |
| `apps/ui-playground/src/lib/auth-refresh.ts` | Shared refresh utility | Doesn't sync to AgenticClient |
| `apps/ui-playground/src/features/admin/api/admin-client.ts` | Admin API client | Refreshes without syncing to SDK |
| `apps/ui-playground/src/features/summarization/api/smr-client.ts` | SMR API client | Same issue as admin-client |

---

## Implementation Plan

### Fix 1: Add refresh mutex to `AgenticClient`

Add an `inflightRefresh` promise field to `AgenticClient` so that when multiple concurrent 401s trigger `onUnauthorizedHandler`, only the first call actually invokes the handler; subsequent calls await the same promise.

### Fix 2: Unify `handleUnauthorized` to use `tryRefreshToken()`

Change `handleUnauthorized` in `use-auto-refresh.ts` to call `tryRefreshToken()` (which already has its own mutex) instead of `sdkRefreshRef.current()`. This ensures a single deduplication point for all refresh attempts.

### Fix 3: Add `AgenticClient` sync to `tryRefreshToken()`

Make `tryRefreshToken()` accept an optional `AgenticClient` reference. After a successful refresh, push the new token to `AgenticClient.updateAccessToken()` in addition to updating the Zustand store. Alternatively, use a callback registration pattern.

### Testing Strategy (TDD)

1. **AgenticClient mutex test**: Verify that N concurrent 401s produce exactly 1 handler invocation
2. **tryRefreshToken sync test**: Verify that after `tryRefreshToken()`, the registered `AgenticClient` has the new token
3. **End-to-end path test**: Verify that after admin-client triggers refresh, SDK requests use the new token

---

## Implementation Summary

### What Was Built

Three targeted fixes that eliminate the token refresh race condition:

#### Fix 1: Refresh mutex in `AgenticClient`

Added an `inflightRefresh` promise field and a `deduplicatedRefresh()` private method. When multiple concurrent requests receive 401, only the first invokes the `onUnauthorizedHandler`; all others await the same promise. After the promise settles, the field is cleared for the next refresh cycle.

#### Fix 2: Listener pattern in `auth-refresh.ts`

Added `registerOnTokenRefreshed()` and `unregisterOnTokenRefreshed()` exports. After a successful refresh, `tryRefreshToken()` iterates over registered listeners and passes the new access token. This allows external HTTP clients to receive the new token without coupling to the Zustand store.

#### Fix 3: Unified `handleUnauthorized` in `use-auto-refresh.ts`

Replaced the dual-path architecture (SDK `refreshToken()` vs `tryRefreshToken()`) with a single path. The 401 handler now delegates entirely to `tryRefreshToken()`, which has its own mutex. The hook registers `AgenticClient.updateAccessToken` as a listener via `registerOnTokenRefreshed()`, and unregisters on unmount. Proactive timer refresh also uses `tryRefreshToken()` directly.

### Files Changed

| File | Change | Purpose |
|------|--------|---------|
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | Added `inflightRefresh` field and `deduplicatedRefresh()` method | Deduplicate concurrent 401 refresh calls |
| `apps/ui-playground/src/lib/auth-refresh.ts` | Added listener registration/notification pattern | Sync new token to external clients after refresh |
| `apps/ui-playground/src/hooks/use-auto-refresh.ts` | Unified to use `tryRefreshToken()` + listener pattern | Single refresh path for all clients |
| `apps/ui-playground/src/hooks/__tests__/use-auto-refresh.task234.test.ts` | Updated to test via `tryRefreshToken()` path | Reflect new unified architecture |
| `apps/ui-playground/src/hooks/__tests__/use-auto-refresh.proactive.test.ts` | Updated sync assertions | Reflect listener-based sync |

### New Test Files

| File | Tests | Purpose |
|------|-------|---------|
| `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.refreshMutex.test.ts` | 5 | Mutex deduplication, retry with new token, error propagation, infinite loop prevention, sequential cycles |
| `apps/ui-playground/src/lib/__tests__/auth-refresh.sync.test.ts` | 5 | Listener notification, failure handling, multiple listeners, unregister, concurrent deduplication |
| `apps/ui-playground/src/hooks/__tests__/use-auto-refresh.task235.test.ts` | 5 | Unified 401 path, AgenticClient sync via listener, failure/logout, unmount cleanup |
| `apps/ui-playground/src/hooks/__tests__/use-auto-refresh.impersonation.test.ts` | 4 | Re-impersonation on 401, fallback to admin token, logout on base-refresh failure, normal flow unchanged |

### Test Results

- SDK test suite: **2539 passed**, 0 failed
- Playground test suite: **347 passed**, 2 failed (pre-existing, unrelated to TASK-235)
- New TASK-235 tests: **19 passed**, 0 failed

#### Fix 4: Impersonation-aware 401 handling

When impersonating, the `AgenticClient` holds an impersonation token (15min TTL) that cannot be refreshed via the normal `/auth/refresh` endpoint. Before this fix, a 401 during impersonation would refresh the base user token and push it to `AgenticClient`, breaking the impersonation context.

Now `handleUnauthorized` detects impersonation and performs a two-step recovery:
1. Refresh the base admin token via `tryRefreshToken()`
2. Re-impersonate the target user via `POST /auth/impersonate`
3. Update `AgenticClient` and auth store with the fresh impersonation token

If re-impersonation fails, impersonation ends gracefully and the admin token is used.

The `syncListener` also skips pushing the base token to `AgenticClient` during impersonation, preventing it from overwriting the impersonation token.

### Architecture After Fix

```
                    ┌─────────────────────┐
                    │   AgenticClient     │
                    │  (inflightRefresh   │
                    │   mutex)            │
                    └────────┬────────────┘
                             │ 401 → deduplicatedRefresh()
                             ▼
                    ┌─────────────────────┐
                    │  handleUnauthorized  │
                    │  (use-auto-refresh)  │
                    └────────┬────────────┘
                             │
                    ┌────────▼────────┐
                    │ isImpersonating? │
                    └──┬──────────┬───┘
                   NO  │          │ YES
                       ▼          ▼
        ┌──────────────────┐  ┌────────────────────────┐
        │ tryRefreshToken()│  │ 1. tryRefreshToken()   │
        │ (normal path)    │  │ 2. Set admin token     │
        └────────┬─────────┘  │ 3. POST /impersonate   │
                 │            │ 4. Update impersonation │
                 │            │    token                │
                 │            └────────────┬────────────┘
                 │                         │
        ┌────────▼─────────────────────────▼──────┐
        │         Zustand auth-store              │
        │  (admin-client, smr-client read from)   │
        ├─────────────────────────────────────────┤
        │         Listeners                       │
        │  (AgenticClient.updateAccessToken)      │
        │  Skipped during impersonation —         │
        │  impersonation handler syncs directly   │
        └─────────────────────────────────────────┘
```

All refresh paths converge through `tryRefreshToken()`. Both the Zustand store (for `admin-client`/`smr-client`) and `AgenticClient` (for SDK requests) receive the new token immediately.

---

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-03 | Initial analysis and implementation plan | README.md |
| 2026-03-03 | Implemented fix with TDD (19 new tests) | AgenticClient.ts, auth-refresh.ts, use-auto-refresh.ts, 4 new test files, 2 updated test files |
| 2026-03-03 | Added impersonation-aware 401 handling — re-impersonates target user after refreshing base token | use-auto-refresh.ts, use-auto-refresh.impersonation.test.ts |
