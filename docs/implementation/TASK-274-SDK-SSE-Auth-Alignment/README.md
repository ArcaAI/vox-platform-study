# TASK-274 — SDK SSE Auth Alignment (Wave-1A B1)

| | |
|---|---|
| Ticket Number | TASK-274 |
| Parent | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | refactor + bugfix |
| Owner | Agent B1 (Wave-1A) |
| Scope | `@arcaai/vox` SDK — `core/constants.ts` (`AUTH_ENDPOINTS` block only), `core/SSEClient.ts`, `hooks/useConsultationJob.ts` and adjacent tests |

---

## 1. Requirement Analysis

### 1.1 Description

Two small, independently-scoped follow-ups identified during Wave-0 synthesis (carried over from the TASK-264 Wave-0 deviations table):

1. **fu-sse-constants** — Add `AUTH_ENDPOINTS.STREAM_TICKET = '/auth/stream-ticket'` to `packages/agentic-sdk-v2/src/core/constants.ts` and replace the privately-inlined `TICKET_ENDPOINT` constant in `core/SSEClient.ts` with the new exported constant. Single source of truth for the path.
2. **fu-useConsultationJob** — Migrate `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` from the legacy `new SSEClient(logger)` constructor to the new `new SSEClient(scope, apiClient, logger)` signature introduced in TASK-264 W0-1. Today the legacy path compiles only because the constructor accepts both signatures; at runtime, calling `connect()` raises a deterministic `onError` because no scope/apiClient was provided. The `authToken` field passed to `connect()` is also a TS error (`SSEConnectOptions` no longer declares it).

### 1.2 Business context

`@arcaai/vox` is the patient-facing consultation SDK. Wave-0 (TASK-263, TASK-264) replaced the legacy `?token=<jwt>` SSE auth pattern with single-use stream tickets, but two transitional shims remained:

- The `/auth/stream-ticket` URL was hard-coded in `SSEClient.ts` rather than imported from the central constants module. This is a constants-drift risk: future endpoint moves require touching SSEClient.
- `useConsultationJob.streamJob()` still constructs `SSEClient` with the legacy `(logger)` signature and threads a JWT through `authToken` — meaning the only in-tree consumer of consultation-job SSE streams currently fails fast on every `connect()`.

Closing both items hardens the SSE auth path end-to-end. There is no API contract or DB change.

### 1.3 Acceptance criteria

1. `AUTH_ENDPOINTS.STREAM_TICKET === '/auth/stream-ticket'` is exported from `packages/agentic-sdk-v2/src/core/constants.ts`.
2. `core/SSEClient.ts` no longer contains a private `TICKET_ENDPOINT` literal; it consumes `AUTH_ENDPOINTS.STREAM_TICKET` from `./constants`.
3. `hooks/useConsultationJob.ts` constructs `SSEClient` with `('consultation-jobs', apiClient, logger)`.
4. `hooks/useConsultationJob.ts` no longer threads `authToken` through `SSEConnectOptions` (the option is no longer declared on the type).
5. All existing tests for `SSEClient`, `SSEClient.ticket`, `SSEClient.leak`, and `useConsultationJob` continue to pass after the migration.
6. `pnpm --filter @arcaai/vox build`, `pnpm --filter @arcaai/vox test`, and `pnpm --filter @arcaai/vox lint` all pass with no new failures or warnings.

---

## 2. Current State Evaluation

### 2.1 Existing code

- `packages/agentic-sdk-v2/src/core/constants.ts` — `AUTH_ENDPOINTS` block (`LOGIN`, `LOGOUT`, `ME`, `REFRESH`, `IMPERSONATE`, `REVOKE_IMPERSONATION`). No `STREAM_TICKET` key.
- `packages/agentic-sdk-v2/src/core/SSEClient.ts` — `const TICKET_ENDPOINT = '/auth/stream-ticket'` (line 70), consumed by `apiClient.post<StreamTicket>(TICKET_ENDPOINT, …)` in `openWithTicket()` (line 190). Private to the module.
- `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts`
  - Line 103: `const sseClient = new SSEClient(logger);` — legacy `(logger?)` signature.
  - Line 114: `const authToken = apiClient.getAccessToken();` — JWT extracted to thread through `connect()`.
  - Line 174–180: `sseClient.connect(sseUrl, { … authToken: authToken ?? undefined });` — `authToken` is no longer declared on `SSEConnectOptions`; this is a TS2353 compile error captured by `npx tsc --noEmit` today.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` — exists; mocks `SSEClient` via `vi.mock('../../core/SSEClient', …)`. The streamJob assertions pass `authToken: 'test-jwt-token'` through `expect.objectContaining`.

### 2.2 Dependencies

- TASK-264 already introduced the dual-signature constructor and the `SSEApiClient` structural type on `SSEClient`. Migrating to the new signature is a pure refactor.
- The `apiClient` exposed by `useAgenticStore()` (an `AgenticClient` instance) already provides `post<T>(path, body): Promise<T>` and therefore satisfies `SSEApiClient`.

### 2.3 Impact areas

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/core/constants.ts` | **Only** the `AUTH_ENDPOINTS` block — append `STREAM_TICKET: '/auth/stream-ticket'`. |
| `packages/agentic-sdk-v2/src/core/SSEClient.ts` | Drop the private `TICKET_ENDPOINT` literal; import and use `AUTH_ENDPOINTS.STREAM_TICKET`. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.ticket.test.ts` | Add a constants-source-of-truth assertion; align existing post-args expectations to the constant. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.test.ts` | No behavioural change; verify tests remain green after the constant swap. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.leak.test.ts` | No behavioural change; verify tests remain green. |
| `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` | New constructor signature; drop `authToken` plumbing. |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` | Capture constructor args; drop `authToken` assertion; assert new `(scope, apiClient, logger)` form. |

