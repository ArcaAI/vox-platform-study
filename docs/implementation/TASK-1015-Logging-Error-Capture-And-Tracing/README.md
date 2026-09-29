# TASK-1015: Logging, error capture and end-to-end correlation

**Status:** Review — merged to `dev-2.2`, full gate and live proof run, awaiting owner sign-off
**Type:** refactor + bugfix (observability, PHI hardening)
**Branch:** `dev-2.2` (lanes in worktrees, merged into `dev-2.2` by the orchestrator)
**Base commit at planning:** `818fe7ddf`
**Related:** TASK-987 (`hope_obs` Python logging/tracing standard), TASK-776 (F-03 defect row),
TASK-1013 (observability metric fix — different scope), `docs/operations/observability/python-logging-and-tracing.md`

## Requirement Analysis

Owner request (2026-09-29):

1. Review the logging implementation.
2. Capture more detail for every validation error, error and exception thrown by any endpoint in `apps/api`.
3. Capture more detail for every validation error, error and exception thrown by services (TS services + the six Python services).
4. Correlation id / span id tracing that follows best practice (W3C Trace Context, OTel log↔trace correlation) and fits the existing stack.

Hard constraints: PHI must never reach a log line or an error body (healthcare platform); no new runtime
dependency where an existing helper already does the job (`trace-propagation.ts`, `hope_otel`, `describeCauseForOperator`);
Python stays on `hope_obs` only (rule 06); config rules from rule 00/09 apply (no new env knobs beyond bootstrap).

## Current State Evaluation

Four read-only reviews (Sonnet, one lens each) on 2026-09-29, synthesized by the orchestrator. Three
high-severity claims were re-verified by hand:

- `apps/api/src/app.module.ts:336` — `idGenerator` reads `req.headers['X-Request-Id']`; Node lowercases
  header names, so the CLS id is ALWAYS a fresh uuidv7.
- `packages/applications/src/services/baseServices/logging/logging.service.ts:437` — `setLevel()` only
  assigns `this.level`; `dispatch()` (`:341`) never consults it, so the live log-level knob is inert.
- `packages/domains/src/common/repository.ts:126` — `findFirst` puts `JSON.stringify(props)` (the whole
  where-clause, possibly PHI) into the `DataNotFoundException` message.

Everything else below is reviewer evidence (file:line in the finding ids) not yet re-read line by line; grep
counts are unfiltered for tests.

### Root causes

| # | Root cause | Symptoms | Finding ids |
|---|---|---|---|
| R1 | No single request id | Client `correlationId` ≠ log `requestId` ≠ audit `correlationId`; no `X-Request-Id` response header; not forwarded on internal hops; `Math.random()` proxy fallback; client header unvalidated | TRC-1/5/7/11, API-3, LOG-6 |
| R2 | `LoggingService` never reads CLS or the active span | Most gateway lines lack `traceId`/`requestId`/`tenantId`; Loki→Tempo link dead for them | LOG-2, TRC-2, API-1 |
| R3 | API error-capture gaps | No catch-all filter (bare 500, no id, double log); envelope filter silent (401/403); 429 unlogged; 4xx detail at `debug`; "Request failed" at `error` for every 4xx; no validation property/constraint names | API-1/2/4/5/6/7/12/14 |
| R4 | Errors lose detail | Application exceptions take only `message`; `toJSON` serialises `cause` as `{}`; ~460 `err.message`-only logs; persistence exceptions never raised | SVC-1/2/5/6/8–11, LOG-10 |
| R5 | Silent swallowing | ~123 `.catch(() => null)`; auth lookups turn outages into 404; `token_classifier` `print` + empty result; ~145 Python `except: pass` | SVC-7/13, API-10/11, PY-2/7 |
| R6 | PHI leak paths | Redactor skips `error.cause`; `findFirst` message; Prisma validation messages; consent 403 echoes `externalPatientId`; FastAPI default 422 echoes `input`; guardrail `str(e)` in `detail`; raw ids in Python logs | LOG-3/4/5, SVC-4, API-8/9, PY-1/5/8/11 |
| R7 | Async boundaries break the trace | BullMQ, Dramatiq, TTS WS bridge carry no carrier; workers never `cls.setId`; Temporal gate on the legacy AND flag; `AuditLog` has no `traceId` | TRC-3/6/8/9, SVC-3 |

