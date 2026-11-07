# Visual — `app.module.ts` and the request pipeline

**Audience:** visual learners, new to NestJS.
**Companion to:** [../02-API-BOOT-AND-REQUEST-PIPELINE.md](../02-API-BOOT-AND-REQUEST-PIPELINE.md) Part B.
**All paths are relative to** `project-hope/apps/api/src/` unless marked `npm:` (a downloaded library), `pkg:` (a workspace package under `packages/`), or `local:` (a file in `apps/api/src`, written without the `./` prefix for space).

---

## 1. What `app.module.ts` actually builds

```
@Module({ imports: [...common, ...featureModules],
          providers: [...interceptors, ...guards, ...filters] })
        │
        ├─ imports
        │   │
        │   ├─ common[]  (34 modules, root-level)
        │   │   │
        │   │   ├─ infrastructure
        │   │   │   ├─ pkg: LoggingServiceModule
        │   │   │   ├─ pkg: CommonServiceModule
        │   │   │   ├─ pkg: ConfigModule            ← CUSTOM, not @nestjs/config
        │   │   │   ├─ pkg: ObservabilityModule
        │   │   │   ├─ pkg: RedisServiceModule      → registers JobQueue names
        │   │   │   ├─ pkg: BlobStorageModule
        │   │   │   └─ pkg: SysEventServiceModule
        │   │   │
        │   │   ├─ guard dependencies  (must be root-level)
        │   │   │   ├─ pkg: OriginRegistryServiceModule   → OriginTenantBindingGuard
        │   │   │   ├─ pkg: ConsentServiceModule          → PatientConsentGuard
        │   │   │   ├─ pkg: RateLimitServiceModule        → TieredThrottlerGuard
        │   │   │   ├─ pkg: EntitlementsServiceModule     → TieredThrottlerGuard
        │   │   │   ├─ pkg: ApiKeyServiceModule           → TieredThrottlerGuard
        │   │   │   ├─ pkg: ServiceAccountServiceModule   → TieredThrottlerGuard
        │   │   │   └─ pkg: TenantLockModule              → TenantLockGuard
        │   │   │
        │   │   ├─ auth wiring
        │   │   │   ├─ pkg: AuthServiceModule
        │   │   │   ├─ pkg: ApiKeyServiceModule                 → API-key branch
        │   │   │   ├─ pkg: ServiceAccountServiceModule         → service-account branch
        │   │   │   ├─ pkg: UnifiedAuthGuard (class)            → guard #3
        │   │   │   ├─ pkg: JWT_AUTH_GUARD (token)              → picks JwtAuthGuard
        │   │   │   └─ pkg: AuthorizationModule + SERVICE_ACCOUNT_AUTHENTICATOR
        │   │   │
        │   │   ├─ data / tenancy
        │   │   │   ├─ pkg: CoreDatabaseModule (from @arcaai/domains)
        │   │   │   ├─ local: vault-prisma.module               → VaultPrismaFactoryModule
        │   │   │   ├─ local: workers/vault-rotation.worker.module
        │   │   │   ├─ local: database/tenant-context.provider  → CLS → Prisma tenant scope
        │   │   │   └─ local: common/                           → TenantOwnedResourceModule (SSE)
        │   │   │
        │   │   └─ background workers (schedule)
        │   │       ├─ pkg: AuditRetentionServiceModule
        │   │       ├─ pkg: ConsultationTimeoutSweepServiceModule
        │   │       ├─ pkg: SttJobReaperServiceModule
        │   │       ├─ pkg: TenantStoragePurgeServiceModule
        │   │       ├─ pkg: UsageLedgerServiceModule
        │   │       └─ … (see 04-arcaai-workspace-packages.md)
        │   │
        │   └─ featureModules[]  (74 modules + 1 conditional, controllers only)
        │       ├─ ./modules/consultation/consultation.module.ts
        │       ├─ ./modules/auth/auth.module.ts
        │       ├─ ./modules/workflows/workflows.module.ts
        │       ├─ ./modules/streaming/streaming.module.ts
        │       ├─ … the other ~69 modules
        │       └─ ./modules/pstudio/pstudio.module.ts   ← conditionally pushed
        │
        └─ providers
            ├─ interceptors[]   (6 × APP_INTERCEPTOR)
            ├─ guards[]         (8 × APP_GUARD)
            └─ filters[]        (4 × APP_FILTER, from ./filters/global-filters.ts)
```

