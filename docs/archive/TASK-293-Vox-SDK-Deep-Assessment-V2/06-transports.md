# 06 — Transports (HTTP, SSE, WebSocket, WebRTC)

**Reviewer**: A6  **Status**: Review  **Updated**: 2026-05-24
**Scope**: SDK transports (`packages/agentic-sdk-v2/`) and backend ingress (`apps/api/`).

## 1. Method

Static read of SDK transport modules + backend gateways/controllers. Cross-checked against TASK-262 §SEC-A, §H-1/S-1; TASK-274 stream-ticket contract; TASK-280 cross-tab HMAC scope. WebRTC presence verified via repo-wide grep (`RTCPeerConnection`, `RTCDataChannel`, `mediasoup`, `livekit`, `WebRTCAdapter`).

## 2. Transport matrix

| Transport | Purpose | SDK file | Backend file | Auth (today) | Reconnect | Backpressure | Status |
|---|---|---|---|---|---|---|---|
| HTTP | REST API (CRUD, ticket mint, session create) | `AgenticClient.ts` | `apps/api/src/modules/**/*.controller.ts` | `Authorization: Bearer` + `X-Tenant-ID` (header), 401→`/auth/refresh` | n/a (per-request `AbortController`) | Implicit (`fetch`) | OK with caveats |
| SSE | Async job updates (consultation jobs, DNA, transcription) + SMR streaming | `SSEClient.ts`, `SharedConnectionWorker.ts`, `SharedConnectionManager.ts` | `consultation-job.controller.ts`, `dna-writing-style*.controller.ts`, `transcription-job.controller.ts`, `smr-proxy.controller.ts` | `?ticket=<single-use>` (TASK-274) on `consultation-job` only; **all other SSE endpoints expect `Authorization` header which `EventSource` cannot send** | Bounded exp+jitter (cap 30 s, 10 attempts) | None (server→client only) | **Broken on 4 of 5 producers** |
| WebSocket | STT audio streaming | `SttWebSocketClient.ts`, `StreamingSessionManager.ts` | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | **NONE — `sessionId` only; gateway does not validate JWT/ticket/tenant** | Bounded exp+jitter (cap 30 s, 5 attempts) | Implicit (UA buffering); no `bufferedAmount` checks; mic frames sent unconditionally | **CRITICAL — unauth** |
| WebRTC | (none) | — | — | — | — | — | **ABSENT** — verified by grep of `RTCPeerConnection`, `RTCDataChannel`, `mediasoup`, `livekit`, `WebRTCAdapter` across `packages/`, `apps/`. Only matches were `pnpm-lock.yaml` and `knowledge/room/README.md` (a doc reference). |

## 3. HTTP

`AgenticClient` is the sole HTTP surface. It uses native `fetch`, attaches `Authorization`, `X-API-Key`, `X-Tenant-ID`, `X-Request-ID`, `X-Correlation-ID`, `traceparent`. 401 triggers a single deduplicated refresh via `setOnUnauthorized()` + `AUTH_REFRESH_ENDPOINT`; refresh failures fall through to throw. Errors are mapped through `classifyHttpError` to typed `AgenticError`. Per-request `AbortController` plus client-wide `timeout` (default `DEFAULT_TIMEOUT`) and optional client-side rate-limit (sliding window). Impersonation token is held in a module-level `WeakMap`, not a field — confirms TASK-264 W0-3 properly applied (`AgenticClient.ts:30,760-802`).

Defects:

| ID | File:line | Severity | Issue |
|---|---|---|---|
| H-HTTP-1 | `AgenticClient.ts:243` | High | 401-refresh skip-list checks `endpoint.includes('/auth/refresh')` but **does not** skip `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate`. A 401 on any of those still triggers a refresh attempt — wasted RPC and confusing logs; refresh on `stream-ticket` after JWT expiry will mint a fresh JWT, then *retry* mint, hiding genuine ticket failures. |
| M-HTTP-2 | `AgenticClient.ts:215` | Medium | Error-body parsed via `response.json().catch(() => ({}))` then concatenated into `errorMessage`. If the body is HTML (proxy 502) the catch swallows it — caller gets `"HTTP 502: Bad Gateway"` with no upstream context. |
| M-HTTP-3 | `AgenticClient.ts:393-501` | Medium | `postFormData` lacks the 401-refresh path that `request<T>` has — uploads after token expiry hard-fail instead of refreshing+retrying. |
| L-HTTP-4 | `AgenticClient.ts:75` | Low | `requestTimestamps` array grows without `.shift()`; filter rebuild on every call is O(n) but unbounded if called many times within `windowMs`. Trivial; flag for future. |

