# TASK-768 — Downstream-Unreachable Error Contract

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix (public error-contract change) |
| **Branch** | `feat/loop` |
| **Opened** | 2026-08-19 |
| **Surfaces** | `apps/api`, `packages/applications` |
| **Related** | Evidence: `docs/implementation/TASK-764-Pre-Existing-E2e-Failures/README.md` §"Owner decisions / recommendations" item 1 |

> **Ticket-number note.** This work was commissioned as "TASK-765". `TASK-765` was already
> allocated on 2026-08-18 to **TASK-765-Design-System-Conformance** (status *In Progress*,
> untracked in git, owned by a concurrent sibling). `TASK-766` and `TASK-767` are likewise
> concurrently owned (seed data / credential access). Per `00-project-context.md` §Ticket
> Workflow the next free number was taken: **TASK-768**. Rename the folder if the owner's
> ledger says otherwise — nothing outside this folder cites the number.

## Requirement Analysis

Two owner requirements (2026-08-18):

1. **A downstream-unreachable condition must map to `503`**, not `400` and not an opaque `500`.
2. **The internal host:port must never reach the client.**

### Acceptance criteria

- **AC-1** A transport failure to any Python service (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`,
  `ECONNRESET`, `EAI_AGAIN`, socket hang up, DNS) surfaces as **`503 Service Unavailable`**.
  A transport failure may never surface as `4xx`.
- **AC-2** No client-facing error body contains a host, a port, an IPv4/IPv6 literal, an errno,
  an internal service name, a file path or a stack frame.
- **AC-3** The client-facing body is **built in exactly one place**. No call site composes a
  client-facing message out of a caught error.
- **AC-4** The operator gets the full cause (host, port, errno, upstream status) in the
  server-side log, keyed by the same `correlationId` the client received.
- **AC-5** Every `503` carries a `Retry-After` header with a small integer seconds value.
- **AC-6** An upstream **5xx** maps to `502 Bad Gateway`; an upstream **4xx** propagates that
  status with a sanitized body.
- **AC-7** Streaming/SSE paths that cannot open the upstream stream fail the same way as the
  synchronous call.
- **AC-8** A regression sweep prevents a *new* call site from reintroducing the leak.

### Why 502 for an upstream 5xx, and 503 for transport

The two conditions have different operator meanings and different client actions, so they must
not collapse into one status.

- **Transport failure → `503`.** The gateway never reached the dependency. RFC 9110 §15.6.4:
  the server "is currently unable to handle the request" — and `503` is the only 5xx that RFC
  9110 pairs with `Retry-After`. This is the retry-me case.
- **Upstream responded 5xx → `502`.** The gateway reached the dependency and got an invalid
  response from it (RFC 9110 §15.6.3). Retrying immediately will usually reproduce it, so it
  deliberately carries no `Retry-After`. Alerting can then separate "dependency down" from
  "dependency erroring" on status alone, without parsing bodies.

## Current State Evaluation

### The evidence, reproduced

`POST /api/v1/admin/prompt-templates/:id/test` with `apps/text` down (TASK-764 §1, reproduced
with curl):

```
status=400
{"message":"Failed to call SMR service: AggregateError: connect ECONNREFUSED ::1:8862;
  connect ECONNREFUSED 127.0.0.1:8862","error":"Bad Request","statusCode":400,
  "correlationId":"01a0155d-21c7-7993-81d3-fe740595897d"}
```

Two defects in one body: the status says the *caller* was wrong when the *dependency* was
absent, and the message hands the caller the internal host and port.

`POST /api/v1/consultations/:id/summary/async` with `apps/harness` down answers an opaque
`500`: `HarnessGatewayService` has **no `catch` at all**, so a raw `AxiosError` escapes to
Nest's default filter. The body does not leak, but the status is wrong — and the same
controller throws `ServiceUnavailableException` one branch away
(`consultation.controller.ts:1321`).

### Call-site inventory

Found by grepping for `ECONNREFUSED`, `Failed to call`, exception messages interpolating a
caught error, and axios/`response.data` passthrough across `apps/api/src` and
`packages/applications/src` (tests excluded).

**A. Leaks the cause string into the client body (the `host:port` leak)**

| # | Site | Was | Defect |
|---|---|---|---|
| A1 | `packages/applications/src/services/consultation/summary/summary.service.ts:1543` | `BadRequestException(\`Failed to call SMR service: ${primaryError}\`)` | 400 + host:port |
| A2 | `packages/applications/src/services/consultation/summary/summary.service.ts:1824` | `BadRequestException(\`Failed to call NLP service: ${error}\`)` | 400 + host:port |
| A3 | `packages/applications/src/services/prompt-management/prompt-management.service.ts:1313` | `BadRequestException(\`Failed to call SMR service: ${error}\`)` | 400 + host:port |
| A4 | `packages/applications/src/services/prompt-management/prompt-management.service.ts:1349` | `BadRequestException(\`Failed to call SMR service: ${error}\`)` | 400 + host:port |
| A5 | `apps/api/src/modules/ai-inference/ai-inference.client.ts:159` | `ServiceUnavailableException(\`AI inference request failed (${action}): ${message}\`)` | status right, body leaks |
| A6 | `apps/api/src/modules/harness-admin/harness-ops.client.ts:176` | `ServiceUnavailableException(\`Harness ops request failed (${action}): ${message}\`)` | status right, body leaks |
| A7 | `apps/api/src/modules/harness-admin/harness-ops.client.ts:172` | `error.response.data ?? { message: error.message }` | empty upstream body ⇒ leaks axios message |
| A8 | `apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts:128` | `ServiceUnavailableException(\`AI service request failed (${action}): ${message}\`)` | status right, body leaks |
| A9 | `apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts:124` | `error.response.data ?? { message: error.message }` | empty upstream body ⇒ leaks axios message |

**B. Correct body, wrong status**

| # | Site | Was | Defect |
|---|---|---|---|
| B1 | `apps/api/src/modules/streaming/text-proxy.controller.ts:383` (`buildUpstreamException`) | no upstream response ⇒ `502` | transport must be `503` |
| B2 | `apps/api/src/modules/speech/speech-proxy.controller.ts:187` (`buildUpstreamException`) | no upstream response ⇒ `502` | transport must be `503` |
| B3 | `apps/api/src/modules/text-compat/text-compat.controller.ts:1305` (`buildUpstreamFailure`) | unreachable ⇒ `500` | transport must be `503` |

**C. No handling at all — raw `AxiosError` escapes to a generic `500`**

| # | Site | Defect |
|---|---|---|
| C1 | `packages/applications/src/services/consultation/harness/harness-gateway.service.ts` (12 `axiosRef` calls, no `catch`) | opaque `500` for an unreachable harness |
| C2 | any future un-`catch`ed downstream call | same |

C is the reason the fix is **boundary-first**: fixing only the sites we can name leaves C2 open
forever.

### What was already right (kept as precedent)

- `ExceptionInterceptor` (`apps/api/src/interceptors/exception.interceptor.ts`) already is the
  single sanitizing boundary — it does exactly this job for Prisma (full detail to the log,
  `{statusCode, error, correlationId}` to the client). The new mapping joins it rather than
  inventing a second boundary.
- `text-proxy` / `speech-proxy` `buildUpstreamException` and `text-compat`
  `buildUpstreamFailure` already redact the upstream body (it can echo the assembled clinical
  prompt / PHI) and log a redaction sentinel. Only their *status* was wrong.
- `ai-inference.client.ts` `UPSTREAM_ERROR_MESSAGE` already replaces the upstream body with a
  constant.

## Implementation Plan

1. **RED** — write the failing tests first:
   - `apps/api/src/filters/__tests__/downstream-error.test.ts` — cause classification per errno,
     status mapping, capability phrasing, body sanitization, `Retry-After`.
   - `apps/api/src/interceptors/__tests__/exception.interceptor.downstream.test.ts` — a **route
     sweep**: every downstream-facing route × every transport errno through the real
     interceptor, asserting `503` + `Retry-After` + no topology in the body.
   - `apps/api/src/filters/__tests__/downstream-error-leak-sweep.test.ts` — a **source sweep**
     asserting no downstream-facing file composes a client-facing message from a caught error.
2. **GREEN — the boundary.** New `apps/api/src/filters/downstream-error.ts`: pure classifier +
   status map + capability map + body builder + `containsTopology` predicate. Exported from
   `apps/api/src/filters/index.ts`.
3. **GREEN — wire it.** One new branch in `ExceptionInterceptor`, plus a `Retry-After` pass that
   covers any `503` leaving the gateway.
4. **GREEN — call sites.** A1–A4 stop building strings and rethrow the cause (the boundary
   classifies it). A5–A9 drop the interpolated cause from the client body, keeping it in the
   log. B1–B3 take their status from the shared classifier.
5. **Verify** — `pnpm --filter @arcaai/api test`, `pnpm --filter @arcaai/applications test`,
   `pnpm api:build`, lint.

### Not in scope

- `text-compat.controller.ts` `buildGenerationFailure` (`{ detail: "<label> failed: <reason>" }`,
  `500`) — a *parse/mapping* failure, not a transport failure. Its `reason` is an internal
  mapping message, not topology. Left alone deliberately (surgical-change rule).
- The v1-compat **body shapes** of `text-compat` (`{ error, requestId, timestamp }`) — consumed
  by `@arcaai/vox-node`. Only the status changes; the shape is frozen.
- Auth/scope posture on any route (TASK-767 owns that concurrently).

## Implementation Summary

### The boundary (new)

`apps/api/src/filters/downstream-error.ts` — pure, side-effect free, unit-tested directly:

| Export | Role |
|---|---|
| `classifyDownstreamFailure(err)` | cause ⇒ `transport` / `upstream_server_error` / `upstream_client_error` / `null`. Walks `.code`, `.errno`, the `cause` chain, and `AggregateError.errors` (Node's happy-eyeballs dialer produces an `AggregateError` carrying **no** `.code` — the errnos live only on its members, which is exactly the shape the TASK-764 evidence captured), then falls back to a message match for codeless failures (`socket hang up`, `fetch failed`, `getaddrinfo`). |
| `downstreamStatusFor(kind, upstreamStatus?)` | `transport` ⇒ 503 · `upstream_server_error` ⇒ 502 · `upstream_client_error` ⇒ the upstream 4xx. |
| `capabilityForPath(path)` | route ⇒ user-facing capability phrase. Deriving it from the ROUTE means a newly added downstream call is labelled correctly with no cooperation from its author. |
| `buildDownstreamErrorBody(...)` | **the only** client-facing body builder for a downstream failure. |
| `describeCauseForOperator(err)` | the operator's half: errno, host, port, upstream status, nested causes — for the log, never the upstream response BODY (it can echo the assembled clinical prompt). |
| `containsTopology(text)` / `redactTopology(text)` | one shared definition of "leak", used by the code AND by all three test sweeps so they cannot drift apart. |
| `DOWNSTREAM_RETRY_AFTER_SECONDS = 5` | |

`ExceptionInterceptor` (`apps/api/src/interceptors/exception.interceptor.ts`) gained two blocks:

- a downstream branch that runs **last**, only on errors nothing else claimed, and only when the
  error is neither an `HttpException` nor a `BaseException`. That ordering makes it a safety net,
  not an override: a service with a considered mapping keeps it, while a raw `AxiosError` that no
  call site caught — **the `HarnessGatewayService` case (C1), which had no `catch` at all** — now
  lands on 503 without that service knowing this module exists;
- a `Retry-After` pass applied to **every** 503 leaving the gateway, including ones a controller
  raised directly. Without it, whether a client backed off correctly depended on which layer
  happened to notice the outage.

### Public error contract — before ⇒ after (release notes)

| Condition | Before | After |
|---|---|---|
| Downstream **transport** failure (`ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND`/`ECONNRESET`/DNS/socket hang up) on a service route | **400** `{"message":"Failed to call SMR service: … connect ECONNREFUSED 127.0.0.1:8862","error":"Bad Request"}` | **503** `{"statusCode":503,"error":"Service Unavailable","message":"<Capability> is temporarily unavailable. Please retry.","code":"GATEWAY.DOWNSTREAM_UNAVAILABLE","correlationId":"…"}` + `Retry-After: 5` |
| Transport failure with **no** `catch` at the call site (`POST /consultations/:id/summary/async`) | opaque **500** `Internal server error` | **503** `… "message":"Note generation is temporarily unavailable. Please retry."` + `Retry-After: 5` |
| Upstream answered **5xx** | 400 / 500 / 502 depending on the call site | **502** `… "message":"<Capability> returned an invalid response."` (deliberately no `Retry-After`) |
| Upstream answered **4xx** | wrapped as 400, or forwarded with the upstream body | that **4xx**, body sanitized to `"<Capability> rejected the request."` |
| `text-proxy` / `speech-proxy`, no upstream response | **502** `{"detail":"SMR service unavailable"}` | **503**, same body shape |
| `text-compat` (v1), SMR unreachable | **500** `{"error":"SMR service unavailable","requestId","timestamp"}` | **503**, **body shape frozen** (`@arcaai/vox-node` parses it; its `retry.ts:16` already treats any 5xx as retryable, so 503 is strictly better than 500) |
| `base-proxy` on.error (dormant template) | **502**, `detail` = `connect ECONNREFUSED 127.0.0.1:8862` | **503**, `detail` topology-redacted |
| `GET /admin/health/services` (a **200** body) | `error: "connect ECONNREFUSED 127.0.0.1:8862"` | `error: "connect ECONNREFUSED [redacted-address]"` — the errno is a REASON and is kept (it is the point of a health screen); the address is not |
| DNA job SSE `error` frame | relayed the BullMQ `failedReason` verbatim (host:port when the processor's axios call went unwrapped) | topology-redacted |

Capability phrases: `Note generation`, `Summarization`, `Transcription`, `Speech synthesis`,
`AI text analysis`, and `A required downstream capability` as the fallback. None names a host, a
port or an internal service.

### Files changed

**New**
- `apps/api/src/filters/downstream-error.ts`
- `apps/api/src/filters/__tests__/downstream-error.test.ts` (73 tests)
- `apps/api/src/filters/__tests__/downstream-error-leak-sweep.test.ts` (8 tests)
- `apps/api/src/interceptors/__tests__/exception.interceptor.downstream.test.ts` (112 tests)

**Modified**

| File:line | Change |
|---|---|
| `apps/api/src/interceptors/exception.interceptor.ts:19,38,~330,~470` | downstream branch + `Retry-After` pass + `setRetryAfter` helper |
| `apps/api/src/filters/index.ts:4-9` | export the boundary |
| `packages/applications/src/services/consultation/summary/summary.service.ts:1543` (A1) | stop composing a message; log the cause, rethrow it |
| `packages/applications/src/services/consultation/summary/summary.service.ts:1824` (A2) | same |
| `packages/applications/src/services/prompt-management/prompt-management.service.ts:1313` (A3) | same |
| `packages/applications/src/services/prompt-management/prompt-management.service.ts:1349` (A4) | same (the considered upstream-404 ⇒ `NotFoundException` mapping is kept) |
| `apps/api/src/modules/ai-inference/ai-inference.client.ts:11,26,~165` (A5) | opaque `TRANSPORT_ERROR_MESSAGE`; cause via `describeCauseForOperator` |
| `apps/api/src/modules/harness-admin/harness-ops.client.ts:5-12,~180,~190` (A6,A7) | opaque transport message; empty upstream body no longer falls back to the axios message |
| `apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts:4-11,~130,~140` (A8,A9) | same |
| `apps/api/src/modules/streaming/text-proxy.controller.ts:57-59,~385` (B1) | status from the shared classifier (502 ⇒ 503 on transport); body shape unchanged |
| `apps/api/src/modules/speech/speech-proxy.controller.ts:18-20,~190` (B2) | same |
| `apps/api/src/modules/text-compat/text-compat.controller.ts:~1305` (B3) | 500 ⇒ 503 on transport; frozen v1 body shape unchanged |
| `apps/api/src/shared/base-proxy.controller.ts:6-8,~110` | 502 ⇒ 503; `detail` redacted |
| `apps/api/src/modules/health/admin-health-services.controller.ts:6,~203` | `redactTopology` on the probe error string |
| `apps/api/src/modules/dna-writing-style/dna-writing-style-job-stream.ts:5,~70` | `redactTopology` on the relayed `failedReason` |

**Tests updated to the new contract** (each was pinning the old, wrong status):
`apps/api/src/__tests__/base-proxy-controller.test.ts:602` (502 ⇒ 503, + a new redaction assertion),
`apps/api/src/modules/streaming/__tests__/text-proxy.controller.test.ts:292` (502 ⇒ 503),
`apps/api/src/modules/text-compat/__tests__/text-compat.controller.test.ts:700` (500 ⇒ 503),
`packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts:766`
(asserted the 400 wrapper; now asserts the cause is rethrown unwrapped),
`apps/api/tests/e2e/task-635-prompt-test-bench.spec.ts:253` — this one got *stronger*: it used to
read the error message because SMR-down and a genuinely-rejected pair both produced a 400, and it
could not tell them apart. They are now different statuses, so it asserts `not.toBe(400)` outright
and additionally checks that a 503 carries no topology and does carry `Retry-After`.

### Regression protection (AC-8)

Three layers, all sharing one `containsTopology` definition:

1. **Route × errno sweep** (`exception.interceptor.downstream.test.ts`) — 15 downstream-facing
   routes × 7 transport errnos through the real interceptor, asserting 503 + no topology +
   correlationId present. A new call site on any of these routes cannot reintroduce the leak.
2. **Source sweep** (`downstream-error-leak-sweep.test.ts`) — scans every non-test `.ts` under
   `apps/api/src` and `packages/applications/src` for an exception message interpolating a caught
   error, and for the `?? { message: error.message }` fallback. Comment lines are skipped (a
   comment cannot build a body, and several fixed sites quote the old expression deliberately).
3. **Named-site guards** — the five files the evidence implicated, pinned by name.

### Verification

```
pnpm --filter @arcaai/api test          → Test Files 231 passed | 2 skipped (233)
                                          Tests 3508 passed | 4 skipped (3512)
pnpm --filter @arcaai/applications test → Test Files 510 passed | 1 skipped (511)
                                          Tests 9351 passed | 4 skipped (9355)
pnpm api:build                          → Tasks: 12 successful, 12 total (exit 0)
eslint (all changed files)              → 0 errors, 23 warnings (all pre-existing
                                          `eslint-comments/require-description`)
```

RED-then-GREEN was observed: the three new test files failed on `Cannot find module
'../downstream-error'` before the boundary existed, and the three contract tests above failed on
the old statuses (502/502/500) before being updated.

### Known gaps / not fixed

1. **`packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts:222,225`** —
   forwards the STT service's own FastAPI `detail` verbatim. This is a *deliberate* documented
   choice ("so the UI surfaces the real reason instead of an opaque 500") and it is an
   **upstream-response** passthrough, not a transport leak, so it does not carry a host:port.
   Left as-is: changing it is a product decision about how much upstream detail a clinician-facing
   surface should show. Flagged for an owner call.
2. **`apps/api/src/modules/stt-compat/stt-compat.gateway.ts:270`** — relays the upstream STT error
   frame's own `message` field verbatim over the legacy v1 WebSocket. Downstream-authored, but an
   application-level error frame rather than a transport failure. Not changed (legacy compat
   surface; blanking it loses real diagnostics).
3. **`text-compat.controller.ts` `buildGenerationFailure`** — `{ detail: "<label> failed: <reason>" }`
   at 500. A parse/mapping failure, not a transport failure; `reason` is an internal mapping
   message, not topology. Deliberately untouched.
4. **Hard-coded downstream URLs** (`ai-service-proxy.client.ts:6-7`
   `DEFAULT_GUARDRAIL_URL = 'http://localhost:8863'` and siblings). Not a leak — they are never
   interpolated into a client body — but they are hard-coded configuration, which
   `00-project-context.md` §Configuration Principles bans. **Out of scope here; belongs with the
   TASK-735 config work.** A sweep assertion for this was drafted and removed: it would have
   failed on pre-existing defaults across the repo, i.e. it is a real finding but not this
   ticket's.
5. **Not run:** the Playwright e2e suite. `apps/api/tests/e2e/task-635-prompt-test-bench.spec.ts`
   was updated to the new contract but the shared test API on :8968 predates this change, so it
   would still answer 400. **The test API needs a rebuild before that spec is meaningful.**

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | Ticket opened. Requirement analysis, call-site inventory (A1–A9, B1–B3, C1–C2), plan. |
| 2026-08-19 | RED: three new test files added (`downstream-error.test.ts`, `downstream-error-leak-sweep.test.ts`, `exception.interceptor.downstream.test.ts`) — all failing. |
| 2026-08-19 | GREEN: `filters/downstream-error.ts` added; `ExceptionInterceptor` wired (downstream branch + `Retry-After` pass); 14 call sites fixed; 5 pre-existing tests updated to the new contract. Status: **Review** — pending a test-API rebuild for the e2e leg. |
| 2026-08-20 | Status advanced to Completed per owner directive: implementation complete (GREEN, 14 call sites fixed, all unit gates passing); outstanding e2e/live-run verification (Playwright e2e not run — test API needs a rebuild) is not a status gate. |
