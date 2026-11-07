# API Boot Sequence & Request Pipeline

**Files analysed:** `apps/api/src/main.ts` (499 lines), `apps/api/src/app.module.ts` (620 lines), `apps/api/src/filters/global-filters.ts`, `apps/api/src/global-prefix.config.ts`
**Repo state:** branch `dev-2.2`, HEAD `8cb2e5e8e`
**Written:** 2026-11-05 · read-only inspection
**Parent doc:** [01-APPS-API-MAP.md](./01-APPS-API-MAP.md)
**Beginner companion:** [02-main-ts/00-README.md](./02-main-ts/00-README.md)

This is the "read `main.ts` first" document: what the process does between `node dist/main.js` and serving a request, and where a request passes once it arrives.

> **New to NestJS?** This document uses framework vocabulary (module, guard, interceptor, `APP_GUARD`, …) without defining it. Read [02-main-ts/01-nestjs-in-10-minutes.md](./02-main-ts/01-nestjs-in-10-minutes.md) first, then come back. Every import named here is explained in the `02-main-ts/` subfolder:
>
> | Topic | File |
> |---|---|
> | Nest concepts + request lifecycle | [01-nestjs-in-10-minutes.md](./02-main-ts/01-nestjs-in-10-minutes.md) |
> | `@nestjs/*` packages | [02-framework-packages.md](./02-main-ts/02-framework-packages.md) |
> | `express-session`, `uuidv7`, `zod`, OTel… | [03-third-party-libraries.md](./02-main-ts/03-third-party-libraries.md) |
> | `@arcaai/*` project packages | [04-arcaai-workspace-packages.md](./02-main-ts/04-arcaai-workspace-packages.md) |
> | `./bootstrap`, `./config`, `./guards`… | [05-local-app-code.md](./02-main-ts/05-local-app-code.md) |
> | One-line lookup of every import | [06-import-reference.md](./02-main-ts/06-import-reference.md) |
> | **Diagram:** boot phases + every `main.ts` step | [07-visual-boot-flow.md](./02-main-ts/07-visual-boot-flow.md) |
> | **Diagram:** `app.module.ts`, guards, hooks, filters | [08-visual-request-pipeline.md](./02-main-ts/08-visual-request-pipeline.md) |
> | **Diagram:** where every import comes from | [09-visual-import-map.md](./02-main-ts/09-visual-import-map.md) |

---

# Part A — `main.ts`: the boot contract

`main.ts` is not a thin entrypoint. It is the ordered list of things that must be true before the gateway may accept traffic. Read it top to bottom; the comments explain *why* each placement is load-bearing, not just what runs.

## A.1 Boot order

