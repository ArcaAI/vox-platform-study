# TASK-589 — SMR Compat Streaming Toggle (summary + pre-summary)

**Status:** Review (implemented + gate-verified; staged-not-committed)
**Type:** feature
**Branch:** dev-2.1
**Owner model tier:** opus-4-8-medium

Give v1-compat clients a developer-controllable **streaming toggle** on the two SMR
summary shims, so the same request can return either an **SSE stream** (progressive
deltas + a terminal event carrying the full v1 body) or the **single JSON response
body** it returns today. Covers both the **API compat** surface (`apps/api`
`SmrCompatController`) and the **SDK compat** surface (`@arcaai/vox/compat` `useSMR`).

Wire-contract decision (confirmed with owner): the toggle is an **optional
`stream: boolean` field in the request body** (default `false` → today's behavior).
No new routes; no `main.ts` change. The existing `apps/api` `smr-compat` module is
extended in place (no new module).

**Second, owner-directed requirement:** the compat layer must **require** the Hope V2
Core mandatory context — **`tenant-id` above all** — rather than resolving it
best-effort. Today missing tenant silently resolves SYSTEM defaults; that is closed
here (see "Mandatory V2 Core context" below). The SDK/API caller migration itself is
owner-communicated separately.

---

## Requirement Analysis

Two v1 endpoints must gain an opt-in streaming mode while staying byte-for-byte
compatible in the non-streaming default:

| v1 endpoint | Reproduced by | Today | Add |
|---|---|---|---|
| `POST /api/smr/api/v1/summary/sync` | `SmrCompatController.summarySync` | single JSON `SummaryResponse` | `stream:true` → `text/event-stream` |
| `POST /api/smr/api/v1/presummary` | `SmrCompatController.presummary` | single JSON `PreSummaryResponse` | `stream:true` → `text/event-stream` |

**Streaming semantics (both endpoints):**
- `stream` omitted / `false` → **unchanged**: single JSON body (incl. the TASK-588
  per-tenant fallback for `summary/sync`).
- `stream:true` → `Content-Type: text/event-stream`, emitting:
  - `event: delta` — `data: { "text": "<incremental content>" }` — progress chunks.
    Pre-summary deltas are clean markdown; **summary deltas are strict-JSON
    fragments** (the summary uses `response_format:{type:'json_schema',strict:true}`),
    so deltas are for progress/telemetry, not display.
  - `event: result` — `data: <the exact v1 JSON body>` — the terminal event. Its
    payload is **identical** to what the non-streaming path returns
    (`SummaryResponse` / `PreSummaryResponse`), so streaming and non-streaming callers
    converge on the same final object.
  - `event: error` — `data: { "detail": "<label> failed: ..." }` — PHI-redacted; the
    raw upstream body is never written to the stream (parity with §3.4/§4.3 posture).
  - `res.end()` follows the terminal `result`/`error`.

**Why the terminal-event approach:** the v1 `SummaryResponse` is an assembled,
mapped, strict-JSON object (`mapGenerateToV1Summary`). Streaming raw tokens alone
would give the caller partial JSON and no v1-shaped result. Emitting `delta`s for
progress **plus** a `result` event carrying the fully-mapped v1 body preserves exact
v1 parity while enabling progressive rendering.

### Mandatory V2 Core context — `tenant-id` is required (owner-directed)

V2 Core is multi-tenant PHI. Provider/model selection, the per-tenant SMR fallback,
config-cache keys, and data isolation are ALL keyed by tenant. The compat controller
must therefore treat tenant-id as **mandatory**, not optional:

- **Resolve-or-reject.** A new `requireTenantId()` resolves the tenant from CLS
  (`cls.get('tenantId')`, set by `UnifiedAuthGuard` from the api key —
  `unified-auth.guard.ts:200`) or the authenticated api key's `tenantId`, and throws
  `UnauthorizedException('Tenant context is required')` when neither is present.
  Applied to **both** endpoints, in **both** streaming and non-streaming branches,
  **before** any SMR call.
- **No SYSTEM-default leak.** `resolveSmrSelection(tenantId?)` today accepts
  `undefined` and resolves the SYSTEM/default `AiTaskDefault` — losing the caller's
  per-tenant selection, fallback, and isolation (the §9.3 M4 hazard: a tenant-blind
  read serving another scope's value). `applySmrModelSelection` and the fallback
  resolution are changed to take a **required** `tenantId: string`.
- This is defense-in-depth: for a correctly tenant-scoped api key the guard already
  sets CLS tenant, so this never fires in the happy path — it fails closed on the
  misconfiguration (untenanted key / global-admin key with no `X-Tenant-Id`) instead
  of silently summarizing under the wrong scope.

**V2 "mandatory / changed" items to document for the developer** (migration note):
1. Point the client base URL at the **v2 gateway**; the literal v1 paths still work.
2. Keep **`x-api-key`** — the working tenant is resolved **from the key**
   (`UnifiedAuthGuard`, TASK-560 D2). A tenant-scoped key needs nothing extra; a
   global-admin key **must** send `X-Tenant-Id`. **The request is now rejected with
   `401 Tenant context is required` if no tenant resolves** — tenant-id is mandatory
   in V2 (no SYSTEM-default fallback).
3. **Provider/model is tenant-configured and fails closed** — v2 resolves SMR
   provider/model via `HarnessPolicyService.resolveSmrSelection(tenantId)`; the tenant
   must have `smr.*` AI task defaults configured (TASK-588). This replaces v1's env
   fallback and is the one behavior change a caller can observe.
4. Streaming is **opt-in** via `stream:true` (SDK: `{ stream:true, onDelta }`).

**Out of scope:** the SDK's `summarizeAsync` → `POST summary/async` (no server route
exists today — a pre-existing gap, tracked separately, not a streaming concern).

---

## Current State Evaluation

- **API** — `apps/api/src/modules/smr-compat/smr-compat.controller.ts`
  - `summarySync` / `presummary` post to SMR `/api/v1/generate` (no `stream`), map the
    content to the v1 body. `summarySync` has a TASK-588 per-tenant fallback.
  - `postGenerate()` already handles connect-phase retry; `getForwardHeaders()`,
    `getSmrBaseUrl()`, `isFallbackEligible()`, error mappers all reusable.
  - **Tenant gap:** `resolveTenantId()` returns `string | undefined` and its
    `undefined` flows into `applySmrModelSelection` → `resolveSmrSelection(undefined)`,
    which silently resolves SYSTEM defaults. This is the mandatory-context violation to
    close (→ `requireTenantId()`).
- **SMR** — `POST /api/v1/generate` accepts `stream:true` → `202 { task_id, status,
  stream_url }`, then streams SSE at `GET /api/v1/tasks/{task_id}/stream`
  (`StreamChunk` types `chunk|reasoning|meta|done|error|usage`;
  `apps/smr/.../models/stream.py`).
- **Proven proxy pattern** — `SmrProxyController.streamTaskEvents`
  (`apps/api/src/modules/streaming/smr-proxy.controller.ts:624`) shows the exact
  `@Res()` + `responseType:'stream'` + heartbeat + header set for proxying SMR SSE
  through the gateway. We reuse the shape (minus the native ticket/`StreamScope` — the
  compat POST already authenticated via `x-api-key`, so the held-open response needs
  no ticket).
- **main.ts** — `summary/sync` + `presummary` POST are already excluded from the
  `api/v1` prefix. Same routes stream → **no change**.
- **SDK** — `packages/agentic-sdk-v2/src/compat/useSMR.ts` does `fetch` → single JSON.
  `types.ts` holds `SMRRequest` / `PreSummaryRequest` / `SummaryResponse` /
  `PreSummaryResponse`.

---

## Implementation Plan (TDD)

Layer order: **API DTO → API controller → SDK types → SDK hook → docs.** Red-Green per
step; the non-streaming regression tests must stay green throughout.

### Test list (write first, watch fail)

**API — `apps/api/src/modules/smr-compat/__tests__/smr-compat.controller.test.ts`**
0a. `summary/sync` with **no resolvable tenant** (CLS unset + api key absent) →
    `UnauthorizedException`, and **no** SMR call is made (mandatory tenant-id).
0b. `presummary` with no resolvable tenant → same.
0c. Tenant present (CLS or api key) → `resolveSmrSelection` is called with that
    **exact** tenantId (never `undefined`).
1. `summary/sync` `stream` omitted → **unchanged** JSON `SummaryResponse` (regression;
    fallback path still exercised).
2. `summary/sync` `stream:true` → sets `text/event-stream` headers; forwards each SMR
   `chunk` as an `event: delta`; on SMR `done` emits `event: result` whose `data`
   equals the same `mapGenerateToV1Summary` body; `res.end()` called.
3. `presummary` `stream:true` → `event: delta` (markdown) + terminal `event: result`
   with `PreSummaryResponse`.
4. Stream **start** failure on `summary/sync` (SMR non-2xx / unreachable on the
   `/generate` call, before any bytes) → tenant fallback provider used for the start
   (reuse `isFallbackEligible` + `resolveSmrFallbackSelection`); if no fallback →
   single `event: error` then `res.end()`.
5. Mid-stream SMR error → `event: error` (PHI-redacted `detail`), no raw upstream body
   on the wire.
6. `stream:true` with SMR selection unresolved (fail-closed) surfaces as `event: error`,
   not a thrown 500 after headers flushed.

**SDK — `packages/agentic-sdk-v2/src/compat/__tests__/useSMR.test.ts`**
7. `summarizeSync({ stream:true, onDelta })` parses a mocked SSE `ReadableStream`,
   invokes `onDelta` per `delta`, resolves with the terminal `result` structured
   summary, and fires `onComplete` with it.
8. `preSummarize({ stream:true, onDelta })` → same for `PreSummaryResponse`.
9. `stream` omitted → **unchanged** JSON path; no `Accept: text/event-stream` header
   sent (regression).
10. Stream `error` event → hook rejects with the `detail` message and fires `onError`.

### File modification order

1. **`dto/sync-summary.request.ts`** + **`dto/pre-summary.request.ts`** — add
   `@ApiPropertyOptional @IsOptional @IsBoolean stream?: boolean`.
2. **`smr-compat.controller.ts`**
   - **Tenant enforcement (first):** add `requireTenantId(authRequest?): string` —
     `cls.get('tenantId') ?? authRequest?.apiKey?.tenantId`, else throw
     `UnauthorizedException('Tenant context is required')`. Call it at the top of both
     `summarySync` and `presummary` (covers stream + non-stream). Change
     `applySmrModelSelection(request, tenantId: string)` and the fallback resolution to
     take the required tenantId; drop the `undefined`-returning `resolveTenantId` from
     these paths.
   - Add `stream?: boolean` to the private `SmrGenerateRequest` interface.
   - Add optional `@Res({ passthrough: true }) res?: Response` param to `summarySync`
     and `presummary` (keeps existing unit calls — which pass no `res` — valid on the
     non-stream branch, which still `return`s the object).
   - Branch: `body.stream === true && res` → `streamSummary(...)` / `streamPreSummary(...)`;
     else current path.
   - New private `streamGenerate(res, smrRequest, label, buildResult)`:
     set SSE headers (mirror `streamTaskEvents`); POST `/generate` with `stream:true`
     (reuse connect-retry) → `{ task_id }`; open `GET /tasks/{id}/stream`
     (`responseType:'stream'`, `Accept: text/event-stream`); parse SMR frames →
     re-emit `chunk`→`delta`, accumulate content; on `done` call
     `buildResult(accumulated)` and emit `event: result`; on `error`/parse-failure emit
     `event: error` (redacted); heartbeat + disconnect cleanup.
     `buildResult` for summary = `mapGenerateToV1Summary(...)`, for presummary =
     `mapGenerateToV1PreSummary(...)` (same mappers as the sync path — one source of
     truth for the terminal body).
   - Fallback: apply only to the **start** (pre-stream) failure on `summary/sync`,
     reusing `isFallbackEligible` + `resolveSmrFallbackSelection`; mid-stream failures
     → `event: error` (documented limitation — a half-emitted stream can't restart).
3. **`packages/agentic-sdk-v2/src/compat/types.ts`** — add client-only
   `stream?: boolean` and `onDelta?: (delta: string, accumulated: string) => void` to
   `SMRRequest` and `PreSummaryRequest`. Only `stream` goes on the wire; `onDelta` is
   stripped when building the payload.
4. **`packages/agentic-sdk-v2/src/compat/useSMR.ts`** — extend the `request()` helper:
   when `stream`, send `stream:true` + `Accept: text/event-stream`, read
   `res.body.getReader()`, parse SSE frames (`delta` → `onDelta`, `result` → resolve
   value, `error` → throw `detail`); non-stream branch unchanged. Thread
   `stream`/`onDelta` through `runSync` and `preSummarize`; `onComplete` still fires
   with the final structured object.
5. **Docs** — add a "Streaming (opt-in)" section to
   `docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`
   (SSE event schema `delta`/`result`/`error`, `stream:true` / `onDelta` usage) and the
   four V2-mandatory notes above; cross-link from this README.

### Verification criteria

- `pnpm --filter @arcaai/api test:unit` — smr-compat suite green (new + regression).
- `pnpm --filter @arcaai/vox build test` — useSMR suite green; `.d.ts` emitted.
- `pnpm lint` clean for `apps/api` (hard errors) and `@arcaai/vox`.
- Owner live tail: `curl … -d '{"…","stream":true}'` against a running gateway returns
  `text/event-stream` with `delta`* then a single `result` carrying the v1 body;
  `stream` omitted returns the identical single JSON body as today.

---

## Implementation Summary

Built in two parallel lanes (opus-4-8 API / sonnet-5 SDK) on disjoint packages, then an
owner integration + verification pass. All non-streaming behavior is unchanged.

**API compat — `apps/api/src/modules/smr-compat/`**
- `dto/sync-summary.request.ts`, `dto/pre-summary.request.ts` — added `stream?: boolean`.
- `smr-compat.controller.ts`:
  - **Mandatory tenant-id**: `requireTenantId()` (CLS `tenantId` ?? api-key `tenantId`,
    else `UnauthorizedException('Tenant context is required')`) called first in both
    endpoints; `applySmrModelSelection` / fallback now take a **required** `tenantId` —
    `resolveSmrSelection` is never called with `undefined` (no SYSTEM-default leak).
  - Extracted pure `computeSummary` / `computePreSummary` (return the DTO, TASK-588
    fallback preserved); `@Post` handlers are thin routers using `@Res()`
    (non-passthrough) → `res.json(result)` or the stream branch.
  - `streamGenerate` + `pumpTaskStream`: POST SMR `/generate` with `stream:true` (connect
    retry) → proxy `GET /tasks/:id/stream`; SMR `chunk` → `event: delta {text}`
    (accumulating), `done` → `event: result` (same `mapGenerateToV1*` body as sync),
    failures → single PHI-redacted `event: error`. SSE headers + heartbeat mirror
    `SmrProxyController.streamTaskEvents`. Summary START-failure keeps the TASK-588
    fallback; mid-stream failure → `event: error` (documented; no half-stream restart).

**SDK compat — `packages/agentic-sdk-v2/src/compat/`**
- `types.ts` — client-only `stream?` + `onDelta?` on `SMRRequest` / `PreSummaryRequest`
  (only `stream` goes on the wire).
- `useSMR.ts` — `parseSseFrame` + `requestStream` (sends `stream:true` +
  `Accept: text/event-stream`, reads `body.getReader()`, routes `delta`→`onDelta`,
  `result`→resolve, `error`→throw `detail`), wired through `runSync` / `preSummarize`;
  non-stream path and `onComplete`/`onError` unchanged.

**Cross-lane contract verified**: emit/parse agree on `event: delta|result|error`,
`data: {text}` / full v1 body / `{detail}`, `\n\n`-framed, `data:` space-tolerant.

**Docs**: MIGRATION_GUIDE (TASK-560) gained "Streaming summaries & pre-summaries
(opt-in)" + "Tenant context is mandatory" sections and parity-table notes.

### Verification evidence (owner re-run)
- `pnpm --filter @arcaai/api exec vitest run src/modules/smr-compat` → **Test Files 4
  passed (4); Tests 71 passed (71)** (63 regression + 8 new: tenant×3, streaming×5).
- `pnpm --filter @arcaai/vox exec vitest run src/compat/__tests__/useSMR.test.ts` →
  **Test Files 1 passed (1); Tests 17 passed (17)**; full compat suite 117/117; `build`
  emits the new `.d.ts` fields.
- eslint on all 5 touched source files → **exit 0** (`no-direct-downstream-url-env`
  respected; SMR reached only via `getSmrBaseUrl()`).

### Owner tails
- No `main.ts` change (same excluded POST routes) — nothing to migrate there.
- Staged-not-committed. Live e2e (curl `stream:true` against a running gateway +
  SMR) authored-in-guide but not run against live infra.
- Pre-existing unrelated: full `pnpm --filter @arcaai/api lint` still flags the
  separately-owned `smr-compat/dept-templates.ts` formatting; full `apps/api` `tsc`
  exits 1 on pre-existing drift (both documented, not from this task).
- `summary/async` remains a pre-existing SDK-references-but-no-route gap (out of scope).

## Change History

- 2026-07-31 — Plan authored (TASK-589). Wire-contract decision: `stream:boolean` body
  flag; terminal `result` event carries the exact v1 body. Extended in place on the
  existing `apps/api` `smr-compat` module.
- 2026-07-31 — Owner-directed addition: **mandatory tenant-id enforcement**
  (`requireTenantId()` resolve-or-reject; `resolveSmrSelection` always called with a
  required tenantId — no SYSTEM-default leak).
- 2026-07-31 — **Implemented** (2 parallel lanes) + integrated + gate-verified. API
  71/71, SDK 17/17, lint clean, docs updated. Status → Review; staged-not-committed.
