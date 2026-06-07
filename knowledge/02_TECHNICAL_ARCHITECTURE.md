# Technical Architecture, Project Structure & Tech Stack

> **Project**: HOPE — Hybrid Agentic Medical Conversation System
> **Last Updated**: 2026-02-19

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Architecture Layers](#architecture-layers)
3. [Core Architectural Principles](#core-architectural-principles)
4. [Technology Stack](#technology-stack)
5. [Monorepo Structure](#monorepo-structure)
6. [Package Dependency Graph](#package-dependency-graph)
7. [Turborepo Build Pipeline](#turborepo-build-pipeline)
8. [Data Architecture](#data-architecture)
9. [Communication Patterns](#communication-patterns)
10. [Progressive Enhancement Strategy](#progressive-enhancement-strategy)
11. [Deployment Architecture](#deployment-architecture)
12. [Observability](#observability)

---

## System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER — Progressive Enhancement                                 │
│  ReactJS + AgenticSDK (Tier 1: Cloud / Tier 2: Enhanced / Tier 3: Local)│
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  API GATEWAY — NestJS (Port 8868)                                       │
│  JWT / OIDC / API Key Auth · RBAC (CASL) · Rate Limiting · WebSocket   │
└──┬────────────┬────────────┬────────────┬───────────────────────────────┘
   │            │            │            │
   ▼            ▼            ▼            ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐
│STT v2  │ │  TTS   │ │  SMR   │ │     NLP      │
│FastAPI │ │FastAPI │ │FastAPI │ │   FastAPI     │
│:8861   │ │:8863   │ │:8862   │ │   :8864      │
└────────┘ └────────┘ └────────┘ └──────────────┘
   │            │            │            │
┌──▼────────────▼────────────▼────────────▼───────────────────────────────┐
│  DATA LAYER                                                             │
│  PostgreSQL 18 · Redis 8 (BullMQ) · MinIO (S3)                         │
└─────────────────────────────────────────────────────────────────────────┘
   │
┌──▼──────────────────────────────────────────────────────────────────────┐
│  EXTENDED SERVICES                                                      │
│  Vault (secrets) · Qdrant (vector DB)                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Layers

### 1. Client Layer

ReactJS applications powered by the AgenticSDK (`@arcaai/vox`), with audio processing plugins (Room, VAD, Noise Filter, Pipeline, Med-NER). The client layer adapts behavior based on device capabilities through progressive enhancement tiers.

### 2. API Gateway Layer

NestJS application serving as the central gateway with:
- Multi-authentication (JWT, OIDC, API Keys)
- Policy-based RBAC via CASL
- Rate limiting and CORS
- WebSocket proxy for real-time services
- Swagger/OpenAPI documentation
- Domain-driven module structure (controllers → services → repositories)

### 3. AI Processing Layer

Independent Python FastAPI microservices:
- **STT (Speech-to-Text)**: Multi-model ASR (Whisper ONNX, NeMo, Azure), VAD (Silero v5), speaker diarization (Pyannote), Qdrant speaker embeddings
- **TTS (Text-to-Speech)**: Azure TTS integration, 400+ voices, batch synthesis, WebSocket streaming
- **SMR (Summarization)**: Multi-LLM (LM Studio (OpenAI-compatible, default local engine), Ollama, Azure OpenAI), specialty-specific prompts, sync/async processing via Celery. Provider/model are admin-configurable per tenant (see *Admin-Configurable LLM Engine Settings*).
- **Guardrail (Content Safety)**: Granite Guardian moderation over the same pluggable LLM engines (LM Studio / Ollama / Azure OpenAI); provider/model + Azure deployment name are admin-configurable per tenant.
- **NLP (Natural Language Processing)**: Text classification, medical NER, diagnosis classification, spell correction (SymSpell)

### 4. Data Layer

- **PostgreSQL 18**: Multi-tenant relational storage with Prisma 7 ORM
- **Redis 8**: Caching, BullMQ job queues, pub/sub event system, RBAC ability cache
- **MinIO**: S3-compatible object storage for audio files, reports, model artifacts
- **Qdrant**: Vector database for speaker embeddings and semantic search

### 5. Extended Services

- **HashiCorp Vault**: Secret management (development mode)
- **MLflow**: Model versioning, experiment tracking, model registry

---

## Core Architectural Principles

**Domain-Driven Design** — Business logic lives in `packages/applications` (services, RBAC, audit) and `packages/domains` (entities, factories, repositories, mappers). The database layer uses `packages/database` with Prisma 7.

**Multi-Tenancy** — All data is scoped by `tenantId`. RBAC policies enforce tenant isolation at the query level via CASL conditions. Users can hold different roles in different tenants.

**Event-Driven Architecture** — Services emit system events via `EventEmitter2`. Events flow through Redis (BullMQ) for async audit logging, notifications, and job processing.

**Soft Delete** — Records are never hard-deleted. The `resourceStatus` field supports `ENABLED`, `DISABLED`, `ARCHIVED`, and `DELETED` states with a Prisma extension that intercepts delete operations.

**Cloud-First** — The baseline always works via cloud services. Client-side processing is a progressive optimization, not a requirement.

**Microservices Independence** — Each AI service (STT, TTS, SMR, NLP) is independently deployable, scalable, and replaceable behind a consistent API contract.

---

## Technology Stack

### Backend

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Framework | NestJS | 11.x | API Gateway with DI, guards, interceptors |
| Language | TypeScript | 5.8+ | Shared types across frontend and backend |
| Runtime | Node.js | 22+ | JavaScript server runtime |
| ORM | Prisma | 7.x | Type-safe database access with migrations |
| Queue | BullMQ | 5.42 | Async job processing via Redis |
| Validation | class-validator | Latest | Decorator-based request validation |
| WebSocket | WS / Socket.IO | Latest | Real-time bidirectional communication |
| API Docs | Swagger/OpenAPI | Latest | Auto-generated API documentation |

### AI / ML Services

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| STT | Python / FastAPI | 3.11+ | Speech-to-text with Whisper models |
| TTS | Python / FastAPI | 3.11+ | Text-to-speech with Azure TTS |
| SMR | Python / FastAPI | 3.11+ | Summary generation via multi-LLM |
| NLP | Python / FastAPI | 3.11+ | Named entity recognition, classification |
| Model Registry | MLflow | Latest | Model versioning and experiment tracking |
| Inference | ONNX Runtime | Latest | Cross-platform model serving |
| Training | PyTorch | Latest | Model training pipeline |

### Frontend

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Framework | ReactJS | 19.x | UI with progressive enhancement |
| Component Library | shadcn/ui + ElevenLabs UI | Vega style | Accessible components with Radix UI primitives |
| Styling | Tailwind CSS | 4.x | Utility-first CSS framework |
| Icons | Tabler Icons | 3.x | Icon library for shadcn components |
| SDK | AgenticSDK (`@arcaai/vox`) | v2 | Medical conversation SDK |
| WebSocket | Socket.IO / WS | Latest | Real-time communication |
| Events | EventEmitter3 | 5.0.1 | Internal SDK events |
| Build | tsup / Vite | Latest | SDK and package bundling (CJS + ESM) |
| Monorepo | Turbo | Latest | Incremental builds and caching |
| Package Manager | pnpm | 10.6.5 | Efficient workspace management |
| Testing | Vitest + Playwright CT | 4.x / 1.58 | Unit, component, and E2E tests |
| Storybook | Storybook | 10.x | Component development and documentation |

### Infrastructure

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Database | PostgreSQL | 18 | Multi-tenant relational storage |
| Cache / Queue | Redis | 8 | Caching, BullMQ jobs, pub/sub |
| Object Storage | MinIO | Latest | S3-compatible audio/artifact store |
| Vector Database | Qdrant | 1.16 | Semantic search over context items |
| Secrets | HashiCorp Vault | 1.15 | Secret management (dev mode) |
| Containers | Docker + Compose | Latest | Local and CI environments |
| Metrics | Prometheus | Latest | Metrics collection |
| Dashboards | Grafana | Latest | Observability dashboards |
| Logging | Loki | Latest | Log aggregation |
| Tracing | OpenTelemetry / Jaeger | Latest | Distributed tracing |

### Security

| Category | Technology | Purpose |
|----------|-----------|---------|
| Transport | TLS/SSL (OpenSSL) | Encryption in transit |
| At-rest | AES-256 | Database encryption |
| Password | bcryptjs | Salt-based hashing |
| Token signing | RS256 (asymmetric JWT) | Stateless authentication |
| RBAC | CASL | Fine-grained permission management |
| Input validation | class-validator | Decorator-based request validation |
| Rate limiting | express-rate-limit + @nestjs/throttler | DoS protection |

### Browser Compatibility (Client-side Progressive Enhancement)

| Feature | Minimum Version | Purpose |
|---------|----------------|---------|
| WebAssembly | Chrome 57+, Firefox 52+ | Client-side AI models (Tier 3) |
| WebAudio API | Chrome 66+, Firefox 25+ | Audio processing |
| IndexedDB | Chrome 24+, Firefox 16+ | Offline storage |
| WebWorkers | Chrome 4+, Firefox 3.5+ | Background processing |

---

## Monorepo Structure

The project is a **Turborepo + pnpm** monorepo.

```text
hope-monorepo/
├── apps/
│   ├── api/                 # NestJS API Gateway
│   ├── admin/               # Admin web application
│   ├── stt-v2/              # Python STT Service (primary)
│   ├── stt/                 # Python STT Service (legacy)
│   ├── tts/                 # Python TTS Service
│   ├── smr/                 # Python SMR Service (summarization)
│   ├── nlp/                 # Python NLP Service (NER)
│   ├── mlflow/              # MLflow tracking server
│   ├── feedback/            # Feedback collection service
│   └── fedl/                # Federated learning service
├── packages/
│   ├── agentic-sdk-v2/      # @arcaai/vox — ReactJS SDK
│   ├── applications/        # Business logic layer (DDD services)
│   ├── domains/             # Domain entities, factories, repositories
│   ├── database/            # Prisma schema, migrations, seed
│   ├── logger/              # Structured logging (Winston)
│   ├── exceptions/          # Shared error types
│   ├── tools/               # Code generators (prisma-commander, scaffolding)
│   ├── ui/                  # Shared UI components (shadcn/ui + ElevenLabs UI)
│   ├── types/               # Shared TypeScript types
│   ├── utils/               # Shared utility functions
│   ├── federated-learning/  # Federated learning package
│   ├── med-ner/             # Medical NER (Transformers.js)
│   ├── noise-filter/        # Audio noise filtering (RNNoise WASM)
│   ├── pipeline/            # Processing pipeline utilities
│   ├── room/                # Audio processing framework (plugin arch)
│   ├── stt/                 # STT client package
│   ├── vad/                 # Voice activity detection (Silero v5)
│   └── config-*/            # Shared ESLint, TypeScript, Rollup, Tailwind configs
├── infrastructure/
│   └── docker/              # Docker Compose + service configs
├── knowledge/               # Consolidated knowledge base
├── docs/                    # Legacy documentation (archive)
├── tests/                   # Shared test fixtures and contracts
├── turbo.json               # Build pipeline definitions
├── pnpm-workspace.yaml      # Workspace configuration
└── package.json             # Root scripts and dependencies
```

### Application Directory Structure

```text
apps/api/src/
├── controllers/             # HTTP endpoints (NestJS controllers)
├── guards/                  # Authentication and authorization guards
├── interceptors/            # Request/response processing
├── services/                # Application services
├── decorators/              # Custom decorators
└── modules/                 # Feature modules (NestJS modules)
```

---

## Package Dependency Graph

```text
apps/api ──────► packages/applications ──► packages/domains
   │                   │                        │
   │                   ├──► packages/database ◄──┘
   │                   ├──► packages/logger
   │                   └──► packages/exceptions
   │
   └──► Redis, PostgreSQL (infrastructure)

packages/agentic-sdk-v2 ──► packages/ui (optional)

apps/stt-v2, tts, smr, nlp ─·─·─► MinIO, Qdrant (via HTTP)
```

| Package | Depends On | Purpose |
|---------|-----------|---------|
| `apps/api` | applications, domains, database, logger, exceptions | API Gateway with full business logic |
| `packages/applications` | domains, database, logger, exceptions | Business services, RBAC, audit logging |
| `packages/database` | domains | Prisma client, soft-delete extensions |
| `packages/domains` | — | Entities, factories, mappers, repositories |
| `packages/ui` | — | Shared component library (shadcn/ui, ElevenLabs UI, Tailwind CSS) |
| `packages/agentic-sdk-v2` | ui (optional) | Client SDK for medical conversations |

---

## Turborepo Build Pipeline

| Task | Dependencies | Cached | Notes |
|------|-------------|--------|-------|
| `build` | `^build`, `^db:generate` | Yes | Produces `dist/`, `.next/`, `public/dist/`, `pkg/` |
| `dev` | `^db:generate` | No | Persistent dev servers |
| `dev:watch` | `^dev:watch` | No | Persistent file watchers |
| `start` | `^build` | Yes | Production start |
| `lint` | `^build` | Yes | Requires built packages |
| `test` | `build` | Yes | Outputs: none |
| `db:generate` | — | No | Generates Prisma client |
| `db:push` | `db:generate` | No | Pushes schema to database |
| `db:migrate` | `db:generate` | No | Persistent migration runner |
| `seed` | `db:generate` | No | Seeds database |
| `clean` | — | No | Cleans build artifacts |
| `nuke` | — | No | Full clean including node_modules |

Global cache invalidation variables: `NEXT_PUBLIC_API_HOST`, `NODE_ENV`, `DATABASE_URL`.

---

## Data Architecture

### Database Design

PostgreSQL 18 with Prisma 7 using a multi-schema layout organized by domain:

| Schema Prefix | Entities |
|---------------|----------|
| `core` | User, Tenant, AuditLog, GlobalSetting, Notification, Webhook, Tag |
| `rbac` | Role, Policy, RolePolicy, UserRoleAssignment |
| `consultation` | Consultation, ContextItem, MedicalReport, NamedEntity |
| `stt` | SttConfig, SttModel, SttPipeline |
| `media` | AudioRecording, Media |
| `department` | Department |
| `apikey` | ApiKey, ApiKeyScope |
| `dna` | DnaWritingStyle |
| `prompt` | PromptTemplate |
| `fedl` | FederatedLearningConfig |

### Entity Patterns

**BaseEntity** — All entities share: `id` (UUIDv7), `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `resourceStatus`.

**Soft Delete** — Prisma middleware intercepts `delete()` → `update({ resourceStatus: 'DELETED' })`. Queries default-filter `resourceStatus !== 'DELETED'`.

**Multi-tenancy** — All tenant-scoped entities include `tenantId`. CASL conditions enforce isolation at the query level.

**DDD Patterns** — Factory (create entities), Repository (data access), Mapper (domain ↔ persistence), Unit of Work (transaction management).

### Admin-Configurable LLM Engine Settings

The SMR and Guardrail engines are selected per tenant from the database (TASK-338), reusing the `GlobalSetting` pattern rather than redeploying services. Defaults are seeded on the `__GLOBAL__` tenant and cloned to each tenant on provisioning (`TenantService.provisionTenantConfigs()`); the admin console (`ui-playground` → Configuration Management) edits them via the tenant-config PATCH endpoints with optimistic-concurrency (`If-Match`/`expectedVersion`).

| Namespace | Key | Purpose | Locked |
|-----------|-----|---------|--------|
| `smr` | `default-smr-provider` / `default-smr-model` | Active summarization provider + model | Yes (SUPER_ADMIN) |
| `smr` | `smr-azure-deployment` | Azure OpenAI deployment **name** for SMR (non-secret) | No |
| `guardrail` | `default-guardrail-provider` / `default-guardrail-model` | Active guardrail provider + model (default `lm-studio` / `granite-guardian-4.1-8b`) | Yes (SUPER_ADMIN) |
| `guardrail` | `guardrail-azure-deployment` | Azure OpenAI deployment **name** for Guardrail (non-secret) | No |
| `ux-constants` | `smr-provider-models` / `guardrail-provider-models` | Catalogs of selectable provider→model options for the admin dropdowns | Yes |

The API gateway exposes the resolved provider lists at `GET /api/v1/text/providers` (SMR) and `GET /api/v1/text/guardrail-providers` (Guardrail); admins pick a default from the catalog and the value is validated (`TenantService.validateProviderModel`) against it before persistence.

**Azure API key remains env/Vault.** Only the Azure **deployment name** is DB-driven; the Azure OpenAI API key is never stored as a `GlobalSetting` and continues to be sourced from environment/Vault. Admin-set (DB-driven) provider API keys are unblocked by TASK-302 Phase 4D (encrypted secret settings) and are out of scope here.

### Context Item Types

The `ContextItem` entity stores all consultation-related content:

| Type | Description |
|------|-------------|
| `TRANSCRIPT` | Raw or corrected transcription |
| `WORKNOTE` | Doctor's inline notes |
| `CASE_NOTE` | Clinical case documentation |
| `PRE_SUMMARY` | Pre-processing summary |
| `RAW_SUMMARY` | AI-generated summary |
| `MODIFIED_SUMMARY` | Doctor-edited summary |
| `AUDIO_RECORDING` | Reference to audio file |

### Storage Architecture

| Store | Technology | Content |
|-------|-----------|---------|
| Relational | PostgreSQL 18 | All structured data, audit logs, configurations |
| Cache | Redis 8 | Session data, RBAC abilities, job queues |
| Object | MinIO | Audio files, medical reports, model artifacts |
| Vector | Qdrant 1.16 | Speaker embeddings, semantic context search |

---

## Communication Patterns

### REST (API Gateway ↔ Python Services)

The NestJS API Gateway proxies requests to Python FastAPI services over HTTP:

| Route Prefix | Target Service | Port |
|-------------|---------------|------|
| `/api/v1/audio/*` | STT v2 Service | 8861 |
| `/api/v1/speech/*` | TTS Service | 8863 |
| `/api/v1/text/*` | SMR Service | 8862 |
| `/api/v1/nlp/*` | NLP Service | 8864 |
| `/api/v1/fedl/*` | FedL Service | 8865 |

### WebSocket (Real-time Streaming)

- STT audio streaming: Client → API Gateway → STT Service (binary frames)
- TTS audio playback: SMR Service → API Gateway → Client
- Live transcript updates: STT Service → API Gateway → Client

### Redis Pub/Sub and BullMQ

- **Pub/Sub**: Real-time event distribution (authorization audit, system events)
- **BullMQ Queues**: Async job processing (summary generation, audit logging, notifications)
- **RBAC Cache**: User ability objects cached with 5-minute TTL

### Event Flow

```text
Service Operation
    │
    ├──► EventEmitter2 (in-process)
    │       │
    │       ├──► SysEventService (listener)
    │       │       ├──► Queue AuditLogJob → BullMQ → AuditLog table
    │       │       ├──► Queue UserActivityJob → BullMQ → Activity tracking
    │       │       └──► Queue SysEventJob → BullMQ → Event processing
    │       │
    │       └──► Redis publish (real-time subscribers)
    │
    └──► HTTP Response to client
```

---

## Progressive Enhancement Strategy

The client SDK adapts behavior based on device capabilities:

| Tier | RAM | Capabilities | Processing |
|------|-----|-------------|-----------|
| **Tier 1 — Baseline** | 2 GB | Cloud STT, manual editing, basic reports | All server-side |
| **Tier 2 — Enhanced** | 4 GB | Real-time streaming, entity highlighting, offline recording | Hybrid |
| **Tier 3 — Optimized** | 8 GB | Client-side STT (WASM/Whisper), local NLP, full offline | Mostly client-side |

### Model Loading Strategy

- **Tier 1**: No models downloaded; all processing via cloud APIs
- **Tier 2**: Enhanced streaming models (<50 MB) with intelligent caching
- **Tier 3**: Full client-side models (<100 MB) via WebAssembly/ONNX with IndexedDB persistence

### Fallback Behavior

If client-side processing fails or device capability is insufficient, the system automatically falls back to the next lower tier. Cloud services are always available as the ultimate fallback.

---

## Deployment Architecture

### Local Development

Docker Compose orchestrates all services:

| Service | Port | Image |
|---------|------|-------|
| PostgreSQL | 5432 | postgres:18-alpine |
| Redis | 6379 | redis:8-alpine |
| MinIO | 9000/9001 | minio/minio |
| Qdrant | 6333/6334 | qdrant/qdrant:v1.16.0 |
| Vault | 8200 | hashicorp/vault:1.15 |
| API Gateway | 8868 | Node.js (local) |
| STT V2 | 8861 | Python (conda) |
| TTS | 8863 | Python (conda) |
| SMR | 8862 | Python (conda) |
| NLP | 8864 | Python (conda) |

### Test Environment

Separate Docker Compose with isolated ports:

| Service | Dev Port | Test Port |
|---------|----------|-----------|
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| Kafka | 9092 | 9093 |
| API Server | 8868 | 3000 |

### CI/CD

- **GitHub Actions**: Primary CI — lint, unit tests, integration tests, E2E tests
- **GitLab CI**: Secondary CI — same workflow stages
- **Path filtering**: Only relevant workflows triggered based on changed files
- **Shared actions**: Reusable setup actions for Node.js+pnpm, Python+uv, test environment

### Environment Configuration

| File | Purpose |
|------|---------|
| `.env.dev` | Local development variables |
| `.env.test` | Test environment variables (committed) |
| `.env.production` | Production configuration |
| `.env.example` | Template with all available variables |

Loading priority: Host environment variables → `.env.*` files based on `NODE_ENV`.

---

## Observability

### Health Checks

All services expose health endpoints:
- API Gateway: `GET /api/health` (database, Redis, dependent services)
- Python services: `GET /health` (model availability, dependencies)

### Metrics (Prometheus)

- Request latency, throughput, error rates
- Service-specific metrics (STT session count, TTS synthesis time, etc.)
- Database connection pool metrics
- Redis queue depths

### Logging (Winston + Loki)

- Structured JSON logging with correlation IDs
- Log levels: ERROR, WARN, INFO, DEBUG
- Transports: console, file rotation, S3 archival
- Sensitive data redaction (passwords, PII)

### Tracing (OpenTelemetry)

- Distributed request tracing across services
- Span-level detail for performance analysis
- Integration with Jaeger for visualization

---

## Related Documentation

- [Project Brief & Requirements](./01_PROJECT_BRIEF_AND_REQUIREMENTS.md) — Business context, SOW, feature scope
- [Quality Control](./03_QUALITY_CONTROL.md) — Testing strategy, CI/CD pipeline, coverage targets
- [Access Control](./04_ACCESS_CONTROL.md) — Authentication, RBAC, tenant isolation, audit logging
