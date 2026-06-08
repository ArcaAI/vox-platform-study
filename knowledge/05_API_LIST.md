# HOPE API Reference

## Overview

The HOPE platform exposes APIs through a central NestJS API Gateway and multiple Python FastAPI microservices. This document provides a comprehensive inventory of all API endpoints, cross-cutting concerns (rate limiting, OpenAPI docs, versioning), and service-to-service communication patterns.

**Total Applications**: 6 backend services (1 NestJS gateway + 5 Python microservices: STT, SMR, Guardrail, NLP, Harness)  
**Total API Endpoints**: ~289  
**API Versioning**: URI-based (`/api/v1/`) via NestJS `enableVersioning()`  
**Swagger UI**: Available at `/docs` (non-production only)

## Architecture

```
                        ┌──────────────┐
                        │   Clients    │
                        │ (Admin, SDK) │
                        └──────┬───────┘
                               │ HTTPS
                               ▼
                  ┌────────────────────────────┐
                  │   API Gateway (NestJS)      │
                  │   Port 8868                 │
                  │                             │
                  │  ┌─────────────────────┐    │
                  │  │ Rate Limiting       │    │
                  │  │ (@nestjs/throttler) │    │
                  │  └─────────────────────┘    │
                  │  ┌─────────────────────┐    │
                  │  │ Auth (JWT/OIDC/     │    │
                  │  │       API Key)      │    │
                  │  └─────────────────────┘    │
                  │  ┌─────────────────────┐    │
                  │  │ URI Versioning      │    │
                  │  │ /api/v1/*           │    │
                  │  └─────────────────────┘    │
                  └──┬────┬────┬────┬────┬──────┘
                     │    │    │    │    │
       ┌────────┬─────────┴───┬──────────┬──────────┐
       ▼        ▼             ▼          ▼          ▼
  ┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────┐ ┌──────────┐
  │ STT-v2  │ │  SMR   │ │Guardrail │ │ NLP  │ │ Harness  │
  │ :8861   │ │ :8862  │ │  :8863   │ │:8864 │ │  :8866   │
  │ Python  │ │ Python │ │  Python  │ │Python│ │  Python  │
  └────┬────┘ └────────┘ └──────────┘ └──────┘ └──────────┘
          │
          │ Redis Streams (audio/results)
          │ HTTP callbacks (/internal/stt/*)
          ▼
     ┌─────────┐
     │  Redis   │  (Streams, Pub/Sub, BullMQ, Throttler state)
     └─────────┘
```

### Frontend Apps
- `apps/ui-playground` (React 19 / Vite / TanStack Router) - SDK playground + admin console (port 5175)
- `apps/example` (React / Vite) - Minimal SDK integration example
- `packages/agentic-sdk-v2/` - Agentic SDK V2 (`@arcaai/vox`)

### Backend Services
- `apps/api` (NestJS) - Main API Gateway (port 8868)
- `apps/stt-v2` (FastAPI) - Speech-to-Text Service (port 8861)
- `apps/smr` (FastAPI) - Summarization / LLM Generation Service (port 8862)
- `apps/guardrail` (FastAPI) - Content Safety / Medical Validation Service (port 8863)
- `apps/nlp` (FastAPI) - Medical NLP Service (port 8864)
- `apps/harness` (FastAPI) - Clinical Documentation Harness (port 8866)

---

## Cross-Cutting Concerns

### API Versioning

All public endpoints are served under the `/api/v1/` prefix via NestJS URI versioning.

| Configuration | Value |
|---------------|-------|
| Versioning type | `VersioningType.URI` |
| Default version | `'1'` |
| Prefix | `api/v` |
| Config location | `apps/api/src/main.ts` |

**Special routes** that opt out of versioning (using `VERSION_NEUTRAL`):
- `/internal/*` - Service-to-service endpoints (no version prefix)
- `/health/*` - Kubernetes probes (must be accessible without version)

### Rate Limiting

Distributed rate limiting via `@nestjs/throttler` with named tiers.