Also found: `@arcaai/logger` is dead code (winston, no redaction) that `docs/development-patterns-and-standards.md:209`
names as the shared logger (LOG-9); rule 05 F-03 is stale — `PrismaClientExceptionFilter` was removed, not
unwired (API-16); `child()`/`withMeta()` rebuild every transport per call (LOG-8); crash handlers register
after `NestFactory.create`, skip `flushOtel`, and have no flush timeout (LOG-7).

Python (`hope_obs`) is already mostly correct: every line carries `traceId`/`spanId`, httpx peers propagate
`traceparent`, Redis Streams STT and Temporal carry context.

## Owner Decisions (resolved 2026-09-29 — "go with your recommendations")

| # | Decision | Resolution |
|---|---|---|
| OD-1 | Request id vs trace id | Separate edge `requestId` (client-quotable, works with tracing off), stamped on the root span as `hope.request_id`. |
| OD-2 | Log field names | camelCase everywhere (`requestId`, `tenantId`, matching `traceId`/`spanId`). `hope_obs` switches; emits the snake_case aliases for ONE release. |
| OD-3 | Raw ids in logs | `tenantId`/`userId` stay raw (operational). `patientId`/`consultationId`/`externalPatientId` and friends become a stable hash (`redactId`, same algorithm as `hope_obs.phi.redact_id`) instead of `[REDACTED]`. |
| OD-4 | BullMQ propagation | Payload carrier via existing `trace-propagation.ts`; no `bullmq-otel`. |
| OD-5 | `AuditLog.traceId` | Add nullable column + migration. |
| OD-6 | Temporal tracing gate | Move to endpoint-only, gated on `test_replay_compat` passing. |
| OD-7 | `@arcaai/logger` | Delete the package and both workspace deps; fix the docs. |
| OD-8 | Browser → BFF OTel | Deferred. BFF only forwards/originates `x-request-id` and forwards `traceparent`/`tracestate`. |
| OD-9 | Swallowed-error scope | High-risk sites (auth, resolvers, outbox, token classifier) + a lint rule for new bare `.catch(() => null)`; full sweep is a follow-up ticket. |

## Implementation Plan

### Shared contract (fixed before any lane starts — every lane codes against this)

- **Request id.** One value per request, `cls.getId()`. Source: inbound `x-request-id` if it matches
  `^[A-Za-z0-9._-]{1,64}$`, else `uuidv7()`. Set ONLY by the CLS middleware `idGenerator`. Anything else that
  needs it reads `cls.getId()` (`request.requestId` becomes an alias assigned from it in CLS `setup`).
- **CLS keys** read by the logger: `tenantId`, `userId`, `credentialClass` (`jwt` | `apiKey` | `serviceAccount` | `anonymous`).
  Trace ids come from `trace.getActiveSpan()`, never from CLS.
- **Headers.** `X-Request-Id` on every gateway response (incl. guard rejections) and in `CORS_EXPOSED_HEADERS`;
  forwarded on every internal hop next to `X-Tenant-Id`; `traceparent`/`tracestate` W3C. `x-correlation-id` retired.
- **Log line (TS and Python, JSON).** Always `timestamp`, `level`, `service`, `message`. When known: `traceId`
  (32 hex), `spanId` (16 hex), `requestId`, `tenantId`, `userId`. Absent means absent — never `"0"`.
  Errors: `error: { name, message, code?, status?, stack, cause: {…recursive} }`, redacted.
- **Error body (unchanged shape, now universal).** `{ statusCode, code, message, correlationId }` where
  `correlationId === cls.getId()` — for EVERY status, including uncaught 500s.
