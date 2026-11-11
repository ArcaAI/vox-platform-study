# NestJS Request Pipeline (Guards, Pipes, Filters, Interceptors)

**Scope:** `project-hope` API gateway (`apps/api/src`)  
**Inspected from:** `vox-platform-study` workspace, branch `api_explore`  
**Primary sources:** `project-hope/apps/api/src/main.ts`, `app.module.ts`, `filters/global-filters.ts`, `interceptors/index.ts`, `guards/index.ts`, `filters/validation-violations.ts`, scoped decorator scan in `apps/api/src` (non-test)

> This document inventories NestJS cross-cutting request-pipeline configuration and where it is applied (global / controller / method / parameter). Line-level references are omitted where they drift quickly; file paths are the source of truth.

## 1) Execution model and ordering (important)

### Bootstrap / global wiring (`main.ts`)
- Express middleware is registered early (e.g. `httpResponseMetricsMiddleware()` is first `app.use(...)`), before Nest route handling; it can observe responses short-circuited by later middleware/guards.
- Global prefix: `app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS)` (`global-prefix.config.ts`).
- Global validation pipe: `app.useGlobalPipes(createGlobalValidationPipe())` (`filters/validation-violations.ts`).
- Express ETag generation is disabled: `app.getHttpAdapter().getInstance().set('etag', false)`; **generation is replaced** by Nest global interceptor `ETagInterceptor` registered via `app.useGlobalInterceptors(new ETagInterceptor())`.
- WebSocket adapter: `WsAdapter` (`@nestjs/platform-ws`).

### Global providers (`app.module.ts`)
- **Guards (`APP_GUARD`) execute in declaration order** (array in `app.module.ts`).
- **Interceptors (`APP_INTERCEPTOR`)** are registered as providers in `app.module.ts`; Nest applies global interceptors in registration order (and `ETagInterceptor` is additionally registered globally in `main.ts` via `useGlobalInterceptors`).
- **Exception filters (`APP_FILTER`)** are registered from `GLOBAL_EXCEPTION_FILTERS`; Nest consults the **last-registered matching filter first**, so registration order is intentionally widest-to-narrowest.

### Notable load-bearing dependencies
- `UnifiedAuthGuard` must run before guards/interceptors that depend on resolved CLS user/tenant context.
- `TenantLockGuard`, `PatientConsentGuard`, `TenantOwnedResourceSseGuard`, `OriginTenantBindingGuard`, `RequiresIfMatchGuard` are ordered after auth/CLS establishment as documented in `app.module.ts`.
- `TieredThrottlerGuard` runs first (before auth) to reject abusive traffic early.

## 2) Guards inventory