| Tier | Limit | Window | Applies To |
|------|-------|--------|------------|
| `default` | 100 req | 60s | All public endpoints |
| `strict` | 10 req | 60s | Auth endpoints (brute-force protection) |
| `heavy` | 20 req | 60s | Summary generation, AI processing |
| `relaxed` | 300 req | 60s | Health probes, monitoring |

**Configuration**: `apps/api/src/modules/throttle/throttle.module.ts`  
**Service**: `RateLimitConfigService` (reads from `RATE_LIMIT_ENABLED`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`)  
**Guard**: `ThrottlerGuard` applied globally via `APP_GUARD`

**Override decorators**:
- `@Throttle({ strict: { limit: 10, ttl: 60000 } })` - Apply named tier
- `@SkipThrottle()` - Exempt from all rate limiting (used on internal endpoints)

**Capacity**: At default 100 req/min per user, the system supports 200+ concurrent users comfortably (20,000 req/min aggregate).

### OpenAPI Documentation (Swagger)

| Property | Value |
|----------|-------|
| Swagger UI | `/docs` (non-production only) |
| Title | HOPE API |
| Auth schemes | Bearer (JWT) + API Key (`x-api-key` header) |
| Servers | `http://localhost:{port}` (local), `https://staging.arcaai.com` (staging) |
| Config location | `apps/api/src/main.ts` |

All 30 controllers have OpenAPI decorators:
- 24 controllers use standard `@ApiOperation` / `@ApiResponse` decorators
- 6 controllers use the custom `@ApiEndpoint` decorator (which auto-generates `@ApiOperation` + `@ApiOkResponse`) supplemented with standard error response decorators

### Authentication

All routes are protected by a single `UnifiedAuthGuard` from `@arcaai/applications` that handles authentication and authorization in one pipeline (Public → API Key → JWT → CASL). Three authentication strategies are supported:

| Strategy | Guard Path | Header/Method | Use Case |
|----------|-----------|---------------|----------|
| JWT | `UnifiedAuthGuard` (JWT path) | `Authorization: Bearer <token>` | Client-facing endpoints |
| OIDC | `OidcAuthGuard` (separate) | OpenID Connect flow | Enterprise SSO |
| API Key | `UnifiedAuthGuard` (API Key path) | `x-api-key`, `api-key`, or `apikey` | Service-to-service |

### Service Communication

| Pattern | Used Between | Transport |
|---------|-------------|-----------|
| HTTP Proxy / Direct | Gateway -> SMR, NLP, Harness, STT-v2 sessions | HTTP |
| WebSocket Proxy | Gateway -> STT v2, NLP | WebSocket |
| Redis Streams | Gateway <-> STT-v2 (audio streaming) | Redis |
| Redis Pub/Sub | Job status updates (SSE) | Redis |
| BullMQ | DNA generation, consultation summaries | Redis-backed queue |
| HTTP Callbacks | STT-v2 -> Gateway `/internal/stt/*` | HTTP + API Key |

---

## 1. API Gateway (NestJS) - `apps/api`

**Technology**: NestJS, TypeScript  
**Role**: Central API Gateway that proxies to microservices and manages core business logic  
**Total Endpoints**: ~180+  
**Base URL**: `/api/v1/`

### 1.1 Authentication & Authorization

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Auth | POST | `/auth/login` | User login with JWT token |
| Auth | POST | `/auth/logout` | User logout |
| Auth | GET | `/auth/me` | Get current user info |
| RBAC | GET | `/rbac/roles` | List all roles |
| RBAC | GET | `/rbac/roles/:id` | Get role by ID |
| RBAC | POST | `/rbac/roles` | Create role |
| RBAC | PUT | `/rbac/roles/:id` | Update role |
| RBAC | DELETE | `/rbac/roles/:id` | Delete role |
| RBAC | POST | `/rbac/roles/:roleId/policies/:policyId` | Assign policy to role |
| RBAC | DELETE | `/rbac/roles/:roleId/policies/:policyId` | Remove policy from role |
| RBAC | GET | `/rbac/policies` | List all policies |
| RBAC | GET | `/rbac/policies/:id` | Get policy by ID |
| RBAC | POST | `/rbac/policies` | Create policy |
| RBAC | PUT | `/rbac/policies/:id` | Update policy |
| RBAC | DELETE | `/rbac/policies/:id` | Delete policy |
| RBAC | POST | `/rbac/policies/validate` | Validate policy rules |
| RBAC | POST | `/rbac/check` | Check single permission |
| RBAC | POST | `/rbac/check/bulk` | Check multiple permissions |
| RBAC | POST | `/rbac/check/my-permissions` | Get user's effective permissions |

### 1.2 User Management

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Users | POST | `/users` | Create user |
| Users | GET | `/users` | List users with pagination |
| Users | GET | `/users/:id` | Get user by ID |
| Users | GET | `/users/external/:externalId` | Get user by external ID |
| Users | PATCH | `/users/:id` | Update user |
| Users | DELETE | `/users/:id` | Soft delete user |
| User Prefs | GET | `/users/me/preferences` | Get user preferences |
| User Prefs | POST | `/users/me/preferences` | Update preferences |
| User Prefs | POST | `/users/me/preferences/reset` | Reset to defaults |
| User Settings | POST | `/user-settings` | Create user settings |
| User Settings | GET | `/user-settings` | List all settings |
| User Settings | GET | `/user-settings/:id` | Get settings by ID |
| User Settings | PATCH | `/user-settings/:id` | Update settings |
| User Settings | DELETE | `/user-settings/:id` | Delete settings |

### 1.3 Tenant & Department Management

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Tenants | POST | `/tenants` | Create tenant |
| Tenants | GET | `/tenants` | List tenants |
| Tenants | GET | `/tenants/:id` | Get tenant by ID |
| Tenants | GET | `/tenants/code-name/:code-name` | Get tenant by code |
| Tenants | PATCH | `/tenants/:id` | Update tenant |
| Tenants | DELETE | `/tenants/:id` | Delete tenant |
| Tenants | GET | `/tenants/configs/:identifier` | Get tenant configs |
| Tenants | PATCH | `/tenants/configs/:identifier` | Update tenant configs |
| Departments | GET | `/departments` | List departments |
| Departments | GET | `/departments/roots` | Get root departments |
| Departments | GET | `/departments/:id` | Get department by ID |
| Departments | GET | `/departments/code/:code` | Get by code (CARD, RAD) |
| Departments | GET | `/departments/:id/children` | Get child departments |
| Departments | POST | `/departments` | Create department |
| Departments | PATCH | `/departments/:id` | Update department |
| Departments | PATCH | `/departments/:id/prompt-config` | Update prompt config |
| Departments | DELETE | `/departments/:id` | Delete department |

### 1.4 Consultation Workflow

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Consultation | POST | `/consultations/open` | Open/create consultation |
| Consultation | POST | `/consultations/:parentId/revisit` | Create follow-up |
| Consultation | GET | `/consultations/:id` | Get consultation |
| Consultation | GET | `/consultations/patient/:patientId/history` | Patient history |
| Consultation | GET | `/consultations/patient/:patientId/date/:date` | By patient & date |
| Consultation | GET | `/consultations/:id/chain` | Get consultation chain |
| Consultation | POST | `/consultations/:id/context` | Add context item |
| Consultation | PATCH | `/consultations/:id/context/:contextId` | Update context |
| Consultation | GET | `/consultations/:id/context` | Get context items |
| Consultation | GET | `/consultations/:id/context/:contextId/versions` | Version history |
| Consultation | GET | `/consultations/:id/context/shared` | Shared context |
| Consultation | GET | `/consultations/:id/context/transcriptions` | Get transcriptions |
| Consultation | GET | `/consultations/:id/context/case-notes` | Get case notes |
| Consultation | GET | `/consultations/:id/timeline` | Get timeline |
| Consultation | GET | `/consultations/:id/named-entities` | Get entities |
| Summary | POST | `/consultations/:id/summary/pre-summary` | Generate pre-summary |
| Summary | POST | `/consultations/:id/summary` | Generate summary |
| Summary | GET | `/consultations/:id/summary` | Get all summaries |
| Summary | GET | `/consultations/:id/summary/latest` | Get latest summary |
| Summary | PATCH | `/consultations/:id/summary/:contextItemId` | Update summary |
| Summary | POST | `/consultations/:id/summary/:contextItemId/extract-entities` | Extract entities |
| Summary | POST | `/consultations/:id/summary/comprehensive` | Comprehensive summary |
| Summary | POST | `/consultations/:id/summary/comprehensive/async` | Async comprehensive |
| Summary | POST | `/consultations/:id/summary/pre-summary/async` | Async pre-summary |
| Summary | POST | `/consultations/:id/summary/async` | Async summary |
| Jobs | GET | `/consultations/jobs/:jobId` | Get job status |
| Jobs | DELETE | `/consultations/jobs/:jobId` | Cancel job |
| Jobs | SSE | `/consultations/jobs/:jobId/sse` | SSE job updates |

### 1.5 DNA Writing Style

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| DNA | POST | `/dna-writing-styles/generate` | Queue DNA generation |
| DNA | GET | `/dna-writing-styles/my-style` | Get my DNA style |
| DNA | PATCH | `/dna-writing-styles/:reportId` | Update DNA report |
| DNA | GET | `/dna-writing-styles/:reportId/versions` | Version history |
| DNA Admin | POST | `/admin/dna-writing-styles/generate/:doctorId` | Generate for doctor |
| DNA Admin | GET | `/admin/dna-writing-styles` | List all DNA reports |
| DNA Admin | PATCH | `/admin/dna-writing-styles/:reportId` | Admin update |
| DNA Admin | GET | `/admin/dna-writing-styles/jobs/:jobId` | Job status |

### 1.6 Prompt Management

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Prompts | POST | `/prompt-templates` | Create template |
| Prompts | GET | `/prompt-templates` | List templates |
| Prompts | GET | `/prompt-templates/:id` | Get by ID |
| Prompts | PATCH | `/prompt-templates/:id` | Update template |
| Prompts | DELETE | `/prompt-templates/:id` | Delete template |
| Prompts | GET | `/prompt-templates/:id/versions` | Version history |
| Prompts | GET | `/prompt-templates/:id/versions/:versionNumber` | Specific version |

### 1.7 STT-V2 (Transcription)

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| STT Jobs | POST | `/api/v1/transcription-jobs` | Create job |
| STT Jobs | POST | `/api/v1/transcription-jobs/batch` | Create batch job |
| STT Jobs | POST | `/api/v1/transcription-jobs/streaming` | Create streaming job |
| STT Jobs | POST | `/api/v1/transcription-jobs/stream/session` | Create WS session |
| STT Jobs | GET | `/api/v1/transcription-jobs` | List jobs |
| STT Jobs | GET | `/api/v1/transcription-jobs/stats` | Job statistics |
| STT Jobs | GET | `/api/v1/transcription-jobs/:id` | Get job by ID |
| STT Jobs | PATCH | `/api/v1/transcription-jobs/:id/cancel` | Cancel job |
| STT Jobs | PATCH | `/api/v1/transcription-jobs/:id/retry` | Retry job |
| STT Stream | POST | `/api/v1/transcription-jobs/transcribe` | Upload & stream |
| STT Stream | SSE | `/api/v1/transcription-jobs/:jobId/stream` | Reconnect SSE |
| STT Internal | POST | `/internal/stt/transcripts` | Create transcript |
| STT Internal | PATCH | `/internal/stt/jobs/:id/start` | Start job |
| STT Internal | PATCH | `/internal/stt/jobs/:id/progress` | Update progress |
| STT Internal | PATCH | `/internal/stt/jobs/:id/complete` | Complete job |
| STT Internal | PATCH | `/internal/stt/jobs/:id/fail` | Mark failed |
| Pipelines | POST | `/api/v1/pipelines` | Create pipeline |
| Pipelines | GET | `/api/v1/pipelines` | List pipelines |
| Pipelines | GET | `/api/v1/pipelines/:id` | Get by ID |
| Pipelines | GET | `/api/v1/pipelines/slug/:slug` | Get by slug |
| Pipelines | PATCH | `/api/v1/pipelines/:id` | Update pipeline |
| Pipelines | DELETE | `/api/v1/pipelines/:id` | Delete pipeline |
| Pipelines | POST | `/api/v1/pipelines/validate` | Validate YAML |
| AI Models | POST | `/api/v1/ai-models` | Create model |
| AI Models | GET | `/api/v1/ai-models` | List models |
| AI Models | GET | `/api/v1/ai-models/:id` | Get by ID |
| AI Models | GET | `/api/v1/ai-models/slug/:slug` | Get by slug |
| AI Models | GET | `/api/v1/ai-models/task/:taskType` | By task type |
| AI Models | PATCH | `/api/v1/ai-models/:id` | Update model |
| AI Models | DELETE | `/api/v1/ai-models/:id` | Delete model |

### 1.8 Service Proxies (SMR, NLP)

> **Removed:** The gateway no longer exposes TTS or FedL proxies — there is no `apps/tts` or `apps/fedl` service in this repo.

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| SMR | GET | `/text/api/v2/health` | SMR health check |
| SMR | POST | `/text/api/v2/generate` | Generate text |
| SMR | GET | `/text/api/v2/tasks/:taskId` | Task status |
| SMR | POST | `/text/api/v2/tasks/:taskId/cancel` | Cancel task |
| SMR | SSE | `/text/api/v2/tasks/:taskId/stream` | SSE stream |
| SMR | GET | `/text/api/v2/providers` | List providers |
| NLP | GET | `/nlp/health` | NLP health check |
| NLP | POST | `/nlp/classify/text` | Classify text |
| NLP | POST | `/nlp/classify/tokens` | Token classification |
| NLP | POST | `/nlp/correct` | Spelling correction |
| NLP | POST | `/nlp/suggest` | Medical suggestions |

### 1.9 Infrastructure

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Health | GET | `/health` | Detailed health check |
| Health | GET | `/health/live` | Liveness probe |
| Health | GET | `/health/ready` | Readiness probe |
| Health | GET | `/health/startup` | Startup probe |
| Monitoring | GET | `/monitoring/uptime` | All services uptime |
| Monitoring | GET | `/monitoring/uptime/:service` | Service uptime |
| Monitoring | GET | `/monitoring/heartbeats/:service` | Heartbeat history |
| Monitoring | GET | `/monitoring/sessions` | Active sessions |
| Feedback | POST | `/feedback/summary` | Summary feedback |
| Feedback | POST | `/feedback/events` | Interaction events |
| Feedback | POST | `/feedback/labels` | Feedback labels |
| Audit | GET | `/audit-logs` | List audit logs |
| Audit | GET | `/audit-logs/:id` | Get by ID |
| Audit | GET | `/audit-logs/resource/:type/:id` | By resource |
| Audit | GET | `/audit-logs/user/:userId` | By user |

### 1.10 Prisma Studio (Admin)

Embedded database browser for admin users. Conditionally enabled via `ENABLE_PRISMA_STUDIO` (on by default in non-production).

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| Prisma Studio | GET | `/admin/pstudio` | Serve Studio HTML page (public, requires `?token=` query param) |
| Prisma Studio | POST | `/admin/pstudio` | Execute Studio database query (BFF endpoint, JWT `manage:all`) |

**Access**: `http://localhost:8868/api/v1/admin/pstudio?token=<jwt-token>`

---

## 2. STT-V2 Service (FastAPI) - `apps/stt-v2`

**Technology**: FastAPI, Python  
**Role**: Speech-to-Text processing with streaming support  
**Total Endpoints**: 16

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health check (liveness) |
| GET | `/ready` | Readiness check |
| GET | `/live` | Liveness probe |
| GET | `/metrics` | Prometheus metrics |
| GET | `/internal/cache/stats` | Model cache statistics |
| POST | `/internal/cache/clear` | Clear model cache |
| GET | `/internal/cache/model/{slug}` | Cached model info |
| GET | `/internal/pipelines/loaded` | Loaded pipelines |
| GET | `/internal/sessions` | Active sessions |
| GET | `/internal/streaming/status` | Streaming status |
| POST | `/internal/sessions/cleanup` | Cleanup expired sessions |
| POST | `/api/v1/transcribe` | Transcribe audio file |
| POST | `/internal/streaming/sessions` | Create streaming session |
| GET | `/internal/streaming/sessions/{session_id}` | Session status |
| DELETE | `/internal/streaming/sessions/{session_id}` | Remove session |
| GET | `/internal/streaming/availability` | Check availability |

---

## 3. TTS Service (FastAPI) - `apps/tts`

> **Removed:** There is no `apps/tts` service in this repo, and the gateway no longer proxies it. Port 8863 is now used by the Guardrail service.

---

## 4. SMR Service (FastAPI) - `apps/smr`

**Technology**: FastAPI, Python, Multi-provider LLM  
**Role**: Summary generation via LLM (Azure OpenAI, Bedrock, Ollama)  
**Total Endpoints**: 6

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/health` | Health check with provider status |
| POST | `/api/v2/generate` | Text generation (sync/streaming) |
| GET | `/api/v2/tasks/{task_id}` | Task status |
| POST | `/api/v2/tasks/{task_id}/cancel` | Cancel task |
| GET | `/api/v2/tasks/{task_id}/stream` | SSE streaming |
| GET | `/api/v2/providers` | List LLM providers |

---

## 5. NLP Service (FastAPI) - `apps/nlp`

**Technology**: FastAPI, Python, ML Models  
**Role**: Medical text classification and entity extraction  
**Total Endpoints**: 8

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/api/v1/health` | Health check |
| POST | `/api/v1/classify/text` | Text classification |
| POST | `/api/v1/classify/tokens` | Token/entity extraction |
| POST | `/api/v1/correct/text` | Spelling correction |
| POST | `/api/v1/diagnosis/suggestions` | Diagnosis suggestions |
| WebSocket | `/ws/v1/classify/token/{session_id}` | Real-time token classification |
| WebSocket | `/ws/v1/classify/text/{session_id}` | Real-time text classification |

---

## 6. FedL Service (FastAPI) - `apps/fedl`

> **Removed:** There is no `apps/fedl` service in this repo.

---

## 7. MLflow Service (FastAPI) - `apps/mlflow`

> **Removed:** There is no `apps/mlflow` service in this repo. DNA writing-style functionality is now served via the API gateway's `DnaWritingStyleModule`. This section is retained for historical reference only.

**Technology**: FastAPI, Python, MLflow, Celery, Qdrant  
**Role**: ML experiment tracking, prompt management, DNA writing style  
**Total Endpoints**: 46

### 7.1 Prompts v1 (Celery-based)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/prompts` | List prompts |
| GET | `/api/prompts/{promptId}` | Get prompt |
| POST | `/api/prompts/{promptId}/versions` | Create version |
| DELETE | `/api/prompts/{promptId}/versions/{versionId}` | Delete version |
| DELETE | `/api/prompts/{promptId}` | Delete prompt |

### 7.2 Prompts v2 (REST)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/prompts` | List prompts |
| GET | `/api/v2/prompts/{name}` | Get by name |
| POST | `/api/v2/prompts` | Create prompt |
| PATCH | `/api/v2/prompts/{name}` | Update prompt |
| DELETE | `/api/v2/prompts/{name}` | Delete prompt |
| GET | `/api/v2/prompts/{name}/versions` | List versions |
| POST | `/api/v2/prompts/{name}/versions` | Create version |
| POST | `/api/v2/prompts/{name}/tags` | Set tag |
| DELETE | `/api/v2/prompts/{name}/tags/{key}` | Delete tag |

### 7.3 DNA Writing Style

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dna/style/{userId}` | Get DNA style |
| GET | `/api/dna/style-by-doctor/{doctorId}` | Get by doctor |
| GET | `/api/dna/style/{userId}/versions` | Style versions |
| GET | `/api/dna/prompts/{userId}` | User prompts |
| POST | `/api/dna/analyze-prompts` | Analyze via Langflow |
| POST | `/api/dna/redact` | Apply writing style |
| POST | `/api/dna/ingest` | Ingest DNA data |
| POST | `/api/dna/audit` | Validate note sections |
| POST | `/api/dna/seed` | Create demo DNA |

### 7.4 Models & Datasets

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/models/experiments` | Create experiment |
| POST | `/api/models/runs` | Create run |
| DELETE | `/api/models/versions/{name}/{version}` | Delete version |
| POST | `/api/datasets/experiments` | Create dataset experiment |
| POST | `/api/datasets/runs` | Create dataset run |

---

## 8. Feedback Service (FastAPI) - `apps/feedback`

> **Removed:** There is no `apps/feedback` service in this repo. This section is retained for historical reference only.

**Technology**: FastAPI, Python, InfluxDB  
**Role**: Collect user feedback and interaction metrics  
**Total Endpoints**: 5

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/health` | Health check |
| POST | `/api/feedback/summary` | Summary-level feedback |
| POST | `/api/feedback/events` | Interaction events batch |
| POST | `/api/feedback/labels` | Feedback labels batch |

---

## Summary Statistics

| Service | Technology | Endpoints | Role |
|---------|------------|-----------|------|
| API Gateway | NestJS | ~180 | Central gateway, business logic |
| STT-V2 | FastAPI | 16 | Speech-to-text |
| SMR | FastAPI | 6 | LLM text generation |
| NLP | FastAPI | 8 | Medical NLP |
| MLflow | FastAPI | 46 | ML tracking, DNA styles |
| Feedback | FastAPI | 5 | Metrics collection |
| **Total** | - | **~261** | - |

---

## API Categories

### Public APIs (Client-facing, `/api/v1/`)

All client-facing endpoints require JWT authentication unless otherwise noted.

| Category | Prefix | Rate Limit Tier |
|----------|--------|-----------------|
| Authentication | `/api/v1/auth/*` | `strict` (10 req/min) |
| User Management | `/api/v1/users/*` | `default` (100 req/min) |
| Tenants | `/api/v1/tenants/*` | `default` |
| Departments | `/api/v1/departments/*` | `default` |
| Consultations | `/api/v1/consultations/*` | `default` |
| Summary Generation | `/api/v1/consultations/:id/summary/*` | `heavy` (20 req/min) |
| DNA Writing Styles | `/api/v1/dna-writing-styles/*` | `default` |
| Prompt Templates | `/api/v1/prompt-templates/*` | `default` |
| Transcription Jobs | `/api/v1/transcription-jobs/*` | `default` |
| ASR Pipelines | `/api/v1/pipelines/*` | `default` |
| AI Models | `/api/v1/ai-models/*` | `default` |
| Service Proxies | `/api/v1/{stt,text,nlp}/*` | `default` |

### Internal APIs (Service-to-service, `/internal/`)

All internal endpoints are consolidated in `InternalModule` (`apps/api/src/modules/internal/`).

**Common patterns for all internal controllers:**

| Concern | Implementation |
|---------|---------------|
| Route prefix | `/internal/{service}/` |
| Authentication | `UnifiedAuthGuard` via `@Authorize()` (header: `x-api-key`, `api-key`, or `apikey`) |
| Rate limiting | Exempt (`@SkipThrottle()`) |
| Swagger | Hidden from public docs (`@ApiExcludeController()`) |
| Versioning | `VERSION_NEUTRAL` (no `/api/v1/` prefix) |

#### STT Internal (`/internal/stt/*`)

Called by the STT-v2 Python service via `APIGatewayClient` with `X-Internal-Service-Key` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/stt/transcripts` | Create transcript context item (called after transcription) |
| `PATCH` | `/internal/stt/jobs/:id/start` | Mark job as processing (called by STT-v2 worker) |
| `PATCH` | `/internal/stt/jobs/:id/progress` | Update job progress percentage |
| `PATCH` | `/internal/stt/jobs/:id/complete` | Mark job as completed with results |
| `PATCH` | `/internal/stt/jobs/:id/fail` | Mark job as failed with error details |
| `POST` | `/internal/stt/audio-records` | Create audio recording record (after storing blob to MinIO) |

#### Future Internal Endpoints (Planned)
- Streaming Sessions (`/internal/streaming/*`)
- Cache Management (`/internal/cache/*`)

### Admin APIs (`/api/v1/admin/`)
- DNA Admin (`/api/v1/admin/dna-writing-styles/*`) - Requires admin role
- Prisma Studio (`/api/v1/admin/pstudio`) - Embedded database browser, requires `manage:all` permission

### RBAC APIs (`/api/v1/rbac/`)
- Roles Management (`/api/v1/rbac/roles/*`)
- Policies Management (`/api/v1/rbac/policies/*`)
- Permission Checks (`/api/v1/rbac/check/*`)

### Infrastructure APIs (VERSION_NEUTRAL)

These endpoints are not versioned to remain accessible for Kubernetes probes and monitoring.

| Category | Prefix | Rate Limit Tier | Auth |
|----------|--------|-----------------|------|
| Health Probes | `/health/*` | `relaxed` (300 req/min) | None |
| Monitoring | `/api/v1/monitoring/*` | `relaxed` | JWT |
| Feedback | `/api/v1/feedback/*` | `default` | JWT |
| Audit Logs | `/api/v1/audit-logs/*` | `default` | JWT |

---

## Environment Variables Reference

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Set to `false` to disable all rate limiting |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Default tier max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Default tier window in milliseconds |

### Service URLs (used by API Gateway)

| Variable | Default | Target Service |
|----------|---------|---------------|
| `STT_V2_URL` | `http://localhost:8861` | STT v2 Python service |
| `SMR_URL` | `http://localhost:8862` | SMR Python service |
| `GUARDRAIL_URL` | `http://localhost:8863` | Guardrail Python service |
| `NLP_URL` | `http://localhost:8864` | NLP Python service |
| `HARNESS_URL` | `http://localhost:8866` | Clinical Documentation Harness Python service |
| `FEEDBACK_SERVICE_URL_HTTP` | `http://localhost:5015` | Feedback Python service |
| `FEEDBACK_API_KEY` | - | API key for Feedback service calls |

---

## Implementation Tickets

| Ticket | Area | Status | Description |
|--------|------|--------|-------------|
| TASK-001 | Internal Consolidation | Completed | Created `InternalModule`, standardized internal endpoint patterns |
| TASK-030 | OpenAPI Documentation | Completed | Fixed 6 controllers, enhanced Swagger config, 87 new tests |
| - | Rate Limiting | Completed | ThrottleConfigModule with 4 named tiers, global ThrottlerGuard |
| - | API Versioning | Completed | `enableVersioning()` with URI-based `/api/v1/` prefix |

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-21 | 2.1.0 | Added embedded Prisma Studio admin endpoints, fixed API Gateway port from 3000 to 8868 |
| 2026-02-19 | 2.0.0 | Major update: added cross-cutting concerns (rate limiting tiers, OpenAPI config, versioning, auth strategies, service communication patterns), environment variables reference, implementation ticket tracking |
| 2026-02-19 | 1.1.0 | Internal API consolidation — detailed endpoint docs, common patterns |
| 2026-02-19 | 1.0.0 | Initial API inventory documentation |