| # | Line | Step | Why it is here |
|---|---|---|---|
| 0 | `44–48` | `registerCrashHandlers()` **before anything else** | A crash during env load or DI graph construction still emits one structured log line and flushes OTel/logs. `attachLogger()` upgrades it once the Nest logger exists (line 128). |
| 1 | `64` | `loadEnv()` | Resolves the `NODE_ENV` → `.env.<env>` file **before** any `process.env` read. Host env wins; skipped in CI/production. |
| 2 | `72` | `assertGenaiContentCaptureDisabled()` | Refuses to boot in production if OTel GenAI content capture is not pinned off (PHI leakage guard). |
| 3 | `82` | `apiEnv()` | zod validation of the whole declared env surface. Fails once with **every** problem listed, before any port is bound. The three pre-Nest reads (`LOG_LEVEL`, `PORT`, `SHUTDOWN_*_MS`) come from this typed result, not `process.env`. |
| 4 | `96` | `installPrismaPoolMetrics()` | Must be **after** `loadEnv()` (metric prefix derives from `OTEL_SERVICE_NAME`) and **before** `NestFactory.create()` (DI warmup issues the first queries). |
| 5 | `116` | `NestFactory.create(AppModule)` | `bufferLogs: true`, `rawBody: true`, `forceCloseConnections` only in dev. |
| 6 | `125–128` | `app.useLogger(loggingService)` + `crashHandlers.attachLogger()` | From here crashes go through the platform logger. |
| 7 | `146` | `app.use(httpResponseMetricsMiddleware())` | **First** `app.use`: counts responses that never reach an interceptor — 429s from the throttler, 401s from auth, CORS/session short-circuits. |
| 8 | `151` | `applyInternalBodyLimits(app)` | 2 MB JSON bodies for the internal guardrail evaluation drain only. |
| 9 | `153` | `app.useWebSocketAdapter(new WsAdapter(app))` | Native `ws` adapter (not socket.io) for the STT/workflow gateways. |
| 10 | `158` | `app.setGlobalPrefix('api/v1', options)` | Only `/metrics` is excluded. Values come from `global-prefix.config.ts` by import, never copy. |
| 11 | `162–165` | `SwaggerModule.setup('api/v1/docs', ...)` | Non-production only. Uses the same builder + per-operation security derivation as the committed `openapi.json`. |
| 12 | `181` | `assertJwtSecretNotPlaceholder(secretsService)` | Defense-in-depth mirror of `JwtStrategy`'s own assertion. Reaching here means the secrets cache warmed successfully. |
| 13 | `187` | `express-session` | Secret from `SecretsService`, not `process.env`. `secure` in prod, `httpOnly` outside prod, 24h max age. |
| 14 | `206` | `createGlobalValidationPipe()` | `whitelist` + `forbidNonWhitelisted` + `forbidUnknownValues`; closes the `JWT_SECRET_KEY` mass-assignment chain. Emits a structured `violations` list (paths + constraint names, never values). |
| 15 | `223` | `httpAdapter.set('etag', false)` | Disables Express's weak auto-ETag. The **only** ETag the API emits is the strong `body.version` tag from `ETagInterceptor`. |
| 16 | `251` | `app.useGlobalInterceptors(new ETagInterceptor())` | RFC 7232 strong ETag + conditional GET (`If-None-Match` → 304) + `Cache-Control: private, no-cache` on authenticated GETs. |
| 17 | `256–286` | Graceful shutdown | `enableShutdownHooks()`, registers `otel-flush` and `service-release-heartbeat` cleanup callbacks, logs the timeout/drain config. |
| 18 | `274` | `startServiceReleaseRegistration(...)` | Fire-and-forget self-registration + heartbeat. Never blocks or fails boot. |
| 19 | `291` | `app.enableCors(buildCorsOptions(nodeEnv))` | `credentials: false`. Origins come from the `TenantAllowedOrigin` registry only. |
| 20 | `295–311` | Security headers | `nosniff`, `DENY`, `X-XSS-Protection`, `Referrer-Policy`; CSP only on `/api/v1/docs`. |
| 21 | `313–354` | Static CORS posture log | Deliberately does **not** report `origin.enforcementEnabled`; that is announced by `PlatformKnobsBinder` on `app-settings.cache-refreshed` (grep `ORIGIN ENFORCEMENT IS`). |
| 22 | `365–460` | **Boot-time audits** | See Part C. Any failure throws out of `bootstrap()` and kills the process. |
| 23 | `481–482` | `keepAliveTimeout = 65s`, `headersTimeout = 66s` | Must outlive the upstream proxy's idle timeout; `headersTimeout` must stay strictly greater. Prevents intermittent 502/ECONNRESET on pooled sockets. |
| 24 | `484` | `app.listen(port)` | Then logs `Application started` with Swagger and health URLs. |

## A.2 Things `main.ts` deliberately does **not** do

- **`trust proxy` is not set** (lines 225–250). On `Cloudflare → cloudflared → Traefik → pod`, trusting `X-Forwarded-For` would name the cloudflared pod, not the browser. Client IP is resolved narrowly via `packages/applications/src/common/client-ip.ts` + `RATE_LIMIT_TRUSTED_PROXIES`, and only when the socket peer is a declared ingress.
- **No static CORS allow-list.** There is no `CORS_ALLOWED_ORIGINS` env var any more; an unavailable registry denies all browser origins.
- **No env reads after `apiEnv()`.** Anything needed pre-Nest comes from the typed schema result.

