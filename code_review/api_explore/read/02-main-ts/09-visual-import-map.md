# Visual — import map

**Audience:** visual learners, new to NestJS.
**Question this answers:** "This file imports 40 things — where does each one come from, and what does it do?"
**Companions:** [02-framework-packages.md](./02-framework-packages.md) · [03-third-party-libraries.md](./03-third-party-libraries.md) · [04-arcaai-workspace-packages.md](./04-arcaai-workspace-packages.md) · [05-local-app-code.md](./05-local-app-code.md)

---

## 1. Four kinds of import — the shape to memorise

```
                        any import specifier
                                │
        ┌───────────────┬───────┴────────┬────────────────┐
        ▼               ▼                ▼                ▼
   starts with      starts with      starts with      bare name
   "@nestjs/"       "@arcaai/"       "./" or "../"    ("zod")
        │               │                │                │
        ▼               ▼                ▼                ▼
   FRAMEWORK       THIS PROJECT     THIS PROJECT     GENERAL NPM
   node_modules    packages/        apps/api/src/    node_modules
   Nest team       your company     your company     third parties
        │               │                │                │
        └───────────────┴────────────────┴────────────────┘
                                │
                                ▼
                    all end up inside the same
                    NestJS dependency-injection graph
```

**Examples from these two files:**

```
@nestjs/core          → node_modules/@nestjs/core
@arcaai/applications  → project-hope/packages/applications
./bootstrap/…         → project-hope/apps/api/src/bootstrap/…
express-session       → node_modules/express-session
```

---

## 2. `main.ts` import tree

```
main.ts
│
├─ FRAMEWORK · 4 imports
│  │
│  ├─ @nestjs/common ────────── LogLevel ─────────────► type for LOG_LEVEL
│  ├─ @nestjs/core ──────────── NestFactory ──────────► creates the app [5]
│  ├─ @nestjs/platform-ws ───── WsAdapter ────────────► raw WS adapter [9]
│  └─ @nestjs/swagger ───────── SwaggerModule ────────► /api/v1/docs [11]
│
├─ GENERAL NPM · 1 import
│  │
│  └─ express-session ───────── session ──────────────► signed cookie [13]
│
├─ PROJECT PACKAGE · 1 specifier, 5 symbols
│  │
│  └─ @arcaai/applications
│     ├─ loadEnv ─────────────────────────────────────► read .env [1]
│     ├─ SecretsService ──────────────────────────────► session secret [12]
│     ├─ ILoggingService ─────────────────────────────► logger interface [6]
│     ├─ BuildInfoService ────────────────────────────► build metadata [18]
│     └─ IServiceReleaseService ──────────────────────► heartbeat [18]
│
└─ LOCAL FILES · 26 imports
   │
   ├─ ./app.module ───────────────────────────────────► root module [5]
   │
   ├─ ./crash-handlers ───────────────────────────────► process safety [0]
   │
   ├─ ./config ───────────────────────────────────────► apiEnv() zod [3]
   │   └─ ./config/index.ts
   │       ├─ env.schema.ts
   │       └─ env.descriptors.ts
   │
   ├─ ./cors.config ──────────────────────────────────► CORS policy [19]
   │
   ├─ ./global-prefix.config ─────────────────────────► api/v1 [10]
   │
   ├─ ./instrumentation ──────────────────────────────► flushOtel [17b]
   │   └─ (also PRELOADED as a side effect before main.ts)
   │
   ├─ ./filters/validation-violations ────────────────► global pipe [14]
   │
   ├─ ./interceptors ─────────────────────────────────► ETagInterceptor [16]
   │
   ├─ ./observability
   │  ├─ http-response-metrics ───────────────────────► count all responses [7]
   │  └─ prisma-pool-metrics ─────────────────────────► pg pool gauges [4]
   │
   ├─ ./services ─────────────────────────────────────► shutdown + heartbeat [17][18]
   │
   ├─ ./swagger.config ───────────────────────────────► OpenAPI builder [11]
   │
   └─ ./bootstrap/...  (14 files)
      ├─ internal-body-limit ─────────────────────────► body limit [8]
      ├─ admin-route-permission-audit ────────────────► audit [22]
      ├─ api-key-scope-audit ─────────────────────────► audit [22]
      ├─ admin-scope-audit ───────────────────────────► audit [22]
      ├─ api-key-surface-audit ───────────────────────► audit [22]
      ├─ business-plane-apikey-exemptions-audit ──────► audit [22]
      ├─ consent-route-coverage-audit ────────────────► audit [22]
      ├─ service-account-surface-audit ───────────────► audit [22]
      ├─ ws-gateway-owner-audit ──────────────────────► audit [22]
      ├─ casl-enforce-reachability-audit ─────────────► audit [22]
      ├─ occ-coverage-audit ──────────────────────────► WARN only [22]
      ├─ genai-content-capture-audit ─────────────────► PHI guard [2]
      └─ jwt-secret-placeholder-audit ────────────────► secret guard [12]
```

