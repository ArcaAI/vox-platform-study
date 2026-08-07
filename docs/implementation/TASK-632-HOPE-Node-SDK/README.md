# TASK-632 — HOPE Node SDK (`@arcaai/vox-node`)

| Field | Value |
|---|---|
| **Status** | `Pending` — awaiting plan approval (Phase 3 gate) |
| **Type** | `feature` |
| **Owner** | Tap Huynh |
| **Created** | 2026-08-07 |
| **Depends on** | TASK-562 (v1-compat SMR endpoints), TASK-592/599/600 (compat summary enrichment) |
| **Related** | TASK-560/561/563 (v1→v2 migration), TASK-603 (compat batch upload) |

> **Ticket number is provisional.** Highest number found in `docs/implementation/` is
> TASK-631. Numbers 612–615 exist on `dev-2.1` but not on this branch. Confirm
> **TASK-632** before work starts.

---

## 1. Requirement Analysis

### 1.1 Ask

Ship a **dedicated Node.js SDK package for non-browser, server-side integration**
with the HOPE v2 gateway. Day-1 the package MUST expose **Pre-Summarization** and
**Summarization** so backend engineers can build Node services against HOPE without
touching a browser, React, or the audio/ML stack.

### 1.2 Why a new package rather than an entry point on `@arcaai/vox`

`@arcaai/vox` cannot serve this need, structurally:

| Blocker | Evidence |
|---|---|
| React is a **required** peer dependency | `packages/agentic-sdk-v2/package.json` — `react`/`react-dom` are in `peerDependencies` with no `peerDependenciesMeta.optional` entry |
| The entire public API is React hooks over a context-scoped Zustand store | `src/core.ts`, `src/providers/AgenticProvider.tsx` |
| Every entry carries `"use client"` | `packages/agentic-sdk-v2/README.md` §Entry points |
| Audio/ML deps (`onnxruntime-web`, `@huggingface/transformers`, `@ricky0123/vad-web`) sit in `dependencies`, not optional peers | `package.json` |

Peer dependencies are **package-scoped**, not subpath-scoped — a `@arcaai/vox/node`
subpath would still demand React on every consumer's server. A separate package is
the only correct answer.

### 1.3 Non-goals for this ticket

- Replacing or refactoring `@arcaai/vox` (convergence is TASK-633, §7).
- Browser support. This package targets server runtimes only.
- Audio capture, VAD, noise filtering, on-device ML.
- Webhook **delivery** (backend gap — see §3.4); webhook **verification** ships when delivery exists.

---

## 2. Current State Evaluation

### 2.1 The one Node-safe asset that exists today

[`AgenticClient.ts`](../../../packages/agentic-sdk-v2/src/core/AgenticClient.ts) (1,320 lines)
is `fetch`-based with `Authorization: Bearer` + `X-API-Key`, single-slot 401 refresh,
client-side rate limiting, and ETag handling. It contains **no** `window`, `document`,
`localStorage`, or `navigator` references. It is Node-capable but unreachable — the only
way in is through `AgenticProvider`.

Two sibling transports are **not** Node-portable as written:

- [`SSEClient.ts:230`](../../../packages/agentic-sdk-v2/src/core/SSEClient.ts:230) constructs a browser
  `EventSource`, which cannot set request headers — the reason stream tickets exist. Server-side
  with an API key this constraint disappears; the Node SDK parses SSE off `response.body` instead.
- [`SttWebSocketClient.ts:321`](../../../packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts:321) uses global
  `WebSocket`. Out of day-1 scope.

### 2.2 Day-1 target surfaces (verified against the gateway)

**A. Stateless summarization — the v1-compat SMR shims.** No consultation required;
POST a transcript, get a summary. Served by
[`smr-compat.controller.ts`](../../../apps/api/src/modules/smr-compat/smr-compat.controller.ts).

| Route | Notes |
|---|---|
| `POST /api/smr/api/v1/presummary` | Body `PreSummaryRequest`; `stream: true` → SSE |
| `POST /api/smr/api/v1/summary/sync` | Body `SyncSummaryRequest`; `stream: true` → SSE |

⚠️ **These paths are excluded from the `api/v1` global prefix**
([`main.ts:101-102`](../../../apps/api/src/main.ts:101)) so v1 clients keep their literal URLs.
The SDK's base-URL joining must special-case them or it will produce
`/api/v1/api/smr/api/v1/...`. This is the single most likely day-1 bug.

