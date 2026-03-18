# TASK-227: JWT Refresh Token Integration

- **Ticket**: TASK-227
- **Created**: 2026-02-26
- **Last Updated**: 2026-02-26
- **Status**: Completed

## Requirement Analysis

The API Gateway already supports refresh tokens for JWT authentication:
- `POST /auth/login` returns `{ user, token, refreshToken }`
- `POST /auth/refresh` accepts `{ refreshToken }` and returns a new `{ token, refreshToken }` pair

The SDK (`useAuth` hook) already exposes a `refreshToken()` method. However, the vite example app was **not utilizing** the refresh token at all:
1. The login form discarded `data.refreshToken` from the login response
2. The `AuthSession` interface had no `refreshToken` field
3. The `AgenticClient` had no auto-retry mechanism for 401 responses
4. No background or automatic token refresh existed

### Acceptance Criteria

- Refresh token stored in session after JWT login
- Automatic retry of 401 requests after refreshing the access token
- Loop prevention (no retry on `/auth/refresh` itself, max 1 retry)
- Session updated with new tokens after refresh
- Graceful fallback when refresh fails (propagate original 401)

## Current State Evaluation

### What existed
- API: Full `/auth/refresh` endpoint with refresh token generation
- SDK types: `RefreshTokenResponse`, `RefreshTokenRequest` interfaces
- SDK hook: `useAuth().refreshToken()` method that posts to `/auth/refresh`
- SDK client: `AgenticClient` with `updateAccessToken()` but no 401 interceptor

### What was missing
- `AuthSession.refreshToken` field in `auth-store.ts`
- Login form storing the refresh token
- `AgenticClient.setOnUnauthorized()` for 401 interception
- `useAutoRefresh` hook wiring everything together

## Implementation Summary

### Layer 1: Auth Store (`auth-store.ts`)
- Added `refreshToken: string | null` to `AuthSession` interface
- Added `refreshToken: null` to `DEFAULT_SESSION`
- Automatically persists/restores via existing `sessionStorage` mechanism

### Layer 2: Login Gate (`login-gate.tsx`)
- `JwtLoginForm` now reads `data.refreshToken` from login response
- Passes `refreshToken` to `setSession()` alongside `jwtToken`

### Layer 3: AgenticClient (`AgenticClient.ts`)
- Added `onUnauthorizedHandler` private field
- Added `setOnUnauthorized(handler)` public method
- Modified `request()` to intercept 401 responses:
  - Skips auth refresh endpoint (`/auth/refresh`) to prevent loops
  - Calls handler, retries original request if handler returns `true`
  - Only retries once (`isRetry` flag prevents infinite retry)
  - Falls through to original 401 error on failure

### Layer 4: Auto-Refresh Hook (`auto-refresh.ts`)
- New `useAutoRefresh()` hook that wires the three layers together
- Registers an `onUnauthorized` handler on the `AgenticClient`
- Handler reads current refresh token from `getAuthSession()`
- Calls `useAuth().refreshToken()` with the stored refresh token
- Updates `auth-store` session with new `jwtToken` and `refreshToken`
- Returns `false` (propagate 401) if no refresh token or refresh fails

### Layer 5: App Integration (`App.tsx`)
- `AutoRefreshInit` component calls `useAutoRefresh()` inside `AgenticProvider`
- Initialized once when the app mounts

### Files Modified
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts` — 401 interceptor
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/auth-store.ts` — `refreshToken` field
- `packages/agentic-sdk-v2/examples/vite-app/src/components/login-gate.tsx` — store refresh token
- `packages/agentic-sdk-v2/examples/vite-app/src/App.tsx` — wire `useAutoRefresh`

### Files Created
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/auto-refresh.ts` — hook

### Test Files Created (TDD)
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/__tests__/auth-store.task227.test.ts` — 9 tests
- `packages/agentic-sdk-v2/examples/vite-app/src/components/__tests__/login-gate.task227.test.tsx` — 2 tests
- `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.task227.test.ts` — 12 tests
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/__tests__/auto-refresh.task227.test.ts` — 5 tests

### Test Files Updated (regression fix)
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/__tests__/auth-store.task224.test.ts` — added `refreshToken: null` to exact-match assertions

### Total Tests: 28 new tests, all passing
### Regressions: 0 (existing tests all pass)

## Testing Strategy

Strict TDD (Red-Green-Refactor) was followed for every change:
1. Write failing tests defining the expected behavior
2. Verify tests fail for the right reason
3. Write minimal implementation to make tests pass
4. Verify all tests pass including existing ones
5. Refactor if needed

## Token Refresh Flow

```
API request → 401 Unauthorized
  ↓
AgenticClient.onUnauthorized handler fires
  ↓
useAutoRefresh reads refreshToken from auth-store
  ↓
Calls useAuth().refreshToken(currentRefreshToken)
  ↓
SDK POSTs to /auth/refresh → receives { token, refreshToken }
  ↓
AgenticClient.updateAccessToken(newToken) — SDK updates internally
auth-store.setSession({ jwtToken, refreshToken }) — persisted to sessionStorage
  ↓
Original request retried with new Bearer token
  ↓
Success → result returned to caller transparently
```
