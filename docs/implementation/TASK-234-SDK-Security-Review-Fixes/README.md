# TASK-234: SDK Security Review — Critical Fixes, Recommendations & SharedWorker

| Field | Value |
|-------|-------|
| **Ticket** | TASK-234 |
| **Type** | Security Fix / Refactor / Feature |
| **Status** | Completed |
| **Created** | 2026-03-02 |
| **Updated** | 2026-03-02 |
| **Packages** | `@arcaai/vox`, `apps/api`, `apps/ui-playground` |

---

## Requirement Analysis

### Description

Comprehensive security review of `@arcaai/vox` SDK and `ui-playground` identified critical architectural violations where client applications bypassed the API gateway to access backend services directly. Additionally, the SDK's `useConsultationJob` hook used unauthenticated SSE connections, and the WebSocket reconnection strategy lacked jitter (risking thundering herd). A SharedWorker-based multi-tab connection management system was also implemented.

### Business Context

- **Healthcare compliance**: All client traffic must traverse the API gateway for authentication, authorization, rate limiting, and audit logging
- **Security**: Direct service access bypasses RBAC, tenant isolation, and audit trails
- **Reliability**: Unauthenticated SSE connections fail silently; missing jitter causes coordinated reconnection storms
- **Performance**: Multi-tab users create redundant WebSocket/SSE connections, wasting server resources

### Acceptance Criteria

- [x] No client-side code accesses backend services directly (all traffic through API gateway)
- [x] All SSE connections in the SDK use `SSEClient` with authentication
- [x] WebSocket reconnection includes jitter to prevent thundering herd
- [x] `SmrProxyController` enforces JWT authentication and supports task cancellation
- [x] SharedWorker manages WebSocket/SSE connections across browser tabs
- [x] All changes have tests (2535/2535 passing)
- [x] No new lint errors or type errors

---

## Current State Evaluation

### Issues Identified

| ID | Severity | Component | Issue |
|----|----------|-----------|-------|
| CRIT-01 | Critical | `vite.config.ts` | Vite proxy `/api/v2` routed directly to SMR service (port 8862), bypassing API gateway |
| CRIT-02 | Critical | `smr-client.ts` | `getSmrBaseUrl()` stripped API path to construct direct SMR URLs |
| CRIT-03 | Critical | `summarization.ts` | All 8 SMR API calls used `/api/v2/*` paths with `{ baseUrl: 'smr' }` |
| CRIT-04 | Critical | `useConsultationJob.ts` | `streamJob()` used raw `EventSource` without authentication or reconnection |
| REC-01 | High | `smr-proxy.controller.ts` | Missing `@ApiBearerAuth()`, `JwtAuthGuard`, and cancel route |
| REC-02 | Medium | `SttV2WebSocketClient.ts` | Exponential backoff lacked jitter, risking thundering herd |
| STRATEGIC | Feature | SDK | No multi-tab connection management; each tab creates independent connections |

### Impact Analysis

**CRIT-01 through CRIT-03 (SMR Gateway Bypass)**:
- Authentication headers were sent but never validated by SMR service
- RBAC policies not enforced on SMR operations
- No audit logging for direct SMR access
- No rate limiting on direct SMR access
- Tenant isolation not enforced

**CRIT-04 (Unauthenticated SSE)**:
- Consultation job SSE streams had no authentication
- No auto-reconnection on network failures
- Unsafe `(store as any)` type assertions
- No structured logging or error handling for SSE events

---

## Implementation Plan

### Fix Order

```
1. CRIT-01: Remove Vite /api/v2 proxy bypass
2. CRIT-02: Refactor smr-client.ts (remove getSmrBaseUrl)
3. CRIT-03: Rewrite summarization.ts (change /api/v2/* to /text/*)
4. CRIT-04: Refactor useConsultationJob to use SSEClient
5. REC-01: Add auth guard + cancel route to SmrProxyController
6. REC-02: Add jitter to SttV2WebSocketClient
7. STRATEGIC: Implement SharedWorker multi-tab connection management
```

