# API Gateway

The HOPE API Gateway is the central entry point for all client requests in the HOPE platform. Built with NestJS 11, it provides multi-authentication, multi-tenant data isolation, microservice orchestration to Python AI services, real-time WebSocket communication, and enterprise-grade observability.

## Architecture

### High-Level Request Flow

```
Client (Web / Mobile / SDK)
          │
          ▼
┌──────────────────────────────────────────────────────────┐
│                  API Gateway  (NestJS)                    │
│                                                          │
│  Middleware Pipeline                                     │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  Security   │→ │    CORS      │→ │  Rate Limiter   │  │
│  │  Headers    │  │              │  │                 │  │
│  └────────────┘  └──────────────┘  └─────────────────┘  │
│                         │                                │
│  Guard Chain            ▼                                │
│  ┌──────────────────────────────────────────────────┐    │
│  │         UnifiedAuthGuard (API Key → JWT → CASL)     │ │
│  └──────────────────────────────────────────────────┘    │
│                         │                                │
│  Interceptors           ▼                                │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  Context   │→ │  Exception   │→ │  Maintenance    │  │
│  └────────────┘  └──────────────┘  └─────────────────┘  │
│                         │                                │
│  Feature Modules        ▼                                │
│  ┌─────────┐ ┌─────┐ ┌─────┐ ┌────────┐ ┌────────────┐  │
│  │ Consult  │ │ STT │ │ SMR │ │Harness │ │ NLP + more │  │
│  └─────────┘ └─────┘ └─────┘ └────────┘ └────────────┘  │
└──────────────────────┬───────────────────────────────────┘
          ┌────────────┼────────────┬────────────┐
          ▼            ▼            ▼            ▼
   STT Service   SMR Service  Guardrail    NLP Service
   (Python)      (Python)     (Python)     (Python)
          │            │            │            │
          └────────────┴────────────┴────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
     PostgreSQL                   Redis
     (via Prisma)           (Cache / BullMQ)
```

### Module Structure

The application is composed of **common infrastructure modules** and **feature modules**, wired together in `app.module.ts`.

**Common / Infrastructure:**

| Module | Source | Purpose |
|--------|--------|---------|
| `ConfigModule` | `@arcaai/applications` | Typed environment configuration |
| `LoggingServiceModule` | `@arcaai/applications` | Structured JSON logging |
| `RedisServiceModule` | `@arcaai/applications` | Redis connections and BullMQ queues |
| `BlobStorageModule` | `@arcaai/applications` | Provider-agnostic blob storage (S3/MinIO/Azure); registered once via `forRoot()` as a single app-wide provider factory |
| `ObservabilityModule` | `@arcaai/applications` | Highlight, OpenTelemetry |
| `AuditLogServiceModule` | `@arcaai/applications` | Event-driven audit logging |
| `AuditRetentionServiceModule` | `@arcaai/applications` | Scheduled `AuditLog` retention purge (bounds table growth) |
| `AuthorizationModule` | `@arcaai/applications` | CASL-based policy authorization |
| `RateLimitServiceModule` | `@arcaai/applications` | DB-backed rate-limit settings; exposes `IRateLimitSettingsService` (live limits for the throttler guard) and `IRateLimitAdminService` (admin endpoint) |
| `SysEventServiceModule` | `@arcaai/applications` | System event bus |
| `CommonServiceModule` | `@arcaai/applications` | Shared utilities |
| `ClsModule` | `nestjs-cls` | Continuation-local storage for request context |
| `ScheduleModule` | `@nestjs/schedule` | Cron jobs and intervals |
| `EventEmitterModule` | `@nestjs/event-emitter` | In-process event emitter |
| `GracefulShutdownModule` | Local | Coordinated shutdown with drain delay |
| `ThrottleConfigModule` | Local | Global `@nestjs/throttler` config in `modules/throttle/` — named tiers (`default`/`strict`/`heavy`/`relaxed`) over Redis or in-memory storage; exports `TieredThrottlerGuard` |
| `JwtAuthGuardModule` | Local | `@Global` module (defined in `app.module.ts`) registering `JWT_AUTH_GUARD` so `UnifiedAuthGuard` resolves the JWT strategy across feature modules |
| `VaultPrismaFactoryModule` | Local | `vault-prisma.module.ts` — binds `VAULT_PRISMA_FACTORY` to a Vault-backed PrismaClient when `SECRETS_PROVIDER=vault` + `PG_DYNAMIC_CREDS=true`; a no-op factory otherwise |
| `VaultRotationWorkerModule` | Local | `workers/` — leader-elected worker that tails the Vault audit log to invalidate rotated DB credentials; self-gated by `SECRETS_PROVIDER=vault` + `VAULT_AUDIT_LOG_PATH` |
| `TenantContextProviderModule` | Local | `database/` — wires `ClsService` into the `tenantScopeFilter` Prisma extension so queries are tenant-scoped from the active request context |
| `TenantOwnedResourceModule` | Local | `common/` — registers the global `TenantOwnedResourceInterceptor` that enforces cross-tenant resource ownership |