| Guard | Type | Scope | Registration | Order / position (if global) | Applies to / exemptions | Purpose / behavior | Key dependencies / context | Source |
|---|---|---|---|---|---|---|---|---|
| `TieredThrottlerGuard` | Throttle / DoS protection | Global | `APP_GUARD` (`app.module.ts`) | 1st global guard | Default tier gates broadly; stricter/heavier/relaxed tiers opt-in per route (guard implementation) | Rate limiting before heavier auth/tenant resolution | Throttler/Redis config (`ThrottleConfigModule`), request identity | `modules/throttle/tiered-throttler.guard.ts`, `app.module.ts` |
| `ClsGuard` (`nestjs-cls`) | Request context lifecycle | Global | `APP_GUARD` (`app.module.ts`) | 2nd | Framework-provided; runs for requests in CLS context | Establishes/propagates CLS request context | `ClsModule.forRoot(CLS_MODULE_OPTIONS)` | `app.module.ts`, `request-id.ts` |
| `UnifiedAuthGuard` | Authentication / auth entrypoint | Global | `APP_GUARD` (`app.module.ts`) | 3rd (must precede context-dependent guards) | Default deny posture; `@Public()` opts out (metadata), `@Authorize()`/permission decorators layer on top | Unified auth pass (JWT / other configured branches) and context resolution | `JWT_AUTH_GUARD`, `SERVICE_ACCOUNT_AUTHENTICATOR`, CLS/auth services | `@arcaai/applications` (wired in `app.module.ts`) |
| `TenantLockGuard` | Tenant write/restore lock | Global | `APP_GUARD` (`app.module.ts`) | 4th (after auth/tenant resolution) | `@TenantLockExempt()` handlers exempt; denies while tenant restore lock held (fail-closed behavior per comments) | Blocks tenant-context requests during checkpoint restore (`423` / unreadable state handling as implemented) | CLS tenant, tenant lock state | `guards/tenant-lock.guard.ts`, `app.module.ts` |
| `PatientConsentGuard` | Consent / ABAC enforcement | Global | `APP_GUARD` (`app.module.ts`) | 5th (after auth; before precondition guard) | No-op unless route requires consent metadata; enforcement on by default (no kill-switch per code comments) | Enforces patient/consultation consent verdicts for annotated routes | Consent services/repositories, CLS tenant/user, route metadata | `guards/patient-consent.guard.ts`, `app.module.ts` |
| `TenantOwnedResourceSseGuard` | Tenant ownership (SSE-specific) | Global | `APP_GUARD` (`app.module.ts`, from `common`) | 6th (after auth/CLS tenant) | No-op on non-SSE routes | Performs ownership assertion before SSE handler executes (avoids post-stream 404 timing issue) | `@TenantOwnedResource(...)` metadata, CLS tenant/resource lookup | `common/tenant-owned-resource-sse.guard.ts`, `app.module.ts` |
| `OriginTenantBindingGuard` | Origin-to-tenant binding | Global | `APP_GUARD` (`app.module.ts`) | 7th (must remain after auth/CLS tenant) | Requests without resolved tenant/origin conditions pass through per guard logic | Ensures browser `Origin` is bound to the tenant that registered it (control beyond CORS) | CLS tenant, origin registry/config | `guards/origin-tenant-binding.guard.ts`, `app.module.ts` |
| `RequiresIfMatchGuard` | Optimistic concurrency precondition marker | Global | `APP_GUARD` (`app.module.ts`) | 8th | No-op unless route annotated with `@RequiresIfMatch()` metadata | Propagates marker to request so `@ExpectedVersion()` param decorator can enforce `If-Match`/`428` behavior | Reflector metadata | `decorators/requiresIfMatch.guard.ts`, `app.module.ts` |
| `JwtAuthGuard` (`AuthGuard('jwt')`) | JWT strategy adapter | Global token provider (indirect) | `JWT_AUTH_GUARD` provider in `JwtAuthGuardModule` (`@Global`, before `AuthorizationModule`) | N/A (resolved by `UnifiedAuthGuard`) | Used as part of unified auth flow; not a standalone `APP_GUARD` | Passport JWT authentication implementation for unified guard | JWT strategy/secrets/auth service | `guards/jwtauth.guard.ts`, `app.module.ts` |
| `OidcAuthGuard` (`AuthGuard('oidc')`) | OIDC strategy adapter | Implementation available (not seen in global provider wiring scan) | Exported from guards index; registration/use not observed in global `app.module.ts` scan | N/A | Unknown from inspected global wiring (may be feature-specific or unused) | Passport OIDC authentication guard implementation | OIDC strategy/config | `guards/oidcauth.guard.ts`, `guards/index.ts` |
| `InternalTenantLockGuard` | Tenant lock for internal/service endpoints | Controller (scoped) | `@UseGuards(..., InternalTenantLockGuard)` on internal controllers | N/A | Applied to authenticated internal routes (paired with service/harness token guards) | Enforces tenant-lock constraints on internal control-plane endpoints | Tenant lock services, request tenant context | `guards/internal-tenant-lock.guard.ts`, internal controllers (see below) |
| `ServiceReleaseTokenGuard` | Internal service authentication | Controller (scoped) | `@UseGuards(ServiceReleaseTokenGuard, InternalTenantLockGuard)` | N/A | Service-release internal endpoint only (as observed) | Authenticates internal service-release caller | Secrets/token validation | `modules/service-release/service-release-internal.controller.ts` |
| `InternalServiceTokenGuard` | Internal service authentication | Controller (scoped) | `@UseGuards(InternalServiceTokenGuard, InternalTenantLockGuard)` on multiple internal controllers | N/A | Internal-only controllers | Authenticates internal service callers | Secrets/token validation | e.g. `modules/internal/*-internal.controller.ts`, `modules/guardrail-evaluation-internal/...` |
| `HarnessServiceTokenGuard` | Harness/service authentication | Controller / Method (scoped) | `@UseGuards(HarnessServiceTokenGuard, InternalTenantLockGuard)` on harness/internal consultation/speech/governed-prompt endpoints | N/A | Harness/internal routes | Authenticates harness-originated internal requests | Secrets/token validation | e.g. `modules/consultation/harness-internal.controller.ts`, `modules/speech/harness-tts-internal.controller.ts`, `modules/governed-prompt/governed-prompt-internal.controller.ts` |
| `ServiceAccountTokenGuard` | Service-account token endpoint auth | Method (scoped) | `@UseGuards(ServiceAccountTokenGuard)` | N/A | Token exchange/auth endpoint | Guards service-account token issuance/auth path | Service-account auth logic | `modules/service-account/service-account-token.controller.ts` |

