# TASK-310 — API gateway hygiene sweep (Prisma error mapping, throttle, config, typing)

| Field | Value |
|---|---|
| **Ticket** | TASK-310-API-Gateway-Hygiene-Sweep |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `In Progress` |
| **Classification** | Refactor (hygiene, defense-in-depth, observability) |
| **Priority** | Low — none affect SDK behavior; can be picked up opportunistically |
| **Source** | TASK-307 §10.1 deferrals W7.A.4 + W7.A.9 + W7.A.14 + E-2 + E-5 + E-6 + E-7 + E-8 + E-10 + E-11 |
| **Audit refs** | Audit `04-api-design-review.md` D-6 (Prisma filter shadow) + E-series |
| **Base branch** | `fix/2605-review` (HEAD `2a1ee7be` — TASK-307 closed) |

---

## 1. Requirement Analysis

### 1.1 Description

A grab-bag of low-priority, low-risk hygiene items deferred from TASK-307. None block SDK rollout. Grouped here to amortize ceremony cost. Each sub-task is independently mergeable.

### 1.2 Sub-tasks

| # | Source | Description | Scope |
|---|---|---|---|
| 1 | W7.A.14 | Resolve `PrismaClientExceptionFilter` ↔ `ExceptionInterceptor` shadow — interceptor converts Prisma errors to `HttpException(400)` before the filter runs, collapsing P2002→400 (should be 409), P2025→400 (should be 404). Either remove the redundant filter or widen the interceptor's exclusion list so Prisma errors flow through. | S |
| 2 | W7.A.4 | Atomic `RefreshTokenService.consume()` via Lua script — closes the microsecond race window in single-use rotation. Family-revoke already detects the race today; this makes it impossible. | M |
| 3 | W7.A.9 | `closeStreamSession` ownership refactor — introduce a `StreamSession` resource type with its own `@TenantOwnedResource('sessionId', { lookup: 'session' })` entry so the route-level guard covers it without relying solely on the Prisma `tenantScope` extension. | M |
| 4 | E-2 | Dev CORS: swap `allow-all + credentials: true` (which browsers reject anyway) for a `localhost`-only RegExp so the intent matches the actual surface. | S |
| 5 | E-5 | Migrate direct `process.env.SMR_URL` reads in `smr-proxy.controller.ts:114-116` and `health.controller.ts:38-63` to typed `ConfigService.getOrThrow('downstream.smr.url')`. | S |
| 6 | E-6 | Add a `RequestWithAuth` interface narrowing `request.apiKey` / `request.user` / `request.tenantId`. Prevents typo-rendered authentication bypasses (`request.aip_key` silently undefined → no rejection). | S |
| 7 | E-7 | `MetricsInterceptor` Prometheus cardinality fix — fall back to `<route-untemplated>` instead of raw `request.url` when `route.path` is unset. Or omit the metric entirely. | S |
| 8 | E-8 | Register the Swagger `addApiKey(...)` scheme in `DocumentBuilder` so existing `@ApiSecurity('api-key')` annotations have a backing definition. | S |
| 9 | E-10 | `request.requestId = request?.body?.requestId ?? uuidv7()` blindly trusts client body. Source from `X-Request-Id` header only; fall back to generated UUIDv7. | S |
| 10 | E-11 | `UserController.bulkDelete` iterates without transaction or partial-failure semantics. Wrap in `$transaction(callback)` so partial failures roll back; or return per-id status. | S |

### 1.3 Business context

Defense-in-depth and observability polish. Item #1 (Prisma error mapping) is the highest-value — if/when the SDK does optimistic-concurrency UX or duplicate-prevention, it'll want proper 409s. Items #4/#5/#6/#9 are server-side hygiene that prevents future foot-guns. Items #2/#3 are minor security hardening with working defense-in-depth today.

### 1.4 Acceptance criteria

Each sub-task is gated by its own AC; the implementation plan splits them into ~10 surgical PRs that can land independently.

- **AC-1 (W7.A.14)** P2002 → 409, P2014 → 400, P2003 → 400, P2025 → 404 visible at the controller boundary. New integration test asserting each Prisma error code maps to the expected HTTP status.
- **AC-2 (W7.A.4)** `consume()` uses a Lua script that atomically reads-and-marks-used. Race-replay unit test verifies no double-spend under concurrent invocation.
- **AC-3 (W7.A.9)** `closeStreamSession` carries `@TenantOwnedResource('sessionId', { lookup: 'session' })`. The decorator entry knows how to resolve a `sessionId` to its owning `tenantId`. E2E test: cross-tenant `closeStreamSession` → 404.
- **AC-4 (E-2)** Dev CORS uses `origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`. Production CORS unchanged.
- **AC-5 (E-5)** Zero direct `process.env.{SMR,STT,TTS,NLP}_URL` reads in `apps/api/src/modules/**`. ESLint rule (custom or `no-process-env` with allow-list) added to enforce. Configuration goes through a `DownstreamServiceConfig` interface.
- **AC-6 (E-6)** `RequestWithAuth` interface defined in `apps/api/src/types/request-with-auth.ts`. Used as the typed `req` parameter in all controllers + guards + interceptors that read auth context.
- **AC-7 (E-7)** Prometheus `http_requests_total` metric only emits with templated `route.path`. Unset-route requests use `<unmatched>` label or omit the metric.
- **AC-8 (E-8)** `DocumentBuilder.addApiKey(...)` called in `apps/api/src/main.ts` Swagger bootstrap. Generated OpenAPI spec includes the security scheme.
- **AC-9 (E-10)** `request.requestId = request.headers['x-request-id'] ?? uuidv7()`. The body field is ignored.
- **AC-10 (E-11)** `UserController.bulkDelete` wrapped in `databaseService.client.$transaction(async (tx) => ...)` OR returns `{ succeeded: [...], failed: [...] }` shape.

