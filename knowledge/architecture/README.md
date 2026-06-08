# System Architecture Overview

HOPE (Hybrid Agentic Medical Conversation System) is a cloud-first platform for capturing, processing, and summarizing medical conversations. It combines enterprise-grade backend services with intelligent client-side enhancement for privacy and performance.

## Architecture Layers

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER — Progressive Enhancement                                 │
│  ReactJS + AgenticSDK (Tier 1: Cloud / Tier 2: Enhanced / Tier 3: Local)│
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  API GATEWAY — NestJS (Port 8868)                                       │
│  JWT / OIDC / API Key Auth · RBAC (CASL) · Rate Limiting · WebSocket   │
└──┬───────────┬───────────┬───────────┬───────────┬───────────────────────┘
   │           │           │           │           │
   ▼           ▼           ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ ┌──────────────────────────┐
│STT v2  │ │  SMR   │ │Guardrail │ │  NLP   │ │ Harness (orchestrator)   │
│FastAPI │ │FastAPI │ │ FastAPI  │ │FastAPI │ │ FastAPI + Temporal       │
│:8861   │ │:8862   │ │ :8863    │ │ :8864  │ │ :8866                    │
└────────┘ └────────┘ └──────────┘ └────────┘ └──────────────────────────┘

   SMR calls Guardrail for medical-content validation. The Harness drives the
   guides → generate → sensors → gate loop and reuses STT / NLP / SMR / Qdrant
   as tools (apps/api remains the gateway and system-of-record).

┌──────────────────────────────────────────────────────────────────────────┐
│  DATA LAYER                                                                 │
│  PostgreSQL 18 · Redis 8 (BullMQ) · MinIO (S3)                            │
└──────────────────────────────────────────────────────────────────────────┘
   │
┌──▼──────────────────────────────────────────────────────────────────────┐
│  EXTENDED SERVICES                                                      │
│  Vault (secrets) · Qdrant (vector DB) · Temporal (harness, opt-in)     │
└─────────────────────────────────────────────────────────────────────────┘
```

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

### AI / ML Services

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| STT | Python / FastAPI | 3.11+ | Speech-to-text with Whisper models |
| SMR | Python / FastAPI | 3.11+ | Summary generation via LLM |
| Guardrail | Python / FastAPI | 3.11+ | Content safety + medical-context validation (LM Studio / Granite Guardian default) |
| NLP | Python / FastAPI | 3.11+ | Named entity recognition (NER) |
| Harness | Python / FastAPI + Temporal | 3.11+ | Clinical documentation orchestrator (durable workflow) |
| Model Registry | MLflow | Latest | Model versioning and experiment tracking |
| Inference | ONNX Runtime | Latest | Cross-platform model serving |

### Frontend

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Framework | ReactJS | 19.x | UI with progressive enhancement |
| Component Library | shadcn/ui + ElevenLabs UI | Vega style | Accessible components with Radix UI primitives |
| Styling | Tailwind CSS | 4.x | Utility-first CSS framework |
| Icons | Tabler Icons | 3.x | Icon library for shadcn components |
| SDK | AgenticSDK (Vox) | v2 | Medical conversation SDK |
| WebSocket | Socket.IO / WS | Latest | Real-time bidirectional communication |
| Build | tsup / Vite | Latest | SDK and package bundling (CJS + ESM) |
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

## Monorepo Structure

The project is a **Turborepo + pnpm** monorepo (package manager `pnpm@10.31.0`).

```text
hope-monorepo/
├── apps/
│   ├── api/                 # NestJS API Gateway
│   ├── stt-v2/              # Python STT Service (Speech-to-Text)
│   ├── smr/                 # Python SMR Service (summarization, module smr_v2)
│   ├── guardrail/           # Python Guardrail Service (content safety + medical validation)
│   ├── nlp/                 # Python NLP Service (NER / classification)
│   ├── harness/             # Python Clinical Documentation Harness (FastAPI + Temporal)
│   ├── ui-playground/       # React SDK playground + admin console (Vite/TanStack Router)
│   └── example/             # Minimal SDK usage example (Vite)
├── packages/
│   ├── agentic-sdk-v2/      # @arcaai/vox — ReactJS SDK
│   ├── applications/        # Business logic layer (DDD services)
│   ├── domains/             # Domain entities, factories, repositories
│   ├── database/            # Prisma schema, migrations, seed
│   ├── logger/              # Structured logging
│   ├── exceptions/          # Shared error types
│   ├── tools/               # Code generators (prisma-commander, scaffolding)
│   ├── ui/                  # Shared UI components (shadcn/ui + ElevenLabs UI)
│   ├── types/               # Shared TypeScript types
│   ├── utils/               # Shared utility functions
│   ├── med-ner/             # Medical NER package
│   ├── noise-filter/        # Audio noise filtering
│   ├── pipeline/            # Processing pipeline utilities
│   ├── room/                # Room/session management
│   ├── stt/                 # STT client package
│   ├── vad/                 # Voice activity detection
│   ├── eslint-plugin-arcaai-internal/  # Internal ESLint rules
│   └── config-*/            # Shared ESLint, TypeScript, Rollup, Tailwind configs
├── infrastructure/
│   └── docker/              # Docker Compose + service configs
├── docs/                    # Project documentation (ticket implementation records)
├── knowledge/               # Evergreen knowledge base (this folder)
├── turbo.json               # Build pipeline definitions
├── pnpm-workspace.yaml      # Workspace configuration
└── package.json             # Root scripts and dependencies
```

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

apps/stt-v2, smr, guardrail, nlp, harness ─·─·─► MinIO, Qdrant (via HTTP)
```

