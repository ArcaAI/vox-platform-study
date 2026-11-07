# Code Walkthrough — From Process Start to a Handler

**Target:** `project-hope/apps/api` (HOPE API Gateway)  
**Companion docs:** [01 — What are the APIs?](file:///Users/apple/repos/VOX/review/api_explore_2/01-WHAT-ARE-THE-APIS.md) · [02 — Controllers & Call Trees](file:///Users/apple/repos/VOX/review/api_explore_2/02-API-CONTROLLERS-AND-CALL-TREES.md) · [06 — Observability](file:///Users/apple/repos/VOX/review/api_explore_2/06-OBSERVABILITY-AND-LOG-TRACING.md) · [08 — Local Debugging](file:///Users/apple/repos/VOX/review/api_explore_2/08-LOCAL-DEBUGGING-PLAYBOOK.md)

> **Line numbers are a reading aid, not a contract.** Every anchor below also names the symbol, so if code moves, search the symbol. Paths are relative to `project-hope/`.

---

## 0. What this document is (and is not)

The gateway serves **818 routes** from **148 controllers** in **77 feature modules**. A literal line-by-line trace of all of them would be a copy of the source. This document does the opposite:

1. Traces **every stage the process executes once**, from the launcher to the listening socket, with the lines that run at each stage.
2. Traces **the complete request pipeline** — the code every one of the 818 routes shares.
3. Traces **four representative endpoints line by line**, one per shape:
   - a read (`GET /consultations/:id`),
   - a write with a detached tail (`POST /consultations/:id/stop`),
   - a machine/service route (`POST /internal/stt/segments`),
   - a WebSocket stream (`/ws/stt/stream`).
4. Gives a **recipe** for tracing any of the other routes in minutes.

The architectural invariant to keep in mind throughout:

```text
apps/api/src/modules/**            ← transport: controllers, guards, DTOs
packages/applications/src/**       ← business rules, orchestration, events
packages/domains/src/**            ← entities + repositories
packages/database/src/**           ← Prisma client, extensions, schema
```

The gateway itself contains **no business rules and no direct Prisma queries**. A controller validates, authorizes, and delegates. Everything below `packages/applications` is where the work happens.

### 0.1 Presenter's 10-minute path

If you are presenting rather than reading, this is the talk track. Each row maps to a section you can put on screen.

| Time | Show | Say |
|---|---|---|
| 0:00–0:01 | §1 diagram | "One process, three layers: bootstrap, composition, pipeline. Everything else is a specialization." |
| 0:01–0:03 | §2 + §3 | "`instrumentation` runs before `main` because tracing must patch `pg` before the app imports it. `main` validates env, builds the graph, installs transport/security, runs ~15 fail-fast audits, then listens. No route is reachable until `app.listen`." |
| 0:03–0:05 | §4 | "`app.module.ts` is the real composition root. Eight guards in a fixed order, eight interceptors, four filters. Order is the security model; several guards depend on it and silently degrade if moved." |
| 0:05–0:06 | §5 | "Every request takes the same path: middleware → CLS → router → guards → interceptors → pipes → handler. Guards run before interceptors, which is why refusals are counted by Express middleware, not the interceptor metric." |
| 0:06–0:08 | §6 + §7 | "A read does two DB reads and emits two `ResourceViewed` events: one to authorize, one to hydrate. A stop returns before its detached tail drains the live note, so 200 does not mean drained." |
| 0:08–0:09 | §8 + §9 | "The internal STT route is the one API-key path through `/internal/*`; a tenant pin is only safe because a constant-time platform secret is checked first. The WebSocket bypasses HTTP guards entirely and hand-rolls origin, single-use ticket, tenant+owner binding, and the restore lock." |
| 0:09–0:10 | §10 + §11 | "Failures converge on one envelope and one failure line, keyed by `X-Request-Id` that exists before guards. For the other 814 routes, read the decorators as pipeline instructions and follow the interface token." |

Leave on the last slide: **guards establish who and which tenant; interceptors shape the response; filters shape the failure; the business rules live below the gateway.**

---

## 1. The whole trip on one page

```text
SHELL
  node --import ./dist/instrumentation.js dist/main.js
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 1. instrumentation.ts        OTel SDK starts on import (L66)         │
│                              auto-instrumentation patches http/pg/…  │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. main.ts module scope      registerCrashHandlers() (L48)           │
│                              bootstrap() begins (L50)                │
│    pre-Nest                  loadEnv → env schema → pool metrics     │
│    NestFactory.create        builds the DI graph, warms secrets      │
│    transport                 WS adapter, prefix, Swagger, pipes      │
│    security/semantics        session, ETag, CORS, headers, shutdown  │
│    boot audits               ~15 fail-fast structural checks         │
│    listen                    keep-alive > proxy idle, app.listen     │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. app.module.ts             composition root                        │
│    imports: [...common, ...featureModules]                           │
│    providers: [...interceptors, ...guards, ...filters]               │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
   ┌──────────────────────────── REQUEST ────────────────────────────┐
   │ socket → Express middleware → router → global guards            │
   │   → route guards → interceptors (pre) → pipes                   │
   │   → controller handler → application service → repository       │
   │   → interceptors (post) → response                              │
   │                                                                 │
   │ any throw → exception filters → uniform error envelope          │
   └─────────────────────────────────────────────────────────────────┘
```

---

## 2. Stage 1 — Before `main.ts`: `instrumentation.ts`

### 2.1 Why this runs first

Production start command (`apps/api/package.json`):

```json
"start:prod": "node --import ./dist/instrumentation.js dist/main.js"
```

`--import` is a Node ESM preload. It executes `instrumentation.ts` **before** `main.js` is evaluated. That is load-bearing: OpenTelemetry auto-instrumentation must monkey-patch `http`, `pg`, `ioredis`, and Prisma **before** any application module imports them, or the patches miss the module instances the app later uses.

Dev mode (`nest start --watch`) does not use the preload, but `main.ts:29` imports `flushOtel` from `./instrumentation`, so the module is evaluated anyway (at import time): the telemetry plan is resolved and, when enabled, `sdk.start()` runs. The ordering guarantee is weaker in dev; production is the strict path.

### 2.2 What it executes

| Lines | Symbol | What happens |
|---|---|---|
| 13–24 | imports | OTel SDK, auto-instrumentations, OTLP gRPC exporters, Prisma instrumentation, `resolveTelemetryPlan`. |
| 14–18 | `diag` | If `OTEL_DEBUG=true`, turn on the OTel diagnostic logger. |
| 25 | `resolveTelemetryPlan(process.env)` | Decides whether telemetry is enabled and which exporters are configured. **Explicit opt-in; no localhost fallback.** |
| 32–65 | `new NodeSDK({...})` | Builds the SDK: resource (`service.name`, `service.version`), trace exporter, log exporter + batch processor, auto-instrumentations, Prisma instrumentation. |
| 66 | `sdk.start()` | Registers instrumentations and starts the batch processors. From this point, outbound HTTP/DB/Redis calls can be traced. |
| 90–97 | `flushOtel()` | `sdk.shutdown()` with a console marker. Called later from Nest's shutdown sequence (`main.ts:266`), not from a competing `SIGTERM` handler. |

**Design note:** there is deliberately **no `process.on('SIGTERM')` here**. The comment at L74 explains that a second signal handler raced Nest's graceful shutdown. OTel flush is registered as a cleanup callback inside `GracefulShutdownService` instead, so there is exactly one shutdown coordinator.

### 2.3 Crash handlers are registered even earlier

`main.ts:48`, at module scope — before `bootstrap()`:

```ts
const crashHandlers = registerCrashHandlers(undefined, { flushOtel });
```

`crash-handlers.ts` installs `uncaughtException` / `unhandledRejection` handlers. Until a logger is attached (`main.ts:128`), a crash is written to stderr as **one JSON line**; afterwards it goes through `ILoggingService`. Every crash path flushes the logger and OTel, bounded by `DEFAULT_FLUSH_TIMEOUT_MS = 2_000` (`crash-handlers.ts:19`).

This exists because a failure during module construction (a secret that fails to warm, a provider that throws) used to die silently: `NestFactory.create` had not returned, so no Nest logger existed yet.

---

## 3. Stage 2 — `main.ts`, block by block

`main.ts` is 499 lines. It contains **no routes and no business logic**. Its only job is to turn a module graph into a listening, observable, fail-fast process. The table below covers every executable block.

### 3.1 Pre-Nest: environment and telemetry gates (L48–L112)

| Lines | Call | What it does / why here |
|---|---|---|
| 48 | `registerCrashHandlers(undefined, { flushOtel })` | Process-level crash capture before anything can throw. |
| 50 | `async function bootstrap()` | Entry. The final line of the file (`499`) calls `bootstrap()`. |
| 64 | `loadEnv()` | Reads the env file for `NODE_ENV` **into `process.env`**, without overriding existing vars. Must run before `LOG_LEVEL`, `PORT`, `SHUTDOWN_*` are read, because those are consumed before Nest's `ConfigService` exists. |
| 72 | `assertGenaiContentCaptureDisabled()` | Production PHI guard: refuses to boot unless OTel GenAI content capture is pinned off. Deliberately placed immediately after `loadEnv()` so it fails on the most direct check, not as a generic schema error. |
| 82 | `apiEnv()` | Validates the entire declared env surface (zod, built from the settings registry). Throws **one** error listing every problem, before any port is bound. Returns the typed env used below. |
| 96 | `installPrismaPoolMetrics()` | Publishes pg pool saturation. Must be **after** `loadEnv()` (metric prefix comes from `OTEL_SERVICE_NAME`) and **before** `NestFactory.create()` (the DI warmup issues the process's first queries; a later observer misses them). |
| 100 | `process.env.NO_COLOR = '1'` | Steers Nest's built-in logger. |
| 103–108 | `getLogLevels()` | Maps `LOG_LEVEL` to Nest `LogLevel[]` (`info` → `log`). |
| 110–112 | `nodeEnv`, `isProduction`, `isDevelopment` | Branch switches used later. |

**Failure semantics:** any throw here propagates out of `bootstrap()`. Node prints it; the process exits **before** a port is bound. There is no partially-started gateway.

### 3.2 Nest creation and transport (L116–L165)

| Lines | Call | What it does / why here |
|---|---|---|
| 116–121 | `await NestFactory.create(AppModule, {...})` | **The composition happens here.** Nest reads `@Module` metadata, constructs every provider in dependency order, resolves `APP_GUARD` / `APP_INTERCEPTOR` / `APP_FILTER`, and instantiates controllers. It does **not** mount routes or run `onModuleInit` yet — those happen at `listen()` → `init()` (L484). `bufferLogs: true` holds log output until the custom logger is installed; `rawBody: true` preserves raw bodies (webhook signatures); `forceCloseConnections` is dev-only so hot reload does not hang. |
| 124–125 | `app.get(ILoggingService)` → `app.useLogger(...)` | Replaces the buffered Nest logger with the application logger. Buffered boot logs are flushed through it. |
| 128 | `crashHandlers.attachLogger(loggingService)` | From now on crashes are structured log lines, not raw stderr. |
| 146 | `app.use(httpResponseMetricsMiddleware())` | **First `app.use`, deliberately.** It counts every response on `res.on('close')`, including 429/401/403 produced by guards and responses short-circuited by session/CORS/security middleware. `MetricsInterceptor` cannot see those because guards run before interceptors. The authoritative response counter is `…_http_responses_total`; `…_http_requests_total` means "reached a handler". |
| 149 | `applyInternalBodyLimits(app)` | Mounts a 2 MB JSON parser **only** on `/api/v1/internal/guardrail/evaluations`, ahead of Nest's default parser. Every other route keeps the 100 kB default. |
| 153 | `app.useWebSocketAdapter(new WsAdapter(app))` | Native `ws` adapter. No Socket.IO. WebSocket routes are **not** under the HTTP global prefix. |
| 155–156 | `port`, `globalPrefix` | `env.PORT`, `API_GLOBAL_PREFIX` (`api/v1`). |
| 158 | `app.setGlobalPrefix('api/v1', { exclude: ['/metrics'] })` | Every HTTP route is mounted under `/api/v1` except `/metrics`. The prefix lives in `global-prefix.config.ts` so the offline OpenAPI emitter and the live server cannot drift. |
| 160–165 | `SwaggerModule.setup('api/v1/docs', ...)` | Non-production only. Uses the **same** document builder and security derivation as the committed `openapi.json`, so the dev UI cannot show different lock icons from the published reference. |

**What "NestFactory.create" actually did inside:** `ConfigModule.forRoot()` loaded config; `SecretsModule`'s async factory warmed `COMMON_SERVICE_WARMUP_KEYS`; the Prisma client was constructed with the tenant-scope and soft-delete extensions; `ClsModule` was configured; every feature module's controllers were registered. By the time L116 returns, the first DB queries have already happened (which is why pool metrics had to be installed at L96).

### 3.3 Secrets, session, validation, ETag (L173–L251)

| Lines | Call | What it does / why here |
|---|---|---|
| 173 | `app.get(SecretsService)` | The cache is already warm from the module factory. |
| 181 | `assertJwtSecretNotPlaceholder(secretsService)` | Refuses to boot if `JWT_SECRET_KEY` is the literal placeholder or never warmed. Mirrors `JwtStrategy`'s own check (defense in depth). |
| 185–197 | `secretsService.getSecret('SESSION_SECRET_KEY')` → `app.use(session({...}))` | Express session. `secure` in production, `httpOnly` elsewhere, 24 h cookie. The secret comes from the secrets service, **not** `process.env`. |
| 206 | `app.useGlobalPipes(createGlobalValidationPipe())` | `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`. Any DTO key not declared on the class is rejected at the HTTP boundary. The custom pipe also attaches a structured `violations` list (property path + constraint names, never the submitted value) for the failure log. |
| 223 | `getInstance().set('etag', false)` | Disables Express's automatic **weak** ETag generation. Reason: ~70 % of GETs have no `version`, so a replayed `If-Match` either fails the strong-validator check or is silently ignored and the write proceeds. Advertising no validator is safer. |
| 251 | `app.useGlobalInterceptors(new ETagInterceptor())` | The only ETag the API emits: an RFC 7232 **strong** ETag derived from `body.version`, plus `If-None-Match → 304` and `Cache-Control: private, no-cache` on authenticated GETs. Non-versioned routes pass through unchanged. |

**`trust proxy` is intentionally not set** (comment L225–L243). The ingress chain is Cloudflare → cloudflared → Traefik → pod, so `X-Forwarded-For` names the cloudflared pod, not the browser. Client IP is resolved narrowly through `packages/applications/src/common/client-ip.ts` only when the socket peer is a declared ingress.

### 3.4 Shutdown, CORS, headers, audits, listen (L256–L496)

| Lines | Call | What it does / why here |
|---|---|---|
| 256 | `app.enableShutdownHooks()` | Activates `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown` for Kubernetes/Docker termination. |
| 259 | `app.get(GracefulShutdownService)` | The single shutdown coordinator. |
| 266 | `registerCleanupCallback('otel-flush', flushOtel)` | OTel flush runs inside Nest's shutdown sequence, after readiness closes and connections drain. |
| 274–278 | `startServiceReleaseRegistration(...)` | Fire-and-forget self-registration + heartbeat. Bounded timeout, failures swallowed and logged — it must never block or fail boot. The handle's `stop()` is registered as a cleanup callback. |
| 291 | `app.enableCors(buildCorsOptions(nodeEnv))` | CORS options are built in `cors.config.ts` (`credentials: false`). The allow-list is the `TenantAllowedOrigin` table, consulted **per request** through `OriginRegistryService`; there is no static env allow-list and no fallback. If the registry is unavailable, browser origins are denied. |
| 295–308 | security-header middleware | `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`. CSP is only set for `/api/v1/docs` so API responses and SDKs are not broken. |
| 343–357 | CORS posture log | Logs only **static** facts. It deliberately does not claim whether enforcement is currently on, because the settings cache is not warm yet; `PlatformKnobsBinder` announces the authoritative posture later, on `app-settings.cache-refreshed`. |
| 365–460 | boot audits | See table below. Each one **throws** on failure, which exits the process before `listen`. |
| 480–482 | `keepAliveTimeout = 65_000`, `headersTimeout = 66_000` | Keeps the server's idle timeout **longer** than the upstream proxy's. Node's 5 s default races a pooled client: the server closes a socket the client still thinks is usable, and the next request gets an RST / 502. `headersTimeout` must stay strictly greater. |
| 484 | `await app.listen(port)` | Binds the port, finalizes route registration, starts accepting. **This is the first moment a request can arrive.** |
| 487–496 | startup log | Environment, port, Swagger URL, health URL. |

### 3.5 The fail-fast audits (L365–L460)

These run **after** the module graph exists and **before** `listen`. They are the reason a missing decorator is a boot failure rather than a production authorization hole.

| Line | Audit | Refuses to start when… |
|---|---|---|
| 365 | `auditAdminRoutePermissions(app)` | Any HTTP route lacks both `@Public()` and a permission decorator (`@Authorize` / `@CanXxx`). |
| 371 | `auditApiKeyRequiredScopes()` | Any route on the SDK's day-1 summarization surface lost its `@RequiredScopes(...)`. |
| 378 | `auditInternalRoutesOffApiKeySurface(app)` | Any `/internal/*` route is reachable through ordinary JWT/API-key auth instead of a dedicated platform guard. |
| 383 | `auditAdminControllersDeclareNoApiKeyScopes(app)` | Any `/admin/*` route declares `@RequiredScopes` (admin is JWT-only). |
| 388 | `auditAdminScopedControllers()` | A named admin controller is not pinned `@ForbidApiKey()` (catches a controller disappearing from the graph). |
| 397 | `auditEveryApiKeyReachableRouteDeclaresScopes(app)` | Any non-`@Public()` route declares neither `@RequiredScopes` nor `@ForbidApiKey`. |
| 405 | `auditBusinessPlaneApiKeyExemptions(app)` | A non-admin route forbids API keys without being a named, reasoned exemption. |
| 412 | `auditConsentRouteCoverage(app)` | Any `:patientId` route lacks `@RequiresConsent` or `@ConsentExempt`. |
| 434 | `auditServiceAccountSurface(app)` | A service-account token leaks into `/admin/*`, an `/internal/*` route declares `svc:*`, an `svc:*` scope has no live admin area, `/admin/service-accounts` lacks both forbid-decorators, `POST /auth/service-token` is not `@Public()` + guarded, or an admin route declares both/neither of `svc:*` and `@ForbidServiceAccount`. |
| 443 | `auditWebSocketGatewayOwnerBinding(app)` | A `@WebSocketGateway()` class is not classified in `WS_OWNER_BOUND_GATEWAYS`. This is the **only** audit that walks `moduleRef.providers`, because Nest registers gateways as providers, not controllers. |
| 454 | `auditCaslEnforcePairReachability(app)` | A pair in `CASL_ENFORCED_PAIRS` cannot actually produce the 403 it claims (e.g. the resolver throws before the deny path), or an enforced pair is on an OR-mode route. |
| 460 | `auditOptimisticConcurrencyCoverage(app)` | **Warn-only.** Reports version-bearing PATCH/PUT routes without `If-Match`; does not refuse boot, because closing that gap is a client migration. |

---

## 4. Stage 3 — `app.module.ts`, the real composition root

`main.ts` starts the process; `app.module.ts` decides what exists.

```ts
// app.module.ts:616–620
@Module({
  imports: [...common, ...featureModules],
  providers: [...interceptors, ...guards, ...filters],
})
export class AppModule {}
```

### 4.1 `common` — imported first, order matters

`common` (L330–L449) is not a grab-bag. The sequence is the dependency order the global guards need. Selected entries:

| Line | Module | Why it is at the root |
|---|---|---|
| 331 | `LoggingServiceModule` | `ILoggingService` must exist for `main.ts:124`. |
| 332 | `GracefulShutdownModule` | Shutdown coordinator used at `main.ts:259`. |
| 338 | `ClsModule.forRoot(CLS_MODULE_OPTIONS)` | Request-scoped CLS. Middleware is mounted at app init; `setup` runs **before any guard**, so `request.requestId`, CLS `correlationId`, and the `X-Request-Id` response header exist even for a guard rejection. |
| 343 | `ThrottleConfigModule` | Named throttlers + Redis/in-memory storage; exports `TieredThrottlerGuard` deps. |
| 347 | `OriginRegistryServiceModule` | `OriginTenantBindingGuard` is an `APP_GUARD` and resolves from this injector. |
| 352 | `CoreDatabaseModule` | Prisma client with extensions; also needed by `PatientConsentGuard` to load a consultation's `patientId`. |
| 356 | `ConsentServiceModule` | Exports `IConsultationConsentService`, the `assertConsent` choke point. |
| 360 | `RateLimitServiceModule` | Live rate-limit settings for `TieredThrottlerGuard`. |
| 364 | `EntitlementsServiceModule` | Per-tenant plan tiers for the same guard. |
| 371–372 | `ApiKeyServiceModule`, `ServiceAccountServiceModule` | The machine-credential lanes the throttler and `UnifiedAuthGuard` resolve. |
| 373–374 | `ScheduleModule.forRoot()`, `EventEmitterModule.forRoot()` | Cron sweeps and in-process domain events. |
| 381–382 | `BlobStorageModule.forRoot()`, `RedisServiceModule.register(queueNames)` | One blob provider factory; one Redis/BullMQ registration for every queue. |
| 383–387 | `ObservabilityModule`, audit + retention modules | Metrics, audit log outbox, scheduled purges. |
| 391–401 | Consultation lifecycle, timeout sweep, attachments, fact ledger, feedback rollup, history | The clinical plane's background workers and services. |
| 443 | `TenantContextProviderModule` | Supplies the CLS tenant to the Prisma tenant-scope extension. Until it loads, the extension treats every query as super-admin pass-through (safe for CLI/seed). |
| 448 | `TenantOwnedResourceModule` | Registers `TenantOwnedResourceInterceptor` as an `APP_INTERCEPTOR`; no-op unless the handler is annotated. |

### 4.2 Global guards — execution order is the security model

`guards` (L202–L269), executed **in declaration order**:

| # | Guard | File | Effect |
|---|---|---|---|
| 1 | `TieredThrottlerGuard` | `apps/api/src/modules/throttle/tiered-throttler.guard.ts:163` | Rejects abusive traffic **before** auth work. Default tier gates every route; strict/heavy/relaxed are opt-in. `handleRequest` at L192. |
| 2 | `ClsGuard` | `nestjs-cls` | Establishes the CLS context for the request. |
| 3 | `UnifiedAuthGuard` | `packages/applications/src/authorization/unified-auth.guard.ts:377` | The authentication fork. `canActivate` L404 → credential detection L404–521 → service-account branch L560, API-key branch L689, JWT branch L896. Sets CLS user/tenant; enforces scopes and CASL instance checks (L1018). `@Public()` is the only opt-out. |
| 4 | `TenantLockGuard` | `apps/api/src/guards/tenant-lock.guard.ts` | While a tenant restore holds the lock, every request in that tenant is `423 TENANT_RESTORE_IN_PROGRESS` unless `@TenantLockExempt()`. Fails closed (503) if lock state is unreadable. Must run **after** auth (it reads CLS tenant). |
| 5 | `PatientConsentGuard` | `apps/api/src/guards/patient-consent.guard.ts` | Consent/ABAC for `@RequiresConsent(...)`. No-op on routes without it. Enforcement is unconditional — there is no kill switch. Must run after auth and **before** the OCC check. |
| 6 | `TenantOwnedResourceSseGuard` | `apps/api/src/common/tenant-owned-resource-sse.guard.ts` | Re-runs the ownership assertion **before** an SSE handler opens the stream. The interceptor version throws too late for SSE (headers already sent). No-op on non-SSE routes. |
| 7 | `OriginTenantBindingGuard` | `apps/api/src/guards/origin-tenant-binding.guard.ts` | Binds a browser `Origin` to the tenant that registered it. **This is the tenant-isolation control for browser callers**; CORS only decides who may talk. Must run after auth because it reads CLS tenant. |
| 8 | `RequiresIfMatchGuard` | `apps/api/src/decorators/requiresIfMatch.guard.ts` | Copies the `@RequiresIfMatch()` marker onto `req._requiresIfMatch`; the `@ExpectedVersion()` param decorator then enforces `428` when the header is missing. |

> **Why the comments are so emphatic about order:** several of these guards silently degrade to no-ops if moved. `OriginTenantBindingGuard` placed before auth reads an empty CLS tenant, passes every request, and still looks installed. That is why the order is documented in the module, not just in a wiki.

### 4.3 Global interceptors — outermost to innermost

`interceptors` (L157–L185) plus `TenantOwnedResourceModule` (L448) plus the one appended in `main.ts:251`:

| # | Interceptor | File | Role |
|---|---|---|---|
| 1 | `MetricsInterceptor` | `apps/api/src/interceptors/metrics.interceptor.ts:19` | Duration histogram + `http_requests_total` for requests that **reach** a handler. |
| 2 | `RateLimitHeadersInterceptor` | `apps/api/src/modules/throttle/rate-limit-headers.interceptor.ts:46` | Advertises the applied policy from what the throttler stashed. Cheap. |
| 3 | `ContextInterceptor` | `apps/api/src/interceptors/context.interceptor.ts:10` | Resolves the active tenant, attaches request/route/span attributes, records duration on the failure line. Rejects an `x-tenant-id` that diverges from the authenticated principal. |
| 4 | `ExceptionInterceptor` | `apps/api/src/interceptors/exception.interceptor.ts:46` | Maps domain errors to `HttpException`s with stable codes. Guards run before interceptors, so guard errors never reach it. |
| 5 | `MaintenanceInterceptor` | `apps/api/src/interceptors/maintenance.interceptor.ts:6` | Maintenance-mode gate. |
| 6 | `ImpersonationAuditInterceptor` | `apps/api/src/interceptors/impersonation-audit.interceptor.ts:23` | WORM audit row when an admin impersonates a user. |
| 7 | `TenantOwnedResourceInterceptor` | `apps/api/src/common/` (via `TenantOwnedResourceModule`) | Generic row-ownership check for `@TenantOwnedResource(...)`. No-op otherwise. |
| 8 | `ETagInterceptor` | `apps/api/src/interceptors/etag.interceptor.ts:92` | Appended by `useGlobalInterceptors` at `main.ts:251`. Strong ETag, conditional GET, cache headers. |

Controller- and method-level `@UseInterceptors(...)` wrap **inside** this global chain. For example `ConsultationController` has `@UseInterceptors(ConsultationLifecycleVocabularyInterceptor)` at L318, so status projection happens before `ETagInterceptor` hashes the body.

### 4.4 Global filters — resolution is last-registered-first

`GLOBAL_EXCEPTION_FILTERS` is mapped at `app.module.ts:290`. With multiple `APP_FILTER` providers, Nest consults the **last registered matching** filter first. The registration order (widest net first) is therefore the resolution order reversed:

| Registration order | Filter | Claims |
|---|---|---|
| 1 | `AllExceptionsFilter` (`@Catch()`) | Anything nothing else claims: `TypeError`, non-HTTP errors from guards. Returns generic `500 INTERNAL.UNEXPECTED`; detail goes to the log, never the body. |
| 2 | `HttpExceptionEnvelopeFilter` (`@Catch(HttpException)`) | Every `HttpException`, including guard 401/403/429 and errors mapped by `ExceptionInterceptor`. |
| 3 | `DataNotFoundExceptionFilter` | The generic 404 that withholds model name and row id. |
| 4 | `ConsentExceptionFilter` | `PatientConsentGuard` verdicts (403/503). |

Every filter writes the same envelope (`{ statusCode, code, message, correlationId }`) and exactly one failure line via `filters/failure-log.ts`.

### 4.5 `featureModules` — 77 modules, 148 controllers

`featureModules` (L452–L606) is the route surface. A few order-sensitive entries:

- `SecurityPolicyModule` **before** `GlobalSettingModule` (L528–L531), so the static `admin/settings/catalog` route registers before `admin/settings/:id`.
- `ConsultationModule` (L488) brings `ConsultationController` and its lifecycle services.
- `InternalModule` (L536) brings `SttInternalController`.
- `WorkflowsModule` (L605) is the public workflow exposure plane, gated off by default (`WORKFLOW_EXPOSURE_ENABLED`).
- `PrismaStudioModule` is pushed conditionally at L612–614 (`ENABLE_PRISMA_STUDIO=true`), never in the base graph.

---

## 5. Stage 4 — The HTTP request pipeline

Everything below is shared by all 818 HTTP routes. The endpoint traces in §6–§9 are specializations of this skeleton.

### 5.1 The ordered path

```text
 0. TCP socket (keep-alive 65 s, headers timeout 66 s)
 1. Express app-level middleware, in registration order:
       httpResponseMetrics → scoped 2 MB parser → session → CORS → security headers
 2. At listen()/init(): Nest's default body parser, then module middleware,
    then the router. CLS middleware runs here (request id, correlationId,
    X-Request-Id) — before any guard, but after the middleware above.
 3. Router match: global prefix /api/v1 + controller path + method path
 4. Global guards, in the order from §4.2
 5. Route/class guards (@UseGuards, e.g. InternalTenantLockGuard)
 6. Global + controller + method interceptors, pre-handler (outer → inner)
 7. Pipes: global ValidationPipe → param/body/query DTO validation
 8. Controller handler
 9. Application service → domain entity → repository → Prisma extension → Postgres
10. Interceptors unwind (inner → outer): class/method interceptors first
    (e.g. lifecycle projection), then the globals in reverse —
    ETag → TenantOwnedResource → … → Metrics
11. Response write

 On any throw at 4–9:
    guard error  → filters directly (no interceptor saw it)
    handler error → ExceptionInterceptor maps → filters
    filter → uniform envelope + one failure line + correlationId
```

### 5.2 The load-bearing details

- **Request id exists before guards.** `CLS_MODULE_OPTIONS` (`request-id.ts:61–69`) mounts CLS middleware with `generateId`, `idGenerator: resolveRequestId`, and `setup: setupRequestContext`. `setupRequestContext` (L47–59) aliases the id onto `request.requestId`, sets CLS `correlationId`, and writes `X-Request-Id` on the response — so a 401/403/429 still carries the id.
- **Metrics are split in two.** `http_responses_total` (Express middleware) is the count of what the gateway answered; `http_requests_total` (interceptor) is the count of requests that reached a handler. Their difference is exactly the refusals.
- **Guards precede interceptors.** A guard rejection is invisible to `MetricsInterceptor`, `ExceptionInterceptor`, and every `@UseInterceptors`. Only filters see it.
- **Pipes are per-argument.** The global pipe validates DTO classes; a bare `@Param('id') id: string` is not UUID-validated unless a `ParseUUIDPipe` is attached. Do not assume every path param is validated.
- **The tenant boundary has three layers.** (1) `UnifiedAuthGuard` establishes CLS tenant; (2) the Prisma `tenantScope` extension injects `tenantId` into every query on a scoped model; (3) service methods call `assertEqualTenants` and fail closed with `404 Resource not found`. The database also has RLS. See `packages/database/src/extensions/tenant-scope.ts` and `packages/applications/src/common/tenant-guards.ts:86`.
- **404-over-403.** Cross-tenant reads return 404, not 403, to prevent tenant enumeration. A privilege failure **inside** the caller's own tenant is a 403.

---

## 6. Trace A — `GET /api/v1/consultations/:id` (human read)

This is the canonical read path: auth → access check → two repository reads → projection → ETag.

### 6.1 Route metadata (what the pipeline reads before any code runs)

`apps/api/src/modules/consultation/consultation.controller.ts`:

| Line | Decorator | Effect |
|---|---|---|
| 306–308 | `@ApiBearerAuth()`, `@ApiTags`, `@Controller('consultations')` | Mount under `/api/v1/consultations`. |
| 309 | `@Authorize()` | Route is not public; CASL/permission gate applies. |
| 316 | `@RequiredScopes('consultation:session:write')` | Class-level API-key default. Method-level metadata overrides it. |
| 318 | `@UseInterceptors(ConsultationLifecycleVocabularyInterceptor)` | Projects `PAUSED → RECORDING` in `status` unless the request sends `X-Hope-Lifecycle: 2`. `lifecycle.status` is always accurate. |
| 808–812 | `@ApiEndpoint({ returnedModel, path: ':id', by: ['id'] })` | OpenAPI/audit metadata. |
| 815 | `@RequiredScopes('consultation:session:read')` | **Method-level override**: API keys need the read scope, not the class write scope. |
| 816 | `@RequiredSvcScopes('svc:consultation:session:read')` | Service accounts need the `svc:` twin. |
| 817 | `async getById(@Param('id') id: string)` | Handler. |

### 6.2 Guards

1. `TieredThrottlerGuard` — counts the route and applies the tenant/API-key tier.
2. `ClsGuard` — request context.
3. `UnifiedAuthGuard` — `canActivate` (L404). It extracts an API key (`extractApiKeyFromRequest`, L435), a service-account token, or a JWT. For a JWT it calls `handleJwtPostAuth` (L896), which enforces the CASL ability and runs instance checks (L1018) where the route names an instance. For an API key it calls `handleApiKeyAuth` (L689): authenticate the raw key, apply the key's own rate limit, enforce `@RequiredScopes` (L790), set `request.apiKey`, CLS `apiKey`/user/tenant, then `enforceApiKeyAbilities` (L840). For a service account it calls `handleServiceAccountAuth` (L560): check `@ForbidServiceAccount`, authenticate the opaque token, set CLS, enforce `svc:*` scopes.
4. `TenantLockGuard` — 423 if the tenant is restoring.
5. `PatientConsentGuard` — this route carries no `@RequiresConsent(...)` metadata, so the guard is a no-op (its coverage audit is what would fail boot if a route should have carried it).
6. `TenantOwnedResourceSseGuard` — not `@Sse()`, so no-op.
7. `OriginTenantBindingGuard` — if a browser `Origin` is present, it must map to this tenant.
8. `RequiresIfMatchGuard` — no `@RequiresIfMatch`, no-op.

### 6.3 Interceptors and pipes

Pre-handler: `MetricsInterceptor` starts the timer and route label; `RateLimitHeadersInterceptor` is a no-op if the throttler skipped; `ContextInterceptor` resolves the active tenant and span attributes; `ExceptionInterceptor` wraps; `MaintenanceInterceptor` passes; `ImpersonationAuditInterceptor` passes; `TenantOwnedResourceInterceptor` is a no-op (no decorator on this route); `ETagInterceptor` waits for the body.

Pipes: there is no `@Body()` and no `ParseUUIDPipe`; the only argument is the raw `id` string. **No validation happens here.** A malformed id simply misses in the repository and yields 404.

### 6.4 Handler, line by line

```ts
// consultation.controller.ts:817–822
async getById(@Param('id') id: string): Promise<ConsultationResponse> {
  await this.verifyConsultationAccess(id);                       // 818
  const result = await this.consultationService.getByIdWithRelations(id); // 819
  if (!result) throw new NotFoundException(`Consultation ${id} not found`); // 820
  return result;                                                // 821
}
```

#### Step 1 — `verifyConsultationAccess` (`consultation.controller.ts:588–649`)

| Line | What executes |
|---|---|
| 589 | `consultationService.getById(consultationId)` — first DB read (below). |
| 590–592 | `null` → `NotFoundException`. |
| 607–609 | **Machine branch:** if the caller is a service account, return immediately. Tenant + `svc:` scope are the entire authority; there is no doctor/CASL/shared-patient check. The tenant boundary was already closed by `getById`'s `assertEqualTenants` and the tenant-scope extension. |
| 611 | `getDoctorId()` — the human caller's user id from CLS. |
| 614–616 | **Layer 1 — owner:** `consultation.doctorId === doctorId` → allow. |
| 619–626 | **Layer 1b — CASL:** `policyEngine.can(ability, 'read', 'Consultation', { tenantId, doctorId })` → allow (tenant admin, department head). |
| 630–633 | **Layer 2 — sharing gate:** if the tenant has `enable-consultation-sharing` off → 403. |
| 635–636 | If on: `doctorHasPatientRelationship(doctorId, consultation.patientId, tenantId)`. |
| 637–639 | No relationship → 403. |
| 641–648 | Debug-log the grant and return. |

#### Step 2 — `ConsultationService.getById` (`packages/applications/.../consultation.service.ts:1681–1697`)

| Line | What executes |
|---|---|
| 1682–1684 | If `this.tenantId` is absent → `BadRequestException('Tenant ID is required')`. Fail closed for a missing CLS. |
| 1686 | `consultationRepository.findWithContext(id)` — the first DB read, with `ContextItems`. |
| 1687 | `null` → `null` (the controller turns it into 404). |
| 1689 | `assertEqualTenants(consultation, { tenantId: this.tenantId })` — defense in depth on top of the extension. |
| 1691–1694 | `broadcastSysEvent(SysEventType.ResourceViewed, ...)` — domain event. |
| 1696 | `ConsultationDtoMapper.toResponseWithContext(consultation, false, await this.encounters.lifecycleView(consultation))`. |

#### Step 3 — `ConsultationRepository.findWithContext` (`packages/domains/.../ConsultationRepository.ts:123–139`)

| Line | What executes |
|---|---|
| 125–133 | `db.findFirst({ where: { id, resourceStatus: ENABLED }, include: { ContextItems: true } })`. |
| — | Before it reaches Postgres, the Prisma client applies the composed extensions: **soft delete** adds `resourceStatus: { not: DELETED }`; **tenant scope** injects `tenantId` from CLS on `TENANT_SCOPED_MODELS` (including `Consultation`). |
| 134–135 | Map the Prisma model to a domain entity. |
| 136–138 | Any exception → `null` (the caller renders 404; no internals leak). |

#### Step 4 — back in the handler: `getByIdWithRelations` (`consultation.service.ts:1714–1730`)

| Line | What executes |
|---|---|
| 1715–1717 | Missing tenant → 400. |
| 1719 | `consultationRepository.findWithRelations(id)` — **a second read**. |
| 1720 | `null` → `null`. |
| 1722 | `assertEqualTenants`. |
| 1724–1727 | `broadcastSysEvent(ResourceViewed, { withRelations: true })` — a **second** event for the same request. |
| 1729 | `ConsultationDtoMapper.toResponseWithContext(...)` with the lifecycle view. |

`findWithRelations` (`ConsultationRepository.ts:144–164`) is the same `findFirst` plus `Doctor { UserProfile }`, `Department`, and `ContextItems`.

> **Walkthrough insight:** a single `GET /consultations/:id` performs **two** consultation reads and emits **two** `ResourceViewed` events. The first read exists to authorize; the second to hydrate the response. If you are profiling a slow read, both matter.

#### Step 5 — projection and response

1. `ConsultationLifecycleVocabularyInterceptor` (controller-level) projects `status`: a `PAUSED` consultation is returned as `RECORDING` unless the client sends `X-Hope-Lifecycle: 2`; `lifecycle.status` is always the accurate value.
2. `ETagInterceptor` computes a strong ETag from `body.version`, sets `Cache-Control: private, no-cache` on the authenticated GET, and returns `304` if `If-None-Match` matches.
3. `MetricsInterceptor` records duration and status; the Express response counter records the same response independently.
4. `X-Request-Id` was already written by the CLS middleware before the guards ran.

---

## 7. Trace B — `POST /api/v1/consultations/:id/stop` (write with a detached tail)

This is the most interesting write in the clinical plane because it combines a synchronous lifecycle transition, a variable-latency finalization wait, and **work that deliberately outlives the response**.

### 7.1 Route metadata

`consultation.controller.ts:1022–1037`:

| Line | Decorator | Effect |
|---|---|---|
| 1022 | `@HttpCode(HttpStatus.OK)` | `POST` returns 200, not 201. |
| 1023 | `@Post(':id/stop')` | `/api/v1/consultations/:id/stop`. |
| 1036 | `@RequiredSvcScopes('svc:consultation:session:write')` | Machine callers need the `svc:` write scope. |
| — | class `@RequiredScopes('consultation:session:write')` | API keys need the write scope. |
| — | class `@Authorize()` | JWT callers go through CASL. |
| — | no `@RequiresIfMatch` | Stop is **not** OCC-gated; it is idempotent and state-machine-guarded instead. |

### 7.2 Guards and pipes

Same eight global guards as §6.2. `RequiresIfMatchGuard` is a no-op. `PatientConsentGuard` is a no-op because this route carries no `@RequiresConsent(...)` metadata. The body is `StopConsultationRequest | undefined`; the global validation pipe validates it when present and rejects unknown keys.

### 7.3 Handler, line by line

```ts
// consultation.controller.ts:1037–1054
async stop(@Param('id') id: string, @Body() request: StopConsultationRequest | undefined): Promise<StopResultResponse> {
  const consultation = await this.verifyConsultationOwnership(id);        // 1038
  const waitForFinal = request?.waitForFinal ?? true;                     // 1039
  if (lifecycleStatusOf(consultation) === 'STOPPED') {                    // 1041
    return this.wired(this.lifecycleService, 'IConsultationLifecycleService')
      .stop(id, { waitForFinal });                                       // 1042
  }
  await this.liveDocumentationService.markHandoffPending(id);             // 1044
  let result: StopResultResponse;
  try {
    result = await this.wired(this.lifecycleService, 'IConsultationLifecycleService')
      .stop(id, { waitForFinal });                                       // 1047
  } catch (error) {
    this.finishRecordingStop(id, request ?? {}, { signalEnding: false }); // 1049
    throw error;                                                         // 1050
  }
  this.finishRecordingStop(id, request ?? {}, { signalEnding: true });    // 1052
  return result;                                                         // 1053
}
```

| Line | What executes |
|---|---|
| 1038 | `verifyConsultationOwnership` (`consultation.controller.ts:659–688`): load via `getById`; 404 if missing; service-account branch returns; owner returns; CASL `manage Consultation` returns; otherwise **403** (`Only the assigned doctor can modify this consultation`). Shared-patient doctors **never** get write access. |
| 1039 | `waitForFinal` defaults to `true`. |
| 1041–1043 | **Idempotent poll path:** if already `STOPPED`, delegate to `lifecycle.stop`, which short-circuits and reports the current final-transcript state. No drain, no signal — a client can poll by re-POSTing stop. |
| 1044 | `liveDocumentationService.markHandoffPending(id)` — marks the live note as handing off before the state transition, so the drain has a durable intent. |
| 1047 | `lifecycleService.stop(id, { waitForFinal })` — the synchronous half (below). |
| 1048–1051 | On failure: run the drain with `signalEnding: false` (drain the live note, but do **not** tell the consultation loop the recording ended), then rethrow. This prevents a half-stopped consultation from silently keeping a live note. |
| 1052 | On success: schedule the detached tail with `signalEnding: true`. |
| 1053 | Return the stop result. The HTTP response is sent **before** the detached tail completes. |

### 7.4 `ConsultationLifecycleService.stop` (`consultation-lifecycle.service.ts:182–251`)

| Line | What executes |
|---|---|
| 183 | `load(consultationId)` — tenant-scoped read; 404 on miss. |
| 184–187 | If already `STOPPED`: compute `finalizing = processing === FINALIZING_TRANSCRIPT`; return `pending` or `complete` without writing. |
| 189 | `applyLifecycleTransition(consultation, STOPPED, actor, 'stop')` — the state machine. Illegal transitions throw `CONSULTATION_TRANSITION_ILLEGAL` (409). |
| 190–195 | Preserve the previous processing state **only if it is in flight**. A note outcome (`AWAITING_REVIEW`, `FAILED`, `IDLE + NOTE_READY`) belongs to the previous recording and must not be restored as current. |
| 196–197 | `setProcessing(FINALIZING_TRANSCRIPT)`; store `processingPrior`. |
| 198 | `persist(consultation, consultation.version)` — optimistic-concurrency write at the current version. |
| 201 | `endCurrentEncounter(stopped)` — the encounter's speech has ended; a later re-visit `open` appends the next encounter. |
| 202 | `events.publish(stopped, 'stopped')` — lifecycle SSE frame. |
| 204 | `liveBoundSessions(consultation)` — which live STT sessions are bound. |
| 205 | `sendControl(sessions, 'finalize', consultationId)` — tell each session to finalize. |
| 207–215 | Decide `state`: no sessions → `complete`; `waitForFinal === false` or no transcript service → `pending`; otherwise `awaitFinal(consultationId, sessions, timeoutMs)` where the timeout comes from the tenant's `finalTranscriptTimeoutSeconds`. |
| 217–219 | `pending` → return immediately with `FINALIZING_TRANSCRIPT`. |
| 225–234 | For `complete`: re-read the row; if it is still `FINALIZING_TRANSCRIPT`, compare-and-set it back to `prior ?? IDLE` **only if** still finalizing. A `SUMMARIZING` value written by a session final that landed during the wait is newer and is kept. |
| 235–245 | Build `EncounterStoppedPayload`; `claimEncounterStopped(...)` deduplicates against a session final that already announced the encounter; emit `ConsultationPipelineEvent.EncounterStopped` (this is what triggers downstream note/fact-ledger work). |
| 246–249 | `events.publish(subject(...), 'transcript_final')` — SSE frame with the restored processing state. |
| 250 | `stopResult(stopped, 'complete', restored)`. |

### 7.5 The detached tail — `finishRecordingStop` (`consultation.controller.ts:1467–1503`)

| Line | What executes |
|---|---|
| 1468 | `const tenantId = this.cls.get('tenantId')` — captured **synchronously**, before the response ends, so the async work has the caller's tenant. |
| 1469 | `work = async () => { ... }` — the detached unit. |
| 1471 | `liveDocumentationService.stop(id, { persistSnapshot })` — drains the live note. The drain writes the terminal `closed` frame and the live handoff. Single-flight, so a second stop joins rather than duplicates. |
| 1472–1479 | Drain failure is logged with the consultation id and tenant; the consultation is `DRAINING` **without** its final live note. It does **not** fail the HTTP request (already sent). |
| 1480 | If `signalEnding` is false (the lifecycle stop threw), stop here. |
| 1481–1496 | `loopContextSignalService.signalConsultationEnding(id, { reason: 'recording_stopped', persistSnapshot, acceptedProposals? })` — best-effort; a no-op when the tenant is not entitled to the loop or the platform emergency stop is engaged. Accepted corrections ride along for `feedback.capture`. |
| 1497–1500 | Signal failure is logged, never thrown. |
| 1501 | `void Promise.resolve(this.cls.run({ ifNested: 'inherit' }, work)).catch(() => undefined)` — runs in a **copy** of the request's CLS context, detached from the response lifecycle. `ifNested: 'inherit'` keeps tenant/user. |

### 7.6 Response and side effects

- HTTP 200 `StopResultResponse` with `finalTranscript.state` (`complete` or `pending`).
- SSE clients receive `stopped` and `transcript_final` (and later live-note frames from the drain).
- In-flight sessions receive a `finalize` control.
- The encounter is ended; `EncounterStopped` may trigger note generation, fact-ledger extraction, and recap work.
- The detached tail continues after the socket has the response. This is why "stop returned 200" does **not** mean "the live note is drained".

---

## 8. Trace C — `POST /api/v1/internal/stt/segments` (machine route)

This is the route the platform STT worker uses to push streaming finals back into the consultation timeline. It demonstrates the **third credential class** and the tenant-pin mechanism.

### 8.1 Route metadata (`apps/api/src/modules/internal/stt-internal.controller.ts`)

| Line | Decorator | Effect |
|---|---|---|
| 47–50 | `@ApiTags`, `@ApiExcludeController`, `@ApiSecurity('api-key')`, `@Authorize()` | Hidden from public docs; still authorized. |
| 59 | `@RequiredScopes('internal:stt:worker')` | **Reserved** scope, never issued to tenant SDK/WEBHOOK/INTEGRATION keys. Only the platform service-account credential (`['*']`) satisfies it. |
| 78 | `@UseGuards(InternalTenantLockGuard)` | Route/class guard on top of the globals. |
| 79 | `@Controller('internal/stt')` | Mounted at `/api/v1/internal/stt`. |
| 225 | `@Post('segments')` | The ingest route. |
| 239–243 | `ingestSegments(@Req, @Body, @Headers('x-internal-tenant-id'))` | The handler. |

### 8.2 Guards, in order

1. Global eight from §4.2. `UnifiedAuthGuard` takes the **API-key branch** (`handleApiKeyAuth`, L689): the worker presents `X-Internal-Service-Key` containing the raw value of a registered active service-account `ApiKey` row. The guard authenticates it, applies its rate limit, enforces `internal:stt:worker` (L790), sets `request.apiKey`, and sets CLS tenant to the key's platform tenant.
2. `InternalTenantLockGuard` (route-level) — refuses while the tenant is restoring.

> **Why this route is the documented exception:** it is the **only** `/internal/*` controller on the API-key path. The other internal controllers are `@Public()` + a service-token guard. `auditInternalRoutesOffApiKeySurface` fails boot if this class loses its `internal:`-rooted scope, so the carve-out is policed, not merely written down.

### 8.3 Handler, line by line

| Line | What executes |
|---|---|
| 244 | `ensureInternalApiKey(request)` (L191–195): `request.apiKey` must be set; otherwise 401. This is the **second** gate — it verifies the credential **class**, not which key. |
| 245–248 | `X-Internal-Tenant-Id` is mandatory here (unlike other internal routes where it is optional). Missing → 400. |
| 249–251 | The header must equal `dto.tenantId`. Mismatch → 400. |
| 252–254 | If the transcript service is not wired → 400. |
| 256 | `runTenantPinned(request, pinned, () => transcriptRecord.ingestSegments(dto))`. |

### 8.4 `runTenantPinned` (`stt-internal.controller.ts:134–150`)

| Line | What executes |
|---|---|
| 135–138 | No header → run unchanged (backward-compatible for an un-upgraded worker). |
| 140 | `assertPlatformInternalCredential(request)` (L173–185): reads `x-internal-service-key`; resolves the expected `API_GATEWAY_KEY` from `SecretsService`; if unresolvable → **403** (fail closed); if absent or not constant-time-equal → **403**. This is the privilege boundary that makes a caller-supplied tenant selector safe. |
| 142–144 | No CLS service → 400. |
| 146–149 | `cls.run(async () => { cls.set('tenantId', pinned); return work(); })` — re-establishes a SYSTEM-free CLS context for the tenant-scoped service call. |

The tenant-scope extension stays **on**: a header naming a tenant the caller should not touch still yields a 404 from the scoped lookup, not a cross-tenant read.

### 8.5 `TranscriptRecordService.ingestSegments` (`transcript-record.service.ts:117–…`)

| Line | What executes |
|---|---|
| 118–120 | `tenantId`, `consultationId`, `sttSessionId` are required → 400. |
| 121 | `loadConsultation(consultationId, tenantId)` — tenant-scoped `findByIdOrNull`; 404 if the row is missing or belongs to another tenant. The route itself documents a 409 when the consultation no longer accepts content (`APPROVED` / `CLOSED`). |
| 122 | `consultationRepository.touchActivity(consultation.id)` — resets the stale-recording clock even for an empty batch. |
| 124–127 | Empty `segments` → **heartbeat**: return `{ accepted: 0, duplicates: 0, lastSegmentSeq: segmentSeqHead }`. |
| 130–134 | Deduplicate **within the batch** by `utteranceIndex`, first wins, then sort ascending. |
| 135–141 | Build `(sttSessionId, utteranceIndex)` keys; load existing rows; filter out already-stored keys. |
| 142–144 | Everything duplicate → return duplicates count. |
| 146 | `recordingOffsetFor(consultation, sttSessionId)` — places session-relative ms on the consultation timeline. |
| 147 | `encryptTexts(fresh.map(s => s.text))` — PHI encryption before persistence. |
| 148 | `sttStreamRunKey(sttSessionId)`. |
| 150–197 | In one transaction: `allocateSegmentSeqs`, create `ContextItem` transcript segments with `segmentSeq`, `segmentKey`, `t0Ms/t1Ms`, speaker, capture time, metadata (`sttRunKey`, `sttSessionId`, `utteranceIndex`, language), content counters, ciphertext + key version; `createSegmentsBatch`; create initial `ContextItemVersion` rows with `changeReason: 'initial_creation'`, `changedBy: 'system'`, `changeSource: 'ai'`. |
| 198+ | Persist, emit events, return `{ accepted, duplicates, lastSegmentSeq }`. |

Idempotency is on `(sttSessionId, utteranceIndex)`, so a redelivered batch is harmless.

### 8.6 Sibling route — `POST /internal/stt/audio-records`

Same guard stack, same `ensureInternalApiKey`. `SttInternalService.createAudioRecord` (`sttInternalService.ts:988–…`):

1. L991–997: require either `contextItemId` or `consultationId`, and either `mediaId` or the full storage tuple (`storagePath`, `filename`, `fileSizeBytes`, `mimeType`). Validation happens **before** any side effect, so an invalid request cannot leave an orphan container.
2. L1004–1018: resolve the container — explicit `contextItemId` (batch/local) or `findOrCreateAudioContainer(consultationId, tenantId)` for streaming dual-capture.
3. L1023–1040: resolve the primary `Media` — pre-registered `mediaId` wins (streaming), otherwise build a `Media` from the storage object.
4. L1043: next sequence number for the context item.
5. L1046+: create the `AudioRecording` linking `Media` to `ContextItem` with audio metadata.

---

## 9. Trace D — WebSocket `/ws/stt/stream`

The WebSocket plane deliberately bypasses the HTTP guard chain. Authentication is hand-rolled in `handleConnection`, and a boot audit pins the ownership classification.

### 9.1 Transport

`main.ts:153` installs `WsAdapter` (native `ws`, no Socket.IO). The gateway is **not** under `/api/v1` and is **not** covered by Express middleware, CORS, session, or the eight global guards. That is why the handshake does its own origin, ticket, binding, and lock checks.

### 9.2 `handleConnection` (`stt-ws.gateway.ts:898–…`)

| Line | What executes |
|---|---|
| 912–920 | **CSWSH guard.** Browsers do not apply CORS to the WS handshake. If an `Origin` header is present and not allowed → close `AUTH_FAILED` with a generic reason. **No `Origin` → allow**: a non-browser caller cannot be the victim of cross-site WebSocket hijacking. |
| 922–924 | Parse `sessionId` and `ticket` from the URL. |
| 931–937 | Missing `sessionId` → generic close. |
| 939–946 | Missing `ticket` → generic close. |
| 948 | `streamTicketService.consumeTicket(ticket)` — **single-use**. A replayed ticket fails. |
| 958–968 | Ticket scope must be exactly `stt_session:${sessionId}`. This proves the ticket was minted for this session, not that the minter owns it. |
| 982–1007 | `sessionBinding.lookupBinding(sessionId)` — verify tenant **and** owner. Missing binding, tenant mismatch, owner mismatch, ownerless legacy binding, or a lookup failure → generic close. The owner half closes the same-tenant hijack (a colleague who learns a session id cannot transplant the audio stream). |
| 1012–1034 | Tenant restore lock: if the tenant is locked, close `TENANT_LOCKED`; if the lock state is unreadable, close `1011` (fail closed). |
| 1039–1078 | Best-effort session meta read: `sampleRate` (default 16 000), stream context, `sessionEpochMs`, metadata schema, language receipt, persisted metadata spans. One `Promise.all`, two keys; any failure degrades to defaults and never rejects the handshake. |
| … | Register `SessionInfo`, subscribe to the upstream result stream, restore the resume buffer/seq, `sendReady(...)`. |
| 1328–1342 | `sendReady` writes `{ type: 'ready', sessionId, fromSeq, sessionEpochMs?, languageResolution? }`. This is the deterministic gate that closes the register-vs-resume race. |
| 1351–1371 | `attachMessageHandler`: `pong` resets `missedPongs`; `message` dispatches to `handleMessage`, and any unhandled rejection is logged via `logSessionFailure` / `logWsFailure`. |

### 9.3 `handleMessage` (`stt-ws.gateway.ts:2007–…`)

| Line | What executes |
|---|---|
| 2008 | Look up `SessionInfo` by socket. |
| 2009–2023 | No session: a text `close` gets a polite `{type:'status', status:'closed'}` and close 1000 (a client that finished correctly must not see `NO_SESSION`); every other frame gets `NO_SESSION` error. |
| 2031–2036 | **Binary frame** = audio. If `capturePaused`, drop. Increment `binarySeq`; `forwardAudioFrame(session, seq, audio)`. |
| 2039–2046 | Text frame: `JSON.parse`; invalid → `INVALID_JSON`. |
| 2051 | `switch (type)`. |
| 2052–2064 | `audio`: JSON-embedded audio. Optional inline metadata is applied **before** the bytes advance the clock. `forwardAudioFrame`. |
| 2066–2071 | `metadata`: applies the object from the current audio offset onward. |
| 2073–2088 | `stop`: latch `stopRequested` (survives a transient rebind); on the **first** stop, `writeEndOfStream(session)` in band; then `bridgeService.writeControlCommand(sessionId, 'finalize')` as the fallback for consumers that never see the terminal frame. |
| … | `resume`, `close`, and unknown-type handling. |

### 9.4 `handleDisconnect` (`stt-ws.gateway.ts:1878–…`)

- Marks the session transient, starts a bounded grace window, and keeps the upstream STT session + result subscription alive so a reconnect can rebind.
- On rebind, the message handler and `pong` handler are re-attached and the result subscription is re-established (a cross-instance reconnect would otherwise split the shared caption group).
- If the grace window expires, the session is finalized and `removalRetry.enqueue(...)` parks it for bounded retries instead of leaking until the STT-v2 inactivity reaper.

### 9.5 Where the audio goes

`forwardAudioFrame` calls the streaming bridge service, which writes frames to the upstream STT-v2 session and subscribes to results. Transcript finals come back through the internal HTTP route in §8 (`/internal/stt/segments`), not through this socket, so the WebSocket is the **capture** half and the internal route is the **persistence** half.

---

## 10. The error path, end to end

### 10.1 Three entry points into the filters

| Thrown by | Who sees it | Why |
|---|---|---|
| A **guard** (401/403/423/429) | Filters directly | Guards run before interceptors. `ExceptionInterceptor` never runs. |
| A **pipe** (400 validation) | `ExceptionInterceptor` → filters | Pipes run after guards but inside the handler invocation, so the interceptor chain **does** wrap them; the interceptor maps the error and a filter writes the envelope. |
| A **handler/service** | `ExceptionInterceptor` → filters | Domain errors are mapped to `HttpException` with a stable code, then the envelope filter writes it. |

### 10.2 Filter resolution

Registration order (`GLOBAL_EXCEPTION_FILTERS`, mapped at `app.module.ts:290`):

```text
AllExceptionsFilter  →  HttpExceptionEnvelopeFilter  →  DataNotFoundExceptionFilter  →  ConsentExceptionFilter
```

Resolution is **last-registered-first**:

```text
ConsentExceptionFilter
  → DataNotFoundExceptionFilter
    → HttpExceptionEnvelopeFilter
      → AllExceptionsFilter (catch-all)
```

So a consent verdict lands on `ConsentExceptionFilter`; a generic data 404 on `DataNotFoundExceptionFilter`; every other `HttpException` on `HttpExceptionEnvelopeFilter`; everything else on `AllExceptionsFilter`.

### 10.3 What every error response contains

```json
{
  "statusCode": 403,
  "code": "DOMAIN.CONSENT_DENIED",
  "message": "…",
  "correlationId": "0190…"
}
```

- `correlationId` is the CLS request id, the same value in `X-Request-Id`, the logs, and every internal hop.
- The detail of an unexpected `500` goes to the log, **never** the body.
- The filter also writes exactly one failure line (`filters/failure-log.ts`) with method, templated route, status, code, duration, tenant/user (when resolved), and the request id.
- Cross-tenant reads are 404, not 403, by design.

### 10.4 Where to look when a request fails

1. `X-Request-Id` from the response (present even on guard rejections).
2. Grep the failure line by that id (see doc 06 for the exact patterns).
3. If the failure is 401/403/429, the line came from a guard — check `UnifiedAuthGuard`'s `reason` field (`forbid_service_account`, `forbid_api_key`, scope mismatch, etc.).
4. If 400, check the validation `violations` list (property path + constraint names; values are never logged).
5. If 500, the failure line has the stack; the response body deliberately does not.

---

## 11. How to trace any of the other 814 routes

Use this six-step recipe. It works for every controller in the inventory.

### Step 1 — Locate the route

Three equivalent sources:

| Source | Use it for |
|---|---|
| `apps/api/route-manifest.json` | Canonical method + path + controller + handler. |
| `review/api_explore_2/inventory/api-catalog.csv` | Spreadsheet filtering by module, verb, path, auth. |
| `review/api_explore_2/inventory/api-route-call-tree-catalog.json` | The same data plus the injected service call tree. |

### Step 2 — Read the decorators as pipeline instructions

| Decorator | Stage it controls | What to check |
|---|---|---|
| `@Public()` | `UnifiedAuthGuard` | The only auth opt-out. If absent, auth is mandatory. |
| `@Authorize(...)` / `@CanXxx(...)` | `UnifiedAuthGuard` + CASL | Which action/subject; instance conditions. |
| `@RequiredScopes(...)` | API-key branch | Method metadata overrides class metadata. |
| `@RequiredSvcScopes(...)` | Service-account branch | The `svc:` twin; absence means machine callers are denied. |
| `@ForbidApiKey()` / `@ForbidServiceAccount()` | Auth branches | Named exemptions only; boot audits pin the lists. |
| `@RequiresConsent(...)` / `@ConsentExempt(...)` | `PatientConsentGuard` | Consent coverage is audited at boot for `:patientId`. |
| `@TenantOwnedResource(...)` | `TenantOwnedResourceInterceptor` / SSE guard | Row ownership for `:id`-style routes. |
| `@RequiresIfMatch()` + `@ExpectedVersion()` | `RequiresIfMatchGuard` + param decorator | 428 if header missing, 412 on version conflict. |
| `@Sse()` | `TenantOwnedResourceSseGuard` + stream interceptor | The stream opens before the handler returns; ownership must be checked first. |
| `@UseGuards(...)` / `@UseInterceptors(...)` | Route/class level | These run **inside** the globals. |
| `@ApiEndpoint(...)` | OpenAPI + audits | `returnedModel`, path params, lookup keys. |

### Step 3 — Follow the injected interface token

Controllers inject **interfaces**, not concrete classes, e.g.:

```ts
constructor(
  @Inject(IConsultationService) private readonly consultationService: IConsultationService,
  @Inject(IContextService) private readonly contextService: IContextService,
  ...
)
```

Search the token (`IConsultationService`) in `packages/applications/src` to find the implementation and its module binding. The gateway's own `modules/<feature>/<feature>.module.ts` shows what is provided.

### Step 4 — Follow the service to the repository

In `packages/applications`, look for the repository call (`this.consultationRepository.find...`, `create...`, `update...`). Then open the generated repository in `packages/domains/src/repositories/generated/core/`. The repository's `db` handle is the **extended** Prisma client: tenant scope + soft delete are already applied. Do not expect an explicit `tenantId` in every `where` — the extension injects it.

### Step 5 — Check the response projection

The controller returns a DTO, not an entity. Find the mapper (`ConsultationDtoMapper`, `ContextDtoMapper`, etc.) and any controller-level interceptor (e.g. `ConsultationLifecycleVocabularyInterceptor`) that rewrites fields after the handler. This is where `status` vs `lifecycle.status` differs.

### Step 6 — Set a breakpoint or a log point

Per doc 08:

```bash
pnpm api:dev            # nest start --watch
pnpm api:dev:watch      # nodemon
```

VS Code `outFiles: ["${workspaceFolder}/apps/api/dist/**/*.js"]`. Breakpoints in `main.ts` are only hit at boot; breakpoints in a controller are hit per request. For a route that is hard to exercise, the integration suite `tests/integration/full-route-walk.spec.ts` and `tests/integration/auth-coverage.spec.ts` drive the surface.

### Worked micro-example: `POST /consultations/:id/approve`

1. Manifest → `ConsultationController.approve` (`consultation.controller.ts:1057` decorators, handler at `1090`).
2. Decorators: `@Post(':id/approve')` (L1057), `@RequiresIfMatch()` (L1058), method `@RequiredSvcScopes('svc:consultation:session:write')` (L1089), class `@Authorize` + `@RequiredScopes('consultation:session:write')`.
3. Pipeline: auth → tenant lock → consent (no-op) → SSE (no-op) → origin → `RequiresIfMatchGuard` sets the marker → `@ExpectedVersion()` throws 428 if `If-Match` is absent → handler.
4. Handler: `verifyConsultationOwnership` → `lifecycleService.approve` → state machine + OCC version check → snapshot + note signature → events.
5. Repository: `ConsultationRepository` read/write with tenant scope; `version` is the OCC field; a mismatch is 412.
6. Response: projected DTO + strong ETag.

That is the same six steps, applied to a write with OCC.

---

## 12. Appendix — file map and observability checkpoints

### 12.1 Boot

| File | Role |
|---|---|
| `apps/api/src/instrumentation.ts` | OTel SDK; `sdk.start()` at L66; `flushOtel()` at L90. |
| `apps/api/src/instrumentation.flags.ts` | Testable telemetry enablement rules. |
| `apps/api/src/crash-handlers.ts` | Pre-Nest crash capture; logger attach; bounded flush. |
| `apps/api/src/main.ts` | Bootstrap: env, NestFactory, transport, middleware, audits, listen. |
| `apps/api/src/app.module.ts` | Composition root: `common` + `featureModules` + globals. |
| `apps/api/src/global-prefix.config.ts` | `api/v1`, `/metrics` excluded. |
| `apps/api/src/request-id.ts` | CLS options; request-id generation; response header; `setup` alias. |
| `apps/api/src/bootstrap/*.ts` | The ~15 fail-fast structural audits. |
| `apps/api/src/cors.config.ts` | CORS options, registry-backed origin policy. |

### 12.2 Request pipeline

| File | Role |
|---|---|
| `apps/api/src/filters/global-filters.ts` | Registration order of the four exception filters. |
| `apps/api/src/filters/failure-log.ts` | The single failure line. |
| `apps/api/src/guards/*.ts` | Tenant lock, consent, origin binding, internal tenant lock. |
| `apps/api/src/common/tenant-owned-resource-sse.guard.ts` | SSE pre-handler ownership. |
| `apps/api/src/decorators/requiresIfMatch.guard.ts` | OCC marker guard. |
| `apps/api/src/modules/throttle/tiered-throttler.guard.ts` | Tiered rate limiting. |
| `packages/applications/src/authorization/unified-auth.guard.ts` | The three credential classes. |
| `apps/api/src/interceptors/*.ts` | Metrics, context, exception, maintenance, impersonation, ETag. |
| `apps/api/src/observability/http-response-metrics.ts` | Authoritative response counter. |
| `apps/api/src/filters/validation-violations.ts` | Strict DTO validation + structured violations. |

### 12.3 Domain / persistence

| File | Role |
|---|---|
| `packages/applications/src/services/consultation/consultation/consultation.service.ts` | `getById` L1681, `getByIdWithRelations` L1714. |
| `packages/applications/src/services/consultation/lifecycle/consultation-lifecycle.service.ts` | `stop` L182, `close` L270, `approve` L255. |
| `packages/applications/src/services/consultation/transcript-record/transcript-record.service.ts` | `ingestSegments` L117. |
| `packages/applications/src/services/stt/internal/sttInternal.service.ts` | `createAudioRecord` L988. |
| `packages/domains/src/repositories/generated/core/ConsultationRepository.ts` | `findWithContext` L123, `findWithRelations` L144. |
| `packages/applications/src/common/tenant-guards.ts` | `assertEqualTenants` L86. |
| `packages/database/src/extensions/tenant-scope.ts` | Tenant injection + soft-delete composition. |

### 12.4 Observability checkpoints

| Checkpoint | Where | What it tells you |
|---|---|---|
| `X-Request-Id` response header | Set by CLS `setup` before guards | The one id for logs, traces, and internal hops. |
| `hope_api_http_responses_total` | Express middleware | Every response the gateway produced, including refusals. |
| `hope_api_http_requests_total` | `MetricsInterceptor` | Requests that reached a handler. Difference = refusals. |
| Failure line | `filters/failure-log.ts` | Method, templated route, status, code, duration, tenant/user, correlation id. |
| `ResourceViewed` sys-event | Service layer | Domain-level read audit (note: the GET trace emits it twice). |
| Consultation lifecycle SSE | `events.publish(...)` | `stopped`, `transcript_final`, live-note frames. |
| OTel spans | `instrumentation.ts` + auto-instrumentation | HTTP/DB/Redis/Prisma timing; `ContextInterceptor` attaches request attributes. |
| WS close reason | `stt-ws.gateway.ts` | Generic to the client; the real cause is in the warn log with the session id. |

---

## 13. What this walkthrough deliberately leaves out

- **The other 814 handlers.** Use §11; the inventory has the call tree for each.
- **The Python services** (STT 8861, Text 8862, TTS 8865, NLP 8864, Guardrail, Harness). See doc 03.
- **Temporal workflow internals** and the harness loop. See doc 02, Flow 4.
- **The exact SQL** emitted by Prisma. That is owned by `packages/database`; the repository layer is the boundary.
- **Background workers started by the same image** (`checkpoint-worker.main.ts`, `model-publisher.main.ts`, the cron sweeps). They share the module graph but have their own entry points and do not accept HTTP.

---

**The one-sentence summary:** `main.ts` builds and guards the process; `app.module.ts` decides what exists; eight global guards, eight global interceptors, and four filters form the shared pipeline; a controller is a thin authorization + delegation layer; and the real work happens in `packages/applications` against repositories in `packages/domains`, with tenant isolation enforced three times (CLS guard, Prisma extension, service assert) and failures shaped by one filter chain.
