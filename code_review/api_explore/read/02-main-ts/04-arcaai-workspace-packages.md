# This project's own packages (`@arcaai/*`)

**Audience:** new to NestJS and to this monorepo.
**Scope:** what the `@arcaai/*` specifiers in `main.ts` / `app.module.ts` actually are.

These look like npm packages. They are **local folders** under `project-hope/packages/`, linked by pnpm. In `package.json` they appear as:

```json
"@arcaai/applications": "workspace:*"
```

`workspace:*` means "use the folder in this monorepo, never download it from npm".

---

## 1. The layer chain

This is the most important architectural fact in the repo:

```
packages/database      →  packages/domains      →  packages/applications   →  apps/api
(Prisma schema,           (entities, factories,     (application services,     (HTTP/WS
 generated client,         mappers, repositories,   DTOs, service modules,     controllers only)
 DB extensions)            units of work)           auth, secrets, Redis…)
```

Dependencies point **only to the left**. `apps/api` never imports Prisma directly. That is why the API app has "no business logic of its own".

| Layer | Answers the question | Must not contain |
|---|---|---|
| `database` | How is data stored? | Business rules |
| `domains` | What is an entity, and how is it loaded/saved? | HTTP concepts |
| `applications` | What operations does the platform support? | HTTP routing |
| `apps/api` | How does a client call those operations? | SQL/Prisma access |

---

## 2. Package-by-package

### `@arcaai/database` — v0.1.0

The data foundation.

| Item | What it is |
|---|---|
| `getExtendedPrismaClient()` | Prisma client with **soft-delete** and **tenant-scope** extensions applied |
| `getPlatformAdminPrismaClient_Unscoped()` | deliberately ugly name; an ESLint rule limits who may import it |
| `Prisma` types | generated model types |
| `src/prisma/db_main/` | the multi-file Prisma schema + committed migrations + phased seeds |

- **Soft delete:** rows are marked deleted instead of removed.
- **Tenant scope:** queries are automatically filtered by the current tenant context from CLS. This is a security control, not a convenience.
- **Not used directly by `apps/api`.** It arrives through `@arcaai/domains`.

### `@arcaai/domains` — v0.0.1

The DDD layer: entities and repositories.

| Imported in `app.module.ts` | What it is | Why it is imported at root |
|---|---|---|
| `CoreDatabaseModule` | registers every repository + `CoreDatabaseService` | `PatientConsentGuard` resolves a consultation repository from it |
| `JobQueue` | enum of queue names | `RedisServiceModule.register(Object.values(JobQueue))` registers all queues |

Also contains: `BaseEntity`, `BaseAggregate`, `BaseTenantEntity`, factories that mint UUIDv7 ids, mappers between entities and Prisma models, `QueryBuilder`, `CoreUnitOfWorkService.runInTransaction()`, optimistic concurrency support, domain events.

**Beginner note:** "aggregate" here means a cluster of entities treated as one consistency boundary. You do not need the full DDD theory to read the code; treat repositories as "the only place that talks to the database".

### `@arcaai/applications` — v0.0.1

The application layer. This is where almost all the `@arcaai/*` imports in `main.ts`/`app.module.ts` come from.

It contains four kinds of things:

| Kind | Examples from these files | What it means |
|---|---|---|
| **Services** | `SecretsService`, `ServiceAccountService`, `BuildInfoService` | classes with methods that do work |
| **Interfaces / DI tokens** | `ILoggingService`, `IServiceReleaseService`, `JWT_AUTH_GUARD`, `SERVICE_ACCOUNT_AUTHENTICATOR` | abstractions or `Symbol`s used for injection |
| **Service modules** | `AuthServiceModule`, `ConsentServiceModule`, `RedisServiceModule`, … | Nest modules that wire those services |
| **Authorization** | `UnifiedAuthGuard`, `AuthorizationModule` | the CASL-based access-control engine |
| **Platform infra** | `loadEnv`, `CommonServiceModule`, `ObservabilityModule` | env, config, logging, Redis, S3/blob, health, metrics |

`apps/api` composes its controllers exclusively from modules exported here. There are ~84 service domains in this package — do not try to memorise them.