---

# Part B — `app.module.ts`: the request pipeline

## B.1 Guards — declaration order is enforcement

Registered as `APP_GUARD` providers in `guards[]` (lines 204–279). Nest runs them in array order.

| # | Guard | Line | Responsibility |
|---|---|---|---|
| 1 | `TieredThrottlerGuard` | 211 | Brute-force/DoS rejection **before** auth work. Only the `default` tier (100 req/60s) gates every route; `strict` (10), `heavy` (20), `relaxed` (300) are opt-in per route. Resolves live limits from `GlobalSetting` and per-tenant entitlement tiers. |
| 2 | `ClsGuard` | 215 | Establishes the CLS context (`cls.getId()` = the request id from `request-id.ts`). |
| 3 | `UnifiedAuthGuard` | 219 | Deny-by-default JWT / API-key / service-account auth. `@Public()` is the only opt-out. |
| 4 | **`TenantLockGuard`** | 227 | **Not in the README's list.** Returns `423 TENANT_RESTORE_IN_PROGRESS` while a checkpoint restore holds the tenant; fails closed (503) if lock state is unreadable. Must run after auth (reads CLS tenant) and before any write. `@TenantLockExempt()` opts out. |
| 5 | `PatientConsentGuard` | 238 | Consent/ABAC. Unconditional, no kill-switch. No-op without `@RequiresConsent(...)`. Must run before the OCC guard so a consent denial never reaches it. |
| 6 | `TenantOwnedResourceSseGuard` | 247 | Pre-stream tenant assertion for `@Sse()` routes; closes the cross-tenant leak the interceptor catches too late. No-op on non-SSE. |
| 7 | `OriginTenantBindingGuard` | 266 | Binds a browser `Origin` to the tenant that registered it. If moved before `UnifiedAuthGuard`, it silently degrades to a no-op because the CLS tenant is empty. |
| 8 | `RequiresIfMatchGuard` | 274 | Propagates `@RequiresIfMatch()` onto `req._requiresIfMatch`; `@ExpectedVersion()` then throws 428 on a missing header. |

> **Drift vs README:** the README documents a 7-guard chain and omits `TenantLockGuard`. The code has **8**. The README also calls `PatientConsentGuard` step 4, but `TenantLockGuard` now sits between auth and consent.

## B.2 Interceptors

Registered as `APP_INTERCEPTOR` in `interceptors[]` (lines 168–195), plus two registered elsewhere:

| Order | Interceptor | Source | Notes |
|---|---|---|---|
| 1 | `MetricsInterceptor` | `app.module.ts` | Per-handler request counters. Blind to guard-thrown responses — that is why the Express-level middleware exists. |
| 2 | `RateLimitHeadersInterceptor` | `app.module.ts` | Emits `RateLimit` / `RateLimit-Policy` from what the guard stashed. |
| 3 | `ContextInterceptor` | `app.module.ts` | Request context. |
| 4 | `ExceptionInterceptor` | `app.module.ts` | Maps domain/Prisma/downstream errors. |
| 5 | `MaintenanceInterceptor` | `app.module.ts` | Maintenance-mode gate. |
| 6 | `ImpersonationAuditInterceptor` | `app.module.ts` | Audits super-admin impersonation. |
| — | `TenantOwnedResourceInterceptor` | `common/tenant-owned-resource.module.ts` | Registered as `APP_INTERCEPTOR` by a module, not in the array. No-op without `@TenantOwnedResource(...)`. |
| — | `ETagInterceptor` | `main.ts` | Global via `useGlobalInterceptors`. |

## B.3 Filters — widest net to narrowest