### Testing Strategy

- Update existing `useConsultationJob.test.ts` with SSEClient mock
- Add `SharedConnectionManager.test.ts` for fallback mode
- Add jitter test to `SttV2WebSocketClient.test.ts`
- Verify all 2535 existing tests still pass

---

## Implementation Summary

### CRIT-01: Removed Vite `/api/v2` Proxy Bypass

**File**: `apps/ui-playground/vite.config.ts`

**Before**:
```typescript
proxy: {
    '/api/v2': {
        target: 'http://localhost:8862',  // Direct to SMR!
        changeOrigin: true,
    },
    '/api': {
        target: 'http://localhost:8868',
        changeOrigin: true,
    },
},
```

**After**:
```typescript
proxy: {
    '/api': {
        target: 'http://localhost:8868',
        changeOrigin: true,
    },
    '/ws': {
        target: 'http://localhost:8868',
        changeOrigin: true,
        ws: true,
    },
},
```

**Why**: The `/api/v2` rule matched before `/api` and routed requests directly to the SMR service on port 8862, completely bypassing the API gateway's authentication, authorization, rate limiting, and audit logging. Added `/ws` proxy for WebSocket connections.

---

### CRIT-02: Refactored `smr-client.ts`

**File**: `apps/ui-playground/src/features/summarization/api/smr-client.ts`

**Changes**:
- Removed `getSmrBaseUrl()` function that stripped `/api/v1` from the base URL to construct direct SMR URLs
- Removed `baseUrl: 'api' | 'smr'` option from all request methods (`request`, `requestSSE`, `requestPostSSE`)
- All requests now use `getBaseUrl()` which returns the API gateway URL
- Updated error messages from "Is the SMR service running?" to "Is the API gateway running?"
- Simplified `smrClient` export — no more `opts` parameter with `baseUrl`

---

### CRIT-03: Rewrote `summarization.ts`

**File**: `apps/ui-playground/src/features/summarization/api/summarization.ts`

All 8 API calls changed from direct SMR paths to gateway-proxied paths:

| Hook | Before (Direct SMR) | After (Via Gateway) |
|------|---------------------|---------------------|
| `useSmrProviders` | `/api/v2/providers` + `{ baseUrl: 'smr' }` | `/text/providers` |
| `useSmrHealth` | `/api/v2/health` + `{ baseUrl: 'smr' }` | `/text/health` |
| `useSmrTaskStatus` | `/api/v2/tasks/${taskId}` + `{ baseUrl: 'smr' }` | `/text/tasks/${taskId}` |
| `useGenerateSync` | `/api/v2/generate` + `{ baseUrl: 'smr' }` | `/text/generate` |
| `useGenerateAsync` | `/api/v2/generate` + `{ baseUrl: 'smr' }` | `/text/generate` |
| `useCancelTask` | `/api/v2/tasks/${taskId}/cancel` + `{ baseUrl: 'smr' }` | `/text/tasks/${taskId}/cancel` |
| `useGeneratePreSummary` | `/api/v2/generate` + `{ baseUrl: 'smr' }` | `/text/generate` |
| `useGenerateSummary` | `/api/v2/generate` + `{ baseUrl: 'smr' }` | `/text/generate` |

**Route mapping**: Client sends `/text/*` → API gateway's `SmrProxyController` handles at `@Controller('text')` → proxies to `SMR_SERVICE_URL/api/v2/*`.

---

### CRIT-04: Refactored `useConsultationJob.streamJob()`

**File**: `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts`

**Before**: Used raw `EventSource` with no authentication:
```typescript
const config = (store as any).config?.api;
const baseUrl = config?.baseUrl ?? '';
const eventSource = new EventSource(`${baseUrl}${sseUrl}`);
```

