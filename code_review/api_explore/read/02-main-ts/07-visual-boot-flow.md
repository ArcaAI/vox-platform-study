# Visual — `main.ts` boot flow

**Audience:** visual learners, new to NestJS.
**Companion to:** [../02-API-BOOT-AND-REQUEST-PIPELINE.md](../02-API-BOOT-AND-REQUEST-PIPELINE.md) Part A.
**All paths are relative to** `project-hope/apps/api/src/` unless marked `pkg:` (a workspace package) or `npm:` (a library).

---

## How to read these diagrams

```
LEGEND
  │     continues
  ├─    a step or a branch
  └─    the last step at that level
  [n]   step number, same as the parent document
  ◆     security-critical
  ↕     ordering constraint — do not move this line
  →     calls or imports
```

Read top to bottom. Indentation is nesting, not chronology; chronology is top-to-bottom at the same indentation level.

---

## 1. The seven phases at a glance

```
node --import ./dist/instrumentation.js dist/main.js
│
├─ PHASE 0 · TELEMETRY          instrumentation.ts
│     before any application code runs
│
├─ PHASE 1 · PROCESS SAFETY     [0]   crash handlers
│
├─ PHASE 2 · CONFIGURATION      [1]–[4]  env, PHI guard, zod, pool metrics
│     nothing exists yet except process.env
│
├─ PHASE 3 · CONTAINER          [5]–[6]  NestFactory, logger
│     now the DI graph and every provider exist
│
├─ PHASE 4 · HTTP / WS SURFACE  [7]–[16] middleware, prefix, pipes, ETag
│     the server is being shaped, not yet listening
│
├─ PHASE 5 · LIFECYCLE          [17]–[18] shutdown hooks, heartbeat
│
├─ PHASE 6 · POLICY             [19]–[22] CORS, headers, audits
│     any audit failure kills the process here
│
└─ PHASE 7 · SERVE              [23]–[24] timeouts, listen
```

**Why the phases matter:** each phase may only use what the previous phase created. That is why `PORT` is read from zod (`apiEnv()`) before Nest exists, and why the audits can only run after `NestFactory.create()`.

---

## 2. Full vertical tree