**Notes (guards):**
- `SERVICE_ACCOUNT_AUTHENTICATOR` is registered globally in `ServiceAccountAuthenticatorModule` so `UnifiedAuthGuard` can resolve machine-token authentication (dependency wiring, not an `APP_GUARD` by itself).
- Bootstrap audits in `bootstrap/*` reference guard usage/coverage (e.g. service-token guards, admin/API-key surface expectations) and are useful evidence of intended route policy.

## 3) Pipes inventory

| Pipe | Kind | Scope | Registration | Config / options | Purpose / behavior | Throws / errors | Source |
|---|---|---|---|---|---|---|---|
| `ViolationLoggingValidationPipe` (via `createGlobalValidationPipe()`) | Validation (global) | Global | `app.useGlobalPipes(createGlobalValidationPipe())` in `main.ts`; also used in test module wiring in request-failure pipeline tests | `transform: true`, `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true` | Strict DTO validation and mass-assignment protection; attaches structured validation violations for failure logging while preserving client-facing validation behavior | Validation failures (shaped by exception pipeline into API error envelope) | `filters/validation-violations.ts`, `main.ts` |
| `QueueNamePipe` | Route param parse/validation (custom) | Parameter (queue-admin routes, expected) | `PipeTransform` implementation; used as param pipe (scan did not show `@UsePipes`, typical Nest param usage) | Validates against `JobQueue` enum values | Rejects unknown queue names with `404` instead of opaque DI/provider resolution errors | `NotFoundException` | `modules/queue-admin/pipes/queue-name.pipe.ts` |

**Notes (pipes):**
- No scoped `@UsePipes(...)` decorators were found in non-test `apps/api/src` during scan; custom pipe(s) may be applied at parameter level in controllers.

## 4) Exception filters inventory

| Filter | Caught exception(s) | Scope | Registration | Order / priority | Response shape / mapping | Logging / observability behavior | Purpose / notes | Source |
|---|---|---|---|---|---|---|---|---|
| `AllExceptionsFilter` | `@Catch()` (fallback / anything unclaimed) | Global | `APP_FILTER` via `GLOBAL_EXCEPTION_FILTERS` in `app.module.ts` | 1st registered, **last consulted** among specific matches? (wide net; see global order) | Generic 500 / internal envelope (details not exposed to client) | Writes failure/log details via filter pipeline utilities | Terminal fallback for unexpected/non-HTTP errors (including handler/guard-originated non-HTTP cases) | `filters/all-exceptions.filter.ts`, `filters/global-filters.ts`, `app.module.ts` |
| `HttpExceptionEnvelopeFilter` | `HttpException` (and mapped HTTP exceptions) | Global | `APP_FILTER` via `GLOBAL_EXCEPTION_FILTERS` | 2nd registered | Normalizes HTTP exceptions to unified error envelope (`statusCode`, `code`, `message`, `correlationId` pattern per filter implementation) | Emits single request failure line/log context for handled exception | Covers guard-thrown 401/403/429 and mapped exceptions not seen by interceptor-only flows | `filters/http-exception-envelope.filter.ts`, `filters/global-filters.ts` |
| `DataNotFoundExceptionFilter` | Domain/data-not-found exception(s) (implementation-specific) | Global | `APP_FILTER` via `GLOBAL_EXCEPTION_FILTERS` | 3rd registered | Generic 404 response without leaking model name/row identifiers | Structured failure logging per filter pipeline | Prevents information leakage on missing resources | `filters/data-not-found.filter.ts`, `filters/global-filters.ts` |
| `ConsentExceptionFilter` | Consent/ABAC exceptions from `PatientConsentGuard` | Global | `APP_FILTER` via `GLOBAL_EXCEPTION_FILTERS` | 4th registered, narrowest/specific | Maps consent verdict failures (e.g. 403/503 cases per implementation) to API envelope | Structured failure logging per filter pipeline | Handles guard-thrown consent failures (not visible to interceptors in the same way as handler exceptions) | `filters/consent.filter.ts`, `filters/global-filters.ts` |