**Reading rule:** the number in brackets is the boot step from [07-visual-boot-flow.md](./07-visual-boot-flow.md). Except for `.audit` files, every local import is a small module whose only job is one of these steps.

---

## 3. `app.module.ts` import tree

```
app.module.ts
│
├─ FRAMEWORK · 7 imports
│  │
│  ├─ @nestjs/common ────────── Global, Module ───────► module declaration
│  ├─ @nestjs/core ──────────── APP_GUARD ────────────► 8 global guards
│  │                            APP_INTERCEPTOR ──────► 6 global interceptors
│  │                            APP_FILTER ───────────► 4 global filters
│  ├─ @nestjs/event-emitter ─── EventEmitterModule ───► in-process events
│  ├─ @nestjs/schedule ──────── ScheduleModule ───────► cron workers
│  └─ nestjs-cls ────────────── ClsModule, ClsGuard ──► per-request context
│
├─ PROJECT PACKAGES · 2 specifiers
│  │
│  ├─ @arcaai/applications  (29 imports)
│  │  │
│  │  ├─ SERVICE MODULES (wiring)
│  │  │  ├─ AuthServiceModule, AuthorizationModule
│  │  │  ├─ ApiKeyServiceModule, ServiceAccountServiceModule
│  │  │  ├─ ConsentServiceModule, OriginRegistryServiceModule
│  │  │  ├─ RateLimitServiceModule, EntitlementsServiceModule
│  │  │  ├─ TenantLockModule
│  │  │  ├─ CommonServiceModule, LoggingServiceModule, ObservabilityModule
│  │  │  ├─ RedisServiceModule, BlobStorageModule, SysEventServiceModule
│  │  │  ├─ AuditLogServiceModule, AuditRetentionServiceModule
│  │  │  ├─ ConsultationLifecycleModule, ConsultationAttachmentServiceModule
│  │  │  ├─ FactLedgerServiceModule, FeedbackRollupServiceModule
│  │  │  ├─ ConsultationTimeoutSweepServiceModule, SttJobReaperServiceModule
│  │  │  ├─ DnaProfileRetentionServiceModule, AgentTrajectoryRetentionServiceModule
│  │  │  ├─ UsageLedgerServiceModule, StorageSnapshotServiceModule
│  │  │  └─ TenantStoragePurgeServiceModule
│  │  │
│  │  ├─ CLASSES (behaviour)
│  │  │  ├─ UnifiedAuthGuard ─────────────────────────► guard #3
│  │  │  └─ ServiceAccountService ────────────────────► machine credentials
│  │  │
│  │  ├─ DI TOKENS (not classes)
│  │  │  ├─ JWT_AUTH_GUARD ───────────────────────────► picks JwtAuthGuard
│  │  │  └─ SERVICE_ACCOUNT_AUTHENTICATOR ────────────► picks the SA branch
│  │  │
│  │  └─ CUSTOM ConfigModule ─────────────────────────► NOT @nestjs/config
│  │      └─ wraps loadEnv() and exposes IConfigService
│  │
│  └─ @arcaai/domains  (2 imports)
│     ├─ CoreDatabaseModule ──────────────────────────► all repositories
│     └─ JobQueue ────────────────────────────────────► queue names for Redis
│
└─ LOCAL FILES
   │
   ├─ ./decorators/requiresIfMatch.guard ─────────────► guard #8 (OCC)
   ├─ ./filters/global-filters ───────────────────────► the 4 filters
   ├─ ./request-id ───────────────────────────────────► CLS options (uuidv7)
   ├─ ./guards ───────────────────────────────────────► guards #3,5,7
   ├─ ./interceptors ─────────────────────────────────► interceptors ×5
   ├─ ./common ───────────────────────────────────────► SSE guard + module
   ├─ ./services ─────────────────────────────────────► GracefulShutdownModule
   ├─ ./database/tenant-context.provider ─────────────► CLS → Prisma scope
   ├─ ./vault-prisma.module ──────────────────────────► optional Vault DB
   ├─ ./workers/vault-rotation.worker.module ─────────► credential rotation
   ├─ ./modules/throttle ─────────────────────────────► guard #1 + module
   └─ ./modules/**/*.module ───────────────────────────► ~75 feature modules
```