Streaming frames emitted by the shim ([`smr-compat.controller.ts:933-955`](../../../apps/api/src/modules/smr-compat/smr-compat.controller.ts:933)):

| Event | Data |
|---|---|
| `delta` | `{ text }` — accumulating content |
| `reasoning` | `{ text }` — provider reasoning/thinking deltas |
| `result` | the full v1 `SummaryResponse` / `PreSummaryResponse` |
| `error` | `{ detail }` — PHI-redacted, never echoes upstream content |
| `:keepalive` | comment frame |

Server-side behavior already wired into these routes and inherited free by the SDK:
governed department templates (TASK-592), DNA writing-style via `doctor_id` (TASK-599),
`translate_to_english` via Sarvam (TASK-600), and one-shot tenant-configured provider
fallback on provider-side failure (TASK-588).

**B. Consultation-bound summarization — v2 native, persisted.** Served by
[`consultation.controller.ts`](../../../apps/api/src/modules/consultation/consultation.controller.ts).

| Route | Line |
|---|---|
| `POST /api/v1/consultations/:id/summary` | [845](../../../apps/api/src/modules/consultation/consultation.controller.ts:845) |
| `POST /api/v1/consultations/:id/summary/pre-summary` | [869](../../../apps/api/src/modules/consultation/consultation.controller.ts:869) |
| `POST /api/v1/consultations/:id/summary/async` | [1059](../../../apps/api/src/modules/consultation/consultation.controller.ts:1059) |
| `POST /api/v1/consultations/:id/summary/pre-summary/async` | [1095](../../../apps/api/src/modules/consultation/consultation.controller.ts:1095) |
| `GET /api/v1/consultations/:id/summary` · `/summary/latest` · `/summary/pre-summary/latest` | 857 / 880 / 891 |
| `PATCH /api/v1/consultations/:id/summary/:summaryId` | 904 — OCC (`If-Match`) |
| `GET /api/v1/consultations/jobs/:jobId` · `/cancel` · `/stream` (SSE) | [consultation-job.controller.ts:37/58/70](../../../apps/api/src/modules/consultation/consultation-job.controller.ts:37) |

`GenerateSummaryRequest` already carries `idempotencyKey`
([generate-summary.request.ts:44](../../../packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts:44)) —
a **body field**, not a header. The SDK maps its `idempotencyKey` option onto the body here.

### 2.3 Auth posture for a server integrator

`UnifiedAuthGuard` accepts API keys via `X-API-Key` and binds the tenant from the key
([unified-auth.guard.ts:200](../../../packages/applications/src/authorization/unified-auth.guard.ts:200)),
which the compat controller reads through `requireTenantId`
([smr-compat.controller.ts:671](../../../apps/api/src/modules/smr-compat/smr-compat.controller.ts:671)).
A Node service therefore needs only an API key — no browser session, no stream tickets.

### 2.4 Gaps found during exploration