- **Levels.** 5xx → `error` (with stack); 401/403/404/409/412/428/429 → `warn`; 400 validation → `warn`; pre-auth
  expired-JWT 401 stays `debug`. Exactly ONE failure line per request, written by the terminal filter.
- **Async carrier.** `{ traceparent, tracestate?, requestId }` under the reserved key `_trace` in job data
  (BullMQ) / message `options` (Dramatiq). Consumer restores with `withTraceContext` / `hope_otel` and
  `cls.setId(requestId)`.

### Lanes (disjoint file ownership; each in its own worktree off `dev-2.2`)

| Lane | Owns | Model | Depends on |
|---|---|---|---|
| **A** gateway id + error pipeline | `apps/api/src/app.module.ts` (CLS block), `interceptors/context.interceptor.ts`, `interceptors/exception.interceptor.ts`, `filters/**` (+ new catch-all), `main.ts` (ValidationPipe `exceptionFactory`, crash-handler order), `crash-handlers.ts`, `cors.headers.ts`, `modules/throttle/tiered-throttler.guard.ts`, `unified-auth.guard.ts` (log fields only), `ws` gateways' failure logging, `base-proxy.controller.ts`, `guards/patient-consent.guard.ts` | opus | contract |
| **B** logger core | `packages/applications/src/services/baseServices/logging/**` (service, redactor, transports, `child`/`withMeta`), `redactId` helper | opus | contract |
| **C** exceptions + repository | `packages/exceptions/**`, `packages/domains/src/common/repository.ts` | sonnet | — |
| **D** async propagation | BullMQ enqueue (`redis.service.ts`) + every `WorkerHost` processor's `process()` entry, `sysEvent.service.ts`, `auditLog.processor.ts`, `transcriptionRealtime.service.ts` (Dramatiq enqueue), `tts-ws.gateway.ts` bridge headers, `internal-service-headers.ts`, `apps/admin-console/src/server/**/hope-proxy.ts` allowlists, `audit.prisma` (schema edit only) | sonnet | contract; migration applied by the orchestrator |
| **E** Python | `packages/py-obs/**` (422 handler, WS scope binding, camelCase + aliases, `request.failed` → `error_type`), peer clients (`X-Request-Id` forwarding), `apps/nlp` handlers + `token_classifier.py`, `apps/text/core/exception_handlers.py`, `apps/guardrail` endpoints (`detail` scrub), `apps/stt` worker (`transcribe_file.py` context binding + carrier extract), `apps/harness/temporal/client.py` + `config.py` gate, `redact_id` at the raw-id sites | sonnet (opus reviews the 422 handler) | contract |
| **F** swallowed errors + lint | The OD-9 high-risk `.catch` sites in `packages/applications/src/services/**` (auth, agent-resolver, ai-routing-policy, agent-assignment, model-residency, workflow-definition) and `apps/api/src/modules/auth/auth.controller.ts`, `workflow-ws.gateway.ts:101`, `storage.controller.ts:278`, `text-proxy.controller.ts:1588,1653`; new rule in `packages/eslint-plugin-arcaai-internal` | sonnet | C (`findByIdOrNull` helper) |
| **Orchestrator** | Migration authoring (rule 02 shadow-DB recipe), delete `packages/logger` + deps + `pnpm install`, docs (`development-patterns-and-standards.md:209`, rule 05 F-03, `python-logging-and-tracing.md` field names), merges, the single post-merge gate | — | all |

