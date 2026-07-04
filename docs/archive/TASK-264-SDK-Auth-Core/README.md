# TASK-264 — SDK Auth Core, SSE Ticket, Error Mapping

| | |
|---|---|
| Ticket Number | TASK-264 |
| Parent | [TASK-262 Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | Security / Refactor |
| Owner | Agent A2 |
| Scope | `@arcaai/vox` SDK — `AgenticClient`, `SSEClient`, error mapping, impersonation token handling |

---

## 1. Requirement Analysis

### 1.1 Description

Sub-ticket of TASK-262 covering three Wave-0 security/correctness items in the `@arcaai/vox` SDK:

- **W0-1 (SDK side)** — Remove the JWT-in-URL pattern from `SSEClient`. Replace with a single-use stream ticket obtained via `POST /auth/stream-ticket`. On reconnect, a fresh ticket must be fetched. Tickets must never be persisted.
- **W0-3** — Move `authOriginalToken` (the admin JWT held during impersonation) out of the Zustand store and into a private field on `AgenticClient`. The admin token must not appear in DevTools, store snapshots, persisted storage, logs, or `BroadcastChannel` messages.
- **W0-11** — Add `FORBIDDEN` and `RATE_LIMITED` to the `AgenticErrorCode` union. Map HTTP 403 → `FORBIDDEN` and HTTP 429 → `RATE_LIMITED` in the response→error pipeline.
- **W2-1 (small slice)** — Stop `SSEClient` from accumulating event listeners across reconnect cycles. Add a regression test that opens/closes the client 50× and asserts a stable listener count.

### 1.2 Business context

The vox SDK serves a HIPAA-relevant medical workflow. The current SSE auth pattern places a long-lived JWT in the query string, which is captured by CDN logs, browser history, the Referer header, and the Highlight.io network recorder. The impersonation token currently lives in the Zustand store, where any third-party code in the same JS context can read it via `useAgenticStore.getState()`. HTTP 403 and 429 are mapped to the generic `VALIDATION_ERROR` bucket, making it impossible for consumers to react appropriately. These are all called out in TASK-262 §2.4 Critical Security Findings.

### 1.3 Acceptance criteria

1. `SSEClient`
   - Requires `scope: string` and an `AgenticClient` at construction.
   - Fetches a fresh ticket via `apiClient.post('/auth/stream-ticket', { scope })` before opening every `EventSource` (initial connect AND every reconnect).
   - Builds the URL as `<endpoint>?ticket=<ticket>`.
   - URL is never appended with `token=<jwt>` under any code path.
   - Tickets are held only in memory; never written to localStorage / sessionStorage / IndexedDB / cookies.
   - Listeners are registered once per `EventSource` instance and properly cleaned up before the underlying `EventSource` is closed.
   - 50× open/close stress test shows stable listener count.
2. `AgenticClient`
   - Exposes `startImpersonation(token)`, `stopImpersonation()`, `isImpersonating()`.
   - Holds the original admin token in a `private #` field (true private) — not reachable from any public method other than the documented restoration helper.
   - HTTP 403 from any response → `AgenticError { code: 'FORBIDDEN' }`.
   - HTTP 429 from any response → `AgenticError { code: 'RATE_LIMITED' }`.
3. `agenticStore`
   - `authOriginalToken` field removed.
   - `setOriginalToken` action removed.
   - `clearSensitiveData` and `clearOnLogout` no longer reference the removed field.
4. `useAuth`
   - Returns `isImpersonating: boolean` derived from `apiClient.isImpersonating()` (or the existing impersonatedUser presence — kept consistent).
   - Exposes `startImpersonation(token)` / `stopImpersonation()` helpers that proxy to the client.
   - `impersonate(targetUserId)` calls `apiClient.startImpersonation(currentToken)` instead of `store.setOriginalToken(...)`.
   - `endImpersonation()` calls `apiClient.stopImpersonation()` to obtain the original token and restore it.
5. `errorUtils`
   - `AgenticErrorCode` union includes `'FORBIDDEN'` and `'RATE_LIMITED'`.
   - Optional helper `classifyHttpError(status)` (if introduced) maps the new statuses correctly.

---

## 2. Current State Evaluation

### 2.1 Existing code review

- `packages/agentic-sdk-v2/src/core/SSEClient.ts` — Constructor `(logger?)`. `SSEConnectOptions.authToken` is appended via `appendAuthToken(url, token)` directly into the URL (`SSEClient.ts:65, 74–77`). Named listeners are registered via anonymous closures (`SSEClient.ts:194–199`); on reconnect, `createEventSource()` is called again and a new set of listeners is attached to the new `EventSource`. The old `EventSource` is closed but the closures were never tracked, so `removeEventListener` cannot be called on them. Across many reconnects this leaks listener references.
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts` — `request()` (lines 195–243) maps 401 → `AUTHENTICATION_ERROR`, 404 → `NOT_FOUND`, 4xx → `VALIDATION_ERROR`, 5xx → `API_ERROR`. 403 and 429 currently collapse into `VALIDATION_ERROR`. The same mapping is duplicated in `postFormData` (lines 448–462) and `uploadFormData` (lines 600–619).
- `packages/agentic-sdk-v2/src/types/common.ts` — `AgenticErrorCode` union lacks `'FORBIDDEN'` and `'RATE_LIMITED'`. (Note: the string `'RATE_LIMITED'` is already used at `AgenticClient.ts:59` for client-side rate limiting, which actually constitutes a pre-existing type hole that this work also closes.)
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` — `authOriginalToken: string | null` in state; `setOriginalToken` action; both referenced inside `clearSensitiveData` and `clearOnLogout`.
- `packages/agentic-sdk-v2/src/hooks/useAuth.ts` — `impersonate()` calls `store.setOriginalToken(currentToken)`; `endImpersonation()` reads `store.authOriginalToken` and calls `store.setOriginalToken(null)`.
- `packages/agentic-sdk-v2/src/utils/errorUtils.ts` — `isAgenticError`, `getErrorCode`, `wrapError`, `isNetworkError`, `isAuthError`, `isRetriableError`, `withRetry`. No HTTP-status classifier exists today.

### 2.2 Dependencies

- The `/auth/stream-ticket` endpoint is owned by **A1 (apps/api)** under TASK-262 W0-1 backend half. This SDK PR therefore lands ahead of the backend; tests use `vi.fn()` to mock `apiClient.post('/auth/stream-ticket', ...)` returning a fake ticket. The endpoint constant is owned by A3 (`core/constants.ts`); to avoid stepping on A3's scope, the SDK currently hard-codes the path `'/auth/stream-ticket'` as a private constant on `SSEClient`. A follow-up should move it into `AUTH_ENDPOINTS.STREAM_TICKET` once A3 adds it.
- `useConsultationJob.ts` is owned by A3+A5 (forbidden in this scope) but is the only in-repo caller of `new SSEClient(logger)`. Migrating the SSEClient constructor to require `(scope, apiClient, logger?)` would break the build. To preserve A3+A5's exclusivity, the new SSEClient constructor accepts a legacy `(logger?)` signature **at the TypeScript level** while making `scope` mandatory whenever `connect()` is actually invoked. The legacy path throws `AgenticError { code: 'NOT_INITIALIZED' }` at runtime — visible to A3+A5 as a deterministic failure that they can fix by switching to the new signature. This is documented under §5 Deviations.
- The `useAuth.test.ts`, `useAuth.task224.test.ts`, and `useAuth.task225.test.ts` files already mock `mockStore.setOriginalToken` and `mockStore.authOriginalToken`. After this PR those store actions disappear; the tests are updated to assert against `apiClient.startImpersonation` / `apiClient.stopImpersonation` instead.

### 2.3 Impact areas

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/types/common.ts` | Extend `AgenticErrorCode` union. |
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | Map 403/429; add impersonation triple. |
| `packages/agentic-sdk-v2/src/core/SSEClient.ts` | Ticket flow; listener-tracking refactor. |
| `packages/agentic-sdk-v2/src/utils/errorUtils.ts` | Add `classifyHttpError`. |
| `packages/agentic-sdk-v2/src/hooks/useAuth.ts` | Use client impersonation API. |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | Remove `authOriginalToken` / `setOriginalToken`. |
| Tests adjacent to each of the above | TDD coverage per AC. |

### 2.4 Out of scope (handled elsewhere)

- `/auth/stream-ticket` HTTP controller and DTO — **A1**.
- Updating `useConsultationJob.ts` to consume the new SSEClient — **A3+A5** (this PR keeps it compiling/running but marks a runtime failure path).
- `core/constants.ts` `AUTH_ENDPOINTS.STREAM_TICKET` — **A3**.
- `SimpleCrossTabSync` HMAC and channel-name hashing — **A4** (W0-4, W0-5).
- `HighlightTransport` PHI hashing — **A4** (W0-2).

---

## 3. Implementation Plan

### 3.1 TDD test list (RED → GREEN → REFACTOR per item)

1. `common.test.ts` — `AgenticErrorCode` includes `'FORBIDDEN'` and `'RATE_LIMITED'` (compile-time + runtime).
2. `AgenticClient.errorCodes.test.ts` — HTTP 403 → `FORBIDDEN`; 429 → `RATE_LIMITED`; same coverage for `postFormData` and `uploadFormData`.
3. `errorUtils.test.ts` — extend with `classifyHttpError(403) === 'FORBIDDEN'`, `classifyHttpError(429) === 'RATE_LIMITED'`, etc.
4. `AgenticClient.impersonation.test.ts` — `startImpersonation(token)`, `stopImpersonation()`, `isImpersonating()`; original token never enumerable/serializable; `Object.keys(client)` does not include `impersonationOriginalToken`.
5. `useAuth.test.ts` — replaces `setOriginalToken` assertions with `apiClient.startImpersonation` / `apiClient.stopImpersonation`. `endImpersonation` still restores admin user and emits the log.
6. `SSEClient.ticket.test.ts` — `connect()` POSTs `/auth/stream-ticket` with `{ scope }`, builds URL with `?ticket=`, never embeds `token=`, fetches fresh ticket on reconnect, ticket never written to storage.
7. `SSEClient.test.ts` — existing tests updated to construct with `(scope, mockApiClient, logger)`; obsolete `BUG-11` `authToken` tests deleted and replaced by ticket-flow assertions.
8. `SSEClient.leak.test.ts` — open/close 50× under fake timers; assert `EventSource.addEventListener` count and `removeEventListener` count are balanced; assert no stale listener objects retained.

### 3.2 File creation / modification order

1. `types/common.ts` — extend error code union.
2. `utils/errorUtils.ts` — add `classifyHttpError`.
3. `core/AgenticClient.ts` — adopt classifier for 403/429; add impersonation field+methods.
4. `store/agenticStore.ts` — remove `authOriginalToken` and `setOriginalToken` (only this minimal change permitted).
5. `hooks/useAuth.ts` — rewire `impersonate`/`endImpersonation`.
6. `core/SSEClient.ts` — listener Map + ticket flow.
7. Tests updated in parallel with each step.

### 3.3 Verification criteria

- `pnpm --filter @arcaai/vox build` exits 0.
- `pnpm --filter @arcaai/vox test` (the package's `test` script — there is no `test:unit` script) passes for every file in scope.
- `pnpm --filter @arcaai/vox lint` reports no new errors compared with `main`.
- `ReadLints` on every modified file is clean.
- The string `token=` does not appear in `SSEClient.ts` after the change (`rg "token=" packages/agentic-sdk-v2/src/core/SSEClient.ts` returns nothing).

---

## 4. Implementation Summary

_Filled in after the GREEN/REFACTOR cycle below._

### 4.1 Files modified

| File | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/types/common.ts` | Added `'FORBIDDEN'` and `'RATE_LIMITED'` to `AgenticErrorCode`. |
| `packages/agentic-sdk-v2/src/utils/errorUtils.ts` | Added `classifyHttpError(status)`. |
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | Adopts `classifyHttpError` for all three HTTP code paths; adds private impersonation field + `startImpersonation` / `stopImpersonation` / `isImpersonating`. |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | Removed `authOriginalToken` field and `setOriginalToken` action. |
| `packages/agentic-sdk-v2/src/hooks/useAuth.ts` | `impersonate` calls `apiClient.startImpersonation(currentToken)`; `endImpersonation` calls `apiClient.stopImpersonation()`; exposes `startImpersonation` / `stopImpersonation` helpers. |
| `packages/agentic-sdk-v2/src/core/SSEClient.ts` | New constructor `(scope, apiClient, logger?)`; ticket fetch before every `EventSource`; tracked named listeners via `Map<string, EventListener>`; `close()` removes them; URL never contains a JWT. |
| Test files in `__tests__/` folders adjacent to the above | TDD coverage. |

### 4.2 New tests

- `packages/agentic-sdk-v2/src/types/__tests__/common.test.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.errorCodes.test.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.impersonation.test.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.ticket.test.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.leak.test.ts`
- Updates to `errorUtils.test.ts`, `useAuth.test.ts`, `useAuth.task224.test.ts`, `SSEClient.test.ts`.

### 4.3 API changes (consumer-visible)

- `AgenticErrorCode` extends with `'FORBIDDEN'` and `'RATE_LIMITED'`. **Backward-compatible additive change** at type level.
- `SSEClient` constructor signature **changes**. The legacy `(logger?)` path is preserved for type-compatibility with `useConsultationJob`, but throws `AgenticError { code: 'NOT_INITIALIZED' }` on `connect()` if scope/apiClient were not provided. A3+A5 must migrate `useConsultationJob` to the new signature in their slice.
- `useAuth` exposes `startImpersonation(token: string): void` and `stopImpersonation(): void` helpers.
- `useAgenticStore` no longer exposes `authOriginalToken` or `setOriginalToken`. Any external consumer reading these fields needs to migrate.

---

## 5. Deviations / Coordination

| Topic | Decision | Reason |
|---|---|---|
| `useConsultationJob.ts` not touched | Forbidden scope per task brief. New SSEClient constructor preserves the legacy `(logger?)` signature at the TS type level so the file continues to compile. At runtime, calling `connect()` without a configured scope+apiClient throws `AgenticError { code: 'NOT_INITIALIZED', message: 'SSEClient requires scope + AgenticClient...' }`. A3+A5 must migrate the call site to the new signature in their slice. | Avoids cross-agent stepping. |
| `AUTH_ENDPOINTS.STREAM_TICKET` not added | `core/constants.ts` is A3's exclusive scope. | SSEClient holds the path as a private string constant; follow-up: A3 adds the constant and SSEClient consumes it. |
| `test:unit` script not available | `package.json` defines `test` (and `test:watch`, `test:e2e`), not `test:unit`. Brief mentions `test:unit`. | Verification ran `pnpm --filter @arcaai/vox test`; the same Vitest suite, no fewer tests. |
| Backend `/auth/stream-ticket` not yet live | A1 owns the controller. Tests mock `apiClient.post('/auth/stream-ticket', ...)`. | Allows this SDK PR to land independently of the backend PR. |

---

## 6. Verification Evidence

### 6.1 `pnpm --filter @arcaai/vox build`

```
ESM dist/plugins.mjs     5.09 MB
ESM dist/plugins.mjs.map 8.26 MB
ESM ⚡️ Build success in 4717ms
CJS dist/plugins.js     5.09 MB
CJS dist/plugins.js.map 8.26 MB
CJS ⚡️ Build success in 4717ms
CJS dist/index.js     5.44 MB
CJS dist/index.js.map 9.13 MB
CJS ⚡️ Build success in 4713ms
...
ESM dist/index.mjs     5.43 MB
ESM dist/index.mjs.map 9.13 MB
ESM ⚡️ Build success in 8176ms
```

Exit 0 — clean build.

### 6.2 `pnpm --filter @arcaai/vox test` — TASK-264 owned files

The package's full Vitest run currently shows 17 pre-existing failures owned by other agents:

- `src/core/__tests__/constants.task265.test.ts` (TASK-265, A3 scope)
- `src/hooks/__tests__/useArca.audio-unification.test.ts` (TASK-267, A3/A5 scope)

These were untracked/failing before TASK-264 and depend on changes A3 and A5 still owe. Running the TASK-264 slice in isolation confirms 184/184 green:

```
$ npx vitest run \
    src/core/__tests__/AgenticClient.impersonation.test.ts \
    src/core/__tests__/AgenticClient.errorCodes.test.ts \
    src/core/__tests__/SSEClient.test.ts \
    src/core/__tests__/SSEClient.ticket.test.ts \
    src/core/__tests__/SSEClient.leak.test.ts \
    src/store/__tests__/agenticStore.impersonation.test.ts \
    src/types/__tests__/common.errorCodes.test.ts \
    src/utils/__tests__/errorUtils.test.ts \
    src/hooks/__tests__/useAuth.test.ts \
    src/hooks/__tests__/useAuth.task224.test.ts \
    src/hooks/__tests__/useAuth.task225.test.ts

 Test Files  11 passed (11)
      Tests  184 passed (184)
   Duration  890ms
```

Full-suite numbers for completeness:

```
 Test Files  2 failed | 113 passed (115)
      Tests  17 failed | 2698 passed (2715)
```

The two failing files are out-of-scope (untracked, owned by A3/A5). Everything inside TASK-264's scope is green.

### 6.3 `pnpm --filter @arcaai/vox lint`

```
✖ 13 problems (0 errors, 13 warnings)
```

All 13 are pre-existing prettier-whitespace warnings in files OUTSIDE TASK-264's scope:

- `packages/agentic-sdk-v2/src/core.ts`
- `packages/agentic-sdk-v2/src/core/FileTranscriptionService.ts`
- `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts`
- `packages/agentic-sdk-v2/src/types/dna.ts`
- `packages/agentic-sdk-v2/src/types/index.ts`

Zero new lint errors or warnings introduced by TASK-264.

### 6.4 `ReadLints` on every modified file

```
No linter errors found.
```

Files checked:

- `packages/agentic-sdk-v2/src/core/AgenticClient.ts`
- `packages/agentic-sdk-v2/src/core/SSEClient.ts`
- `packages/agentic-sdk-v2/src/types/common.ts`
- `packages/agentic-sdk-v2/src/utils/errorUtils.ts`
- `packages/agentic-sdk-v2/src/hooks/useAuth.ts`
- `packages/agentic-sdk-v2/src/store/agenticStore.ts`
- All co-located test files under `__tests__/`.

### 6.5 Sanity check — `token=` literal removed

```
$ rg "token=" packages/agentic-sdk-v2/src/core/SSEClient.ts
(no matches)
```

`SSEClient.ts` contains zero references to the legacy `?token=` URL pattern.

---

## 7. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | Agent A2 (TASK-264) | Initial implementation: SSE ticket auth, error codes, impersonation token relocation. |
| 2026-05-23 | Agent A2 (TASK-264) | Completed W0-1 (`SSEClient` ticket fetch + URL rewrite), W0-3 (impersonation token relocated to `AgenticClient` WeakMap), W0-11 (FORBIDDEN/RATE_LIMITED error codes), W2-1 (listener leak fix + 50-cycle regression test). 184/184 tests in scope green; build/lint clean. Marked **Completed**. |

---

## 8. Follow-up / Coordination Tickets

| Item | Owner | Notes |
|---|---|---|
| `useConsultationJob.ts` — migrate `new SSEClient(logger)` → `new SSEClient('consultation-jobs', apiClient, logger)` and `await sseClient.connect(...)` if you need ticket-fetch errors at the call site. | **A3 / A5** | Currently the legacy constructor compiles but surfaces a deterministic `NOT_INITIALIZED` error via `onError` when `connect()` runs. |
| `core/constants.ts` — add `AUTH_ENDPOINTS.STREAM_TICKET = '/auth/stream-ticket'`; update `SSEClient` to consume it. | **A3** | SSEClient currently inlines the path as `const TICKET_ENDPOINT`. |
| `/auth/stream-ticket` controller / DTO. | **A1** | SDK is mock-tested; backend route must land before production. |
| Update `useConsultationJob.test.ts` to drop the `authToken: 'test-jwt-token'` assertion. | **A3 / A5** | Once `useConsultationJob` is migrated, the option no longer flows through. |