| # | Gap | Impact on this ticket |
|---|---|---|
| **G1** | **API-key scopes are unenforceable — the decorator was never written.** `API_KEY_REQUIRED_SCOPES` (`unified-auth.guard.ts:20`) and `enforceApiKeyScopes` (`:217`) are both correct, and `API_KEY_SCOPE_REGISTRY` is rich. But `grep -rn "RequiredScopes" apps/api/src` returns **0 matches**, and the reason is that **no decorator setting that metadata key exists anywhere in the repo** — only the guard-side reader and its tests reference the constant. So `requiredScopes` is always `undefined`, the guard returns early, and any valid API key reaches every route RBAC permits. | **Blocking (owner-confirmed).** Publishing an SDK that makes API keys the primary auth while scopes are structurally unenforceable widens the blast radius of a leaked integration key. Fix on the SDK's own surface (§4.1 B1). |
| **G2** | **No published `openapi.json`.** [`main.ts:111`](../../../apps/api/src/main.ts:111) builds the Swagger doc at runtime, non-production only; nothing writes it to disk. | Blocks contract tests and generated types (§4.1 B2). |
| **G3** | **Webhooks never fire.** `Webhook.hashedSecret` and `WebhookRunHistory` are modeled and `sysEvent.service.ts:190` comments that the queue feeds webhooks, but there is **no processor for `JobQueue.SysEvent`** anywhere and no `createHmac` in the notification/webhook services. | Not day-1 blocking (summarization is request/response), but it means async consumers must poll. Separate ticket. |
| **G4** | Idempotency is honored on `internal/*` routes and the async summary body, but not on public sync writes. | SDK auto-retry must not retry sync POSTs without a key. |
| **G5** | **Async-job status casing is inconsistent across two endpoints of the same workflow.** `AsyncJobResponseDto.status` (returned by `POST …/summary/async`) uses `pending\|processing\|completed\|failed`; `JobStatusResponse.status` (returned by `GET /consultations/jobs/:jobId`) uses `PENDING\|RUNNING\|COMPLETED\|FAILED\|CANCELLED`. Not a 1:1 mapping — `processing` vs `RUNNING`, and `CANCELLED` has no counterpart. Found while deriving SDK types. | A consumer doing `if (job.status === (await hope.jobs.get(job.jobId)).status)` gets a silent mismatch. **SDK policy: type both faithfully — do NOT silently normalize**, since that would hide a gateway defect behind the client. Ship an `isTerminalJobStatus()` helper that accepts both vocabularies, document the split, and fix the gateway separately (TASK-638). |
| **G6** | `JobStatusResponse` timestamps are declared `Date` in the server DTO but always cross the wire via `JSON.stringify` (through `ConsultationJobService.subscribeToJobUpdates`), i.e. ISO strings. | SDK types them as `string` — wire truth over declaration. Harmless, but noted so the next reader doesn't "correct" it. |

---

## 3. Design

### 3.1 Package identity

| Property | Value |
|---|---|
| Directory | `packages/vox-node/` |
| Package name | `@arcaai/vox-node` *(OD-1 — decided 2026-08-07: brand continuity with `@arcaai/vox`)* |
| Runtime floor | `node >= 22` (matches root `engines`) |
| Module format | ESM-first + CJS fallback via `exports`; `types` first in every condition |
| Dependencies | **zero runtime deps** — global `fetch`, `AbortSignal`, Web Crypto, `ReadableStream` only |
| Peer deps | `@opentelemetry/api` (optional, no-ops when absent) |
| Presets | `@arcaai/config-ts/base.json`, `@arcaai/config-eslint/flat/library` |
| Build | `tsup` (mirrors `@arcaai/vox`) |

Targeting the WinterTC minimum common API — no `node:http`, no `axios` — means one build
also runs on Bun, Deno, and edge runtimes at no extra cost. Retrofitting that later is expensive.

### 3.2 Public surface (day-1)

```ts
import { HopeClient } from '@arcaai/vox-node';

const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL!,      // e.g. http://localhost:8868
  apiKey: process.env.HOPE_API_KEY!,        // → X-API-Key
  // tenantId?: string                      // → X-Tenant-Id (global-admin keys only)
  // maxRetries?: number                    // default 2
  // timeout?: number                       // default 60_000 ms
  // fetch?: typeof fetch                   // injectable for tests/proxies
  // logger?: HopeLogger                    // never receives request/response bodies
});
```

**P0 — stateless summarization (zero prerequisites, the v1 backend contract):**

```ts
await hope.summarization.preSummary(input);            // → PreSummaryResponse
await hope.summarization.summary(input);               // → SummaryResponse

for await (const evt of hope.summarization.preSummaryStream(input, { signal })) { … }
for await (const evt of hope.summarization.summaryStream(input, { signal })) { … }
// evt: { type: 'delta' | 'reasoning', text } | { type: 'result', data } | { type: 'error', detail }
```

Plus a convenience that collapses a stream to its terminal value, since most backend
callers want the result and only some want the deltas:

```ts
const summary = await hope.summarization.summaryStream(input).result();
```

**P0.5 — consultation-bound summarization (persisted; same release per OD-5):**

```ts
hope.consultations.summaries.generate(id, req, { idempotencyKey? })
hope.consultations.summaries.generatePreSummary(id, req)
hope.consultations.summaries.generateAsync(id, req)          // → { jobId }
hope.consultations.summaries.generatePreSummaryAsync(id, req)
hope.consultations.summaries.list(id) / latest(id) / latestPreSummary(id)
hope.consultations.summaries.update(id, summaryId, req, { ifMatch })
hope.jobs.get(jobId) / cancel(jobId) / stream(jobId)          // SSE async iterable
hope.jobs.waitFor(jobId, { pollInterval?, signal? })          // stream-with-poll-fallback

hope.consultations.get(id)                                     // minimal read — id validation only
```