## 4. SSE

`SSEClient` (TASK-264 W0-1, W2-1): per-connect mints `?ticket=<base64url>` from `POST /auth/stream-ticket`, listener Map prevents accumulation across reconnects, exp+jitter bounded reconnect (`maxAttempts` default 10, `maxDelayMs` default 30 s, jitter ≤ 50 % of delay) (`SSEClient.ts:300-344`). Backend ticket guard reconstructs expected scope as `${namespace}:${param}` and only allows tickets on `@StreamScope`-decorated routes (`jwtauth.guard.ts:78-106`).

The implementation of `SSEClient` itself is sound. The transport-system around it is not.

Defects:

| ID | File:line | Severity | Issue |
|---|---|---|---|
| C-SSE-1 | `SharedConnectionWorker.ts:99-102`, `SharedConnectionManager.ts:363-366` | **Critical** | **SEC-A regression**: both the SharedWorker and the direct-fallback path still append `?token=<jwt>` when a `subscription.authToken` is provided. Any caller that uses `SharedConnectionManager.subscribeSSE` puts the long-lived JWT in the URL — the exact pattern TASK-274 was meant to eliminate. The `SSEClient` migration did not extend to `SharedConnectionManager`. No callers detected today, but the API is exported and reachable. |
| C-SSE-2 | `useConsultationJob.ts:20,110`, `consultation-job.controller.ts:62` | **Critical** | **D-2 scope mismatch** (cf. `07-summary-with-dna.md`): SDK scope is the literal `'consultation-jobs'`; guard expects `'consultation_job:<jobId>'`. `EventSource` cannot send `Authorization`, so the ticket path is the *only* path — all consultation-job SSE streams 401. |
| H-SSE-3 | `transcription-job.controller.ts:306-307`, `dna-writing-style.controller.ts:131-132`, `dna-writing-style-admin.controller.ts:104` | High | `@Sse()` routes guarded by JWT `@Authorize()` but **no `@StreamScope`**. Because `EventSource` cannot send `Authorization`, browsers cannot open these streams at all. They are reachable only via server-side proxy or `fetch`-based polyfill. No SDK consumer exists. |
| H-SSE-4 | `smr-proxy.controller.ts:361-441` | High | Backend SSE pass-through to SMR; same problem — JWT-guarded, no ticket. SDK's only consumer is `apps/ui-playground/.../sse-transcript-summary-demo.tsx`, which presumably uses `fetch` not `EventSource`. |
| H-SSE-5 | `SharedConnectionWorker.ts:99-141` | High | SharedWorker SSE `EventSource` is *de-duplicated by `id` only*. Two tabs that share a job id share one upstream connection, but the **first subscriber's URL (with its embedded token) is reused for everyone**. Different tabs, different users, same `id` → token-cross-contamination. |
| M-SSE-6 | `SharedConnectionWorker.ts:227,289-297` | Medium | Tab-disconnect detection relies only on `port.onmessageerror`, which fires on bad-message deserialisation — *not* on tab close. Closed tabs leave their `MessagePort` in `allPorts` and `subscribers` until the next `postMessage` throws. Result: `tabCount` is wrong; idle SSE/WS connections persist until the worker itself is GC'd. |
| M-SSE-7 | `SSEClient.ts:300-344` | Medium | Reconnect refetches ticket on every attempt (correct) but never invalidates the cached `eventSource` listener Map until `closeEventSource()` runs inside the timer — narrow race on rapid `disconnect()` followed by `connect()`. Caller test exists; severity Medium. |

## 5. WebSocket