**Two kinds of module in `imports`:**

| Kind | Contains | Analogy |
|---|---|---|
| `common` | shared services, workers, guard dependencies | the building's utilities |
| `featureModules` | controllers for one business area | the rooms |

A controller is only reachable if its module is in `featureModules`. A service is only injectable into a global hook if its module is in `common`. That is why `ConsentServiceModule` appears in `common` even though consent is a feature.

---

## 2. One request, top to bottom

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HTTP or WS request                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
│
├─ EXPRESS MIDDLEWARE            (registered in main.ts, before Nest routing)
│  │
│  ├─ httpResponseMetricsMiddleware ....... main.ts:146  count every response
│  ├─ applyInternalBodyLimits ............. main.ts:149  2 MB for internal drain
│  ├─ express-session ..................... main.ts:187  signed cookie
│  ├─ CORS ................................ main.ts:291  registered-origin only
│  └─ security headers .................... main.ts:295  nosniff / DENY / CSP
│
├─ NEST ROUTER                   global prefix: api/v1
│  │
│  ├─ GUARD 1 · TieredThrottlerGuard ─────────────────────── ./modules/throttle/
│  │   │  npm: @nestjs/throttler
│  │   ├─ pkg: RateLimitServiceModule ....... live limits from GlobalSetting
│  │   ├─ pkg: EntitlementsServiceModule .... per-plan tier
│  │   ├─ pkg: ApiKeyServiceModule .......... API-key tenant lane
│  │   └─ pkg: ServiceAccountServiceModule .. service-account lane
│  │   ◆ first guard: reject abuse before auth work
│  │
│  ├─ GUARD 2 · ClsGuard ─────────────────────────────────── nestjs-cls (npm)
│  │   └─ ./request-id.ts → CLS_MODULE_OPTIONS (uuidv7 request id)
│  │
│  ├─ GUARD 3 · UnifiedAuthGuard ─────────────────────────── pkg: @arcaai/applications
│  │   ├─ JWT branch ............... JWT_AUTH_GUARD → ./guards/jwtauth.guard.ts
│  │   ├─ API-key branch ........... ApiKeyServiceModule
│  │   ├─ service-account branch ... SERVICE_ACCOUNT_AUTHENTICATOR
│  │   └─ ◆ deny-by-default; @Public() is the only opt-out
│  │
│  ├─ GUARD 4 · TenantLockGuard ──────────────────────────── ./guards/tenant-lock.guard.ts
│  │   └─ pkg: TenantLockModule → 423 TENANT_RESTORE_IN_PROGRESS / 503 fail-closed
│  │   ↕ must be after auth (needs CLS tenant)
│  │
│  ├─ GUARD 5 · PatientConsentGuard ──────────────────────── ./guards/patient-consent.guard.ts
│  │   └─ pkg: ConsentServiceModule → assertConsent choke point
│  │   ◆ no kill-switch; no-op without @RequiresConsent(...)
│  │   ↕ before OCC: a consent denial must never reach the OCC check
│  │
│  ├─ GUARD 6 · TenantOwnedResourceSseGuard ──────────────── ./common/
│  │   └─ pre-stream tenant assertion for @Sse() routes
│  │   ↕ closes the leak that the interceptor catches too late
│  │
│  ├─ GUARD 7 · OriginTenantBindingGuard ─────────────────── ./guards/origin-tenant-binding.guard.ts
│  │   └─ pkg: OriginRegistryServiceModule
│  │   ↕ MUST stay after auth; earlier = silently no-op
│  │
│  ├─ GUARD 8 · RequiresIfMatchGuard ─────────────────────── ./decorators/requiresIfMatch.guard.ts
│  │   └─ propagates @RequiresIfMatch() → @ExpectedVersion() throws 428
│  │
│  ├─ INTERCEPTORS (before)
│  │   ├─ MetricsInterceptor ..................... ./interceptors/metrics.interceptor.ts
│  │   ├─ RateLimitHeadersInterceptor ............ ./modules/throttle/
│  │   ├─ ContextInterceptor ..................... ./interceptors/context.interceptor.ts
│  │   ├─ ExceptionInterceptor ................... ./interceptors/exception.interceptor.ts
│  │   ├─ MaintenanceInterceptor ................. ./interceptors/maintenance.interceptor.ts
│  │   ├─ ImpersonationAuditInterceptor .......... ./interceptors/impersonation-audit.interceptor.ts
│  │   ├─ TenantOwnedResourceInterceptor ......... ./common/ (module-registered)
│  │   └─ ETagInterceptor ........................ ./interceptors/etag.interceptor.ts (main.ts:251)
│  │
│  ├─ PIPES
│  │   └─ ValidationPipe ......................... ./filters/validation-violations.ts
│  │       npm: class-validator + class-transformer
│  │
│  ├─ CONTROLLER  →  SERVICE  →  REPOSITORY  →  DB
│  │   ├─ controller ......... ./modules/<name>/**.controller.ts
│  │   ├─ service ............ pkg: @arcaai/applications
│  │   ├─ repository ......... pkg: @arcaai/domains
│  │   └─ database ........... pkg: @arcaai/database (Prisma)
│  │
│  ├─ INTERCEPTORS (after)
│  │   └─ reverse order; can rewrite the response
│  │
│  └─ RESPONSE
│
└─ EXCEPTION?  → FILTERS (see §4)
```

---

## 3. Guard → dependency graph (why root-level)

```
TieredThrottlerGuard
 ├──► RateLimitServiceModule ......... IRateLimitSettingsService
 ├──► EntitlementsServiceModule ...... IEntitlementsService
 ├──► ApiKeyServiceModule ............ IApiKeyService
 └──► ServiceAccountServiceModule .... IServiceAccountService

UnifiedAuthGuard
 ├──► JWT_AUTH_GUARD ................. JwtAuthGuard
 ├──► SERVICE_ACCOUNT_AUTHENTICATOR .. ServiceAccountService
 ├──► ApiKeyServiceModule ............ IApiKeyService
 └──► AuthorizationModule ............ CASL PolicyEngine

PatientConsentGuard
 ├──► ConsentServiceModule ........... IConsultationConsentService
 └──► CoreDatabaseModule ............. ConsultationRepository

OriginTenantBindingGuard
 └──► OriginRegistryServiceModule .... IOriginRegistry

TenantLockGuard
 └──► TenantLockModule ............... ITenantLockService
```

**If a module is imported only by a feature module, an `APP_GUARD` cannot see it.** Nest constructs global hooks in the root injector. The dependency simply resolves to `undefined` and the guard silently degrades — which is why these modules are in `common`, not in the feature's own `imports`.

---

## 4. Filters — registration vs consultation order

```
REGISTRATION ORDER (array in ./filters/global-filters.ts)
  ①  AllExceptionsFilter          @Catch()               ← widest
  ②  HttpExceptionEnvelopeFilter  @Catch(HttpException)
  ③  DataNotFoundExceptionFilter  domain-specific
  ④  ConsentExceptionFilter       domain-specific        ← narrowest

Nest consults the LAST-registered match FIRST:

  ┌──────────────────────────────────────────────────────────────┐
  │ exception arrives                                            │
  └──────────────────────────────────────────────────────────────┘
        │
        ▼
  ④ ConsentExceptionFilter  ── matches? ──► yes → consent envelope 403/503
        │ no
        ▼
  ③ DataNotFoundExceptionFilter ── matches? ──► yes → generic 404
        │ no
        ▼
  ② HttpExceptionEnvelopeFilter ── matches? ──► yes → unified envelope
        │ no
        ▼
  ① AllExceptionsFilter ── always matches ──► 500 INTERNAL.UNEXPECTED
```

**Consequence:** appending a new filter makes it **more specific**, not less. This is the opposite of the guards array, where earlier = first.

---

## 5. What each hook can and cannot see

```
                              sees 401/403/429
                              from guards?
  ┌───────────────────────┬──────────────────┬─────────────────────────────┐
  │ Layer                 │ Runs             │ Blind to                    │
  ├───────────────────────┼──────────────────┼─────────────────────────────┤
  │ Express middleware    │ before router    │ nothing on the response path│
  │ Guard                 │ before handler   │ post-handler work           │
  │ Interceptor           │ around handler   │ guard-thrown errors         │
  │ Pipe                  │ before handler   │ anything outside the input  │
  │ Filter                │ on exception     │ success path                │
  └───────────────────────┴──────────────────┴─────────────────────────────┘
```

This is why the project has **two** metrics paths:

```
MetricsInterceptor ............ counts handler responses only
httpResponseMetricsMiddleware . counts EVERY response, including guard 401/429
```

and **two** error paths:

```
ExceptionInterceptor .......... maps errors thrown inside the handler
Filters ....................... write the final body, including guard errors
```

---

## 6. Feature module anatomy

Most of the 78 modules look like this:

```
modules/consultation/
├─ consultation.module.ts                 ← DI wiring, imports, providers
├─ consultation.controller.ts             ← HTTP routes (thin)
├─ admin-consultation.controller.ts       ← /admin/consultations
├─ consultation-attachment.controller.ts  ← attachments
├─ consultation-feedback.controller.ts    ← feedback
├─ consultation-job.controller.ts         ← jobs
├─ consultation-telemetry.controller.ts   ← telemetry
├─ consultation-lifecycle-events.controller.ts
├─ consent-internal.controller.ts         ← /internal/consent
├─ consultation-read-internal.controller.ts
├─ harness-internal.controller.ts
├─ harness-service-token.guard.ts         ← service-to-service auth
├─ consultation-access.helper.ts          ← shared 404-over-403 check
├─ dto/                                   ← request/response shapes
└─ __tests__/                             ← colocated unit tests
```

Rules visible here:
- one module file, many controllers;
- controllers are thin and delegate to `pkg: @arcaai/applications`;
- internal routes get their own guard (`harness-service-token.guard.ts`);
- the tenant-safe 404 helper is shared rather than duplicated.

---

## 7. The full picture (one screen)

```
                         ┌─────────────────────────┐
                         │  main.ts (process)      │
                         │  env · crash · serve    │
                         └────────────┬────────────┘
                                      │ creates
                                      ▼
                         ┌─────────────────────────┐
                         │  app.module.ts          │
                         │  DI graph + global hooks│
                         └────────────┬────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
  ┌───────────────┐          ┌─────────────────┐          ┌───────────────┐
  │ common[]      │          │ featureModules[]│          │ providers     │
  │ shared infra  │          │ controllers     │          │ guards        │
  │ workers       │          │ (78 modules)    │          │ interceptors  │
  │ guard deps    │          │                 │          │ filters       │
  └───────┬───────┘          └────────┬────────┘          └───────┬───────┘
          │                           │                           │
          ▼                           ▼                           ▼
  @arcaai/applications  ─────►  @arcaai/domains  ─────►  @arcaai/database
  services, secrets,            entities, repos,          Prisma client,
  auth, queues, storage         units of work             tenant scope
```

---

Back to [00-README.md](./00-README.md) · Previous: [07-visual-boot-flow.md](./07-visual-boot-flow.md) · Next: [09-visual-import-map.md](./09-visual-import-map.md).