**Feature Modules:**

> **Note:** The gateway's module layout has been reorganized. Several proxies were consolidated (e.g. the SMR proxy now lives in `modules/streaming/smr-proxy.controller.ts`) and the standalone TTS, FedL, and Feedback proxy modules were removed. New modules were added (`harness-admin`, `pipeline`, `queue-admin`, `storage`, `storage-access-key`, `tenant-bucket`, `tenant-frontend-config`, `tenant-storage-config`, `voice-profile`, `api-key`, `admin-rate-limit`, `internal`). The authoritative list is the `featureModules` array in `app.module.ts` — most modules live under `apps/api/src/modules/`, but a few (e.g. `KnowledgeServiceModule`) are sourced from `@arcaai/applications`.

| Module | Path | Purpose |
|--------|------|---------|
| `RateLimitAdminModule` | `modules/admin-rate-limit/` | Admin configuration of API rate limits (`/admin/rate-limit`) |
| `ApiKeyModule` | `modules/api-key/` | API key issuance, rotation, and scope management (`/admin/api-keys`) |
| `AuditLogModule` | `modules/audit-log/` | Audit log query endpoints |
| `AuthModule` | `modules/auth/` | JWT login/logout, session management |
| `ConsultationModule` | `modules/consultation/` | Consultation lifecycle, context items, summaries, jobs, timeline, harness-internal callbacks |
| `DepartmentModule` | `modules/department/` | Department CRUD with hierarchy |
| `DnaWritingStyleModule` | `modules/dna-writing-style/` | AI writing-style profile generation and management |
| `HarnessAdminModule` | `modules/harness-admin/` | Clinical Documentation Harness admin/ops integration |
| `HealthModule` | `modules/health/` | Health, readiness, liveness, startup probes + consolidated downstream service health |
| `InternalModule` | `modules/internal/` | Internal STT service-to-service endpoints (excluded from the `/api/v1` prefix) |
| `KnowledgeServiceModule` | `@arcaai/applications` (not under `modules/`) | Institutional-RAG knowledge ingestion — BullMQ worker registering the `IngestKnowledgeDocument` queue + processor (worker-only; no REST controllers) |
| `MonitoringModule` | `modules/monitoring/` | Downstream service uptime/heartbeat dashboards |
| `PipelineModule` | `modules/pipeline/` | Audio pipeline configuration (admin + public) and tenant assignment |
| `PromptManagementModule` | `modules/prompt-management/` | Prompt template CRUD with versioning |
| `PrismaStudioModule` | `modules/pstudio/` | Embedded Prisma Studio database browser (dev/staging only) |
| `QueueAdminModule` | `modules/queue-admin/` | BullMQ queue and scheduler administration |
| `RbacModule` | `modules/rbac/` | Roles, policies, permission checks |
| `StorageModule` | `modules/storage/` | Object storage upload/download and metadata |
| `StorageAccessKeyModule` | `modules/storage-access-key/` | Per-tenant storage access key management |
| `StreamingModule` | `modules/streaming/` | Consolidated STT/SMR surface — SMR text proxy, transcription jobs, STT WebSocket gateway |
| `TenantModule` | `modules/tenant/` | Tenant management |
| `TenantBucketModule` | `modules/tenant-bucket/` | Per-tenant storage bucket provisioning |
| `TenantFrontendConfigModule` | `modules/tenant-frontend-config/` | Per-tenant frontend/pipeline configuration |
| `TenantStorageConfigModule` | `modules/tenant-storage-config/` | Per-tenant storage backend configuration |
| `UserModule` | `modules/user/` | User CRUD plus per-user settings, preferences, roles, and departments |
| `VoiceProfileModule` | `modules/voice-profile/` | Speaker voice-profile enrollment and management |