`SttWebSocketClient` is the only WS client. It accepts `WsConnectOptions{timeoutMs}`, `WsReconnectOptions{enabled,maxAttempts=5,baseDelayMs=1000,maxDelayMs=30000}`, exp+jitter (≤50 %), bounded attempts. `acknowledgeConnection()` resets the counter once the server proves liveness. `binaryType='arraybuffer'`. URL is logged with query params stripped (`stripQueryParams`, `:421-428`).

`StreamingSessionManager.getWebSocketUrl()` (`:131-157`) builds `wss://host${wsUrl}?sessionId=...` and explicitly **does not** include the JWT — comments claim "Callers should send the token as the first WebSocket message".

Backend gateway `SttWsGateway` (`stt-ws.gateway.ts`):
- `handleConnection` reads `sessionId` from query, fails if missing, **does not validate JWT, ticket, or tenant** (`:29-50`).
- `handleMessage` switch handles only `audio`, `stop`, `close` — **no `auth` case** (`:147-174`). The "send token as first message" contract is one-sided documentation.
- Result subscription is started immediately on connect (`:62-89`).

Defects:

| ID | File:line | Severity | Issue |
|---|---|---|---|
| C-WS-1 | `stt-ws.gateway.ts:29-50` | **Critical** | **WS gateway is unauthenticated.** The H-1/S-1 finding from TASK-262 is unmitigated. Any client that knows or guesses a `sessionId` can attach to the live transcript stream and inject audio frames. There is no JWT verification, no ticket consumption, no tenant binding, no per-session ownership check. |
| C-WS-2 | `stt-ws.gateway.ts:147-174` | **Critical** | The auth-as-first-message contract documented in `StreamingSessionManager.ts:135-138` is not implemented server-side; the gateway returns `UNKNOWN_TYPE` for `{type:'auth'}`. Even a well-meaning SDK update cannot fix the auth gap without a backend change. |
| C-WS-3 | `SttWebSocketClient.ts:175-230` | **Critical** | Client never sends an `auth` message at all. The contract is unimplemented on both ends. |
| H-WS-4 | `stt-ws.gateway.ts:38-50` | High | No tenant isolation: `SessionInfo` does not record `tenantId`, `userId`, or `consultationId`. Cross-tenant session-id collisions or misuse are not detectable. |
| H-WS-5 | `stt-ws.gateway.ts:62-87` | High | Result subscription is created before any auth check. If C-WS-1 is ever fixed, the bridge subscription must move *after* auth or PHI streams to unauth clients during the validation window. |
| M-WS-6 | `SttWebSocketClient.ts:235-258` | Medium | Audio sends do not check `bufferedAmount`. A slow server lets the UA's send buffer grow unbounded — memory pressure on long sessions. No drop policy, no high-water-mark backpressure event. |
| M-WS-7 | `SttWebSocketClient.ts:202-224` | Medium | `intentionalDisconnect=true` is set in `disconnect()` but `ws.onclose=null` clears the close handler before the close event fires; the disconnect callback is invoked synchronously — fine in practice, but the `wasConnected` guard (`:204`) is now unreachable after `disconnect()` because `ws` is nulled first. Cleanup is correct; the dead code path is misleading. |
| M-WS-8 | `SharedConnectionWorker.ts:155-200` | Medium | The shared-worker WS path **never sends an auth message**, has no awareness of TASK-274 tickets, and would inherit C-WS-1 if anyone routed STT through it. Currently no SDK caller wires WS through the worker; document scope explicitly. |
| L-WS-9 | `SttWebSocketClient.ts:341-344` | Low | `acknowledgeConnection()` is only callable by SDK callers — no internal trigger on first transcript. Counter resets only when consumer remembers; default is "every reconnect counts forever". |

## 6. WebRTC

**ABSENT** — verified by repo-wide `rg` of `RTCPeerConnection`, `RTCDataChannel`, `mediasoup`, `livekit`, `WebRTCAdapter`. Only matches: `pnpm-lock.yaml` and `knowledge/room/README.md` (descriptive prose, no code). `packages/room/` provides AudioContext-based pipeline, not WebRTC. There is no peer connection, no SDP/ICE, no TURN/STUN configuration.