`GLOBAL_EXCEPTION_FILTERS` (`filters/global-filters.ts`) is mapped to `APP_FILTER` providers. Nest consults the **last-registered matching filter first**, so the array is ordered widest → narrowest:

| # | Filter | Catches | Output |
|---|---|---|---|
| 1 | `AllExceptionsFilter` | `@Catch()` — anything unclaimed, including non-HTTP errors from guards | Generic 500 `INTERNAL.UNEXPECTED`; detail logged, never in the body |
| 2 | `HttpExceptionEnvelopeFilter` | `@Catch(HttpException)` — including 401/403/429 thrown by guards | Unified `{statusCode, code, message, correlationId}` envelope |
| 3 | `DataNotFoundExceptionFilter` | Generic 404 | Withholds model name and row id |
| 4 | `ConsentExceptionFilter` | Consent verdicts (403/503) thrown from the guard | Consent-specific envelope |

> **Drift vs README:** the README calls `HttpExceptionEnvelopeFilter` the "catch-all registered first". The actual catch-all is `AllExceptionsFilter`, and it is registered *first* precisely so it is consulted *last*.

## B.4 Module composition

`@Module({ imports: [...common, ...featureModules], providers: [...interceptors, ...guards, ...filters] })`.

**`common` (root-level, ~55 entries)** — chosen for DI visibility, not tidiness. A module must be root-level when an `APP_GUARD`/`APP_INTERCEPTOR` resolves a token from it:

- **Guard dependencies:** `OriginRegistryServiceModule` (origin binding), `ConsentServiceModule` (consent choke point), `CoreDatabaseModule` (consultation lookup by `:id`), `RateLimitServiceModule` + `EntitlementsServiceModule` (throttler tiers), `ApiKeyServiceModule` + `ServiceAccountServiceModule` (machine credential lanes).
- **Global machinery:** `LoggingServiceModule`, `ConfigModule.forRoot()`, `ClsModule.forRoot()`, `ThrottleConfigModule`, `ScheduleModule.forRoot()`, `EventEmitterModule.forRoot()`, `BlobStorageModule.forRoot()`, `RedisServiceModule.register(JobQueue values)`, `ObservabilityModule`.
- **Background workers:** `AuditRetentionServiceModule`, `TenantStoragePurgeServiceModule`, `AgentTrajectoryRetentionServiceModule`, `ConsultationTimeoutSweepServiceModule`, `FeedbackRollupServiceModule`, `SttJobReaperServiceModule`, `DnaProfileRetentionServiceModule`, `UsageLedgerServiceModule`, `StorageSnapshotServiceModule`.
- **Auth wiring:** `JwtAuthGuardModule` *before* `AuthorizationModule`; `ServiceAccountAuthenticatorModule` likewise.
- **Infra:** `VaultPrismaFactoryModule`, `VaultRotationWorkerModule`, `TenantContextProviderModule`, `TenantOwnedResourceModule`, `GracefulShutdownModule`, `TenantLockModule`.

**`featureModules` (~75 entries)** — controllers only. Two ordering constraints worth knowing:

- `PlatformKnobsModule`, `SecurityPolicyModule`, `SettingsCatalogModule` must precede `GlobalSettingModule` so static `admin/settings/catalog` wins over `admin/settings/:id`.
- `PrismaStudioModule` is **conditionally pushed** only when `shouldEnablePrismaStudio()` is true; `PrismaStudioStatusModule` is always registered so the console can distinguish "disabled" from "server down".

---

# Part C — Boot-time audits (`src/bootstrap/`)

Called between line 365 and 460. Every one except OCC **refuses to start** on drift. This is the single most valuable block in `main.ts`: it encodes the platform's authorization invariants as executable gates rather than review conventions.

