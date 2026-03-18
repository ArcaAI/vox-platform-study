# TASK-212: Access Control Refactoring

- **Ticket**: TASK-212
- **Created**: 2026-02-22
- **Last Updated**: 2026-02-22
- **Status**: Completed

## Requirement Analysis

The SDK's `AgenticClient` conflated API keys and JWT access tokens into a single `X-API-Key` header, causing:

1. **SDK sends JWT as `X-API-Key`** — The backend `JwtStrategy` only extracts JWT from `Authorization: Bearer`, so all authenticated SDK calls returned 401.
2. **No semantic separation** — API keys (long-lived, system-to-system) and access tokens (short-lived, user-scoped) were treated identically in `ApiConfig.apiKey`.
3. **IdM/IAM integration blocked** — External identity providers issue standard OAuth2 access tokens via `Authorization: Bearer`. The old architecture couldn't accommodate this.

### Acceptance Criteria

- JWT tokens sent exclusively via `Authorization: Bearer` header
- API keys sent exclusively via `X-API-Key` header
- SDK `ApiConfig` has separate `accessToken` and `apiKey` fields
- Backend `JwtStrategy` only extracts from `Authorization: Bearer`
- Example apps correctly store JWT in `accessToken`, API key in `apiKey`
- All existing tests pass + new tests for dual auth behavior

## Implementation Summary

### Phase 1: Backend — Clean up JwtStrategy

**Files modified:**
- `packages/applications/src/services/auth/jwt.strategy.ts` — Removed `x-api-key` extractor, now only uses `fromAuthHeaderAsBearerToken()`
- `packages/applications/src/services/auth/gateway-auth.strategy.ts` — Same cleanup (also removed URL query parameter extractor)

### Phase 2: SDK — Dual auth fields in ApiConfig and AgenticClient

**Files modified:**
- `packages/agentic-sdk-v2/src/types/config.ts` — `ApiConfig.apiKey: string` → `accessToken?: string` + `apiKey?: string`
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts`:
  - Added `private accessToken?: string` field
  - `request()` and `postFormData()` conditionally add `Authorization: Bearer` and `X-API-Key`
  - New methods: `getAccessToken()`, `updateAccessToken()`, `clearAccessToken()`, `getApiKey()`, `clearApiKey()`
  - Kept `updateApiKey()` for API key channel

### Phase 3: SDK hooks — useAuth stores token correctly

**Files modified:**
- `packages/agentic-sdk-v2/src/hooks/useAuth.ts`:
  - `login()`: `updateApiKey(data.token)` → `updateAccessToken(data.token)`
  - `impersonate()`: `getCurrentApiKey()` → `getAccessToken()`, token updates via `updateAccessToken()`
  - `endImpersonation()`: `updateApiKey(originalToken)` → `updateAccessToken(originalToken)`
  - `logout()`: Added `apiClient.clearAccessToken()`

### Phase 4: Example apps — Store JWT in accessToken

**Files modified:**
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/api-config-store.ts` — Added `accessToken` field to `RuntimeApiConfig`
- `packages/agentic-sdk-v2/examples/nextjs-app/src/lib/api-config-store.ts` — Same
- `packages/agentic-sdk-v2/examples/vite-app/src/components/login-gate.tsx` — JWT login stores `accessToken`
- `packages/agentic-sdk-v2/examples/nextjs-app/src/components/login-gate.tsx` — Same
- `packages/agentic-sdk-v2/examples/vite-app/src/lib/config.ts` — Passes both `accessToken` and `apiKey` to SDK
- `packages/agentic-sdk-v2/examples/nextjs-app/src/lib/config.ts` — Same

### Phase 5: Backend — EitherAuthGuard

**Files created:**
- `apps/api/src/guards/either-auth.guard.ts` — Composite guard: tries JWT first, falls back to API key

**Files modified:**
- `apps/api/src/guards/index.ts` — Re-exports `EitherAuthGuard`

### Phase 6: Tests

**Files modified:**
- `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.test.ts` — 8 new tests for dual auth headers
- `packages/agentic-sdk-v2/src/hooks/__tests__/useAuth.test.ts` — Updated mocks and BUG-10 tests for `updateAccessToken`
- `packages/agentic-sdk-v2/src/__tests__/examples/full-workflow.test.ts` — Updated to use `updateAccessToken`

### Test Results

- **88 test files passed**
- **2,554 tests passed**
- **0 failures**

## Architecture

```
SDK (accessToken) → Authorization: Bearer → JwtAuthGuard → JwtStrategy
SDK (apiKey)      → X-API-Key            → ApiKeyGuard   → Hash lookup
Either route      → Both headers          → EitherAuthGuard → Try JWT, fallback API key
```

## Breaking Changes

This is a big-bang change with no backward compatibility:
- `ApiConfig.apiKey` is now exclusively for API keys (not JWT tokens)
- `AgenticClient.getCurrentApiKey()` removed — use `getAccessToken()` or `getApiKey()`
- Example apps' `localStorage` format changed — old sessions are discarded, users must re-login