**Recommendation**: keep WebRTC out of scope for the current architecture. STT is server-side via Whisper/WS; there is no peer-to-peer requirement, no echo-cancellation that needs `RTCPeerConnection`'s built-in DSP, no multi-party consultation today. Adding WebRTC would introduce TURN/STUN ops, ICE candidate handling, SRTP key management, and a much larger HIPAA threat surface. If a future remote-clinician feature is planned, evaluate LiveKit / mediasoup *then*; do not pre-build.

## 7. Cross-cutting Critical / High defects

- **C-WS-1, C-WS-2, C-WS-3** (`stt-ws.gateway.ts:29-50,147-174`; `SttWebSocketClient.ts:175-230`): unauth WS — entire STT streaming path lacks JWT/ticket/tenant binding; auth-as-first-message contract is one-sided documentation, neither side implements it.
- **C-SSE-1** (`SharedConnectionWorker.ts:99-102`; `SharedConnectionManager.ts:363-366`): `?token=<jwt>` query-string regression in SharedWorker SSE — re-introduces SEC-A in any consumer that uses the connection multiplexer.
- **C-SSE-2** (`useConsultationJob.ts:20,110`): SDK ticket scope `'consultation-jobs'` ≠ guard expectation `'consultation_job:<jobId>'`; **all** consultation-job SSE streams 401 (already documented as D-2 in `07-summary-with-dna.md`).
- **H-SSE-3** (`transcription-job.controller.ts:306`, `dna-writing-style*.controller.ts`): `@Sse()` routes without `@StreamScope` cannot be opened by browser `EventSource` — JWT header is unreachable. Effectively dead endpoints from SDK perspective.
- **H-SSE-5** (`SharedConnectionWorker.ts:99-141`): SSE de-dup by `id` only causes per-tab token reuse — first tab's JWT services every later subscriber on the same id.
- **H-WS-4** (`stt-ws.gateway.ts:38-50`): No tenant binding stored in `SessionInfo` — even if C-WS-1 is fixed, cross-tenant sessionId mixups remain undetectable.

## 8. Security findings

| Concern | Status | Notes |
|---|---|---|
| PHI in URL query | **Partially regressed** | `SSEClient` is clean (TASK-274). `SharedConnectionWorker`/`SharedConnectionManager` still append `?token=<jwt>` (C-SSE-1). `StreamingSessionManager.getWebSocketUrl()` is clean (sessionId only). |
| PHI in logs | OK | `SttWebSocketClient.stripQueryParams` (`:421-428`); `AgenticClient` logs `endpoint`, not `url`. Transcript debug entries pass through `SDKLogger.debug` with `redactPHI` (`SttWebSocketClient.ts:32-42`). |
| Replay | **Partial** | Stream tickets are single-use, 30 s TTL (`stream-ticket.service.ts:25-101`). WS `sessionId` is *not* single-use and *not* TTL-bound — anyone with the ID can re-attach (C-WS-1). |
| MITM | OK if HTTPS | `wss:`/`https:` selected from `apiClient.getBaseUrl().protocol`; assumes deployment uses TLS. |
| Tenant isolation | **Broken on WS, partial on SSE** | HTTP injects `X-Tenant-ID` (verified by ContextInterceptor per `08-api-cross-reference.md §3.4`). SSE ticket carries `tenantId`. WS `SessionInfo` carries no tenant — H-WS-4. |
| TASK-280 cross-tab HMAC scope | **Confirmed scoped** | HMAC sign/verify wired only into `SimpleCrossTabSync` (BroadcastChannel envelopes). `SharedConnectionWorker` does NOT sign tab-to-tab connection-multiplex messages — all `port.postMessage` payloads are unsigned. Acceptable for SSE/WS event fan-out, but documented gap. |

## 9. Test coverage gaps

| Surface | Existing | Missing |
|---|---|---|
| `SSEClient` | Unit, leak, ticket | Reconnect-after-ticket-expiry race; concurrent `disconnect()`+`connect()` |
| `SttWebSocketClient` | Unit, basic reconnect | bufferedAmount backpressure; partial frame on disconnect; no test asserting auth message is *required* |
| `stt-ws.gateway.ts` | Unit (counts) | **No auth tests** — C-WS-1 has no negative test; gateway accepts arbitrary sessionIds |
| `SharedConnectionWorker` | None visible | Token-leak-across-tabs (H-SSE-5); tab-close → connection cleanup (M-SSE-6); SEC-A regression (C-SSE-1) |
| `SharedConnectionManager` | None visible | Fallback `?token=` regression (C-SSE-1) |
| `JwtAuthGuard` ticket path | Unit | E2E SDK→backend ticket round-trip with current SDK scope (would fail and surface C-SSE-2) |

