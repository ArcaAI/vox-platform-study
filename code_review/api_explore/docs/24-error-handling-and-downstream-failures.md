# 24. Error Handling and Downstream Failures

**Sources:** [`apps/api/src/filters/`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters), [`apps/api/src/interceptors/exception.interceptor.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/interceptors/exception.interceptor.ts), [`apps/api/src/README.md`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)

Errors are normalized at two boundaries: the **interceptor** (handler pipeline) and the **filters** (guards/early failures). The goal is consistent envelopes, no topology leakage, correct statuses, and exactly one failure log line per request.

## Filter Chain (order and responsibility)

`GLOBAL_EXCEPTION_FILTERS` (registration order) means **last registered runs first**:

| Filter | Catches | Purpose |
|---|---|---|
| `AllExceptionsFilter` (`@Catch()`) | Everything else | Terminal safety net. Maps body-parser `entity.too.large` → `413` (`REQUEST.PAYLOAD_TOO_LARGE`). Other errors → `500` (`INTERNAL.UNEXPECTED`). Generic body, never leaks exception details. Only handles HTTP context. |
| `HttpExceptionEnvelopeFilter` (`@Catch(HttpException)`) | `HttpException`s not caught by domain filters | Normalizes **every** `HttpException` (including those from guards like `UnifiedAuthGuard`, throttlers, `OriginTenantBindingGuard`, `RequiresIfMatchGuard`) into the unified envelope. Adds missing `code`, `statusCode`, `correlationId` (additive only). Lifts raw string bodies into `{message: ...}`. Calls `logRequestFailure` once. |
| `DataNotFoundExceptionFilter` (`@Catch(DataNotFoundException)`) | `DataNotFoundException` | Returns generic `404 Resource not found` (never leaks model/id). Used for repository `findById` misses; cross-tenant access uses `NotFoundException` directly as 404-over-403. |
| `ConsentExceptionFilter` (`@Catch(ConsentDeniedException, ConsentUnavailableException)`) | Consent exceptions | Required because guards run before interceptors — `PatientConsentGuard` throws in `canActivate()` and never reaches `ExceptionInterceptor`. Maps to `403` / `503`, strips `externalPatientId` from metadata, uses unified envelope. |

## ExceptionInterceptor Responsibilities

[`ExceptionInterceptor`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/interceptors/exception.interceptor.ts):

- **Prisma**: maps `PrismaClientKnownRequestError` by code to RFC-correct statuses (P2002 → 409, etc.); sanitizes messages (`err.message`/`meta` never reach client). Logs code/model/first line. `PrismaClientValidationError` → 400 with `error` log level.
- **Validation**: transforms class-validator array messages into structured body with `code: VALIDATION.FAILED` and `details: subErrors`.
- **Optimistic concurrency**: `OptimisticConcurrencyException` → `412 Precondition Failed`, body carries `PERSISTENCE.CONCURRENCY_CONFLICT`, increments `optimisticLockConflictTotal` (route-labeled).
- **Domain exceptions**: maps `DataConflictException` → 409, `DataNotFoundException` → 404, `Consent*` → 403/503, `QuotaExceededException`/`SpendLimitExceededException` → 402/429 as appropriate, `InvalidStateTransitionException` → 409, `QueryFailedException` → 400, `DatabaseConnectionException` → 503, `ProviderCredentialVetoedException` → 401.
- **Downstream failures (safety net)**: if error is not `HttpException`/`BaseException`, classifies via `classifyDownstreamFailure` and builds body via `buildDownstreamErrorBody`. Runs **last** so services that already map keep their behavior. Sets `Retry-After` on 503.
- **Post-processing**: ensures `correlationId` present on object responses; adds `code` fallback to plain `HttpException`s; propagates `attachFailureLogContext` data.

## Downstream Failure Classification

[`filters/downstream-error.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/downstream-error.ts):

**Classification:**
- Walks error + `cause` chain + `AggregateError.errors` (depth ≤ 5). Transport causes: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `ENETDOWN`, `EPIPE`, `ECONNABORTED`, `EADDRNOTAVAIL`, `EPROTO`, undici errors (`UND_ERR_*`), etc. Also matches transport substrings in messages.
- If upstream answered with HTTP status: 5xx → `upstream_server_error`, 4xx → `upstream_client_error`, 2xx/3xx → `null` (mapping bug).