```
╔══════════════════════════════════════════════════════════════════════════════╗
║ PHASE 0 · TELEMETRY                                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝
│
├─ instrumentation.ts                                        (import side effect)
│  │  loaded by `node --import`, so it runs before main.ts
│  │  purpose: patch HTTP/Express/Prisma/Redis before they are required
│  ├─ instrumentation.flags.ts ............. pure env → enable/disable decisions
│  ├─ npm: @opentelemetry/sdk-node ......... NodeSDK bootstrap
│  ├─ npm: @opentelemetry/auto-instrumentations-node ... automatic spans
│  ├─ npm: @opentelemetry/exporter-trace-otlp-grpc ..... trace export (gRPC)
│  ├─ npm: @opentelemetry/exporter-logs-otlp-grpc ...... log export (gRPC)
│  ├─ npm: @opentelemetry/sdk-logs ......... BatchLogRecordProcessor
│  ├─ npm: @opentelemetry/resources ........ service.name / service.version
│  ├─ npm: @opentelemetry/semantic-conventions ... standard attribute keys
│  └─ npm: @prisma/instrumentation ......... Prisma query spans
│
└─ main.ts
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 1 · PROCESS SAFETY                                                  ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [0] line 48  registerCrashHandlers(undefined, { flushOtel })          ◆
   │   └─ ./crash-handlers.ts
   │      purpose: a crash during env load or DI construction still logs
   │      mode A: JSON to stderr (logger does not exist yet)
   │      mode B: after [6] attachLogger(), structured logging + OTel flush
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 2 · CONFIGURATION                                                   ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [1] line 64  loadEnv()                                                ◆
   │   └─ pkg: @arcaai/applications → common/env/index.ts
   │       └─ npm: dotenv
   │      purpose: choose and read .env.<NODE_ENV> BEFORE any process.env read
   │      rule:   host env > file > schema default; no file in CI/production
   │      why here: LOG_LEVEL / PORT / SHUTDOWN_* are read before Nest exists
   │
   ├─ [2] line 72  assertGenaiContentCaptureDisabled()                      ◆
   │   └─ ./bootstrap/genai-content-capture-audit.ts
   │      purpose: production must never export prompts/responses as telemetry
   │      placement: immediately after loadEnv() — the first resolved env view
   │
   ├─ [3] line 82  const env = apiEnv()                                     ◆
   │   └─ ./config/index.ts → ./config/env.schema.ts + env.descriptors.ts
   │       └─ npm: zod
   │      purpose: validate the whole declared env surface, fail once with
   │               every problem listed, before any port is bound
   │      returns: typed LOG_LEVEL, PORT, SHUTDOWN_TIMEOUT_MS, DRAIN_DELAY_MS
   │
   ├─ [4] line 96  installPrismaPoolMetrics()                              ↕
   │   └─ ./observability/prisma-pool-metrics.ts
   │      purpose: publish pg pool saturation (the gateway HPA cannot use CPU)
   │      why here: AFTER loadEnv (metric prefix from OTEL_SERVICE_NAME)
   │               BEFORE NestFactory (warmup issues the first queries)
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 3 · CONTAINER                                                       ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [5] line 116  NestFactory.create(AppModule, { ... })                  ◆
   │   ├─ pkg: @nestjs/core → NestFactory
   │   │    └─ builds EVERY provider, controller, guard, interceptor, filter
   │   ├─ → ./app.module.ts  (the root module; see 08-visual-request-pipeline.md)
   │   └─ options
   │      ├─ logger: getLogLevels(env.LOG_LEVEL) ... typed env, not process.env
   │      ├─ bufferLogs: true ..................... hold logs until useLogger
   │      ├─ rawBody: true ........................ keep raw body (webhooks)
   │      └─ forceCloseConnections: dev only ...... hot-reload friendliness
   │
   ├─ [6] line 125  app.get(ILoggingService) → app.useLogger(...)
   │   └─ pkg: @arcaai/applications → ILoggingService / LoggingServiceModule
   │      purpose: replace Nest's built-in console logger with platform logging
   │
   └─ [6b] line 128  crashHandlers.attachLogger(loggingService)
       └─ ./crash-handlers.ts
          purpose: crashes from now on use the structured logger
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 4 · HTTP / WS SURFACE                                               ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [7] line 146  app.use(httpResponseMetricsMiddleware())                ↕
   │   └─ ./observability/http-response-metrics.ts
   │      purpose: count EVERY response, including ones guards short-circuit
   │      why FIRST: Express middleware runs before the Nest router, so it sees
   │                429/401/CORS/session responses that interceptors miss
   │
   ├─ [8] line 149  applyInternalBodyLimits(app)
   │   └─ ./bootstrap/internal-body-limit.ts
   │      purpose: 2 MB JSON only for internal guardrail evaluation drain
   │
   ├─ [9] line 153  app.useWebSocketAdapter(new WsAdapter(app))
   │   ├─ pkg: @nestjs/platform-ws → WsAdapter
   │   │    └─ npm: ws
   │   └─ purpose: raw WS for STT + workflow streams (not Socket.IO)
   │
   ├─ [10] line 158  app.setGlobalPrefix('api/v1', options)                ◆↕
   │   └─ ./global-prefix.config.ts
   │      purpose: one constant shared with the offline OpenAPI emitter
   │      exclusion: /metrics only
   │
   ├─ [11] line 164  SwaggerModule.setup('api/v1/docs', ...)
   │   ├─ pkg: @nestjs/swagger
   │   ├─ → ./swagger.config.ts → createHopeOpenApiDocument()
   │   └─ only outside production
   │
   ├─ [12] line 181  assertJwtSecretNotPlaceholder(secretsService)         ◆
   │   ├─ ./bootstrap/jwt-secret-placeholder-audit.ts
   │   └─ pkg: @arcaai/applications → SecretsService
   │      purpose: defense-in-depth mirror of the JwtStrategy assertion
   │
   ├─ [13] line 187  app.use(session({ ... }))
   │   ├─ npm: express-session
   │   └─ secret ← SecretsService.getSecret('SESSION_SECRET_KEY')
   │      purpose: signed HttpOnly cookie, secure in production, 24h max age
   │
   ├─ [14] line 206  app.useGlobalPipes(createGlobalValidationPipe())       ◆
   │   ├─ ./filters/validation-violations.ts
   │   └─ npm: class-validator + class-transformer
   │      purpose: whitelist + forbidNonWhitelisted + forbidUnknownValues
   │      effect: unknown DTO keys are rejected at the HTTP boundary
   │
   ├─ [15] line 223  httpAdapter.set('etag', false)                         ◆
   │   └─ Express instance (npm: express 5.2.1, via @nestjs/platform-express)
   │      purpose: suppress Express weak ETags; only the strong ETag from [16]
   │
   ├─ [16] line 251  app.useGlobalInterceptors(new ETagInterceptor())
   │   └─ ./interceptors/etag.interceptor.ts
   │      purpose: strong ETag from body.version + If-None-Match → 304
   │      pairing: If-Match / 428 / 412 handled by RequiresIfMatchGuard
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 5 · LIFECYCLE                                                       ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [17] line 256  app.enableShutdownHooks()
   │   ├─ → ./services/graceful-shutdown.*  (GracefulShutdownService)
   │   └─ purpose: SIGTERM → close readiness → drain → cleanup → exit
   │
   ├─ [17b] line 266  registerCleanupCallback('otel-flush', flushOtel)
   │   └─ ./instrumentation.ts → flushOtel
   │      purpose: flush spans inside Nest's shutdown, not a competing handler
   │
   ├─ [18] line 274  startServiceReleaseRegistration(...)
   │   ├─ pkg: @arcaai/applications → IServiceReleaseService
   │   ├─ pkg: @arcaai/applications → BuildInfoService
   │   └─ purpose: self-register + heartbeat; NEVER blocks or fails boot
   │
   └─ [18b] line 278  registerCleanupCallback('service-release-heartbeat', ...)
       purpose: stop the heartbeat during shutdown
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 6 · POLICY                                                          ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [19] line 291  app.enableCors(buildCorsOptions(nodeEnv))              ◆
   │   └─ ./cors.config.ts
   │      rule: an origin is admitted IFF registered in TenantAllowedOrigin
   │      no wildcard · no env allow-list · credentials: false
   │      failure mode: registry unavailable → deny all browser origins
   │
   ├─ [20] lines 295–311  app.use(security headers)
   │   ├─ X-Content-Type-Options: nosniff
   │   ├─ X-Frame-Options: DENY
   │   ├─ X-XSS-Protection: 1; mode=block
   │   ├─ Referrer-Policy: strict-origin-when-cross-origin
   │   └─ CSP only for /api/v1/docs
   │
   ├─ [21] lines 313–354  log CORS posture
   │   └─ deliberately does NOT report origin.enforcementEnabled
   │      the authoritative line comes from PlatformKnobsBinder later
   │
   ├─ [22] lines 365–460  BOOT-TIME AUDITS                        ◆◆◆ refuse boot
   │   │
   │   ├─ 365 auditAdminRoutePermissions .............. every route has auth
   │   ├─ 371 auditApiKeyRequiredScopes .............. API-key route has scopes
   │   ├─ 378 auditInternalRoutesOffApiKeySurface .... /internal/* not key-able
   │   ├─ 383 auditAdminControllersDeclareNoApiKeyScopes
   │   ├─ 388 auditAdminScopedControllers ............ named admin list intact
   │   ├─ 397 auditEveryApiKeyReachableRouteDeclaresScopes
   │   ├─ 405 auditBusinessPlaneApiKeyExemptions ..... exemptions are named
   │   ├─ 412 auditConsentRouteCoverage .............. :patientId has consent
   │   ├─ 434 auditServiceAccountSurface ............. 3rd credential contained
   │   ├─ 443 auditWebSocketGatewayOwnerBinding ...... WS gateway classified
   │   ├─ 454 auditCaslEnforcePairReachability ....... denial can actually fire
   │   └─ 460 auditOptimisticConcurrencyCoverage ..... WARN ONLY (no throw)
   │       all live in ./bootstrap/*.ts
   │
   ╔═══════════════════════════════════════════════════════════════════════════╗
   ║ PHASE 7 · SERVE                                                           ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
   │
   ├─ [23] lines 481–482  keepAliveTimeout = 65s, headersTimeout = 66s      ↕
   │   purpose: outlive the upstream proxy idle timeout
   │   rule: headersTimeout MUST stay strictly greater than keepAliveTimeout
   │
   ├─ [24] line 484  await app.listen(env.PORT)
   │   purpose: bind 8868, start accepting HTTP + WS
   │
   └─ [24b] line 486  log "Application started" (env, port, Swagger, health)
```