#### The specific `main.ts` imports

| Import | What it actually is | Why `main.ts` needs it |
|---|---|---|
| `loadEnv` | the single `.env` loader (uses `dotenv`) | called before `NestFactory.create` because `LOG_LEVEL`/`PORT` are read before Nest exists |
| `SecretsService` | Vault-backed secret cache (warmed during module construction) | session secret + JWT secret assertions |
| `ILoggingService` | logging interface | `app.useLogger(loggingService)` after Nest creates the container |
| `BuildInfoService` | build metadata (version, git sha, release tag) | included in the service-release heartbeat |
| `IServiceReleaseService` | service registry interface | `startServiceReleaseRegistration(...)` self-registration |

#### The specific `app.module.ts` imports

Grouped by reason they are root-level:

| Group | Modules | Why root-level |
|---|---|---|
| Guard dependencies | `OriginRegistryServiceModule`, `ConsentServiceModule`, `ApiKeyServiceModule`, `ServiceAccountServiceModule`, `RateLimitServiceModule`, `EntitlementsServiceModule` | the `APP_GUARD` instances resolve tokens from these modules |
| Auth wiring | `AuthServiceModule`, `AuthorizationModule`, `UnifiedAuthGuard`, `JWT_AUTH_GUARD`, `SERVICE_ACCOUNT_AUTHENTICATOR`, `ServiceAccountService` | `UnifiedAuthGuard` is constructed once and must resolve all three credential branches |
| Config/secrets | `ConfigModule` (custom), `CommonServiceModule`, `LoggingServiceModule`, `ObservabilityModule` | config + logging exist before feature modules |
| Storage/queue | `RedisServiceModule`, `BlobStorageModule`, `SysEventServiceModule` | one shared instance app-wide |
| Background jobs | `AuditRetentionServiceModule`, `TenantStoragePurgeServiceModule`, `ConsultationTimeoutSweepServiceModule`, `FeedbackRollupServiceModule`, `SttJobReaperServiceModule`, `DnaProfileRetentionServiceModule`, `UsageLedgerServiceModule`, `StorageSnapshotServiceModule`, `AgentTrajectoryRetentionServiceModule` | scheduled workers must start with the app |
| Consultation domain | `ConsultationLifecycleModule`, `ConsultationAttachmentServiceModule`, `FactLedgerServiceModule` | domain services shared by many controllers |
| Tenancy | `TenantLockModule` | `TenantLockGuard` resolves from it |

> **Warning about `ConfigModule`.** In `app.module.ts` it is imported from `@arcaai/applications`, **not** from `@nestjs/config`. It is a small custom `@Global()` module that exposes `IConfigService` and calls the project's own `loadConfig()`. If you assume it is the Nest package, you will look in the wrong place.

### `@arcaai/exceptions` — v0.0.1

The shared exception hierarchy used by domains and applications (not-found, conflict, validation, optimistic-concurrency, consent, …). `apps/api` maps these to HTTP responses in `src/filters/`.

### `@arcaai/types` — v5.0.1 and `@arcaai/utils` — v0.1.0

Shared TypeScript types and small utilities. Not imported by `main.ts`; used lower in the stack.

### `@arcaai/async-contract` — workspace package

Shared async job/webhook contract (TypeScript half; the Python mirror is `py-async-contract`). Listed as an `apps/api` dependency.

### There is no `@arcaai/logger`

The logger lives **inside** `@arcaai/applications` (`services/baseServices/logging/`). `ILoggingService` is the interface, `LoggingService` the implementation, `LoggingServiceModule` the wiring.

---

## 3. How to explore these packages yourself

```bash
# list every workspace package
cat project-hope/pnpm-workspace.yaml

# see a package's exports
sed -n '1,80p' project-hope/packages/applications/src/index.ts

# find where a symbol is defined
rg "class SecretsService" project-hope/packages
rg "export const JWT_AUTH_GUARD" project-hope/packages
```

**Rule:** if `pnpm why <name>` says `link:../packages/...`, it is local code. If it says a registry URL, it is a downloaded dependency.

Next: [05-local-app-code.md](./05-local-app-code.md).