**Status mapping:**
| Kind | Status | Notes |
|---|---|---|
| `transport` | `503 Service Unavailable` | Peer unreachable; RFC 9110 §15.6.4. Sets `Retry-After: 5` seconds. |
| `upstream_server_error` | `502 Bad Gateway` | Gateway reached peer, peer returned 5xx. No `Retry-After`. |
| `upstream_client_error` | propagate upstream 4xx (else 502) | Caller's request rejected by upstream; body still sanitized. |

**Client-facing body (`buildDownstreamErrorBody`):**
```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "Note generation is temporarily unavailable. Please try again.",
  "code": "GATEWAY.DOWNSTREAM_UNAVAILABLE",
  "correlationId": "..."
}
```
- Message names the **capability** derived from route path (e.g., Note generation, Speech synthesis, Transcription, AI text analysis, Text), never host/port/IP/URL.
- `capabilityForPath` matches ordered regexes against the route template/path.

**Topology redaction:**
- `containsTopology()` detects URLs, IPv4/IPv6+port, `host:port`, stack frames, file paths, errnos, `AxiosError`/`AggregateError`/`node_modules`.
- `redactTopology()` replaces with `[redacted-url]`, `[redacted-address]`, `[redacted-path]` (errnos may remain as reasons for operators in specific cases).
- Operator logs get full cause details via `describeCauseForOperator()`; client bodies never include topology.

## Unified Error Envelope

[`filters/error-envelope.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/error-envelope.ts):

- Shape: `{ statusCode, code, message, correlationId, details?, metadata? }`
- `toUnifiedErrorBody()` is **purely additive** — fills missing keys, never overwrites existing ones.
- `httpCodeForStatus()` maps statuses to stable codes like `HTTP.NOT_FOUND`, `HTTP.BAD_REQUEST`, etc. (domain exceptions keep their own codes).
- Validation uses `VALIDATION_ERROR_CODE = 'VALIDATION.FAILED'` with `subErrors` preserved and also placed in `details`.

## Failure Logging

[`filters/failure-log.ts`](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters/failure-log.ts):

- **Exactly one** failure line per failed request, written by the filter that produces the response.
- Components attach context via `attachFailureLogContext(exception, ctx)` using the global symbol `Symbol.for('hope.failureLogContext')` so guards/interceptors outside `apps/api` can participate.
- Level: 5xx → `error`, 4xx → `warn` (can be overridden via context).
- Fields: `requestId`, `method`, `route` (template, never raw URL), `status`, `code`, `errorName`, `durationMs`, `tenantId`, `userId`, `credentialClass`, plus attached context.
- Prisma logs include code/model/first line of message (no query text).
- `logRequestFailure()` is idempotent per request.

## 404-over-403 (Cross-Tenant)

- **Repositories** throw `DataNotFoundException` on miss; `DataNotFoundExceptionFilter` returns generic `404 Resource not found` (no model/id).
- **Cross-tenant guards/checks** (e.g., `assertEqualTenants`, webhook controller patterns) throw `NotFoundException("Resource not found")` directly. This prevents existence leakage across tenants.
- **SSE**: `TenantOwnedResourceSseGuard` prevents opening cross-tenant streams with `200`.
- **Context**: `ContextInterceptor` rejects `x-tenant-id` header divergence from JWT tenant with `400`.

## Retry-After

`Retry-After: 5` is set for all `503 Service Unavailable` responses, whether raised directly or produced by downstream classification. `DOWNSTREAM_RETRY_AFTER_SECONDS = 5`.

## Key Invariants

1. **Call sites throw causes, boundary builds bodies.** Downstream classification happens in interceptor/filters, not scattered across controllers.
2. **No topology in client responses.** Hosts, ports, IPs, URLs, stack traces, file paths are redacted/omitted.
3. **Guards are covered.** `HttpExceptionEnvelopeFilter` normalizes guard exceptions because interceptors don't run before guards.
4. **One log line.** Upstream components attach context; terminal filter logs once.
5. **Additive envelopes.** Existing fields preserved; missing fields filled.
6. **404-over-403.** Cross-tenant access is indistinguishable from not found.
7. **Downstream mapping is correct.** Transport unreachable ≠ bad request; upstream 5xx ≠ downstream 4xx.

## References
- [apps/api/src/filters/](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/filters)
- [apps/api/src/interceptors/exception.interceptor.ts](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/src/interceptors/exception.interceptor.ts)
- [apps/api/README.md](https://github.com/ArcaAI/project-hope/tree/dev-2.2/apps/api/README.md)