**Notes (filters):**
- `GLOBAL_EXCEPTION_FILTERS` registration order is load-bearing because Nest checks the last registered matching filter first.
- No scoped `@UseFilters(...)` decorators were found in non-test `apps/api/src` during scan.

## 5) Interceptors inventory

| Interceptor | Type | Scope | Registration | Order / position | Request/response behavior | Applies to / exclusions | Purpose / notes | Source |
|---|---|---|---|---|---|---|---|---|
| `MetricsInterceptor` | Metrics | Global | `APP_INTERCEPTOR` (`app.module.ts`) | 1st in `interceptors` array | Observes request/response lifecycle for handled requests (Nest interceptor scope) | Only requests reaching interceptor pipeline; guard-short-circuited responses are not fully equivalent to middleware metrics | HTTP/route metrics instrumentation | `interceptors/metrics.interceptor.ts`, `app.module.ts` |
| `RateLimitHeadersInterceptor` | Response headers / policy advertisement | Global | `APP_INTERCEPTOR` (`app.module.ts`) | 2nd | Adds rate-limit headers based on data stashed by throttle guard | No-op when guard did not stash policy/limit data | Advertises applied rate-limit policy to clients | `modules/throttle/rate-limit-headers.interceptor.ts`, `app.module.ts` |
| `ContextInterceptor` | Request context enrichment | Global | `APP_INTERCEPTOR` (`app.module.ts`) | 3rd | Enriches request/CLS/logging context during handling | Applies to handled requests in Nest pipeline | Correlates request context for downstream services/logging | `interceptors/context.interceptor.ts`, `app.module.ts` |
| `ExceptionInterceptor` | Exception mapping / normalization (pipeline stage) | Global | `APP_INTERCEPTOR` (`app.module.ts`) | 4th | Catches/maps exceptions from handler/interceptor execution path into forms consumed by global exception filters | Cannot observe exceptions thrown by guards before interceptor chain runs | Bridges domain/service exceptions to HTTP/error pipeline | `interceptors/exception.interceptor.ts`, `app.module.ts` |
| `MaintenanceInterceptor` | Availability / maintenance gate | Global | `APP_INTERCEPTOR` (`app.module.ts`) | 5th | May block/alter behavior when maintenance mode applies (per implementation) | Condition-driven | Enforces maintenance behavior at request handling stage | `interceptors/maintenance.interceptor.ts`, `app.module.ts` |
| `ImpersonationAuditInterceptor` | Audit logging | Global | `APP_INTERCEPTOR` (`app.module.ts`) | 6th | Records/audits impersonation-related activity for requests | Impersonation/context-dependent | Audit trail support for impersonated actions | `interceptors/impersonation-audit.interceptor.ts`, `app.module.ts` |
| `ETagInterceptor` | Caching / conditional requests / validators | Global (bootstrap) | `app.useGlobalInterceptors(new ETagInterceptor())` in `main.ts` (also exported via `interceptors/index.ts`) | Registered at bootstrap after pipes/body-limit/session/CORS setup in `main.ts` (separate from module `APP_INTERCEPTOR` array) | Sets strong ETag from `body.version` on eligible responses; handles conditional GET freshness (`If-None-Match` -> 304) and cache-control behavior as implemented | Only versioned/eligible responses; non-versioned routes pass through | Replaces Express-generated ETags with domain-safe validators aligned with OCC flow | `interceptors/etag.interceptor.ts`, `main.ts` |
| `ConsultationLifecycleVocabularyInterceptor` | Response vocabulary/shape adaptation | Controller / Method (scoped) | `@UseInterceptors(ConsultationLifecycleVocabularyInterceptor)` | N/A | Transforms/adapts consultation lifecycle vocabulary in responses | Applied to consultation/guardrail-notice endpoints where annotated | Keeps API vocabulary consistent for lifecycle-related payloads | `modules/consultation/consultation.controller.ts`, `modules/guardrail-notice/guardrail-notice.controller.ts` |
| `FileInterceptor` (`@nestjs/platform-express`) | Multipart file upload parsing | Method (scoped) | `@UseInterceptors(FileInterceptor(...))` | N/A | Parses single-file multipart upload into handler input; enforces configured limits | Endpoint-specific (consultation attachment, storage, tenant bucket, media, transcription job upload) | Upload ingestion with per-endpoint size limits/config | e.g. `modules/consultation/consultation-attachment.controller.ts`, `modules/storage/storage.controller.ts`, `modules/tenant-bucket/tenant-bucket.controller.ts`, `modules/media/media.controller.ts`, `modules/streaming/transcription-job.controller.ts` |
| `FilesInterceptor` (`@nestjs/platform-express`) | Multipart multi-file upload parsing | Method (scoped) | `@UseInterceptors(FilesInterceptor('files', MAX_FILES))` | N/A | Parses multi-file multipart uploads | Endpoint-specific (voice profile) | Multi-file upload ingestion with max file count | `modules/voice-profile/voice-profile.controller.ts` |

