# TASK-216: SDK Health & Monitoring Endpoint Mismatch Fix

- **Ticket**: TASK-216
- **Created**: 2026-02-23
- **Last Updated**: 2026-02-23
- **Status**: Completed

## Requirement Analysis

### Problem

The `agentic-sdk-v2` (`@arcaai/vox`) defines `SERVICE_HEALTH_ENDPOINTS` constants that point to routes that **do not exist** in the API gateway, causing 404 errors. Additionally, the Vite example app calls the `/monitoring/uptime` endpoint with only an API key header, but the endpoint requires JWT Bearer token authentication, causing 401 errors.

### 404 NOT FOUND — Endpoint Mismatch

| SDK Constant (constants.ts)  | Actual API Gateway Route        | Controller          |
|------------------------------|---------------------------------|---------------------|
| `/health/stt`                | **No STT health endpoint**      | N/A                 |
| `/health/tts`                | `/speech/health`                | TtsController       |
| `/health/nlp`                | `/nlp/health`                   | NlpController       |
| `/health/smr`                | `/text/api/v2/health`           | SmrController       |

### 401 Unauthorized — Missing JWT Auth

- `GET /api/v1/monitoring/uptime` requires `@UseGuards(JwtAuthGuard)` (Bearer token)
- Vite app `setup.tsx` sends only `X-API-Key` header → 401

### Business Context

Health checks and monitoring are used by the Vite example app's Setup page, Admin Dashboard, and ServiceStatusBar component to display system status. Incorrect endpoints cause the UI to always show "degraded" or "unhealthy" even when services are running fine.

### Acceptance Criteria

1. `SERVICE_HEALTH_ENDPOINTS` constants match actual API gateway routes
2. `useHealthCheck` hook correctly checks all available services
3. STT health check is excluded (no endpoint exists in API gateway)
4. Vite app monitoring calls include Bearer token for JWT-protected endpoints
5. Dashboard `fetchEndpoint` includes Bearer token
6. All existing tests updated and passing
7. New tests cover the corrected endpoint paths

## Current State Evaluation

### SDK Constants (`packages/agentic-sdk-v2/src/core/constants.ts`)

Lines 374-379 define `SERVICE_HEALTH_ENDPOINTS` with wrong paths added in TASK-032 WS-A:
```typescript
export const SERVICE_HEALTH_ENDPOINTS = {
  STT: '/health/stt',   // WRONG — no endpoint exists
  TTS: '/health/tts',   // WRONG — actual: /speech/health
  NLP: '/health/nlp',   // WRONG — actual: /nlp/health
  SMR: '/health/smr',   // WRONG — actual: /text/api/v2/health
};
```

### Health Check Hook (`packages/agentic-sdk-v2/src/hooks/useHealthCheck.ts`)

Uses `SERVICE_HEALTH_ENDPOINTS` in `SERVICE_CHECKS` array (lines 24-31). All four service checks fail with 404.

### Vite App (`packages/agentic-sdk-v2/examples/vite-app/`)

- `setup.tsx` line 462: Direct `fetch()` to `/monitoring/uptime` with only API key
- `dashboard.tsx` line 47: `fetchEndpoint()` sends only API key, no Bearer token

### API Gateway Controllers

- `NlpController` (`@Controller('nlp')`) → `GET /api/v1/nlp/health` — requires JWT
- `TtsController` (`@Controller('speech')`) → `GET /api/v1/speech/health` — requires JWT
- `SmrController` (`@Controller('text')`) → `GET /api/v1/text/api/v2/health` — no guard on controller (but health endpoint itself has no guard)
- STT v2 — **no health endpoint at all**
- `MonitoringController` → all routes require `JwtAuthGuard`

## Implementation Plan (Option A — Fix SDK to match backend)

### Phase 1: RED — Write Failing Tests

1. **Constants test**: Assert `SERVICE_HEALTH_ENDPOINTS` values match actual backend routes
2. **useHealthCheck test**: Assert correct endpoints are called, STT excluded from service checks
3. **Vite app auth test**: Verify monitoring calls include Bearer token

### Phase 2: GREEN — Minimal Fixes

1. Update `SERVICE_HEALTH_ENDPOINTS` in `constants.ts` to correct paths; remove STT (no endpoint)
2. Update `useHealthCheck` `SERVICE_CHECKS` to exclude STT
3. Fix `setup.tsx` and `dashboard.tsx` to include Bearer token in auth headers

### Phase 3: REFACTOR — Clean Up

1. Verify all existing tests still pass
2. Ensure no other files reference the old endpoint paths
3. Run linter

### Files to Modify

- `packages/agentic-sdk-v2/src/core/constants.ts`
- `packages/agentic-sdk-v2/src/hooks/useHealthCheck.ts`
- `packages/agentic-sdk-v2/src/hooks/__tests__/useHealthCheck.test.ts`
- `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx`
- `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/dashboard.tsx`

## Implementation Summary

### Approach: Option A — Fix SDK to match existing API gateway routes

Used TDD (Red-Green-Refactor) methodology throughout.

### Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Fixed `SERVICE_HEALTH_ENDPOINTS` to match actual API gateway routes; removed STT (no endpoint exists) |
| `packages/agentic-sdk-v2/src/hooks/useHealthCheck.ts` | Removed STT from `SERVICE_CHECKS` array (5 checks instead of 6) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useHealthCheck.test.ts` | Updated degraded test mock count (5 not 6); added TASK-216 tests verifying correct endpoints and STT exclusion |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task210.test.ts` | Updated `SERVICE_HEALTH_ENDPOINTS` assertion to match corrected values |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx` | Added Bearer token to monitoring/uptime fetch headers |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/dashboard.tsx` | Added Bearer token to `fetchEndpoint` headers |

### Files Created

| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task216.test.ts` | New test file asserting corrected `SERVICE_HEALTH_ENDPOINTS` values |

### Endpoint Corrections

| Before (wrong) | After (correct) | API Gateway Controller |
|-----------------|-----------------|----------------------|
| `/health/stt` | **Removed** | No STT health endpoint exists |
| `/health/tts` | `/speech/health` | `TtsController @Controller('speech')` |
| `/health/nlp` | `/nlp/health` | `NlpController @Controller('nlp')` |
| `/health/smr` | `/text/api/v2/health` | `SmrController @Controller('text')` |

### Auth Fix

The Vite example app's `setup.tsx` and `dashboard.tsx` now send both `Authorization: Bearer <token>` and `X-API-Key` headers when available, fixing the 401 on JWT-protected monitoring endpoints.

### Test Results

- All 92 test files pass
- All 2717 tests pass
- No linter errors introduced

### Deviations from Plan

None. All planned changes were implemented as described.

### Known Limitation

The STT v2 service has no health endpoint exposed through the API gateway. If one is added in the future, `SERVICE_HEALTH_ENDPOINTS` and `useHealthCheck` should be updated to include it.