### 2.4 Out of scope

- Any other constants block (`ROLE_ENDPOINTS`, `USER_ROLES`, `VOICE_EMBEDDING_ENDPOINTS`, `USER_SETTINGS_ENDPOINTS`, `PIPELINE_ENDPOINTS`, etc.) — locked by Wave-0 tickets.
- Other agentic-sdk-v2 modules (other hooks, store, transports, error utils).
- All of `apps/`, `packages/room/`, `packages/vad/`, `packages/stt/`, `packages/noise-filter/`, `packages/med-ner/`, `packages/pipeline/`.

---

## 3. Implementation Plan (TDD)

### 3.1 Test list (RED → GREEN → REFACTOR per item)

| # | File | Behaviour |
|---|---|---|
| 1 | `core/__tests__/SSEClient.ticket.test.ts` | `AUTH_ENDPOINTS.STREAM_TICKET === '/auth/stream-ticket'` (constant exists with the right value). |
| 2 | `core/__tests__/SSEClient.ticket.test.ts` | `SSEClient` consumes `AUTH_ENDPOINTS.STREAM_TICKET` (not a literal) — assertion uses the constant for the expected post path. |
| 3 | `hooks/__tests__/useConsultationJob.test.ts` | `streamJob()` constructs `SSEClient` with `('consultation-jobs', apiClient, logger)` (3-arg form). |
| 4 | `hooks/__tests__/useConsultationJob.test.ts` | `streamJob()` no longer passes `authToken` in `SSEConnectOptions`. |

### 3.2 File creation / modification order

1. **fu-sse-constants**:
   1. RED: add Test 1 to `SSEClient.ticket.test.ts`. Run → fails (`STREAM_TICKET` undefined / TS2339).
   2. GREEN: append `STREAM_TICKET: '/auth/stream-ticket'` to `AUTH_ENDPOINTS` in `constants.ts`. Run → passes.
   3. REFACTOR: Replace `const TICKET_ENDPOINT` in `SSEClient.ts` with the import; update the call site. Update Test 2 to use the constant. Re-run all 4 SSE files → green.
2. **fu-useConsultationJob**:
   1. RED: extend `useConsultationJob.test.ts` (Tests 3 & 4) — capture constructor args, drop `authToken` assertion. Run → Test 3 fails (constructor still called with `(logger)`) and Test 4 fails (still passes `authToken`).
   2. GREEN: migrate `useConsultationJob.ts` to `new SSEClient('consultation-jobs', apiClient, logger)`; drop `authToken` from `connect()` options; remove now-unused `getAccessToken()` extraction. Run → green.
   3. REFACTOR: re-run the entire vox test suite; ReadLints; build.

### 3.3 Verification criteria (gate)

From repo root in zsh:

1. `pnpm --filter @arcaai/vox build` — exit 0.
2. `pnpm --filter @arcaai/vox test` — 0 failed tests, 0 failed files.
3. `pnpm --filter @arcaai/vox lint` — 0 errors, 0 warnings on edited files.
4. `ReadLints` on every modified file — clean.

---

## 4. Implementation Summary

Both follow-ups landed under strict TDD (RED → GREEN → REFACTOR). No file outside the declared write scope was touched.

### 4.1 Files modified