**Notes (interceptors):**
- `TenantOwnedResourceModule` registers `TenantOwnedResourceInterceptor` as `APP_INTERCEPTOR` via `useExisting`/module wiring (ownership enforcement for annotated routes) in addition to the SSE guard; see `common/tenant-owned-resource.module.ts` for exact behavior and ordering assumptions.
- Guard-thrown exceptions bypass the interceptor response chain and are handled by global exception filters.

## 6) Cross-cutting observations / gaps

- **Global vs bootstrap registration split:** `ETagInterceptor` is exported in `interceptors/index.ts` but applied globally in `main.ts` (`app.useGlobalInterceptors`) rather than listed in `app.module.ts`'s `APP_INTERCEPTOR` array.
- **Multiple global guard layers:** some auth-related components are provided as tokens/modules (`JWT_AUTH_GUARD`, `SERVICE_ACCOUNT_AUTHENTICATOR`) consumed by `UnifiedAuthGuard`, while other guards are direct `APP_GUARD`s.
- **Decorator-gated/global guards:** several global guards are effectively conditional (metadata/SSE/resource annotations), so “global registration” does not mean “active logic for every route”.
- **Scoped Nest components found:** controller/method `@UseGuards` and `@UseInterceptors` usages exist (internal/harness/service endpoints and upload endpoints); no scoped `@UsePipes`/`@UseFilters` found in non-test source scan.
- **Custom param pipe:** `QueueNamePipe` exists and should be confirmed per-route in queue-admin controllers if future edits change endpoint signatures.
- **Tests as supporting evidence only:** many `__tests__` files wire guards/pipes/filters/interceptors for isolated scenarios; runtime registration should be confirmed against `main.ts`/`app.module.ts`/module providers.

## 7) Suggested verification checklist for future updates

1. Re-check global wiring in `main.ts` and `app.module.ts` (including order).
2. Re-scan for `APP_*`, `useGlobal*`, and scoped `@UseGuards/@UsePipes/@UseFilters/@UseInterceptors`.
3. Confirm any newly added internal controllers follow intended token-guard + tenant-lock patterns.
4. Review `filters/global-filters.ts` whenever exception mapping/response contract changes.
5. Update this doc when adding/removing guards/interceptors/pipes/filters or changing ordering dependencies.
