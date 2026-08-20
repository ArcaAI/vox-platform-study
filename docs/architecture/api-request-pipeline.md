# API Gateway — Request → Response Pipeline (`apps/api`)

**Scope:** the NestJS 11 gateway (`apps/api`, port 8868). Describes every layer a request
crosses from socket to response body, in the order it actually executes.

Companion diagram: [`api-request-pipeline.drawio`](./api-request-pipeline.drawio).

---

## 1. Execution order (the contract)

NestJS fixes the order, and it is the single most load-bearing fact on this page:

```
Express middleware
  → Guards            (APP_GUARD, in declaration order)
  → Interceptors      (pre-handler, APP_INTERCEPTOR, in declaration order)
  → Pipes             (global ValidationPipe + param decorators)
  → Route handler     (controller → application service → repository → Prisma)
  → Interceptors      (post-handler, in REVERSE order)
  → Exception filters (APP_FILTER — only on a throw)
```

Two consequences the codebase depends on:

- **Guards run before interceptors.** So a `UnifiedAuthGuard` 401/403 never reaches
  `ExceptionInterceptor`. That is why `HttpExceptionEnvelopeFilter` (a *filter*) exists —
  it is what puts `code` + `correlationId` on the highest-volume error class on the gateway.
  Same reason `ConsentExceptionFilter` exists for `PatientConsentGuard`'s throws.
- **Filter precedence is last-registered-wins** among matching `APP_FILTER` providers, so the
  catch-all envelope filter is registered **first** and the two specific filters after it.

---

## 2. Bootstrap (before any request) — `src/main.ts`

Ordered, and each step is a gate:

| # | Step | Effect |
|---|---|---|
| 1 | `loadEnv()` | env file by `NODE_ENV`; host env > file > default; no file in CI/production |
| 2 | `assertGenaiContentCaptureDisabled()` | refuses to boot in prod if OTel GenAI content capture is on (PHI) |
| 3 | `apiEnv()` (zod) | validates the declared env surface; throws once, listing every problem |
| 4 | `NestFactory.create` | `rawBody: true`, buffered logs, custom `ILoggingService` |
| 5 | `WsAdapter` | native `ws` adapter for the WebSocket gateways |
| 6 | `setGlobalPrefix('api/v1')` | only `/metrics` is excluded → internal routes live at `/api/v1/internal/*` |
| 7 | Swagger | `/api/v1/docs`, **non-production only** |
| 8 | `SecretsService` warm + `assertJwtSecretNotPlaceholder` | refuses to boot on a placeholder `JWT_SECRET_KEY` |
| 9 | `express-session` | secret from `SecretsService`, not `process.env` |
| 10 | Global `ValidationPipe` | `transform + whitelist + forbidNonWhitelisted + forbidUnknownValues` |
| 11 | `set('etag', false)` | kills Express's weak auto-ETag — unusable as a precondition |
| 12 | `useGlobalInterceptors(new ETagInterceptor())` | the **only** ETag this API emits |
| 13 | `enableShutdownHooks()` + `GracefulShutdownService` | OTel flush + service-release heartbeat registered as cleanup callbacks |
| 14 | `enableCors(buildCorsOptions(nodeEnv))` | `credentials: false`; allow-list is the `TenantAllowedOrigin` table, consulted per request; registry unavailable ⇒ deny |
| 15 | Security-header middleware | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy`, CSP on `/api/v1/docs` only |
| 16 | **Boot audits** (below) | each one can refuse to start the process |
| 17 | keep-alive tuning | `keepAliveTimeout = 65s`, `headersTimeout = 66s` — must outlive the upstream proxy idle timeout |

### Boot audits (fail-fast authorization gates)

All in `src/bootstrap/`. They turn "a decorator was forgotten" from a production
authorization hole into a startup error:

- `auditAdminRoutePermissions` — every HTTP route has `@Public()` **or** a permission decorator.
- `auditApiKeyRequiredScopes` — the SDK summarization surface keeps its `@RequiredScopes`.
- `auditInternalRoutesOffApiKeySurface` — no `/internal/*` route is reachable via ordinary JWT/API-key auth.
- `auditAdminControllersDeclareNoApiKeyScopes` + `auditAdminScopedControllers` — `/admin/*` is JWT-only (policy A2); every admin controller is `@ForbidApiKey()`.
- `auditEveryApiKeyReachableRouteDeclaresScopes` — no non-public route is left undeclared.
- `auditBusinessPlaneApiKeyExemptions` — each `@ForbidApiKey()` outside `admin/` is a named, reasoned exemption.
- `auditConsentRouteCoverage` — every `:patientId` route carries `@RequiresConsent` or `@ConsentExempt`.
- `auditServiceAccountSurface` — the third credential class hasn't leaked into the other two planes (checks B–H).
- `auditWebSocketGatewayOwnerBinding` — the only audit that walks **providers**, because Nest registers gateways as providers and every `.controllers` sweep is blind to them.
- `auditCaslEnforcePairReachability` — an "enforced" CASL pair must actually be able to produce its 403.
- `auditOptimisticConcurrencyCoverage` — **WARN-only**: reports version-bearing PATCH/PUT routes without `@RequiresIfMatch`.

---

## 3. Layer-by-layer, per request

### 3.1 Express middleware
CORS preflight → security headers → `express-session`. Runs before Nest knows which route
was hit, so it never sees route metadata.

### 3.2 Guards — `APP_GUARD`, declaration order (`src/app.module.ts`)

Order is enforcement, not style. Each entry below states what breaks if it moves.

| # | Guard | Role | Ordering constraint |
|---|---|---|---|
| 1 | `TieredThrottlerGuard` | Redis-backed tiered rate limiting. Only the `default` tier gates every route; `strict`/`heavy`/`relaxed` are opt-in. | **First** — reject abuse before the expensive auth + CLS work |
| 2 | `ClsGuard` | opens the CLS (async-local) request context | before anything that writes CLS |
| 3 | `UnifiedAuthGuard` | **the** authn+authz pass: replaces JwtAuthGuard + ApiKeyGuard + EitherAuthGuard + AuthorizationGuard. Deny-by-default; `@Public()` is the only opt-out. Writes user/tenant into CLS. | before every guard that reads CLS tenant/user |
| 4 | `PatientConsentGuard` | consent/ABAC choke point; reads tenant+user from **CLS, never `request.ability`** (the API-key path builds no CASL ability) | after auth, **before** the OCC guard — a consent denial must not reach the If-Match check |
| 5 | `TenantOwnedResourceSseGuard` | re-runs the ownership assertion **before** the handler for `@Sse()` routes — the global interceptor's 404 comes too late once the stream is open | after auth (needs CLS tenantId) |
| 6 | `OriginTenantBindingGuard` | binds a browser `Origin` to the tenants it is registered for, via `IOriginRegistry.allows(origin, tenantId)`. Gated by `origin.enforcementEnabled` (defaults false ⇒ pass-through). | after auth — placed earlier it silently degrades to a no-op and no test fails |
| 7 | `RequiresIfMatchGuard` | propagates the `@RequiresIfMatch()` marker onto `req._requiresIfMatch`; `@ExpectedVersion()` then throws **428** when `If-Match` is absent | last; costs one `Reflector` lookup on unannotated routes |

#### `UnifiedAuthGuard` branches — three credential classes

`canActivate` is memoised per request (the guard runs twice: once as `APP_GUARD`, once via
`@Authorize()`'s `@UseGuards`). **Ambiguous credentials are rejected before either branch runs** —
presenting two classes at once is never silently resolved to one.

| Branch | Header | Scope namespace | CASL principal | Reaches `/admin/*`? |
|---|---|---|---|---|
| Service account | `X-Service-Account-Token` | `svc:*` | the **account itself** | yes — the only machine path that can |
| API key | `X-API-Key` | `api:*` scopes | the key's **bound human** | never (`@ForbidApiKey()` checked first, unconditionally) |
| JWT | `Authorization: Bearer` (or `?ticket=` single-use stream ticket, in `JwtAuthGuard`) | — | the user | yes |

Notes that bite:
- Scopes bind the **credential**; abilities bind the **bound principal**. They compose as AND — a credential can never exceed its human.
- No scope declaration ⇒ deny-by-default 403 for both machine classes.
- There is deliberately **no `?token=` query-parameter credential path**. The supported browser `EventSource` path is `?ticket=<single-use ticket>`.
- Service-account `workingTenantId` binds at **token exchange**, so `X-Tenant-Id` is never sent alongside it.
- CASL instance checks (`@ResolveSubjectInstance`) run shadow unless the pair is in `CASL_ENFORCED_PAIRS`; enforcement can only ever **narrow** the type-level verdict.

### 3.3 Interceptors — `APP_INTERCEPTOR`, declaration order

Pre-handler in this order; post-handler in reverse.

| # | Interceptor | Pre | Post |
|---|---|---|---|
| 1 | `MetricsInterceptor` | stamps start time | records `method/path/status/duration`; unmatched routes collapse to the `<unmatched>` label to bound Prometheus cardinality |
| 2 | `ContextInterceptor` | fills CLS request context (correlation id, user, tenant) | — |
| 3 | `ExceptionInterceptor` | — | maps domain exceptions → HTTP: `DataNotFoundException` 404, `OptimisticConcurrencyException` **412**, `QuotaExceededException`/`SpendLimitExceeded` 409, `ArgumentInvalidException` 400, downstream failures via `classifyDownstreamFailure` (+ `Retry-After`). **This is also where Prisma mapping actually happens** — `PrismaClientExceptionFilter` is never wired (defect F-03) |
| 4 | `MaintenanceInterceptor` | throws **503** when `isMaintenance` is set in the AppSettings cache | — |
| 5 | `ImpersonationAuditInterceptor` | — | fire-and-forget audit event when the JWT carries `impersonatedBy` |
| + | `TenantOwnedResourceInterceptor` (from `TenantOwnedResourceModule`) | — | 404-over-403 posture for `@TenantOwnedResource(...)` handlers; no-op elsewhere |
| + | `ETagInterceptor` (registered in `main.ts`, so it wraps all of the above) | serves `If-None-Match` → **304** | renders a **strong** `ETag` from `body.version`; `Cache-Control: private, no-cache` on authenticated GETs; non-versioned routes untouched |

### 3.4 Pipes
Global `ValidationPipe` with `whitelist + forbidNonWhitelisted + forbidUnknownValues` — an
undeclared DTO field **rejects the request** (mass-assignment protection). Every accepted field
must be declared with `class-validator` + `@ApiProperty` on a DTO in `@arcaai/applications`.
`@ExpectedVersion()` (param decorator) resolves here and is what throws the 428.

### 3.5 Handler → data
```
Controller (no logic, no Prisma)
  → I*Service token (application service, extends BaseService)
    → Domain repository (@arcaai/domains)
      → Extended Prisma client  [tenant-scope injection + soft-delete filter]
        → PostgreSQL
```
Side-channels off the handler: `broadcastSysEvent` → `SysEventService` → BullMQ (audit log,
user activity, webhooks); Redis; Vault; and the Python peers (Text/STT/NLP/Guardrail/Harness)
reached with `X-Service-Token` + `X-Tenant-Id`, with downstream URLs from
`IConfigService.getConfigValue(...)` — never `process.env`.

### 3.6 Exception filters — `APP_FILTER`

Registration order matters (last-registered wins among matches):

1. `HttpExceptionEnvelopeFilter` — `@Catch(HttpException)`, the catch-all normalizer; adds `code` + `correlationId`. Registered first **on purpose**.
2. `DataNotFoundExceptionFilter` — generic `404 { message: "Resource not found" }`, dropping model name + row id.
3. `ConsentExceptionFilter` — `ConsentDenied` → 403, `ConsentUnavailable` → 503, for the guard-thrown case interceptors can't see.

---

## 4. Optimistic concurrency (OCC), end to end

```
_version  →  ETagInterceptor emits strong ETag "<n>"
          →  client replays it as If-Match
          →  RequiresIfMatchGuard marks the request
          →  @ExpectedVersion() : header wins over body; missing ⇒ 428
          →  repository.updateWithVersion(id, entity, expectedVersion)
          →  drift ⇒ OptimisticConcurrencyException ⇒ ExceptionInterceptor ⇒ 412
```

## 5. Non-HTTP entry points

- **WebSocket** — `WsAdapter`; `SttWsGateway` at `/ws/stt/stream`. Gateways are Nest *providers*, so the controller-sweeping boot audits do not see them; `auditWebSocketGatewayOwnerBinding` covers them instead.
- **SSE** — `@Sse()` routes; ownership asserted **pre-stream** by `TenantOwnedResourceSseGuard`. `ETagInterceptor` no-ops once `headersSent` is true.
- **`/metrics`** — excluded from the global prefix; Prometheus scrape.
- **Workers** — BullMQ consumers and the Vault rotation worker run off the HTTP path entirely.

## 6. Posture summary

| Concern | Rule |
|---|---|
| Auth default | deny; `@Public()` is the only opt-out, boot-audited |
| Cross-tenant access | **404**, never 403 |
| Privilege failure | **403** (distinct from the above) |
| Missing precondition | **428**; version drift **412** |
| Maintenance mode | **503** |
| CORS | not a tenant boundary — `OriginTenantBindingGuard` is |
| Downstream URLs | `IConfigService` only; direct `process.env` reads are lint-banned |
| Controller → Prisma | hard lint error |

## 7. Known defects pinned by tests (do not "fix" the tests)

`F-01` empty-PATCH commits when `updatedBy` transitions · `F-02` pagination echoes `limit: 0`
· `F-03` `PrismaClientExceptionFilter` never wired · `F-04` `@ForbidApiKey()` inert on 6
`@Public()` routes · `F-05` no `IsUUID` in sampled request DTOs · `F-06` Prisma `P2025`→404
unreachable on OCC write paths. See `.claude/rules/05-nestjs-api.md`.