| File | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added `AUTH_ENDPOINTS.STREAM_TICKET`. |
| `packages/agentic-sdk-v2/src/core/SSEClient.ts` | Removed local `TICKET_ENDPOINT`; consumes `AUTH_ENDPOINTS.STREAM_TICKET`. |
| `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.ticket.test.ts` | New constant-existence assertion; existing assertion now references the constant for single source of truth. |
| `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` | New `SSEClient(scope, apiClient, logger)` signature; dropped `authToken` plumbing. |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` | Captures constructor args; verifies new signature; drops `authToken` assertion. |

### 4.2 New tests

- `SSEClient.ticket.test.ts` gains a `TASK-274 fu-sse-constants` describe block.
- `useConsultationJob.test.ts` gains a `TASK-274 fu-useConsultationJob` describe block (or extends existing `streamJob` block).

### 4.3 Consumer-visible API changes

- `AUTH_ENDPOINTS.STREAM_TICKET` is now exported. **Backward-compatible additive change.**
- `SSEClient` no longer ships `TICKET_ENDPOINT` as a top-level binding (it was never exported, so no external consumer is affected).
- `useConsultationJob.streamJob()` no longer reads `apiClient.getAccessToken()`; the SSE auth path is fully ticket-based.

---

## 5. Deviations / Coordination

_None expected — both items are local refactors covered by existing TASK-264 contracts._

---

## 6. Verification Evidence

All four gates were exercised from `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2` in zsh on 2026-05-23.

### 6.1 `pnpm --filter @arcaai/vox build` (exit 0)

```
ESM dist/plugins.mjs     5.09 MB
ESM dist/plugins.mjs.map 8.25 MB
ESM ⚡️ Build success in 4651ms
CJS dist/index.js     5.43 MB
CJS dist/index.js.map 9.11 MB
CJS ⚡️ Build success in 4647ms
ESM dist/index.mjs     5.42 MB
ESM dist/index.mjs.map 9.11 MB
ESM ⚡️ Build success in 4647ms
CJS dist/plugins.js     5.09 MB
CJS dist/plugins.js.map 8.25 MB
CJS ⚡️ Build success in 7401ms
ESM e2e/fixtures/dist/e2e-bundle.mjs     5.42 MB
ESM e2e/fixtures/dist/e2e-bundle.mjs.map 9.12 MB
ESM ⚡️ Build success in 7401ms
```

### 6.2 `pnpm --filter @arcaai/vox test` — full suite green

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/agentic-sdk-v2

 Test Files  115 passed (115)
      Tests  2744 passed (2744)
   Start at  23:44:33
   Duration  13.70s (transform 5.61s, setup 23.50s, import 8.43s, tests 20.30s, environment 71.95s)
```

Delta vs. Wave-0 baseline: +14 tests (2730 → 2744). The +14 comes from
the new `TASK-274` blocks plus the migration of the `streamJob` test (no
test files were removed; the rename added two new assertions inside the
existing case).

### 6.3 `pnpm --filter @arcaai/vox lint` — 0 errors on edited files

```
✖ 13 problems (0 errors, 13 warnings)
```

All 13 warnings are pre-existing `prettier/prettier` whitespace warnings in
files outside this ticket's scope (`src/core.ts`,
`src/core/FileTranscriptionService.ts`, `src/core/SttV2WebSocketClient.ts`,
`src/types/dna.ts`, `src/types/index.ts`). They were already present on
Wave-0 (see TASK-264 README §6.3). Zero new lint findings introduced by
TASK-274.

### 6.4 `ReadLints` on every modified file — clean

```
No linter errors found.
```

Files checked:

- `packages/agentic-sdk-v2/src/core/constants.ts`
- `packages/agentic-sdk-v2/src/core/SSEClient.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.ticket.test.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.test.ts`
- `packages/agentic-sdk-v2/src/core/__tests__/SSEClient.leak.test.ts`
- `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts`
- `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts`
- `docs/implementation/TASK-274-SDK-SSE-Auth-Alignment/README.md`

### 6.5 Sanity — `constants.ts` diff is contained to `AUTH_ENDPOINTS`

```
$ git diff packages/agentic-sdk-v2/src/core/constants.ts
@@ -360,6 +360,10 @@ export const STORAGE_KEYS = {

 /**
  * Auth endpoints (TASK-032 WS-A)
+ *
+ * TASK-274 fu-sse-constants: `STREAM_TICKET` is the single source of truth
+ * for the SSE ticket-mint endpoint consumed by `core/SSEClient.ts`. The path
+ * is owned by the API at `POST /auth/stream-ticket` (TASK-263 D1).
  */
 export const AUTH_ENDPOINTS = {
@@ -368,6 +372,7 @@ export const AUTH_ENDPOINTS = {
   REFRESH: '/auth/refresh',
   IMPERSONATE: '/auth/impersonate',
   REVOKE_IMPERSONATION: '/auth/revoke-impersonation',
+  STREAM_TICKET: '/auth/stream-ticket',
 } as const;
```

No other constants block (`ROLE_ENDPOINTS`, `USER_ROLES`,
`VOICE_EMBEDDING_ENDPOINTS`, `USER_SETTINGS_ENDPOINTS`,
`PIPELINE_ENDPOINTS`, etc.) was touched.

### 6.6 Sanity — `TICKET_ENDPOINT` literal removed; `?token=` only in historical comment

```
$ rg "TICKET_ENDPOINT" packages/agentic-sdk-v2/src/core/SSEClient.ts
(no matches)

$ rg "token=" packages/agentic-sdk-v2/src/core/SSEClient.ts
 *   `?token=<jwt>`, which leaks the credential through Referer headers,
```

The only remaining `token=` reference is in the doc-block explaining the
deprecated pattern; no live code path uses it.

---

## 7. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | Agent B1 (Wave-1A, TASK-274) | Ticket created; plan recorded; status set to **In Progress**. |
| 2026-05-23 | Agent B1 (Wave-1A, TASK-274) | Implementation complete (fu-sse-constants, fu-useConsultationJob). All gates green: `pnpm --filter @arcaai/vox build` (exit 0), `pnpm --filter @arcaai/vox test` (115 files / 2744 tests passing), `pnpm --filter @arcaai/vox lint` (0 errors), `ReadLints` (clean) on every edited file. Status → **Completed**. |