---

## 3. Where each phase is decided

```
FILE                                    PHASES IT CONTROLS
──────────────────────────────────────  ──────────────────────────────────────
instrumentation.ts ....................  0
crash-handlers.ts .....................  1, 3b
env/index.ts (pkg) ....................  2
config/env.schema.ts ..................  2
bootstrap/genai-content-capture-audit  2
observability/prisma-pool-metrics.ts ..  2
app.module.ts ........................  3 (the whole DI graph)
logging module (pkg) .................  3b
observability/http-response-metrics.ts  4
bootstrap/internal-body-limit.ts .....  4
global-prefix.config.ts ..............  4
swagger.config.ts ....................  4
filters/validation-violations.ts .....  4
interceptors/etag.interceptor.ts .....  4
services/graceful-shutdown.* .........  5
services/service-release.* ...........  5
cors.config.ts .......................  6
bootstrap/*.audit.ts .................  6
main.ts ..............................  orchestrates all of the above
```

---

## 4. The ordering constraints, visualised

These are the places where **moving a line breaks security silently**. No test catches all of them.

```
loadEnv() ──────────────► apiEnv() ──────────────► NestFactory.create()
   │                        │                          │
   │                        │                          ├─ secrets warm
   │                        │                          ├─ settings registry
   │                        │                          └─ ALL providers exist
   │                        │
   │                        └─ PORT / LOG_LEVEL / SHUTDOWN_* typed
   │
   └─ .env file selected by NODE_ENV

installPrismaPoolMetrics() must be between apiEnv() and NestFactory.create()
```

```
registerCrashHandlers() ──► loadEnv() ──► NestFactory.create() ──► attachLogger()
        │                                                            │
        └─ catches crashes during all of this ────────────────────────┘
```

```
httpResponseMetricsMiddleware()  FIRST app.use
        │
        └─ sees 429 / 401 / CORS / session responses that guards produce
           before Nest's router and interceptors ever run
```

```
audits (365–460) ──► app.listen(484)
        │
        └─ any throw propagates out of bootstrap() and kills the process
           BEFORE a single request is served
```

---

## 5. What runs only in non-production

```
if (!isProduction) {
  SwaggerModule.setup('api/v1/docs', ...)     [11]
}
session.cookie.secure      = isProduction     [13]
session.cookie.httpOnly    = !isProduction    [13]
forceCloseConnections      = isDevelopment    [5]
```

Everything else runs in every environment. Security posture is **not** environment-conditional.

---

Back to [00-README.md](./00-README.md) · Next: [08-visual-request-pipeline.md](./08-visual-request-pipeline.md).