| Line | Audit | Invariant enforced |
|---|---|---|
| 365 | `auditAdminRoutePermissions` | Every HTTP route carries `@Public()` or a permission decorator (`@Authorize` / `@CanXxx`). |
| 371 | `auditApiKeyRequiredScopes` | Every route on the SDK's day-1 summarization surface keeps its `@RequiredScopes(...)`. |
| 378 | `auditInternalRoutesOffApiKeySurface` | No `/internal/*` route is reachable via ordinary JWT/API-key auth. |
| 383 | `auditAdminControllersDeclareNoApiKeyScopes` | Derived sweep: no `admin/`-prefixed route declares API-key scopes. |
| 388 | `auditAdminScopedControllers` | Named-list companion: every registered admin controller is `@ForbidApiKey()`. Catches a controller vanishing from the graph. |
| 397 | `auditEveryApiKeyReachableRouteDeclaresScopes` | No non-public route is left undeclared (scopes or explicit forbid). |
| 405 | `auditBusinessPlaneApiKeyExemptions` | Non-admin `@ForbidApiKey()` routes must be named exemptions in `BUSINESS_PLANE_KEY_FORBIDDEN`. |
| 412 | `auditConsentRouteCoverage` | Every `:patientId` route has `@RequiresConsent(...)` or `@ConsentExempt(...)`. |
| 434 | `auditServiceAccountSurface` | Eight checks (B–H in the source): the third credential class cannot leak into admin or internal planes, no self-replication, `svc:*` scopes map 1:1 to admin areas, POST `/auth/service-token` is public **and** guarded. |
| 443 | `auditWebSocketGatewayOwnerBinding` | Every `@WebSocketGateway()` is classified in `WS_OWNER_BOUND_GATEWAYS`. The only audit that walks `moduleRef.providers` — the `.controllers` sweeps are blind to gateways. |
| 454 | `auditCaslEnforcePairReachability` | Every `CASL_ENFORCED_PAIRS` entry can actually produce its 403; no enforced pair on an OR-mode route. |
| 460 | `auditOptimisticConcurrencyCoverage` | **Warn-only by design** — reports versioned PATCH/PUT routes missing `If-Match` without refusing boot (closing it is a breaking client migration). |

Also called earlier: `assertJwtSecretNotPlaceholder` (181) and `assertGenaiContentCaptureDisabled` (72) — same "refuse to start" posture.

---

# Part D — Practical consequences

| Behaviour | Consequence when changing code |
|---|---|
| `api/v1` prefix is imported, never copied | Change `global-prefix.config.ts` and both the live app and the offline OpenAPI emitter follow. |
| Guard order is the enforcement | Moving `OriginTenantBindingGuard` before `UnifiedAuthGuard` silently disables it — no error, no failing test. |
| `TieredThrottlerGuard` runs before auth | Throttling keys must not depend on a resolved user. |
| Guard-thrown errors bypass interceptors | Metrics come from the Express middleware; error bodies come from filters, not `ExceptionInterceptor`. |
| `ETagInterceptor` is the only ETag source | Express auto-ETag stays off; `If-Match` only works on versioned routes. |
| Filters are consulted last-registered-first | Appending a new filter makes it *more* specific, not less. |
| Boot audits fail the process | A new controller without the right decorator cannot reach production — but it also cannot boot locally. |

---

# Part E — Suggested next reads

| Topic | File |
|---|---|
| Unified auth branches & credential classes | `packages/applications/src/.../unified-auth.guard.ts` (resolved from `@arcaai/applications`) |
| Throttler tiers and principal resolution | `apps/api/src/modules/throttle/` |
| Consent/ABAC implementation | `apps/api/src/guards/patient-consent.guard.ts`, `packages/applications` consent services |
| OCC contract end to end | `apps/api/src/decorators/requiresIfMatch.guard.ts`, `expectedVersion.decorator.ts`, `interceptors/etag.interceptor.ts` |
| Error envelope shape | `apps/api/src/filters/error-envelope.ts`, `http-exception-envelope.filter.ts` |
| CORS decision logic | `apps/api/src/cors.config.ts` (415 lines; read after Part B) |
| Route-level authorization data | `apps/api/route-manifest.json` (query, don't read) |