| Package | Depends On | Purpose |
|---------|-----------|---------|
| `apps/api` | applications, domains, database, logger, exceptions | API Gateway with full business logic |
| `packages/applications` | domains, database, logger, exceptions | Business services, RBAC, audit logging |
| `packages/database` | domains | Prisma client, soft-delete extensions |
| `packages/domains` | — | Entities, factories, mappers, repositories |
| `packages/ui` | — | Shared component library (shadcn/ui, ElevenLabs UI, Tailwind CSS) |
| `packages/agentic-sdk-v2` | ui (optional) | Client SDK for medical conversations |

## Turborepo Build Pipeline

The `turbo.json` defines task dependencies and caching:

| Task | Dependencies | Cached | Notes |
|------|-------------|--------|-------|
| `build` | `^build`, `^db:generate` | Yes | Produces `dist/`, `.next/`, `public/dist/`, `pkg/` |
| `dev` | `^db:generate` | No | Persistent dev servers |
| `dev:watch` | `^dev:watch` | No | Persistent file watchers |
| `start` | `^build` | Yes | Production start |
| `lint` | `^build` | Yes | Requires built packages |
| `test` | `build` | Yes | Outputs: none (empty `[]`) |
| `test:watch` | — | No | Persistent test watcher |
| `test:e2e` | — | Yes | End-to-end tests |
| `db:generate` | — | No | Generates Prisma client → `src/generated/` |
| `db:push` | `db:generate` | No | Pushes schema to database |
| `db:push:force` | `db:generate` | No | Force push with data loss acceptance |
| `db:migrate` | `db:generate` | No | Persistent migration runner |
| `db:migrate:deploy` | — | No | Deploy migrations |
| `db:studio` | — | No | Persistent Prisma Studio |
| `seed` | `db:generate` | No | Seeds database |
| `clean` | — | No | Cleans build artifacts |
| `nuke` | — | No | Full clean including node_modules |

Global environment variables that invalidate caches: `NEXT_PUBLIC_API_HOST`, `NODE_ENV`, `DATABASE_URL`.
Global dependencies: `**/.env.*local`.

## Progressive Enhancement Tiers

The client SDK adapts behavior based on device capabilities:

| Tier | RAM | Capabilities | Processing |
|------|-----|-------------|-----------|
| **Tier 1 — Baseline** | 2 GB | Cloud STT, manual editing, basic reports | All server-side |
| **Tier 2 — Enhanced** | 4 GB | Real-time streaming, entity highlighting, offline recording | Hybrid |
| **Tier 3 — Optimized** | 8 GB | Client-side STT (WASM/Whisper), local NLP, full offline | Mostly client-side |

## Core Architectural Principles

**Domain-Driven Design** — Business logic lives in `packages/applications` and `packages/domains` with entities, factories, repositories, and mappers.

**Multi-Tenancy** — All data is scoped by `tenantId`. RBAC policies enforce tenant isolation at the query level via CASL conditions. See [Security](./security.md).

**Event-Driven** — Services emit system events via `EventEmitter2`. Events flow through Redis (BullMQ) for async audit logging, notifications, and job processing. Kafka has been removed; all event processing uses Redis. See [Communication Patterns](./communication.md).

**Soft Delete** — Records are never hard-deleted. The `resourceStatus` field supports `ENABLED`, `DISABLED`, `ARCHIVED`, and `DELETED` states. See [Data Model](./data-model.md).

**Cloud-First** — The baseline always works via cloud services. Client-side processing is a progressive optimization, not a requirement.

**Gateway-Only Communication** — All client-side traffic must pass through the API gateway (NestJS :8868). Direct access to Python microservices is prohibited. The gateway enforces authentication (JWT/API Key), authorization (CASL RBAC), rate limiting, tenant isolation, and audit logging. Proxy controllers (e.g., `SmrProxyController`) forward requests to backend services after validation. See [Communication Patterns](./communication.md).

**Multi-Tab Connection Sharing** — The `@arcaai/vox` SDK uses a `SharedWorker` to multiplex WebSocket and SSE connections across browser tabs, reducing server load. When `SharedWorker` is unavailable, it falls back to per-tab connections. See [Streaming Architecture](../agentic-sdk-v2/streaming.md).
## Streaming Architecture

The platform supports three real-time streaming protocols:

| Protocol | Use Case | Auth Method |
|----------|----------|-------------|
| **WebSocket** | Live audio → transcription | Post-connect auth message (`{ type: "auth", token }`) |
| **SSE (fetch)** | Summary streaming, job progress | `Authorization` header via `fetch` + `ReadableStream` |
| **SSE (EventSource)** | SDK internal (with query param token) | `?token=...` query parameter |

Key architectural decisions:
- **Binary PCM over WebSocket** — Audio sent as raw `ArrayBuffer` (Int16 LE mono), not base64 JSON, for ~37% bandwidth savings
- **AudioWorkletNode** — Audio capture on audio thread (replacing deprecated `ScriptProcessorNode`)
- **SSE heartbeat** — API Gateway sends `:keepalive` comments every 15s to prevent proxy timeouts
- **Retry with backoff** — SMR proxy retries transient errors (ECONNREFUSED, 502, 503, 504) up to 2 times
- **SharedWorker** — Cross-tab WS/SSE connection sharing via `SharedConnectionManager`

See [Communication Patterns](./communication.md) and [SDK Streaming Architecture](../agentic-sdk-v2/streaming.md) for details.

## Related Documentation

- [Data Model](./data-model.md) — Entity relationships, Prisma schema, DDD patterns
- [Communication Patterns](./communication.md) — REST, WebSocket, SSE, Redis pub/sub, job queues
- [Security](./security.md) — Authentication, RBAC, audit logging
- [Infrastructure](./infrastructure.md) — Docker Compose, CI/CD, environment management
- [Clinical Documentation Harness](../harness/README.md) — Temporal-based documentation orchestrator
- [Guardrail](../guardrail/README.md) — Content safety & medical-context validation
- [SDK Streaming](../agentic-sdk-v2/streaming.md) — WebSocket, SSE, and cross-tab streaming