`generateAsync` + `jobs.waitFor` is the ergonomic pair a backend worker actually wants;
it should be the documented default for long transcripts.

### 3.3 Transport contract

**Errors** — a typed hierarchy mirroring the gateway's real contracts:

```
HopeAPIError            // status, code, requestId, headers, message
├── AuthenticationError // 401
├── PermissionError     // 403 — privilege boundary
├── NotFoundError       // 404 — see the 404-over-403 note below
├── QuotaExceededError  // 409
├── VersionConflictError// 412 — carries currentVersion
├── PreconditionRequiredError // 428 — missing If-Match
├── RateLimitError      // 429 — carries retryAfter
├── APIConnectionError  // network / DNS / connect-phase
└── APITimeoutError
```

**`NotFoundError` must carry a docstring about the 404-over-403 posture.** A cross-tenant
read returns 404, not 403. A backend engineer's first instinct on a 404 is "wrong URL",
and they will file a bug. This is the highest-value piece of HOPE-specific ergonomics in
the whole package.

**Retry:** 408/429/5xx + connection errors, `maxRetries: 2`, **exponential backoff with
full jitter** (not plain exponential — a batch of simultaneous failures otherwise retries
in lockstep and re-floors the recovering gateway), honoring `Retry-After`. Never retry a
non-idempotent POST unless an idempotency key was supplied.

**Streaming:** parse SSE from `response.body` via `ReadableStream` + `TextDecoderStream`.
Handles `event:` / `data:` / `:comment` frames, respects `AbortSignal`, surfaces
`error` frames as thrown `HopeStreamError`. Explicitly **not** `EventSource` — headers
are required for `X-API-Key`, and `EventSource` cannot set them.