**After**: Uses SDK's `SSEClient` with full authentication and reconnection:
```typescript
const sseClient = new SSEClient(logger);
sseClient.connect(sseUrl, {
    autoReconnect: true,
    reconnectIntervalMs: 2000,
    maxReconnectAttempts: 15,
    maxDelayMs: 30000,
    authToken: apiClient.getAccessToken() ?? undefined,
});
```

**Key improvements**:
- Authentication via `authToken` query parameter (EventSource limitation)
- Auto-reconnection with exponential backoff + jitter (15 attempts, 2s base, 30s max)
- Structured logging for all SSE events
- JSON parse error handling (malformed events logged, not thrown)
- Removed unsafe `(store as any)` type assertions — uses `apiClient.getBaseUrl()` and `apiClient.getAccessToken()`
- Proper cleanup via `sseClient.disconnect()` on unmount and terminal status
- Uses `store.consultation?.id` instead of `(store as any).consultation?.id`

---

### REC-01: Enhanced `SmrProxyController`

**File**: `apps/api/src/modules/streaming/smr-proxy.controller.ts`

**Changes**:
1. Added `@ApiBearerAuth()` decorator for Swagger documentation
2. Added `@UseGuards(JwtAuthGuard)` to enforce JWT authentication on all routes
3. Added `POST tasks/:taskId/cancel` route for task cancellation through the gateway

**New route**:
```typescript
@Post('tasks/:taskId/cancel')
@ApiOperation({ summary: 'Cancel a running SMR task' })
@ApiParam({ name: 'taskId', description: 'Task ID to cancel' })
async cancelTask(@Param('taskId') taskId: string): Promise<any>
```

**Route table** (complete):

| Method | Gateway Path | Proxied To | Auth |
|--------|-------------|------------|------|
| POST | `/text/generate` | `SMR_SERVICE_URL/api/v2/generate` | JWT |
| GET | `/text/tasks/:taskId` | `SMR_SERVICE_URL/api/v2/tasks/:taskId` | JWT |
| POST | `/text/tasks/:taskId/cancel` | `SMR_SERVICE_URL/api/v2/tasks/:taskId/cancel` | JWT |
| GET | `/text/tasks/:taskId/stream` | `SMR_SERVICE_URL/api/v2/tasks/:taskId/stream` (SSE) | JWT |
| GET | `/text/providers` | `SMR_SERVICE_URL/api/v2/providers` | JWT |
| GET | `/text/health` | `SMR_SERVICE_URL/api/v2/health` | JWT |

---

### REC-02: Added Jitter to WebSocket Reconnection

**File**: `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts`

**Before**:
```typescript
const delay = Math.min(
    this.reconnectOptions.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
    this.reconnectOptions.maxDelayMs,
);
```

**After**:
```typescript
const exponentialDelay = Math.min(
    this.reconnectOptions.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
    this.reconnectOptions.maxDelayMs,
);
const jitter = Math.random() * exponentialDelay * 0.5;
const delay = Math.round(exponentialDelay + jitter);
```

**Formula**: `delay = exponentialDelay + random(0, exponentialDelay * 0.5)`

This adds 0-50% random jitter to each reconnection delay, preventing multiple clients from reconnecting simultaneously after a server restart (thundering herd problem). The `SSEClient` already had jitter — this brings `SttV2WebSocketClient` to parity.

---

### STRATEGIC: SharedWorker Multi-Tab Connection Management

**New files**:

| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts` | SharedWorker script (runs in separate thread) |
| `packages/agentic-sdk-v2/src/core/SharedConnectionManager.ts` | Client-side manager for each tab |
| `packages/agentic-sdk-v2/src/hooks/useSharedConnection.ts` | React hooks (`useSharedConnection`, `useSharedSSE`, `useSharedWS`) |

**Architecture**:

```text
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Tab 1     │  │   Tab 2     │  │   Tab 3     │
│ Manager     │  │ Manager     │  │ Manager     │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │ MessagePort     │ MessagePort     │ MessagePort
       └────────────┬────┴────────────────┘
                    │
          ┌─────────▼─────────┐
          │  SharedWorker     │
          │  (single thread)  │
          │                   │
          │  SSE Pool:        │
          │   job-123 → ES    │
          │   job-456 → ES    │
          │                   │
          │  WS Pool:         │
          │   stt-789 → WS    │
          └─────────┬─────────┘
                    │ Single connection per endpoint
                    ▼
          ┌───────────────────┐
          │  API Gateway      │
          │  (NestJS :8868)   │
          └───────────────────┘