File conflicts to watch: A and F both touch `apps/api/src/modules/**` — F owns only the listed catch sites;
A owns the WS gateways' *failure-logging* blocks except `workflow-ws.gateway.ts:101` (F). D and A both need
`X-Request-Id` on outbound calls — D owns `internal-service-headers.ts`, A owns `base-proxy.controller.ts`.
Merge order: C → B → A → F → D → E (C first because F imports its helper; B before A so A's tests see CLS-aware logging).

### TDD test list (RED first; each lane runs only its own files — owner rule: no gates before the full merge)

**A** — `apps/api/src/**/__tests__/`
1. CLS id honours a valid lowercase `x-request-id`; rejects `a\nb` and a 65-char id (new uuidv7).
2. Response carries `X-Request-Id` equal to the body `correlationId` — on 200, on a guard 401, on a thrown `TypeError` 500.
3. Catch-all filter: uncaught `Error` → `{statusCode:500, code:'INTERNAL.UNEXPECTED', correlationId}` and exactly ONE `error` log with `error.stack`, route template, `requestId`.
4. Validation 400 logs `violations: [{property, constraints:[names]}]` and never the value.
5. Level by status: 404 → `warn`, 500 → `error`; ContextInterceptor no longer writes a second failure line.
6. 429 from the tiered throttler and the API-key limiter logs `warn` with route template, tier, `retryAfter`.
7. Generic `BaseException` 500 logs at `error` with the cause chain; the client body carries no `cause` and no `stack`.
8. Prisma validation error log contains `code`/`modelName` and not the invocation block.
9. Consent 403 body has no `externalPatientId`.
10. Logs use `req.route.path`, query string stripped.

**B** — `logging/__tests__/`
1. `setLevel('warn')` suppresses `info` on every transport; `setLevel('debug')` enables it.
2. A line logged inside an active span carries that span's `traceId`/`spanId`; inside a CLS context carries `requestId`/`tenantId`/`userId`; explicit meta wins; outside both, the keys are absent.
3. Redactor walks `error.cause` recursively and keeps it (`new Error(msg, {cause})`); a PHI key inside `cause` is redacted.
4. `formatError` emits `code` and `status`.
5. `patientId` is hashed (stable, equals the Python `redact_id` fixture), `tenantId` stays raw.
6. Value-pattern scrub on `message`: email, JWT, bearer token.
7. `child()` does not construct transports (spy on `initializeTransports`).
8. `flush()` resolves within its cap when a transport hangs.

**C** — `packages/exceptions/**/__tests__/`, `packages/domains/src/common/__tests__/`
1. Each application exception accepts `{cause, metadata}` and exposes them.
2. `toJSON()` emits `cause` as `{name, message}` (non-production) and nothing in production.
3. `findFirst` miss: message has the model and filter KEYS only.
4. `updateWithVersion` wraps an unknown Prisma error with `cause`; OCC metadata includes `tenantId`.
5. Prisma `P2002`/`P2025`/connection codes map to the persistence exceptions with `cause`.
6. `findByIdOrNull` returns `null` on `DataNotFoundException` and rethrows anything else.

**D**
1. `queue.add` payload carries `_trace` with the active `traceparent` and `requestId`.
2. A processor's `process()` runs inside the restored span and `cls.getId() === requestId`; an exception raised there has `correlationId`.
3. AuditLog row persists `traceId` and `correlationId` from the enqueue context (also for an event raised before the interceptor).
4. Dramatiq message `options` carries `traceparent`/`requestId`.
5. TTS bridge upstream handshake headers include `traceparent`.
6. `internalServiceHeaders()` includes `X-Request-Id`.
7. BFF proxy forwards `x-request-id` (originating one when absent), `traceparent`, `tracestate`, and returns `x-request-id`.

**E** — each service's tests dir (rule 06 table)
1. Shared 422 handler: body has `loc`/`type`/`msg` and no `input`; log line has `loc`/`type` only.
2. `hope_obs` WS scope binds `requestId`/`tenantId` from handshake headers.
3. Log keys are camelCase plus the snake_case aliases.
4. `request.failed` logs `error_type`, no `str(exc)`.
5. Peer clients (text, nlp, guardrail, harness `api_client`) send `X-Request-Id` from the bound context.
6. `token_classifier` failure logs via `logger.exception` and raises / flags degraded — no empty-success.
7. Guardrail 500/503 `detail` is generic; the log line has the exception type and stack.
8. nlp handlers use stable dotted events.
9. stt `transcribe_file` extracts the carrier and binds `requestId`/`tenantId`; raw ids go through `redact_id`.
10. Temporal client enables `TracingInterceptor` when only the endpoint is set; `test_replay_compat` green.

**F**
1. Each converted site: a `DataNotFoundException` still yields `null`; an infrastructure error is logged and rethrown (or, for documented best-effort sites, logged at `warn`).
2. Lint rule flags `.catch(() => null)` / `.catch(() => [])` / `.catch(() => undefined)` in `services/**` and `apps/api/src/modules/**`; allows it with `// swallow-ok: <reason>`.

### Verification (after all lanes are merged — the one gate)

- `pnpm --filter @arcaai/exceptions test build`, `pnpm --filter @arcaai/domains test build`, `pnpm --filter @arcaai/applications test build`
- `pnpm api:build && pnpm test:unit`, `pnpm lint:all`, `pnpm typecheck:all`
- `pnpm stt:test`, `text:test`, `nlp:test`, `guardrail:test`, `harness:test` (incl. replay-compat), `tts:test`
- `pnpm --filter @arcaai/admin-console build lint test`
- If any route decorator changed: regenerate the five API artifacts (rule 05 DoD).
- Live proof on the running stack: one request through BFF → API → Text → guardrail; the same `requestId`
  on every service's log line, the same `traceId` in Tempo, `X-Request-Id` on the response, and the Loki
  derived field opens the trace. One forced 500 and one validation 400 showing a single log line each.
- Deployment repo (not edited here): confirm the Alloy/Grafana derived field and add a `requestId` link; note
  the alias release so dashboards/alerts move to camelCase.

### Follow-ups (out of scope)

Full swallowed-error sweep (~123 TS + ~145 Python sites); browser/BFF OpenTelemetry (OD-8); removing the
snake_case aliases one release after this lands; the NodeSDK OTLP log exporter (TRC-12) once the collector's
`logs` pipeline is confirmed unused.

## Implementation Summary

Six lanes in worktrees (A, B on Opus; C, D, E, F on Sonnet), merged into `dev-2.2` in the order
C → B → A → F → D → E with no cross-lane file conflicts; the three Python files TASK-1016 also touched
merged cleanly. All six worktrees and branches were removed after the merge was verified.

### What changed, by root cause

| RC | Change | Where |
|---|---|---|
| R1 | One request id per request: `cls.getId()` from a valid inbound `x-request-id` (`^[A-Za-z0-9._-]{1,64}$`) or uuidv7; echoed as `X-Request-Id` on every response (incl. guard rejections), exposed via CORS, = the error body's `correlationId`; forwarded on internal hops (`internalServiceHeaders()` + `requestIdHeader()` for the nine hand-built clients); the BFF forwards/originates it and `traceparent`/`tracestate`. `x-correlation-id` retired in the proxy | `apps/api/src/request-id.ts`, `packages/applications/src/common/internal-service-headers.ts`, `apps/admin-console/src/server/hope-proxy.ts` |
| R2 | `LoggingService` fills `traceId`/`spanId` from the active span and `requestId`/`tenantId`/`userId`/`credentialClass` from CLS; the live log level now gates every transport (root + children); `child()` no longer rebuilds transports; bounded `flush()` | `packages/applications/src/services/baseServices/logging/**` |
| R3 | Catch-all filter; ONE failure line per failed request from the terminal filter (`failure-log.ts`) — 5xx `error` with the Error, 4xx `warn`, expired-JWT 401 `debug`; guards/interceptors attach context to the exception instead of logging; validation lines list `{property, constraints}` never values; 429s logged with limiter/tier/retryAfter; route template, never the raw URL; WS failures via `logWsFailure`; crash handlers first in `main.ts` | `apps/api/src/filters/**`, `interceptors/**`, `unified-auth.guard.ts`, `crash-handlers.ts` |
| R4 | Application exceptions take `{cause, metadata}`; `toJSON()` emits `cause` as `{name, message}` outside production only; `findFirst` miss names model + filter KEYS; OCC metadata carries `tenantId`; `findByIdOrNull` | `packages/exceptions/**`, `packages/domains/src/common/repository.ts` |
| R5 | ~45 high-risk swallow sites: not-found keeps its fallback, anything else is logged and rethrown (documented best-effort sites warn-only); login lookup outage → 503 (401 bodies unchanged); `no-silent-catch` lint rule at `warn` (148 pre-existing violations remain) | lane F files, `packages/eslint-plugin-arcaai-internal/rules/no-silent-catch.js` |
| R6 | Redactor walks and keeps `error.cause`; value scrubbing for email/JWT/bearer; `patientId`/`externalPatientId`/`consultationId` hashed with `redactId` (byte-identical to `hope_obs.phi.redact_id`); MRN/doctorId stay `[REDACTED]`; consent 403 body drops `externalPatientId`; Prisma logs carry code/model, never the invocation; Python: shared PHI-safe 422 (no `input`/`ctx`), guardrail generic `detail`, `redact_id` on raw ids | logger, `exception.interceptor.ts`, `packages/py-obs/src/hope_obs/validation.py`, guardrail/nlp/stt/harness |
| R7 | BullMQ `_trace` + `runJobInContext` (10 processors); Dramatiq `options.hope_trace`; TTS bridge carries `traceparent`/`X-Request-Id`/`X-Tenant-Id`; `AuditLog.traceId` (+ index); Temporal `TracingInterceptor` on the endpoint-only gate (replay-compat green); Python peers forward `X-Request-Id`; WS scopes bind context | `job-context.ts`, `audit.prisma` + migration `20260929144326_task_1015_audit_log_trace_id`, `apps/harness/.../temporal/client.py` |
| OD-2 | Python log keys camelCase (`requestId`, `tenantId`) + snake_case aliases for one release | `hope_obs/logging.py` |
| OD-7 | `@arcaai/logger` deleted (package, deps, Dockerfile COPYs, CI filters/rules, vitest/tsconfig entries); docs/rules name `LoggingService` | commit `899dd1664` |

### Commits (first-parent on `dev-2.2`)

Merges `3854dffd9` (C) · `ec08043f2` (B) · `a9b925767` (A) · `f3dc3f5d4` (F) · `447f51f27` (D) · `7770c5d0e` (E);
then `74470d343` migration · `899dd1664` logger removal · `5a3a90b07` modelTierFor fails closed (owner) ·
`ff4226a3d` + `329244110` gate fixes · `f218ade3a` cross-tenant processors (live-proof finding) ·
`0b2b6152f` + `9f370dcb6` request id on hand-built clients (live-proof findings) · `afebd5ef8` recovered lane C test.

### Verification — the single post-merge gate (HEAD `ff4226a3d`, re-checked after later fixes)

| Check | Result |
|---|---|
| build exceptions / domains / applications / api / admin-console | all rc=0 |
| typecheck exceptions / domains / applications / api / admin-console | all 0 errors |
| unit: exceptions / domains / applications / api / admin-console | 25 · 1995 (+2 skip, 9 todo) · 15295 (+4 skip) · 4656 (+5 skip) · 3764 — all passed |
| lint exceptions / domains / applications / api / admin-console | 0 errors (warnings pre-existing; applications 335 → 300) |
| `no-silent-catch` RuleTester | pass |
| py-obs · parity contract | 96 · 59 passed |
| text · guardrail · harness · tts | 2006 · 569 · 2840 · 483 passed; all Python lints clean |
| stt · nlp | 4127 · 751 passed; remaining failures are PRE-EXISTING (below) |
| migration | shadow DB replay + `migrate diff` → empty migration; `gen:model/entity/factory:check` no drift + coverage OK |

Pre-existing failures, reproduced on the pre-merge commit `cfae6d715` (out of scope): stt
`e2e/test_streaming_sessions_api.py` ×8 (fail with or without `.env.dev`); stt
`test_initialize_creates_session_manager` and nlp `test_metrics_endpoint_task636.py` ×2 fail only when the
local `.env.dev` is present (they reach the running stack's effective-config / read `OTEL_METRICS_ENABLED`).
CI loads no env file.

### Live proof (dev stack: api, text, guardrail, nlp, admin)

- `X-Request-Id: proof-1015-health` echoed; guard 401 → header = body `correlationId`; malformed id replaced.
- Validation 400: ONE `warn` line, `violations=[{property:"extra",constraints:["whitelistValidation"]},{property:"username",constraints:["minLength","isString"]}]`; the submitted value appears nowhere.
- 429: `status=429, limiter=tiered, tier=default, retryAfter, limit=5, windowMs=60000` — previously unlogged.
- End to end `proof-1015-final`: 200 through gateway → text → guardrail → text judge; the same `requestId`
  on 1 gateway line, 11 text lines (incl. the guardrail→text judge hop) and 8 guardrail lines.
- `traceId` absent on dev lines by design: `.env.dev` leaves `OTEL_EXPORTER_OTLP_ENDPOINT` empty, the only
  enable signal. Log↔trace linking is unit-tested; live proof needs a collector (cluster).

Defects the live proof found that no unit test had (all fixed, each with a test):
1. Lane D wrapped two CROSS-TENANT processors in a tenant-less CLS scope → the tenant-scope extension
   refused every query and the usage-outbox drain failed on each run (`f218ade3a`).
2. Nine gateway→service clients assemble headers by hand, so the request id stopped at the gateway (`0b2b6152f`).
3. Guardrail's text-judge client did not forward the id (`9f370dcb6`).

### Owner decisions taken during implementation

| # | Decision |
|---|---|
| OD-10 | `modelTierFor` fails CLOSED: an unreadable tenant plan propagates the error instead of granting the full catalogue tier (owner, 2026-09-29) |
| — | Lane C's repository-level Prisma wrapping was REVERTED before merge: `tenant-allowed-origin`, `context-user-identity` and `usage-outbox.drainer` duck-type raw `P2002`; raw Prisma errors keep propagating |
| — | Accepted as proposed: login lookup outage → 503; STT session-binding lookup outage → 5xx (not 404) |

### Follow-ups (not in this ticket)

- MRN / EMR-number hashing: `redactId` is unsalted, so a short numeric id is brute-forceable. MRN stays
  `[REDACTED]`; `externalPatientId` is hashed — confirm what it holds, or introduce a keyed hash.
- Python tracebacks rendered via `exc_info` still end with the exception message (possible PHI): a PHI-aware
  exception renderer in `hope_obs`.
- Full swallowed-error sweep: 148 `no-silent-catch` violations (TS) + ~145 Python `except: pass`.
- nlp guard routes `HTTPException(detail=str(exc))`, nlp `websocket_manager` f-string logs, remaining stt bare excepts.
- Harness Temporal activities send no `X-Request-Id` (none bound in an activity) — carry it in workflow input.
- Control-plane fetches (`effective_config`, `model_credentials`) don't forward the request id (cached, not request-scoped).
- Remove the snake_case log aliases one release after this lands; move dashboards/alerts to camelCase.
- Deployment repo: confirm the Loki derived field on `traceId`, add a `requestId` link; verify log↔trace live.
- The NodeSDK OTLP log exporter (TRC-12) once the collector `logs` pipeline is confirmed unused; `X-Correlation-ID`
  still accepted in CORS request headers (lane A left it to avoid breaking preflight).
- Browser/BFF OpenTelemetry (OD-8).

## Change History

| Date | Change |
|---|---|
| 2026-09-29 | Ticket created. Four-lens review (logger, API error capture, service error capture, correlation/tracing); root causes R1–R7; OD-1..9 resolved by the owner; lane plan A–F. |
| 2026-09-29 | Lanes A–F implemented and merged; lane C's Prisma wrapping reverted pre-merge; migration, `@arcaai/logger` removal; OD-10 (`modelTierFor` fails closed); post-merge gate fixes; live proof found and fixed three integration defects (cross-tenant CLS scope, hand-built headers ×9, guardrail judge client); lane C's uncommitted test recovered. Status → Review. |
