# Import reference — `main.ts` and `app.module.ts`

**Audience:** quick lookup while reading the code.
**Legend for "Kind":** 🟦 Nest core · 🟨 Nest official integration · 🟪 Community library · 🟩 General npm library · 🏠 This project (`@arcaai/*`) · 📄 Local file

---

## 1. `main.ts` — every import

### Framework and libraries

| Import | Kind | What it gives you | Why it is here |
|---|---|---|---|
| `LogLevel` from `@nestjs/common` | 🟦 | TS type for log levels | build the logger level list |
| `NestFactory` from `@nestjs/core` | 🟦 | creates the app | line 116, builds the DI graph |
| `WsAdapter` from `@nestjs/platform-ws` | 🟨 | raw `ws` adapter | line 153, WebSocket streams |
| `SwaggerModule` from `@nestjs/swagger` | 🟨 | Swagger UI + OpenAPI | line 164, `/api/v1/docs` |
| `session` from `express-session` | 🟩 | signed session cookie middleware | line 187 |
| (implicit) `express` | 🟩 (transitive) | `req`/`res`/`next` | not imported directly |

### This project's packages

| Import | Kind | What it gives you | Why it is here |
|---|---|---|---|
| `loadEnv` | 🏠 `@arcaai/applications` | `.env` loader | line 64, before Nest exists |
| `ILoggingService` | 🏠 | logger interface | `app.useLogger(...)` |
| `SecretsService` | 🏠 | Vault-backed secrets | session secret, JWT assertion |
| `BuildInfoService` | 🏠 | build metadata | service-release heartbeat |
| `IServiceReleaseService` | 🏠 | registry interface | self-registration |

### Local files

| Import | Kind | Purpose |
|---|---|---|
| `./app.module` | 📄 | root module |
| `./bootstrap/internal-body-limit` | 📄 | raise body limit for internal drain only |
| `./bootstrap/admin-route-permission-audit` | 📄 | audit: route has auth metadata |
| `./bootstrap/api-key-scope-audit` | 📄 | audit: API-key scopes + internal surface |
| `./bootstrap/admin-scope-audit` | 📄 | audit: admin plane forbids API keys |
| `./bootstrap/api-key-surface-audit` | 📄 | audit: no undeclared route |
| `./bootstrap/business-plane-apikey-exemptions-audit` | 📄 | audit: exemptions are named |
| `./bootstrap/consent-route-coverage-audit` | 📄 | audit: `:patientId` has consent |
| `./bootstrap/service-account-surface-audit` | 📄 | audit: credential classes do not mix |
| `./bootstrap/ws-gateway-owner-audit` | 📄 | audit: WS gateways classified |
| `./bootstrap/casl-enforce-reachability-audit` | 📄 | audit: CASL denial is reachable |
| `./bootstrap/occ-coverage-audit` | 📄 | warn: PATCH/PUT missing `If-Match` |
| `./bootstrap/genai-content-capture-audit` | 📄 | refuse GenAI content telemetry |
| `./bootstrap/jwt-secret-placeholder-audit` | 📄 | refuse placeholder JWT secret |
| `./config` | 📄 | `apiEnv()` zod-validated env |
| `./cors.config` | 📄 | CORS options builder |
| `./crash-handlers` | 📄 | process-level crash handling |
| `./filters/validation-violations` | 📄 | global validation pipe |
| `./global-prefix.config` | 📄 | `api/v1` constant |
| `./instrumentation` | 📄 | OpenTelemetry side effect |
| `./interceptors` | 📄 | `ETagInterceptor` |
| `./observability/http-response-metrics` | 📄 | count every response |
| `./observability/prisma-pool-metrics` | 📄 | DB pool saturation metrics |
| `./services` | 📄 | graceful shutdown + registration |
| `./swagger.config` | 📄 | OpenAPI document builder |

---

## 2. `app.module.ts` — grouped imports

### Framework

| Import | Kind | Purpose |
|---|---|---|
| `Global`, `Module` from `@nestjs/common` | 🟦 | module declaration, global helper modules |
| `APP_FILTER`, `APP_GUARD`, `APP_INTERCEPTOR` from `@nestjs/core` | 🟦 | global registration **with DI** |
| `EventEmitterModule` from `@nestjs/event-emitter` | 🟨 | in-process events |
| `ScheduleModule` from `@nestjs/schedule` | 🟨 | cron/interval workers |
| `ClsGuard`, `ClsModule` from `nestjs-cls` | 🟪 | per-request context |

### Project packages (`@arcaai/applications`)