```

**Key design decisions**:
- **One connection per unique endpoint**: If 3 tabs subscribe to the same SSE stream, only 1 `EventSource` is created
- **Automatic cleanup**: When a tab disconnects (port closes), its subscriptions are removed. When the last subscriber leaves, the connection is closed
- **Graceful fallback**: When `SharedWorker` is unavailable (unsupported browser, non-HTTPS), falls back to per-tab direct connections with identical API
- **Tab count tracking**: `onTabCountChange(cb)` notifies all tabs when tabs join/leave
- **Named SSE events**: Forwards `status`, `progress`, `result`, `transcript`, `error`, `complete` events

**React hooks**:

| Hook | Purpose | Returns |
|------|---------|---------|
| `useSharedConnection(workerUrl?)` | Singleton manager with tab count | `{ manager, tabCount, isSharedWorkerActive }` |
| `useSharedSSE(id, options, manager)` | Declarative SSE subscription | `{ isConnected, error }` |
| `useSharedWS(id, options, manager)` | Declarative WS subscription | `{ isConnected, error, send }` |

---

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `apps/ui-playground/vite.config.ts` | Modified | Removed `/api/v2` proxy bypass, added `/ws` proxy |
| `apps/ui-playground/src/features/summarization/api/smr-client.ts` | Modified | Removed `getSmrBaseUrl()` and `baseUrl: 'smr'` option |
| `apps/ui-playground/src/features/summarization/api/summarization.ts` | Modified | Changed all `/api/v2/*` paths to `/text/*` gateway routes |
| `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` | Modified | Replaced raw `EventSource` with `SSEClient` + auth |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Modified | Added `@ApiBearerAuth()`, `JwtAuthGuard`, cancel route |
| `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | Modified | Added jitter to reconnection backoff |
| `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts` | Created | SharedWorker script for multi-tab connection management |
| `packages/agentic-sdk-v2/src/core/SharedConnectionManager.ts` | Created | Client-side manager with SharedWorker fallback |
| `packages/agentic-sdk-v2/src/hooks/useSharedConnection.ts` | Created | React hooks for shared connections |
| `packages/agentic-sdk-v2/src/core/index.ts` | Modified | Added SharedConnectionManager exports |
| `packages/agentic-sdk-v2/src/hooks/index.ts` | Modified | Added useSharedConnection exports |

### Test Files

| File | Action | Tests |
|------|--------|-------|
| `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` | Modified | Updated streamJob tests for SSEClient mock, added 8 new tests |
| `packages/agentic-sdk-v2/src/core/__tests__/SharedConnectionManager.test.ts` | Created | 15 tests for fallback mode SSE/WS, callbacks, dispose |
| `packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts` | Modified | Added jitter test, fixed 3 timing-sensitive tests |

---

## Verification

| Check | Result | Evidence |
|-------|--------|----------|
| Tests | 101 files, 2535/2535 passing | `pnpm test -- --run` exit code 0 |
| Lint | 0 errors on all modified files | `ReadLints` on all 11 files |
| Typecheck | 0 new type errors | `pnpm typecheck` — only pre-existing errors in unrelated test files |
| Gateway bypass | 0 remaining `/api/v2` references in ui-playground | `grep` for `/api/v2/(providers\|generate\|tasks\|health)` |
| Auth coverage | All SmrProxyController routes guarded | `@UseGuards(JwtAuthGuard)` at class level |

---

## Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-02 | Initial implementation of all 7 fixes | See Files Changed above |