## 10. Conformance to business requirement

| Transport | Verdict |
|---|---|
| HTTP | **Conforms** — multi-auth, refresh, tracing, impersonation isolation. Minor refresh-skip-list gap. |
| SSE | **Does not conform** — only `consultation-job` route is ticket-aware backend-side, but SDK scope mismatch (C-SSE-2) breaks even that one. Other producers cannot be opened from a browser. |
| WebSocket | **Does not conform** — `H-1/S-1` (TASK-262) is unmitigated. WS gateway is unauthenticated. |
| WebRTC | **Not required** — explicitly absent; recommend keeping out of scope. |

## 11. Recommended fixes

**P0 (block release):**
- Fix WS gateway auth: extend `JwtAuthGuard` (or a sibling `WsTicketGuard`) to consume a `?ticket=` from the upgrade request, scope-bind to `stt_session:<sessionId>`, populate `request.user`+`tenantId`, and store on `SessionInfo`. SDK: mint a ticket per WS connect via `apiClient.post('/auth/stream-ticket',{scope:`stt_session:${sessionId}`})` and append `?ticket=...` in `StreamingSessionManager.getWebSocketUrl()`. Tests: negative-auth e2e on `/ws/stt/stream`. (C-WS-1/2/3, H-WS-4, H-WS-5.)
- Remove `?token=` paths from `SharedConnectionWorker.ts:99-102` and `SharedConnectionManager.ts:363-366`; require ticket-mint at the SDK boundary before `subscribeSSE`. (C-SSE-1.)
- Change `useConsultationJob.ts:20` to `scopeFor(jobId) = `consultation_job:${jobId}``; pass to `new SSEClient(scopeFor(jobId), …)`. (C-SSE-2.)

**P1 (next sprint):**
- Add `@StreamScope` (or equivalent ticket support) to `transcription-job`, `dna-writing-style`, `dna-writing-style-admin`, and `smr-proxy` SSE routes — or remove `@Sse()` and switch to a fetch-based stream readable from the SDK. (H-SSE-3, H-SSE-4.)
- De-dup SSE in `SharedConnectionWorker` by `(id, userId)` not `id` alone; refuse to share an upstream connection across distinct tickets. (H-SSE-5.)
- Skip refresh on `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate` 401s in `AgenticClient.ts:243`. (H-HTTP-1.)
- Add `bufferedAmount` watermark with drop or pause policy in `SttWebSocketClient.sendAudioFrame*`. (M-WS-6.)
- Implement real tab-disconnect detection in `SharedConnectionWorker` via heartbeat ping/pong with timeout. (M-SSE-6.)

**P2 (hygiene):**
- Auto-call `acknowledgeConnection()` on first transcript arrival. (L-WS-9.)
- Bound `requestTimestamps` array length. (L-HTTP-4.)
- Mirror 401-refresh into `postFormData`/`uploadFormData`. (M-HTTP-3.)
- Move bridge subscription in `stt-ws.gateway.ts` to *after* auth. (H-WS-5, prerequisite of P0.)

## 12. Per-transport scorecard

| | Architecture | Correctness | Security | Performance | Test coverage | Conformance |
|---|---|---|---|---|---|---|
| **HTTP** | 4 | 4 | 4 | 4 | 4 | 4 |
| **SSE** | 3 | 2 | 1 | 3 | 3 | 1 |
| **WebSocket** | 3 | 3 | **0** | 3 | 2 | **0** |
| **WebRTC** | n/a | n/a | n/a | n/a | n/a | n/a (absent — acceptable) |

Scale: 0 = absent/broken, 1 = critical gaps, 2 = significant gaps, 3 = adequate, 4 = strong, 5 = exemplary.