**PHI safety (non-negotiable for this codebase):**
- Never log request or response **bodies** at any log level — transcripts and summaries are PHI.
- Redact `Authorization`, `X-API-Key`, `X-Service-Token` in every path, including error `toString()`/`inspect`.
- No on-disk caching of any kind.
- Error messages carry status + `x-request-id`, never upstream content (matching the shim's own posture).

**Observability:** injected logger, optional OTel spans, `traceparent` propagation,
`requestId` surfaced on every error.

### 3.4 What day-1 deliberately excludes

STT (batch + live), TTS, NER/entity extraction, consultation CRUD beyond what summaries
need, admin/tenant surfaces, webhook verification (blocked on G3), WebSocket transport.
Each is a follow-up ticket in §7.

---

## 4. Implementation Plan

### 4.0 Execution setup

| Item | Value |
|---|---|
| Worktree | `.claude/worktrees/task-632` |
| Branch | `feat/task-632-vox-node-sdk`, branched from `dev-2.1` @ `14751451` |
| Baseline verification | All four §2.4 gaps re-confirmed on `dev-2.1` before work began (scope count still 0; compat prefix exclusions at `main.ts:108-109`; `idempotencyKey` still a body field; still no `JobQueue.SysEvent` processor) |

Parallelized across agents on disjoint file sets:

| Wave | Lane | Owns | Tier |
|---|---|---|---|
| 1 | Package scaffold | `packages/vox-node/` config files + `src/index.ts` stub | sonnet |
| 1 | Type definitions | `packages/vox-node/src/types/**` | sonnet |
| 1 | **B1** scope enforcement | `authorization/decorators.ts`, the summarization routes, audit + guard tests | sonnet |
| 2 | Core transport | `packages/vox-node/src/core/**` (TDD steps 1–6) | sonnet, max |
| 3 | Resources | `packages/vox-node/src/resources/**` (TDD steps 7–12) | sonnet, max |
| 4 | Verification + docs | live smoke, `attw`/`publint`, README, example | — |

Waves 2 and 3 are gated on their predecessor because the transport is the substrate for every
resource; running them concurrently would mean writing resources against an unstable contract.

### 4.1 Backend prerequisites

| # | Work | Blocking? |
|---|---|---|
| **B1** | Declare `@RequiredScopes(['consultation:report:write'])` (and read equivalents) on the four summary/pre-summary routes and both compat shims; add a boot-time audit test asserting every route the SDK calls declares a scope. Closes **G1** for the SDK's surface. | **Yes** — do not publish before this |
| **B2** | Add `pnpm api:openapi` writing `apps/api/openapi.json`, wired into CI as a committed artifact + drift gate. Closes **G2**. | Yes for contract tests; SDK can be hand-typed without it |
| **B3** | Confirm/patch `X-Tenant-Id` handling on the compat shims for global-admin API keys (today `requireTenantId` falls back to the key's own tenant). | No — document current behavior if unchanged |

### 4.2 Package scaffold

```
packages/vox-node/
├── package.json · tsconfig.json · tsup.config.ts · eslint.config.mjs · vitest.config.ts
├── README.md
└── src/
    ├── index.ts                     # HopeClient + all public types
    ├── client.ts                    # HopeClient: config, resource wiring
    ├── core/
    │   ├── transport.ts             # fetch wrapper: headers, timeout, abort
    │   ├── retry.ts                 # full-jitter backoff, Retry-After
    │   ├── errors.ts                # the hierarchy above
    │   ├── sse.ts                   # ReadableStream → AsyncIterable<SseFrame>
    │   ├── redact.ts                # PHI/secret redaction for logs + errors
    │   ├── idempotency.ts           # UUIDv7 generation
    │   └── url.ts                   # base-URL join incl. the prefix-exempt compat paths
    ├── resources/
    │   ├── summarization.ts         # P0 — stateless (compat shims)
    │   ├── consultation-summaries.ts# P0.5 — persisted
    │   └── jobs.ts                  # P0.5 — async job get/cancel/stream/waitFor
    ├── types/
    │   ├── summarization.ts         # PreSummaryRequest/Response, SyncSummaryRequest, SummaryResponse…
    │   └── consultation.ts
    └── __tests__/
```

### 4.3 TDD order (Phase 4)

Red → green → refactor at every step; each step's tests must be seen failing first.

| # | Test first | Then implement |
|---|---|---|
| 1 | `url.test.ts` — `/api/smr/api/v1/presummary` is **not** prefixed with `api/v1`; `consultations/:id/summary` **is**; trailing-slash and absolute-URL cases | `core/url.ts` |
| 2 | `errors.test.ts` — each status maps to its class; 412 exposes `currentVersion`; 429 exposes `retryAfter`; `NotFoundError` message mentions cross-tenant | `core/errors.ts` |
| 3 | `redact.test.ts` — API key never appears in `String(err)`, `err.stack`, `util.inspect(err)`, or any logger call; bodies never logged | `core/redact.ts` |
| 4 | `retry.test.ts` — retries 429/503, honors `Retry-After`, jitter bounded, **no** retry on POST without idempotency key, stops at `maxRetries` | `core/retry.ts` |
| 5 | `transport.test.ts` (injected `fetch`) — headers set, timeout aborts, `AbortSignal` propagates, `x-request-id` captured | `core/transport.ts` |
| 6 | `sse.test.ts` — multi-line frames, `:keepalive` ignored, split-chunk boundaries, `error` frame throws, abort mid-stream cleans up | `core/sse.ts` |
| 7 | `summarization.test.ts` — `preSummary`/`summary` request shape + response mapping against fixtures captured from the real controller | `resources/summarization.ts` |
| 8 | `summarization.stream.test.ts` — `delta`/`reasoning`/`result`/`error` sequence; `.result()` collapses correctly | streaming methods |
| 9 | `consultation-summaries.test.ts` — sync + async paths, `idempotencyKey` lands in the **body**, `If-Match` on PATCH, 412 surfaces `VersionConflictError` | `resources/consultation-summaries.ts` |
| 10 | `jobs.test.ts` — `waitFor` resolves on terminal status, falls back to polling when SSE drops, respects abort | `resources/jobs.ts` |
| 11 | `consultations.test.ts` — `get(id)` maps 200/404; a missing id surfaces `NotFoundError` with the cross-tenant docstring | `resources/consultations.ts` |
| 12 | `cross-tenant.test.ts` — a foreign consultation id yields `NotFoundError`, never `PermissionError` | — (contract assertion) |

### 4.4 Verification (Phase 5)

- `pnpm --filter @arcaai/vox-node build lint typecheck test` green — paste output.
- `attw --pack` + `publint` clean (add both to the package's `test` chain).
- **Live smoke** against a running gateway (`pnpm test:up:api`), gated on `HOPE_LIVE_TESTS=1`:
  pre-summary and summary, sync and streaming, with a real API key — capture actual output.
- A worked example under `packages/vox-node/examples/` a backend dev can run in one command.

### 4.5 Documentation

- `packages/vox-node/README.md` — install, auth, the two summarization families, error table
  with the 404-over-403 callout, streaming, PHI-logging posture.
- Add a row to the monorepo map in `.claude/rules/00-project-context.md`.
- Migration note for v1 backend integrators: the compat routes are byte-identical, so migration
  is "swap raw `fetch` for the SDK", not a rewrite.

---

## 5. Verification Criteria (definition of done)

- [ ] B1 landed: summarization routes declare API-key scopes; audit test green
- [ ] `pnpm --filter @arcaai/vox-node build lint typecheck test` green, output pasted
- [ ] `attw` + `publint` clean; package installs into a bare Node 22 project with **no** React present
- [ ] Live smoke: pre-summary + summary, sync + streaming, evidence captured
- [ ] Cross-tenant test asserts 404
- [ ] No request/response body appears in any log at any level (test-enforced)
- [ ] README + example run end-to-end from a clean checkout

---

## 6. Decisions

### 6.1 Settled (owner, 2026-08-07)

| # | Decision | Outcome |
|---|---|---|
| **OD-1** | Package name | **`@arcaai/vox-node`**, directory `packages/vox-node/`. Brand continuity with `@arcaai/vox` wins over the "vox = browser" reading. The README must therefore open by stating plainly that this is a **separate, non-browser package** that shares the brand but not the runtime, React, or the audio stack — otherwise the shared name invites the exact confusion §1.2 exists to prevent |
| **OD-5** | Day-1 release scope | **P0 + P0.5 in one release.** Stateless summarization *and* consultation-bound (sync, async, job stream/`waitFor`). Pulls in a minimal `hope.consultations.get(id)` — scoped to the read needed to validate an id, not consultation CRUD |
| **B1 gate** | Does the API-key scope gap block release? | **Yes.** `@RequiredScopes` lands on the summarization routes *before* the SDK publishes. Scoped to the routes the SDK calls, not a gateway-wide sweep |

### 6.2 Still open

| # | Decision | Recommendation |
|---|---|---|
| **OD-2** | Hand-written vs generated from OpenAPI | Hand-write day-1 (surface is small, ergonomics are the value); revisit generation once B2 lands and the surface grows past ~30 routes |
| **OD-3** | Extract a shared `@arcaai/hope-client-core` now, or converge later | **Converge later (TASK-633).** Extracting from a shipping browser SDK on the critical path of a day-1 deliverable is the wrong risk. Mitigate drift with a **shared contract-test suite** both packages must pass |
| **OD-4** | Publish target — internal GitHub registry (as `@arcaai/vox` does) or public npm | Match `@arcaai/vox` (`npm.pkg.github.com`) unless external customers need it |

---

## 7. Follow-up Tickets (not this ticket)

| Ticket | Scope |
|---|---|
| TASK-633 | Extract `@arcaai/hope-client-core`; converge `@arcaai/vox` and `@arcaai/vox-node` onto one transport with shared contract tests |
| TASK-634 | Implement the `JobQueue.SysEvent` webhook processor (HMAC-SHA256 signing, jittered retries, `WebhookRunHistory`, DLQ) — closes **G3** |
| TASK-635 | `hope.webhooks.verify()` + Express/Fastify/Next raw-body adapters (depends on TASK-634) |
| TASK-636 | STT batch transcription in the Node SDK (`/audio/transcription-jobs/batch`, streaming upload, bounded-concurrency queue) |
| TASK-637 | Idempotency-Key **header** support on public sync writes — closes **G4** |
| TASK-638 | Reconcile async-job status vocabularies between `AsyncJobResponseDto` and `JobStatusResponse` — closes **G5**. Must ship before the SDK can normalize |

---

## 8. Implementation Summary

_To be completed during Phase 4/5._

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-07 | Ticket created; exploration + plan written, awaiting approval (Phase 3 gate) |
| 2026-08-07 | Owner decisions recorded: OD-1 `@arcaai/vox-node` (`packages/vox-node/`); OD-5 P0 + P0.5 in one release (adds minimal `consultations.get`); B1 (API-key scope enforcement on the summarization routes) confirmed as a release blocker |