### Guard & Authorization Chain

The API uses a single `UnifiedAuthGuard` from `@arcaai/applications` that handles all authentication and authorization in one processing pipeline:

1. **Public check** — Routes decorated with `@Public()` skip all authentication
2. **API Key path** — If `apikey`, `api-key`, or `x-api-key` header is present: validates key hash via `IApiKeyService`, enforces rate limits (Redis), IP allowlist, and scope restrictions, sets tenant context in CLS
3. **JWT path** — If `Authorization: Bearer <token>` is present: validates via Passport `jwt` strategy, evaluates CASL permissions via `PolicyEngine`
4. **No credentials** — Returns 401 Unauthorized

`OidcAuthGuard` remains a separate guard for enterprise SSO integration flows.

Controllers use decorator shortcuts from `@arcaai/applications` (re-exported via `apps/api/src/decorators/`):
- `@Authorize(['read', 'User'])` — requires specific CASL permission(s), handles both JWT and API key auth
- `@Authorize()` — authentication only, no specific permissions (replaces removed `@Authenticated()`)
- `@CanRead('User')`, `@CanCreate('User')`, `@CanUpdate('User')`, `@CanDelete('User')`, `@CanManage('User')` — shorthand permission decorators
- `@Public()` — bypasses the entire guard chain

### Middleware & Interceptor Pipeline

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Middleware | Custom security headers | `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy` |
| Middleware | CORS | Origin validation (env-aware callback) |
| Middleware | express-session | Session cookies |
| Interceptor | `ContextInterceptor` | Generates request ID (UUID v7), propagates CLS context |
| Interceptor | `ExceptionInterceptor` | Normalizes error responses |
| Interceptor | `MaintenanceInterceptor` | Returns 503 when maintenance mode is active |
| Filter | `PrismaFilter` | Translates Prisma errors to user-friendly HTTP responses |

## Tech Stack

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Framework | NestJS | 11.x | Enterprise Node.js framework |
| Language | TypeScript | 5.8 | Strict-mode type safety |
| Runtime | Node.js | 18+ | JavaScript runtime |
| ORM | Prisma | (workspace) | Type-safe PostgreSQL access |
| Queue | BullMQ | 5.42 | Background job processing |
| WebSocket | ws (native) | 8.18 | Real-time bi-directional communication (via `@nestjs/platform-ws`) |
| Validation | class-validator | 0.14 | DTO validation decorators |
| API Docs | @nestjs/swagger | 11.x | OpenAPI / Swagger UI |
| Metrics | prometheus-api-metrics | 3.2 | Prometheus endpoint |
| Tracing | @sentry/node | 9.x | Error tracking and profiling |
| HTTP Client | @nestjs/axios | 4.x | Proxying to microservices |
| HTTP Proxy | http-proxy-middleware | 3.x | Reverse proxy for Python services |
| Auth | passport, passport-jwt | 0.7 / 4.x | JWT and OIDC strategies |
| Logging | pino-pretty, winston | — | Structured JSON logging |
| Security | Custom headers middleware | — | HTTP security headers (replaces helmet) |

## Getting Started

### Prerequisites

- **Node.js** 18+ (20.x recommended)
- **pnpm** 10.6.5+
- **PostgreSQL** 14+
- **Redis** 7+
- **Docker & Docker Compose** (optional, for infrastructure services)

### Environment Setup

```bash
# From the monorepo root
pnpm install

# Copy environment template
cp apps/api/.env.example apps/api/.env

# Edit apps/api/.env with local values (see configuration.md)
```

### Database Setup

```bash
cd packages/database
npx prisma migrate dev
npx prisma generate
pnpm seed            # optional: populate seed data
```

### Running Locally

```bash
cd apps/api
pnpm dev             # http://localhost:8868
```

Swagger UI is available at `http://localhost:8868/api/v1/docs` in non-production modes.

### Quick Start with Docker

```bash
cd infrastructure/docker
make dev-up          # starts PostgreSQL, Redis, all services
make dev-down        # tears down
```

## Configuration

All environment variables are documented in [configuration.md](./configuration.md). Key groups:

| Group | Examples |
|-------|---------|
| Application | `NODE_ENV`, `PORT`, `URL` |
| Database | `DB_CONNECTION_STRING`, `DB_CONNECTION_STRING_DIRECT` |
| Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASS` |
| Microservices | `STT_V2_URL`, `SMR_URL`, `NLP_URL`, `GUARDRAIL_URL`, `HARNESS_URL` |
| Auth | `SESSION_SECRET_KEY` |
| Observability | `SENTRY_DSN_API`, `HIGHLIGHT_PROJECT_ID`, `OTEL_*` |
| Logging | `LOG_LEVEL`, `LOG_FILE_ENABLED`, `LOG_FILE_PATH` |

> **Microservice URLs:** The gateway proxies to STT v2 (`8861`), SMR (`8862`), Guardrail (`8863`), NLP (`8864`), and Harness (`8866`). The former TTS and FedL services no longer exist — `TTS_URL`/`FEDL_URL` are not gateway config, and port `8863` now serves the Guardrail service (`GUARDRAIL_URL`).

## Module Reference

See [api-reference.md](./api-reference.md) for the full endpoint catalog grouped by module.

## Testing

```bash
# Unit tests (Vitest)
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:cov

# End-to-end tests
pnpm test:e2e
```

Tests use `@nestjs/testing` with `TestingModule` for isolated unit tests and `supertest` for E2E HTTP assertions.

## Deployment

### Docker

```bash
docker build -t hope-api:latest -f apps/api/Dockerfile .
docker run -p 8868:8868 --env-file apps/api/.env hope-api:latest
```

### Single Server (systemd)

A systemd unit file runs `node dist/main.js` behind an Nginx reverse proxy with TLS. See the deployment guide for full Nginx configuration, SSL setup, and WebSocket proxy rules.

### Kubernetes

The API Gateway ships with a Deployment (3 replicas), HPA (CPU 70 %, memory 80 %), Service, and Ingress manifest. Readiness and liveness probes point to `/api/v1/health/ready` and `/api/v1/health/live`.

### Graceful Shutdown

On `SIGTERM`/`SIGINT`:

1. `/api/health/ready` returns 503 — load balancer stops routing.
2. Drain delay (`SHUTDOWN_DRAIN_DELAY_MS`, default 5 s) for in-flight requests.
3. WebSocket connections are closed with a shutdown message.
4. Database, Redis, and background workers are released.
5. Process exits.

Ensure `terminationGracePeriodSeconds` in Kubernetes matches `SHUTDOWN_TIMEOUT_MS` (default 30 s).

## Observability

| Signal | Endpoint / Tool | Details |
|--------|----------------|---------|
| Health | `GET /api/health` | Detailed status with uptime, environment |
| Readiness | `GET /api/health/ready` | Checks service ready state, returns 503 during shutdown |
| Liveness | `GET /api/health/live` | Process alive check |
| Startup | `GET /api/health/startup` | Startup completion check |
| Metrics | `GET /metrics` | Prometheus scrape target (excluded from `/api` prefix) |
| Errors | Sentry | Automatic capture, profiling, release tracking |
| Sessions | Highlight | Request replay, performance insights |
| Traces | OpenTelemetry | Distributed tracing via OTLP exporter |
| Logs | Structured JSON | Correlation IDs, tenant context, file rotation |

### Key Prometheus Metrics

- `http_request_duration_seconds` — request latency histogram
- `http_requests_total` — request counter by method, path, status
- `http_request_size_bytes` — request payload size
- Active WebSocket connections per namespace
- Database query duration

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| `EADDRINUSE :8868` | Port conflict | `lsof -i :8868` and kill the process |
| `P1001: Can't reach database` | PostgreSQL down or wrong `DB_CONNECTION_STRING` | Verify `pg_isready` and env var |
| `ECONNREFUSED` to Redis | Redis not running | Check `redis-cli ping` |
| `Module not found` after pull | Dependencies changed | Run `pnpm install` and `npx prisma generate` |
| 401 on all requests | Missing or expired auth token / API key | Verify `x-api-key` or `Authorization` header |
| 503 during deployment | Maintenance mode or not-yet-ready pod | Wait for readiness probe or check `MaintenanceInterceptor` |
| WebSocket disconnects | Nginx proxy_read_timeout too low | Set `proxy_read_timeout 86400` on WS locations |

## Related Documentation

- [API Reference](./api-reference.md) — full endpoint catalog
- [Configuration](./configuration.md) — environment variable table
- [Technical Architecture](../architecture/README.md) — platform-wide architecture
- [SMR Service](../smr-v2/README.md) — summarization microservice
