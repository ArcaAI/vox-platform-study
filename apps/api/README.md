# HOPE API Gateway

> Enterprise-grade NestJS API Gateway for the HOPE medical conversation processing platform

[![NestJS](https://img.shields.io/badge/NestJS-11.x-E0234E?logo=nestjs)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Proprietary-blue)]()

## Overview

The HOPE API Gateway serves as the central entry point for all client requests in the HOPE (Healthcare Optimized Processing Engine) platform. Built with NestJS, it provides enterprise-grade features including:

- **Multi-Authentication System**: JWT, OIDC, and API Key authentication strategies
- **Multi-Tenant Architecture**: Organization-level data isolation with tenant-specific configurations
- **Microservice Orchestration**: Proxies the Text service (formerly SMR) and audio transcription to STT (via the `streaming` module) and health-monitors the downstream Python services (STT, Text, NLP, Guardrail, Harness)
- **Real-Time Communication**: WebSocket support for streaming audio transcription
- **Enterprise Security**: HIPAA-compliant audit trails, rate limiting, and CORS management
- **Progressive Enhancement**: Cloud-first API with support for enhanced client-side capabilities

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [API Documentation](#api-documentation)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security](#security)
- [Monitoring](#monitoring)
- [Contributing](#contributing)

## Features

### Core Capabilities

- **Multi-Authentication**
  - JWT-based authentication for web/mobile clients
  - OIDC integration for enterprise SSO
  - API Key authentication for service-to-service communication
  - Role-based and group-based authorization

- **Medical Session Management**
  - Healthcare conversation lifecycle management
  - Real-time session state synchronization
  - Multi-device session coordination
  - Automatic session recovery and validation

- **AI Service Integration**
  - **STT (Speech-to-Text)**: Real-time audio transcription via the `streaming` module (`/api/v1/audio/...`)
  - **Text (formerly SMR)**: Medical conversation summarization proxied by `TextProxyController` in the `streaming` module (`/api/v1/text-generations/...`)
  - **NLP**: Entity extraction / medical terminology — downstream Python service (port 8864), health-monitored; no gateway proxy route
  - **Guardrail**: Safety/guardrail engine (port 8863) — health-monitored downstream
  - **Harness**: Clinical Documentation Harness (port 8866) — health-monitored downstream; admin/observability via `harness-admin` (`/api/v1/admin/harness/...`)

- **Enterprise Features**
  - Multi-tenant data isolation
  - Comprehensive audit logging
  - Request rate limiting
  - Health monitoring endpoints
  - Prometheus metrics export
  - Distributed tracing (Sentry, Highlight)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Client Layer                          │
│  (Web App, Mobile App, Third-party Integrations)           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (NestJS)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Auth Guards  │  │ Controllers  │  │ Interceptors │     │
│  │ - JWT        │  │ - Session    │  │ - Exception  │     │
│  │ - OIDC       │  │ - Audio Proxy│  │ - Context    │     │
│  │ - API Key    │  │ - Text Proxy │  │ - Maintenance│     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
┌──────────────┐ ┌────────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
│ STT :8861 │ │Guardrail :8863 │ │Text :8862 │ │NLP :8864 │ │Harness :8866 │
│ (Python)     │ │ (Python)       │ │ (Python) │ │ (Python) │ │ (Python)     │
└──────────────┘ └────────────────┘ └──────────┘ └──────────┘ └──────────────┘
        │             │             │             │             │
        └─────────────┴─────────────┴─────────────┴─────────────┘
                      │
                      ▼
        ┌─────────────────────────────────────┐
        │        Data Layer                   │
        │  ┌──────────┐  ┌───────┐  ┌──────┐│
        │  │PostgreSQL│  │ Redis │  │ MinIO││
        │  └──────────┘  └───────┘  └──────┘│
        └─────────────────────────────────────┘
```

### Key Components

- **Controllers**: HTTP request handlers organized by domain (session, audio, text, nlp, admin)
- **Services**: Business logic implementation and external service integration
- **Guards**: Authentication and authorization enforcement
- **Decorators**: Custom metadata and parameter decorators for enhanced functionality
- **Interceptors**: Cross-cutting concerns (logging, exception handling, context management)
- **Filters**: Exception handling and error response formatting

## Technology Stack

| Category          | Technology      | Version | Purpose                      |
| ----------------- | --------------- | ------- | ---------------------------- |
| **Framework**     | NestJS          | 11.x    | Enterprise Node.js framework |
| **Language**      | TypeScript      | 5.4     | Type-safe development        |
| **Runtime**       | Node.js         | 18+     | JavaScript runtime           |
| **ORM**           | Prisma          | 6.8.2   | Database access layer        |
| **Queue**         | BullMQ          | 5.42.0  | Background job processing    |
| **WebSocket**     | Socket.io       | 4.8.1   | Real-time communication      |
| **Validation**    | class-validator | 0.14.1  | Request validation           |
| **Documentation** | Swagger         | 7.3.0   | OpenAPI documentation        |
| **Monitoring**    | Prometheus      | Latest  | Metrics collection           |
| **Tracing**       | Sentry          | 9.14.0  | Error tracking               |

## Getting Started

### Prerequisites

- Node.js 18+ (recommended: 20.x)
- pnpm 10.6.5
- PostgreSQL 14+
- Redis 7+
- Docker & Docker Compose (for local development)

### Installation

1. **Clone the repository**

```bash
cd /path/to/HOPE/monorepo
```

2. **Install dependencies**

```bash
# Install all dependencies using pnpm workspace
pnpm install
```

3. **Set up environment variables**

```bash
cd apps/api
cp env.example .env
# Edit .env with your configuration
```

4. **Set up the database**

```bash
# Run Prisma migrations
cd ../../packages/database
npx prisma migrate dev
npx prisma generate

# Seed the database (optional)
pnpm seed
```

5. **Start the development server**

```bash
cd ../../apps/api
pnpm dev
```

The API Gateway will be available at `http://localhost:8868`

### Quick Start with Docker

```bash
# Start all services
cd infrastructure/docker
make dev-up

# View logs
docker-compose -f docker-compose.dev.yml logs -f api

# Stop services
make dev-down
```

## Configuration

### Environment Variables

Create a `.env` file in `apps/api/` based on `env.example`:

```bash
# Application
NODE_ENV=development
PORT=8868
URL=http://localhost:8868

# Database
DB_CONNECTION_STRING=postgresql://user:pass@localhost:5432/hope
DB_CONNECTION_STRING_DIRECT=postgresql://user:pass@localhost:5432/hope

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=redis-password

# Python Microservices
STT_PORT=8861
STT_URL=http://localhost:8861
TEXT_PORT=8862
TEXT_URL=http://localhost:8862
GUARDRAIL_URL=http://localhost:8863
NLP_PORT=8864
NLP_URL=http://localhost:8864
HARNESS_URL=http://localhost:8866

# Authentication
SESSION_SECRET_KEY=your-session-secret-key

# Logging
LOG_LEVEL=debug
LOG_FILE_ENABLED=true
LOG_FILE_PATH=./logs

# Monitoring (Optional)
SENTRY_DSN_API=https://your-sentry-dsn
HIGHLIGHT_PROJECT_ID=your-highlight-project-id

# OpenTelemetry
OTEL_SERVICE_NAME=hope-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_TRACES_ENABLED=true
```

### Phase 0 Item 5 — Boot-time duplicate-key invariant

`AppSettingsService.cacheAppSettings()` refuses to start the process if
more than one row exists in `GlobalSetting` for the same platform key
(rows where `tenantId === GLOBAL_TENANT_ID`). The protection closes
the TASK-301 §P0-1 cross-tenant cache collision: when two rows share a
key, the `Map<key, entity>` cache silently picks the last writer and
downstream consumers see non-deterministic config.

| Env var                       | Default | When honoured                                                                                   |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `APP_SETTINGS_BOOT_INVARIANT` | unset   | Only when `NODE_ENV=development`. In `staging`/`production` the invariant runs unconditionally. |

To bypass during a local rebase (dev only):

```bash
APP_SETTINGS_BOOT_INVARIANT=skip pnpm api:dev
```

Setting `APP_SETTINGS_BOOT_INVARIANT=skip` outside `development` has no
effect — the invariant still runs and the process still refuses to
start. See `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts`
and TASK-302 `docs/archive/TASK-302-System-Config-Implementation-Roadmap/01-phase-0-hotfix.md` §Section E.

### Operating with PgBouncer (TASK-302 Stream C Phase 2A)

The HOPE production HA stack runs **PgBouncer in transaction pooling
mode** ([HA blueprint §10](../../research/deployments/deploy-vm500-502-postgres-ha.md#10-deploy-pgbouncer-transaction-mode)),
validated by [`docs/archive/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-validation-report.md`](../../docs/archive/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-validation-report.md).
The Prisma adapter (`@prisma/adapter-pg`) owns pool sizing in Prisma 7
— the v6 `connection_limit` URL parameter is ignored. Three env vars
wire `packages/database/src/client.ts` and `packages/database/prisma.config.ts`:

| Env var         | Default | Consumed by                                                    | Notes                                                                                                                                                  |
| --------------- | ------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`  | —       | `client.ts` → `new PrismaPg({ connectionString })`             | Runtime queries. In prod points at pgbouncer (`:6432`, txn mode).                                                                                      |
| `DIRECT_URL`    | unset   | `prisma.config.ts` → `resolveMigrationUrl()` (migrations only) | Required in prod/staging. Un-pooled endpoint (`:5432` direct, or `:5000` HAProxy R/W). Bypasses the pooler so Prisma Migrate's advisory locks survive. |
| `PRISMA_PG_MAX` | `5`     | `client.ts` → `new PrismaPg({ max })`                          | Per-pod pool size. See budget rule below.                                                                                                              |

**Budget rule** (do not exceed):

```
pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections
```

With `max_connections = 200` and `PRISMA_PG_MAX = 5`, HOPE supports up to
**28 simultaneous pods** before approaching the safe ceiling. Raise
`max_connections` (not `PRISMA_PG_MAX`) when scaling further. Because
pgbouncer multiplexes ~50 backends per pool with `default_pool_size=50`,
the effective pod ceiling is governed by PG backends, not pgbouncer
clients.

**When to set `DIRECT_URL`**:

- **Local dev (no pooler in path)**: optional. Leaving it unset makes
  `resolveMigrationUrl()` fall back to `DATABASE_URL`, which is fine when
  `DATABASE_URL` is already an un-pooled `:5432` connection.
- **Production / staging (post-Phase 2A)**: **required**. `DATABASE_URL`
  points at pgbouncer (`:6432`); `DIRECT_URL` MUST point at the HAProxy
  R/W VIP (`:5000`) or directly at the primary. Without this split,
  `prisma migrate deploy` runs against the pooler, the per-session
  advisory lock used to serialize migrations hops between PG backends,
  and schema history can be corrupted by concurrent deploys.

`prisma.config.ts` emits a `console.warn` when `DIRECT_URL` does not
appear to target a direct port — see
`packages/database/src/migration-url.ts`.

**Prepared statements**: pgbouncer is configured with
`MAX_PREPARED_STATEMENTS=200`, so Prisma's named prepared statements
work natively in transaction mode. Do NOT set `?pgbouncer=true` on
`DATABASE_URL` — that flag forces unnamed statements and is only needed
when `MAX_PREPARED_STATEMENTS=0`.

See the canonical plan at
[`docs/archive/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md`](../../docs/archive/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md).

### Configuration Files

- **nest-cli.json**: NestJS CLI configuration
- **tsconfig.json**: TypeScript compiler options
- **.eslintrc.js**: ESLint rules
- **nodemon.json**: Development hot-reload configuration

## API Documentation

### Interactive Documentation

When running in development mode, access Swagger UI at:

- **Swagger UI**: http://localhost:8868/api/v1/docs

### Route Convention

All public API endpoints follow the pattern `/api/v1/<domain>`:

| Prefix                | Purpose                     | Example                            |
| --------------------- | --------------------------- | ---------------------------------- |
| `/api/v1/audio/...`   | STT (Speech-to-Text)        | `/api/v1/audio/transcription-jobs` |
| `/api/v1/text-generations/...`    | SMR (Summarization)         | `/api/v1/text-generations/generate`            |
| `/api/v1/admin/...`   | Tenant admin endpoints      | `/api/v1/admin/settings`           |
| `/api/v1/users/me/...` | Current user endpoints      | `/api/v1/users/me/settings`         |
| `/internal/...`       | Internal service-to-service | `/internal/stt`                    |

### API Endpoints

#### Health & Monitoring

```
GET  /api/v1/health              # Health check endpoint
GET  /api/v1/health/ready        # Readiness probe
GET  /api/v1/health/live         # Liveness probe
GET  /metrics                    # Prometheus metrics
```

#### Session Management

```
POST   /api/v1/sessions                    # Create a new session
GET    /api/v1/sessions                    # List all sessions (paginated)
GET    /api/v1/sessions/:id                # Get session by ID
PUT    /api/v1/sessions/:id                # Update session
DELETE /api/v1/sessions/:id                # Delete session
POST   /api/v1/sessions/:id/validate       # Validate session state
POST   /api/v1/sessions/:id/sync           # Sync session data
GET    /api/v1/sessions/patient/:patientId # Get sessions by patient
GET    /api/v1/sessions/tenants/:tenantId  # Get sessions by tenant
```

#### STT Service (Audio)

```
GET    /api/v1/audio/transcription-jobs           # List transcription jobs
POST   /api/v1/audio/transcription-jobs           # Create transcription job
GET    /api/v1/audio/transcription-jobs/:id       # Get job by ID
GET    /api/v1/audio/pipelines                    # List pipelines
GET    /api/v1/audio/ai-models                    # List AI models
WS     /stt                                    # WebSocket for real-time STT
```

#### Text Service (formerly SMR)

```
ALL  /api/v1/text-generations/**                      # TextProxyController (modules/streaming) → Text service (:8862)
```

> **NLP** is a downstream Python service (`:8864`) that the gateway health-monitors via `/api/v1/health/services`; it has **no** gateway proxy route or WebSocket.

#### Workflow Exposure Plane (TASK-722)

A tenant's **published** workflow versions become products, invokable over REST with a scoped API key or a JWT session. ONE generic route family — never a route generated per workflow. **Gated OFF by default** behind `WORKFLOW_EXPOSURE_ENABLED` (a 404, not a 403, while off — the surface's existence is not disclosed).

```
GET  /api/v1/workflows                              # The tenant's published + active workflows (slug + identity)
POST /api/v1/workflows/:slug/invoke                  # Start a run of the tenant's active published version
GET  /api/v1/workflows/:slug/runs/:runId             # Live run status + result
GET  /api/v1/workflows/:slug/runs/:runId/stream      # SSE progress + result (see note below)
POST /api/v1/workflows/:slug/runs/:runId/cancel      # Cancel a run (allow-listed action, never a signal-name pass-through)
```

- **Auth + scopes.** Every route carries both an authorization decorator (JWT/CASL path) and `@RequiredScopes(...)` from the `workflow:*` family (API-key path): `workflow:definition:read`, `workflow:run:read`, `workflow:run:write` (or the wildcard `workflow:*`). A tenant admin holding `manage:WorkflowRun`/`manage:WorkflowDefinition` can also reach it via a JWT session.
- **Tenant resolution.** `tenantId` is read exclusively from the authenticated principal — it is never a body/query/header field a caller controls. A foreign-tenant, unpublished, or unknown `slug`/`runId` is **404**, never 403 (404-over-403).
- **Idempotency.** `Idempotency-Key` header — a repeated invoke with the same key returns the prior response and starts no second run (24h Redis-backed replay cache).
- **`invoke` returns `202 Accepted`**: `{ runId, status, statusUrl, streamUrl }`.
- **Streaming (`.../stream`).** Open with `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` minted from `POST /api/v1/auth/stream-ticket` with scope `workflow_run:<runId>` (mint-time tenant-ownership check; never a JWT in the URL). The stream is a documented **polling bridge**, not a byte-for-byte proxy — no live event-stream producer exists on the interpreter yet, so the gateway re-polls the run's JSON status and translates each snapshot into a `@arcaai/async-contract` envelope (`workflow.run.progress` / `workflow.run.completed`). There is no `Last-Event-ID` resume: a reconnect re-syncs from the current live status rather than filling a gap (no synthetic resume token is minted for the underlying non-resumable Temporal-polling transport).
- **Cloud-provider egress.** A publicly-invoked workflow MAY select a cloud LLM provider (azure/bedrock/openai/anthropic/vertex) — TASK-720 R-4 owner ruling (2026-08-20): the tenant carries the risk, consistent with the platform's BYO-first posture. There is no exposure-plane restriction (the former `WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS` gate, decision #6/R-8, was removed rather than defaulted on). Choosing a cloud provider for a `smr.*`/task-default key sends that tenant's data to that vendor — this is disclosed on the provider-selection screen (AI Task Defaults) and on the workflow-definition `publish` endpoint, not only in ticket history.
- **Rate limiting.** `invoke` is the first `heavy`-tier (`@Throttle`) consumer in the gateway (20 req/60s platform-wide backstop); the per-key `ApiKey.rateLimit` is the control that actually reaches API-key traffic (plan-tier rate limits do not).

#### Admin Endpoints (Tenant Administrators)

```
GET/POST/PATCH/DELETE /api/v1/admin/settings/...         # Global settings
GET/POST/PATCH/DELETE /api/v1/admin/tenants/...          # Tenant management
GET/POST/DELETE       /api/v1/admin/api-keys/...         # API key management
GET                   /api/v1/admin/audit-logs/...       # Audit logs
GET/POST/PATCH/DELETE /api/v1/admin/rbac/roles/...       # RBAC roles
GET/POST/PATCH/DELETE /api/v1/admin/rbac/policies/...    # RBAC policies
ALL                   /api/v1/admin/pstudio/...          # Prisma Studio
ALL                   /api/v1/admin/dna-writing-styles/... # DNA writing styles (admin)
```

#### User Self-Service Endpoints

```
GET/PATCH /api/v1/users/me/...              # User preferences
GET/PATCH /api/v1/users/me/settings/...     # User settings
```

### Authentication

The API supports three authentication methods:

#### 1. JWT Bearer Token

```bash
curl -H "Authorization: Bearer <jwt_token>" \
  http://localhost:8868/api/v1/sessions
```

#### 2. API Key

```bash
curl -H "X-API-Key: <api_key>" \
  http://localhost:8868/api/v1/sessions
```

#### 3. OIDC (OpenID Connect)

```bash
# Redirects to OIDC provider
GET /auth/oidc/login
# Callback endpoint
GET /auth/oidc/callback
```

## Development

### Project Structure

```
apps/api/
├── src/
│   ├── main.ts                    # Application entry point
│   ├── app.module.ts              # Root module
│   │
│   ├── modules/                   # Feature modules (authoritative list: `featureModules` in app.module.ts)
│   │   ├── audit-log/            # Audit log management     → /api/v1/admin/audit-logs
│   │   ├── auth/                 # Authentication (JWT, OIDC)
│   │   ├── consultation/         # Consultation lifecycle & context
│   │   ├── department/           # Department management
│   │   ├── global-settings/      # Global settings           → /api/v1/admin/settings
│   │   ├── harness-admin/        # Harness ops/observability → /api/v1/admin/harness/...
│   │   ├── health/               # Health check endpoints
│   │   ├── monitoring/           # Service health monitoring
│   │   ├── pstudio/             # Prisma Studio             → /api/v1/admin/pstudio
│   │   ├── rbac/                 # Role-based access control → /api/v1/admin/rbac/...
│   │   ├── streaming/            # STT audio (/api/v1/audio) + SMR proxy (/api/v1/text) + STT WebSocket
│   │   ├── tenant/               # Tenant management         → /api/v1/admin/tenants
│   │   ├── user/                 # User management
│   │   ├── user-preferences/     # User preferences          → /api/v1/users/me
│   │   └── user-settings/        # User settings             → /api/v1/users/me/settings
│   │
│   ├── shared/                    # Shared base classes
│   │   └── base-proxy.controller.ts  # Abstract proxy controller
│   │
│   ├── services/                 # API-level shared services
│   │   └── api-key-validation.service.ts
│   │
│   ├── guards/                   # Authentication guards
│   │   ├── apikey.guard.ts      # API key validation
│   │   ├── jwtauth.guard.ts     # JWT token validation
│   │   ├── oidcauth.guard.ts    # OIDC authentication
│   │   ├── roles.guard.ts       # Role-based access
│   │   └── groups.guard.ts      # Group-based access
│   │
│   ├── decorators/               # Custom decorators
│   │   ├── api-key-protected.decorator.ts
│   │   ├── public.decorator.ts
│   │   ├── useRoles.decorator.ts
│   │   ├── useGroups.decorator.ts
│   │   └── authUser.decorator.ts
│   │
│   ├── interceptors/             # Request/response interceptors
│   │   ├── context.interceptor.ts      # Request context
│   │   ├── exception.interceptor.ts    # Error handling
│   │   └── maintenance.interceptor.ts  # Maintenance mode
│   │
│   ├── filters/                  # Exception filters
│   │   └── prisma.filter.ts     # Prisma error handling
│   │
│   └── middlewares/              # Middleware functions
│
├── test/                         # E2E tests
├── docs/                         # API documentation
├── Dockerfile                    # Container definition
├── package.json                  # Dependencies
└── README.md                     # This file
```

### Development Commands

```bash
# Development server with hot-reload
pnpm dev

# Development with debugging
pnpm dev:debug

# Build for production
pnpm build

# Start production server
pnpm start

# Clean build artifacts
pnpm clean

# Remove all dependencies and build artifacts
pnpm clean:all

# Linting
pnpm lint
pnpm lint:fix

# Code formatting
pnpm format
```

### Adding a New Feature

1. **Create the module structure**

```typescript
// src/modules/example/example.module.ts
import { Module } from '@nestjs/common';
import { ExampleController } from './example.controller';

@Module({
  controllers: [ExampleController],
})
export class ExampleModule {}
```

2. **Create the controller**

```typescript
// src/modules/example/example.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../../guards';

@UseGuards(ApiKeyGuard)
@Controller('example')
export class ExampleController {
  @Get()
  async findAll() {
    return { message: 'Hello, World!' };
  }
}
```

3. **Register in app.module.ts**

```typescript
import { ExampleModule } from './modules/example/example.module';

@Module({
  imports: [..., ExampleModule],
})
export class AppModule {}
```

4. **Update documentation** in `apps/api/docs/`

## Testing

### Unit Tests

```bash
# Run all unit tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Generate coverage report
pnpm test:cov
```

### E2E Tests

```bash
# Run end-to-end tests
pnpm test:e2e
```

### Manual Testing

Use the Swagger UI at http://localhost:8868/api/v1/docs for interactive API testing.

## Deployment

### Docker Build

```bash
# Build the Docker image
docker build -t hope-api:latest -f apps/api/Dockerfile .

# Run the container
docker run -p 8868:8868 --env-file apps/api/.env hope-api:latest
```

### Production Deployment

The API Gateway is designed for containerized deployment:

1. **Single Server Deployment**
   - See: `infrastructure/single-deployment/README.md`
   - Uses systemd for service management
   - Includes NGINX reverse proxy

2. **Kubernetes Deployment**
   - See: `deployment/README.md`
   - Supports horizontal pod autoscaling
   - Includes health probes and service mesh

3. **Cloud Deployment**
   - Azure Container Apps
   - AWS ECS/Fargate
   - Google Cloud Run

### Environment-Specific Configuration

#### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong `SESSION_SECRET_KEY`
- [ ] Configure `SENTRY_DSN_API` for error tracking
- [ ] Set up `DATABASE_URL` with SSL
- [ ] Configure Redis cluster
- [ ] Set up CORS allowed origins
- [ ] Enable rate limiting
- [ ] Configure load balancer health checks
- [ ] Set up monitoring and alerting

## Security

### Authentication Strategies

The API Gateway implements multiple authentication strategies:

1. **JWT Authentication** (JwtAuthGuard)
   - Token-based authentication for web/mobile clients
   - Configurable token expiration
   - Refresh token support

2. **OIDC Authentication** (OidcAuthGuard)
   - Enterprise SSO integration
   - Support for major identity providers (Azure AD, Okta, Auth0)

3. **API Key Authentication** (ApiKeyGuard)
   - Service-to-service authentication
   - Scoped permissions per API key
   - Rate limiting per key

### Authorization

- **Role-Based Access Control (RBAC)**: `@UseRoles('admin', 'user')`
- **Group-Based Access**: `@UseGroups('doctors', 'nurses')`
- **Tenant Isolation**: Automatic filtering by tenant context

### Security Headers

The API Gateway automatically applies security headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`

### Rate Limiting

Configurable rate limiting per:

- IP address
- User account
- API key
- Tenant

## Monitoring

### Health Checks

```bash
# Basic health check
curl http://localhost:8868/api/v1/health

# Detailed health check (includes dependencies)
curl http://localhost:8868/api/v1/health/ready
```

### Metrics

Prometheus metrics are exposed at `/metrics`:

- HTTP request duration
- Request count by endpoint
- Error rate
- Active connections
- Database query performance
- Redis cache hit ratio

### Logging

Structured JSON logging with correlation IDs:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "info",
  "context": "SessionController",
  "message": "Session created successfully",
  "requestId": "req_abc123",
  "userId": "user_456",
  "tenantId": "tenant_789"
}
```

### Error Tracking

- **Sentry**: Automatic error capture and tracking
- **Highlight**: Session replay and performance monitoring

## Contributing

### Development Workflow

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes following the coding standards
3. Write/update tests
4. Update documentation
5. Run linting: `pnpm lint`
6. Run tests: `pnpm test`
7. Commit with conventional commits: `git commit -m "feat: add new feature"`
8. Push and create a pull request

### Coding Standards

- Follow NestJS best practices
- Use TypeScript strict mode
- Write unit tests for services
- Write E2E tests for controllers
- Document all public APIs with JSDoc
- Use dependency injection
- Follow SOLID principles

### Documentation

- Update API documentation in `apps/api/docs/`
- Update Swagger decorators for new endpoints
- Add examples for complex features
- Keep README.md up to date

## Additional Resources

### Documentation

- [Development Guide](./docs/02-development-guide.md)
- [Usage Guide](./docs/03-usage-guide.md)
- [Deployment Guide](./docs/04-deployment-guide.md)
- [Implementation Status](./docs/01-implementation-status.md)
- [API Architecture](../../docs/backend-architecture.md)
- [Technical Overview](../../docs/technical-architecture-overview.md)

### Related Packages

- [@arcaai/applications](../../packages/applications/README.md) - Business logic layer
- [@arcaai/domains](../../packages/domains/README.md) - Domain entities
- [@arcaai/database](../../packages/database/README.md) - Database layer
- [@arcaai/logger](../../packages/logger/README.md) - Logging utilities

### External Links

- [NestJS Documentation](https://docs.nestjs.com/)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

## License

Copyright © 2024-2026 ARCAAI. All rights reserved.