---

## 4. Where each layer physically lives

```
/Users/apple/repos/VOX/project-hope
│
├─ apps/
│  └─ api/
│     ├─ package.json
│     │  └─ "@arcaai/applications": "workspace:*"   ──┐
│     ├─ node_modules/                               │
│     │  ├─ @nestjs/*        ← downloaded            │
│     │  ├─ express-session  ← downloaded            │
│     │  └─ @arcaai/applications ── symlink ─────────┘
│     └─ src/
│        ├─ main.ts          ← app entrypoint
│        ├─ app.module.ts    ← root module
│        ├─ bootstrap/       ← local audit files
│        ├─ guards/          ← local guards
│        └─ modules/         ← 78 feature modules
│
└─ packages/
   ├─ database/       v0.1.0  ← Prisma client + extensions
   ├─ domains/        v0.0.1  ← entities, repositories
   ├─ applications/   v0.0.1  ← services, auth, secrets, modules
   ├─ exceptions/     v0.0.1
   ├─ types/          v5.0.1
   └─ utils/          v0.1.0
```

`workspace:*` in `package.json` is the giveaway. pnpm creates a symlink into `packages/`; nothing is downloaded from npm.

---

## 5. Dependency direction — never the other way

```
        ┌─────────────────────────────────────────────────────────┐
        │                      apps/api                           │
        │        controllers + app.module.ts + main.ts            │
        └───────────────────────────┬─────────────────────────────┘
                                    │ imports
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │               @arcaai/applications                      │
        │   services · DTOs · guards · CASL · secrets · queues    │
        └───────────────────────────┬─────────────────────────────┘
                                    │ imports
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │                  @arcaai/domains                        │
        │      entities · repositories · mappers · UoW            │
        └───────────────────────────┬─────────────────────────────┘
                                    │ imports
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │                  @arcaai/database                       │
        │        Prisma client · soft delete · tenant scope       │
        └─────────────────────────────────────────────────────────┘

   ✗ database never imports domains
   ✗ domains never imports applications
   ✗ applications never imports apps/api
   ✗ apps/api never imports Prisma directly
```

**Why beginners should care:** when you see a controller in `apps/api`, you will not find the SQL there. Follow the import down the chain. Each layer only knows about the layer below it, which is why a change in the database rarely breaks a controller.

---

## 6. "Which file do I open?" — flowchart

```
I see an import…
│
├─ @nestjs/… ?
│   └─ open node_modules/@nestjs/<name>
│      or read 02-framework-packages.md
│
├─ @arcaai/… ?
│   ├─ the symbol starts with I or is ALL_CAPS ?
│   │   └─ it is an interface / DI token:
│   │      grep -r "export .*<SYMBOL>" packages/
│   └─ it ends with Module / Service / Guard ?
│       └─ grep -r "class <SYMBOL>" packages/
│
├─ ./… or ../… ?
│   └─ it is a real file: open it directly
│       └─ ends with .audit.ts ? → boot-time check, read 05-local-app-code.md
│
└─ bare name ?
    └─ npm package: open node_modules/<name>/README.md
       or read 03-third-party-libraries.md
```

---

## 7. Symbol → runtime effect (the fast table)

```
IMPORTED SYMBOL              RUNS WHEN?              EFFECT
─────────────────────────────────────────────────────────────────────────────
NestFactory                  boot step [5]           builds the DI graph
WsAdapter                    boot step [9]           enables raw WebSockets
SwaggerModule                boot step [11]          serves /api/v1/docs
session                      boot step [13]          adds cookie middleware
Express middleware            every request           before Nest router
Guard                         every request           allow / deny
Interceptor                   every request           wraps the handler
Pipe                          every request           validates input
Filter                        on exception            writes the response
schedule @Cron                timer                   background jobs
event-emitter                 on emit                 in-process listeners
bullmq worker                 on job                  async processing
Prisma client                 on query                SQL + tenant filter
```

---

Back to [00-README.md](./00-README.md) · Previous: [08-visual-request-pipeline.md](./08-visual-request-pipeline.md).