| Import | Type | Purpose |
|---|---|---|
| `CommonServiceModule` | module | config, secrets, logging, health base |
| `ConfigModule` | module | **custom** config module (not `@nestjs/config`) |
| `LoggingServiceModule` | module | `ILoggingService` |
| `ObservabilityModule` | module | metrics/tracing |
| `RedisServiceModule` | module | Redis + queue registration |
| `BlobStorageModule` | module | S3/MinIO access |
| `SysEventServiceModule` | module | internal event fan-out |
| `AuthServiceModule` | module | auth services |
| `AuthorizationModule` | module | CASL policy engine |
| `UnifiedAuthGuard` | class | the deny-by-default guard |
| `JWT_AUTH_GUARD` | token | JWT branch injection token |
| `SERVICE_ACCOUNT_AUTHENTICATOR` | token | machine-credential branch |
| `ServiceAccountService` / `ServiceAccountServiceModule` | class/module | service accounts |
| `ApiKeyServiceModule` | module | API-key branch + throttler tenant lanes |
| `ConsentServiceModule` | module | consent choke point |
| `OriginRegistryServiceModule` | module | origin → tenant registry |
| `RateLimitServiceModule` | module | live rate-limit settings |
| `EntitlementsServiceModule` | module | per-plan throttler tiers |
| `TenantLockModule` | module | tenant restore lock |
| `AuditLogServiceModule`, `AuditRetentionServiceModule` | modules | audit writes + retention |
| `ConsultationLifecycleModule`, `ConsultationAttachmentServiceModule`, `FactLedgerServiceModule`, `FeedbackRollupServiceModule`, `ConsultationTimeoutSweepServiceModule` | modules | consultation domain |
| `SttJobReaperServiceModule` | module | stranded STT job cleanup |
| `DnaProfileRetentionServiceModule` | module | DNA retention purge |
| `UsageLedgerServiceModule`, `StorageSnapshotServiceModule` | modules | metering |
| `TenantStoragePurgeServiceModule` | module | deleted-tenant bucket purge |
| `AgentTrajectoryRetentionServiceModule` | module | trajectory retention |

### Project packages (`@arcaai/domains`)

| Import | Type | Purpose |
|---|---|---|
| `CoreDatabaseModule` | module | all repositories + DB service |
| `JobQueue` | enum | queue names registered with Redis |

### Local files

| Import | Purpose |
|---|---|
| `./decorators/requiresIfMatch.guard` | OCC marker guard |
| `./filters/global-filters` | filter list |
| `./request-id` | CLS options |
| `./guards` | JWT/consent/origin guards |
| `./interceptors` | six global interceptors |
| `./common` | SSE tenant safety |
| `./services` | graceful shutdown |
| `./database/tenant-context.provider` | CLS → Prisma tenant scope |
| `./vault-prisma.module` | Vault Prisma factory |
| `./workers/vault-rotation.worker.module` | Vault rotation |
| `./modules/throttle` | throttler |
| `./modules/throttle/rate-limit-headers.interceptor` | rate-limit headers |
| `./modules/**/*.module` | ~75 feature modules |

---

## 3. Symbols that are **not** classes

Beginners often trip on these. They are **DI tokens**: opaque keys used by Nest's injector.

| Token | Declared as | Meaning |
|---|---|---|
| `APP_GUARD` | `const` from `@nestjs/core` | "register this class as a global guard" |
| `APP_INTERCEPTOR` | `const` from `@nestjs/core` | "register globally as interceptor" |
| `APP_FILTER` | `const` from `@nestjs/core` | "register globally as exception filter" |
| `JWT_AUTH_GUARD` | `Symbol('JWT_AUTH_GUARD')` | picks the JWT branch implementation |
| `SERVICE_ACCOUNT_AUTHENTICATOR` | `Symbol(...)` | picks the service-account branch |
| `IConfigService`, `ILoggingService`, `IServiceReleaseService` | abstract class or symbol | interface-style injection |

You will see them in `providers` like this:

```ts
{ provide: JWT_AUTH_GUARD, useClass: JwtAuthGuard }
{ provide: APP_GUARD,       useClass: UnifiedAuthGuard }
```

That is not inheritance. It is "when someone asks for token X, give them class Y".

---

## 4. Read the imports in this order

1. `@nestjs/common` + `@nestjs/core` — the framework.
2. `@arcaai/applications` — the business layer.
3. `@arcaai/domains` / `@arcaai/database` — data layer.
4. `./…` — app-specific wiring.
5. `express-session`, `uuidv7`, `zod`, OTel — supporting libraries.

Back to [00-README.md](./00-README.md).