### 1.5 Out of scope

- `User.tenantId` legacy column migration (E-9 / F-6) — tracked in TASK-306 §H-4 / multi-tenant user follow-up.
- Per-tenant throttling (F-2 / F-11) — separate ticket.
- Anything that requires schema migration.

---

## 2. Current State Evaluation

### 2.1 Existing code

- `apps/api/src/filters/prisma.filter.ts` — has 27-line TSDoc explaining the shadow (TASK-307 W7.A.14).
- `apps/api/src/interceptors/exception.interceptor.ts` — current shadower; needs an exclusion list for `PrismaClientKnownRequestError`.
- `packages/applications/src/services/auth/refresh-token.service.ts` — `consume()` is read-mark-use today.
- `apps/api/src/modules/streaming/transcription-job.controller.ts:closeStreamSession` — has TSDoc explaining the sessionId-vs-jobId mismatch (TASK-307 W7.A.9).
- `apps/api/src/modules/streaming/smr-proxy.controller.ts:114-116` — direct `process.env.SMR_URL`.
- `apps/api/src/modules/health/health.controller.ts:38-63` — direct `process.env.SMR_URL` / `STT_URL` / `TTS_URL` / `NLP_URL`.
- `apps/api/src/interceptors/context.interceptor.ts` — assigns `request.requestId`.
- `apps/api/src/modules/users/user.controller.ts:bulkDelete` — iterating without transaction.
- `apps/api/src/main.ts` — Swagger `DocumentBuilder` bootstrap.

### 2.2 Risk

- Each sub-task is independent. Pick whichever is most useful at the moment of implementation. The grouping is administrative, not architectural.

---

## 3. Implementation Plan

### 3.1 Phase order

Not strictly ordered — each sub-task is independent. Suggested by impact:

1. **W7.A.14 / AC-1** — highest user-visible value (proper HTTP status codes).
2. **E-6 / AC-6** — preempts a class of bugs in future controller additions.
3. **E-5 / AC-5** — config hygiene, sets up ESLint rule.
4. **E-2 / AC-4** — dev CORS sanity.
5. **E-10 / AC-9** — small client-trust fix.
6. **E-7 / AC-7** — observability cleanup.
7. **E-8 / AC-8** — Swagger doc completeness.
8. **W7.A.4 / AC-2** — atomic `consume()`.
9. **W7.A.9 / AC-3** — `closeStreamSession` refactor.
10. **E-11 / AC-10** — `bulkDelete` transaction.

### 3.2 Testing

- Each sub-task adds its own unit + (where relevant) E2E test.
- New ESLint rule for E-5: `no-direct-downstream-url-env`.
- Race-replay test for W7.A.4 uses `Promise.all([consume(token), consume(token)])` and asserts exactly one resolves and the other 401s.

### 3.3 Estimated scope

- 8 × S sub-tasks: ~12h total
- 2 × M sub-tasks (W7.A.4 + W7.A.9): ~10h
- **Total**: M-L (~22h)

---

## 4. Implementation Summary

### 4.1 Sub-task status

| # | Sub-id / AC | Status | Notes |
|---|---|---|---|
| 1 | W7.A.14 / AC-1 | Completed | Code-to-status mapping moved into `ExceptionInterceptor` (the registered handler); filter remains as dead-code defense-in-depth with updated TSDoc. 5 new tests pin P2002→409, P2025→404, P2003/P2014→400, default→400, no-leak. |
| 2 | E-6 / AC-6 | Pending | — |
| 3 | E-5 / AC-5 | Pending | — |
| 4 | E-2 / AC-4 | Pending | — |
| 5 | E-10 / AC-9 | Pending | — |
| 6 | E-7 / AC-7 | Pending | — |
| 7 | E-8 / AC-8 | Pending | — |
| 8 | W7.A.4 / AC-2 | Pending | — |
| 9 | W7.A.9 / AC-3 | Pending | — |
| 10 | E-11 / AC-10 | Pending | — |

---

## 5. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Ticket created from TASK-307 §10.1 deferrals (W7.A.4 + W7.A.9 + W7.A.14 + E-2 + E-5 + E-6 + E-7 + E-8 + E-10 + E-11) | — |
| 2026-05-28 | W7.A.14 / AC-1: map Prisma error codes to proper HTTP status in `ExceptionInterceptor` (P2002→409, P2025→404, P2003/P2014→400, default→400). Updated filter TSDoc to reflect that the live mapping is in the interceptor. | `apps/api/src/interceptors/exception.interceptor.ts`, `apps/api/src/interceptors/__tests__/exception.interceptor.test.ts`, `apps/api/src/filters/prisma.filter.ts` |
