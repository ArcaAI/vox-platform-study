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
│  ┌─────────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌──────────────┐  │
│  │ Session  │ │ STT │ │ TTS │ │ SMR │ │  NLP + more  │  │
│  └─────────┘ └─────┘ └─────┘ └─────┘ └──────────────┘  │
└──────────────────────┬───────────────────────────────────┘
          ┌────────────┼────────────┬────────────┐
          ▼            ▼            ▼            ▼
   STT Service   TTS Service  SMR Service  NLP Service
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
| `ObservabilityModule` | `@arcaai/applications` | Highlight, OpenTelemetry |
| `AuditLogServiceModule` | `@arcaai/applications` | Event-driven audit logging |
| `AuthorizationModule` | `@arcaai/applications` | CASL-based policy authorization |
| `SysEventServiceModule` | `@arcaai/applications` | System event bus |
| `CommonServiceModule` | `@arcaai/applications` | Shared utilities |
| `ClsModule` | `nestjs-cls` | Continuation-local storage for request context |
| `ScheduleModule` | `@nestjs/schedule` | Cron jobs and intervals |
| `EventEmitterModule` | `@nestjs/event-emitter` | In-process event emitter |
| `GracefulShutdownModule` | Local | Coordinated shutdown with drain delay |

**Feature Modules:**

| Module | Path | Purpose |
|--------|------|---------|
| `AuthModule` | `modules/auth/` | JWT login/logout, session management |
| `AuditLogModule` | `modules/audit-log/` | Audit log query endpoints |
| `ConsultationModule` | `modules/consultation/` | Consultation lifecycle, context items, summaries, jobs, timeline |
| `DepartmentModule` | `modules/department/` | Department CRUD with hierarchy |
| `DnaWritingStyleModule` | `modules/dna-writing-style/` | AI writing-style profile generation and management |
| `FedlModule` | `modules/fedl/` | Federated learning proxy |
| `FeedbackModule` | `modules/feedback/` | User feedback proxy |
| `GlobalSettingsModule` | `modules/global-settings/` | Platform-wide settings |
| `HealthModule` | `modules/health/` | Health, readiness, liveness, startup probes |
| `MonitoringModule` | `modules/monitoring/` | Downstream service health dashboards |
| `NlpModule` | `modules/nlp/` | NLP proxy + WebSocket gateway |
| `PromptManagementModule` | `modules/prompt-management/` | Prompt template CRUD with versioning |
| `RbacModule` | `modules/rbac/` | Roles, policies, permission checks |
| `SmrModule` | `modules/smr/` | Summarization proxy |
| `SttV2Module` | `modules/stt-v2/` | STT v2 pipelines, AI models, transcription jobs, streaming |
| `TenantModule` | `modules/tenant/` | Tenant management |
| `TtsModule` | `modules/tts/` | TTS proxy + WebSocket gateway |
| `UserPreferencesModule` | `modules/user-preferences/` | SDK-synced user preferences |
| `UsersModule` | `modules/user/` | User CRUD |
| `UserSettingsModule` | `modules/user-settings/` | Per-user settings |
| `PrismaStudioModule` | `modules/pstudio/` | Embedded Prisma Studio database browser (dev/staging only) |

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
| Microservices | `STT_V2_URL`, `SMR_URL`, `TTS_URL`, `NLP_URL`, `FEDL_URL` |
| Auth | `SESSION_SECRET_KEY` |
| Observability | `SENTRY_DSN_API`, `HIGHLIGHT_PROJECT_ID`, `OTEL_*` |
| Logging | `LOG_LEVEL`, `LOG_FILE_ENABLED`, `LOG_FILE_PATH` |

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
