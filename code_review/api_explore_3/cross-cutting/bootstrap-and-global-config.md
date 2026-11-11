# API Bootstrap & Global Config (Nest/Express) — Related Cross-Cutting Concerns

**Scope:** `project-hope/apps/api/src/main.ts` and directly related bootstrap/config modules  
**Purpose:** Document request-pipeline-adjacent global configuration that is not expressed only as Guards/Pipes/Filters/Interceptors but materially affects request handling.

## 1) Bootstrap-time and app-level configuration (`main.ts`)

| Area | Configuration / behavior | Registration / location | Notes / impact |
|---|---|---|---|
| Env & startup validation | `loadEnv()` then `apiEnv()` schema validation; fails fast before app creation | `main.ts`, `config/env.schema.ts`, `config/env.descriptors.ts` | Prevents boot with invalid env surface; pre-bootstrap reads (`LOG_LEVEL`, `PORT`, shutdown timings) use typed env result |
| Telemetry safety gate | `assertGenaiContentCaptureDisabled()` | `bootstrap/genai-content-capture-audit.ts`, called in `main.ts` | Refuses production boot when OTel GenAI content capture is not pinned off (PHI safety) |
| Crash handling | `registerCrashHandlers(...)` early; logger attached later | `crash-handlers.ts`, `main.ts` | Captures crashes during module graph construction/bootstrap before normal logging is ready |
| Metrics (Express middleware) | `httpResponseMetricsMiddleware()` registered as first `app.use(...)` | `observability/http-response-metrics.ts`, `main.ts` | Counts all responses including guard/middleware short-circuits that Nest interceptors may miss |
| Prisma pool metrics | `installPrismaPoolMetrics()` before `NestFactory.create()` | `observability/prisma-pool-metrics.ts`, `main.ts` | Exposes pool saturation metrics early enough to observe DI warmup queries |
| Body/raw body | `NestFactory.create(AppModule, { rawBody: true, ... })`, plus `applyInternalBodyLimits(app)` | `main.ts`, `bootstrap/internal-body-limit.ts` | Supports signature/raw-body use cases; applies tighter internal limits where needed |
| WebSockets | `app.useWebSocketAdapter(new WsAdapter(app))` | `main.ts` | Native WS adapter (`@nestjs/platform-ws`) for gateway websocket support |
| Global prefix | `app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS)` | `main.ts`, `global-prefix.config.ts` | Standardizes route prefixing/exclusions at app level |
| Swagger (non-prod) | `SwaggerModule.setup('api/v1/docs', app, createHopeOpenApiDocument(app))` when not production | `main.ts`, `swagger.config.ts` | Dev/staging API docs use same document/security derivation as committed spec |
| Session | `express-session` configured with `SecretsService`-backed secret and env-dependent cookie flags | `main.ts` | Session behavior differs by production/development cookie settings |
| Global validation pipe | `app.useGlobalPipes(createGlobalValidationPipe())` | `main.ts`, `filters/validation-violations.ts` | Strict whitelist/forbid-non-whitelisted/forbid-unknown-values validation + structured violation context |
| ETag generation/handling | Express `etag` disabled (`'etag', false`) and `ETagInterceptor` registered globally via `useGlobalInterceptors` | `main.ts`, `interceptors/etag.interceptor.ts` | Prevents weak/unusable auto ETags; emits domain-safe strong validators from `body.version` and supports conditional GET behavior |
| Proxy trust | `trust proxy` intentionally not set | `main.ts` comments | Client IP resolution is handled narrowly (trusted ingress + `CF-Connecting-IP` strategy) rather than trusting forwarded headers globally |
| Graceful shutdown | `app.enableShutdownHooks()` and `GracefulShutdownService` usage | `main.ts`, `services/` (graceful shutdown module/service) | Coordinates orderly shutdown in containerized environments |

## 2) Global Nest provider modules with pipeline impact (`app.module.ts`)

| Module / provider wiring | Kind | Why it matters to request handling |
|---|---|---|
| `ClsModule.forRoot(CLS_MODULE_OPTIONS)` | Global request context | Provides per-request correlation/context consumed by guards/interceptors/services |
| `ThrottleConfigModule` + `TieredThrottlerGuard` (`APP_GUARD`) | Throttling infra | Global pre-auth rate limiting and policy advertisement (with `RateLimitHeadersInterceptor`) |
| `JwtAuthGuardModule` (`JWT_AUTH_GUARD`) and `ServiceAccountAuthenticatorModule` (`SERVICE_ACCOUNT_AUTHENTICATOR`) | Auth wiring dependencies | Enable `UnifiedAuthGuard` to authenticate human/service credentials across modules |
| `TenantContextProviderModule` | DB tenant scoping integration | Connects CLS tenant context to Prisma tenant scoping behavior used by request paths |
| `TenantOwnedResourceModule` | Interceptor + SSE guard support | Registers ownership enforcement for annotated routes and SSE-specific pre-handler checks |
| `ConsentServiceModule`, `OriginRegistryServiceModule`, `ApiKeyServiceModule`, `RateLimitServiceModule`, `EntitlementsServiceModule`, etc. | Root-level guard dependencies | Required because global guards resolve from app injector; importing only in feature modules can silently degrade guard behavior |

## 3) Bootstrap audits / policy guardrails (not request handlers, but enforce API configuration)

`apps/api/src/bootstrap/*` contains startup audits and safety checks that constrain or validate controller/route configuration (examples observed during scan/planning):

- Admin route permission/scope audits (`admin-route-permission-audit.ts`, `admin-scope-audit.ts`)
- API key scope/surface and exemption audits (`api-key-scope-audit.ts`, `api-key-surface-audit.ts`, `business-plane-apikey-exemptions-audit.ts`)
- Service-account surface/token exchange audits (`service-account-surface-audit.ts`)
- Consent route coverage and OCC coverage audits (`consent-route-coverage-audit.ts`, `occ-coverage-audit.ts`)
- CASL enforce/reachability and WS gateway owner audits
- Secret/env safety checks (e.g. JWT placeholder, GenAI content capture)

**Why document these:** they act as compile/startup-time guardrails for cross-cutting security and route-policy correctness, complementing runtime guards/interceptors/filters.

## 4) Related cross-cutting conventions (recommended to keep linked from pipeline doc)

- `@Public()` and authorization decorators (`@Authorize`, permission decorators) interpreted by global auth/authorization flow
- `@TenantOwnedResource(...)` metadata for ownership enforcement (interceptor/SSE guard)
- `@RequiresIfMatch()` + `@ExpectedVersion()` optimistic concurrency contract (request precondition enforcement)
- `@TenantLockExempt()` / consent metadata decorators affecting global guard behavior
- Unified error envelope contract implemented by exception filters + failure logging helpers

## 5) Follow-up opportunities

- Add per-controller tables for scoped `@UseGuards` and upload `@UseInterceptors` if endpoint-level traceability is needed.
- Capture concrete line references in a generated snapshot (`sources/` or `evidence-notes.md`) if this doc will be used for audit/compliance review.
- Document feature-module-specific interceptors/pipes/filters if they are introduced later (current non-test scan shows mostly global + a few scoped guards/interceptors and a custom param pipe).
