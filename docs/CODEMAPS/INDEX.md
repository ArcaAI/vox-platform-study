# HOPE Project Codemaps

**Last Updated:** 2026-03-14

> Navigation hub for architectural maps across all HOPE services and packages. Each codemap provides module structure, data flow, external dependencies, and cross-references.

---

## 📍 Quick Navigation

### Backend Services (Apps)

| Service | Tech | Purpose |
|---------|------|---------|
| [API Gateway](./services/api-gateway.md) | NestJS | Central gateway — auth, routing, WebSocket proxy, service orchestration |
| [STT V2](./services/stt-v2.md) | FastAPI | Speech-to-text — multi-model ASR, VAD, diarization, audio processing |
| [SMR V2](./services/smr-v2.md) | FastAPI | Medical summarization — multi-LLM, specialty prompts, conversation analysis |
| [NLP](./services/nlp.md) | FastAPI | Medical NLP — classification, NER, diagnosis, medical entity extraction |

### Shared Packages (@arcaai/*)

| Package | Purpose |
|---------|---------|
| [Agentic SDK V2](./packages/agentic-sdk-v2.md) | React SDK for medical consultations (`@arcaai/vox`) |
| [Database](./packages/database.md) | Prisma ORM, PostgreSQL schema, migrations, seeding |
| [Domains](./packages/domains.md) | DDD entities, repositories, value objects, mappers |
| [Applications](./packages/applications.md) | NestJS shared business logic, use cases, DTOs |
| [Room](./packages/room.md) | Audio processing framework with plugin architecture |
| [Pipeline](./packages/pipeline.md) | Sequential/parallel processing infrastructure |
| [Logger](./packages/logger.md) | Winston structured logging with context tracking |
| [Exceptions](./packages/exceptions.md) | Custom exception hierarchy for error handling |
| [VAD](./packages/vad.md) | Voice Activity Detection (Silero VAD v5) |
| [Noise Filter](./packages/noise-filter.md) | AI noise cancellation (RNNoise WASM) |
| [Med NER](./packages/med-ner.md) | Medical Named Entity Recognition |
| [UI](./packages/ui.md) | Shared React component library (`@arcaai/ui`) |
| [Tools](./packages/tools.md) | CLI code generators, CLI utilities |

### Infrastructure & Configuration

| Resource | Purpose |
|----------|---------|
| [Infrastructure](./infrastructure.md) | Docker Compose, services, networking, secrets |
| [Environment](./environment.md) | Configuration, environment variables, secrets management |
| [Database](./database.md) | PostgreSQL schema, migrations, relationships, indexes |

---

## 🏗️ Architecture Diagrams

### System Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                     Clients                                     │
│         (Web | Mobile | SDK Apps)                              │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS + WebSocket
                         ▼
        ┌────────────────────────────────────┐
        │   HOPE API Gateway (NestJS)        │  Port 3000
        │  auth • routing • WebSocket proxy  │
        │  error  • observation • validation │
        └────────┬──────────────┬─────────┬──┘
                 │              │         │
        ┌────────▼─┐    ┌──────▼──┐   ┌──▼─────────┐
        │ STT V2   │    │ SMR V2   │   │ NLP       │
        │ FastAPI  │    │ FastAPI  │   │ FastAPI   │
        │ P. 8861  │    │ P. 8862  │   │ P. 8864   │
        └────────┬─┘    └──────┬───┘   └──┬────────┘
                 │             │          │
        ┌────────▼─────────────▼──────────▼─────────┐
        │  PostgreSQL (via Prisma)                  │
        │  Redis (Cache + BullMQ)                   │
        │  MinIO (Object Storage)                   │
        │  Qdrant (Vector DB)                       │
        └────────────────────────────────────────────┘
                     └── Vault (Secrets)
```

### Development Stack

```
Monorepo (Turborepo + pnpm workspaces)
│
├── apps/
│   ├── api (NestJS API Gateway)
│   ├── stt-v2 (FastAPI Speech-to-Text)
│   ├── smr-v2 (FastAPI Medical Summarization)
│   ├── nlp (FastAPI NLP)
│   └── ui-playground (React Dev Playground)
│
└── packages/
    ├── agentic-sdk-v2 (React SDK)
    ├── applications (NestJS Business Logic)
    ├── database (Prisma ORM)
    ├── domains (DDD Entities)
    ├── exceptions, logger, tools (Utils)
    ├── room, pipeline, vad, noise-filter (Audio)
    ├── med-ner (Medical NLP)
    └── ui (React Components)
```

---

## 📚 Documentation Layers

Each service/package codemap follows this structure:

1. **Purpose** — Why this exists, what it does
2. **Entry Points** — Main files to start with
3. **Module Structure** — Key files and folders
4. **Data Flow** — How data moves through this area
5. **External Dependencies** — Third-party libraries, internal dependencies
6. **API/Exports** — Public interfaces
7. **Configuration** — Environment variables, settings
8. **Related Areas** — Links to other codemaps

---

## 🔄 Cross-Service Communication

### REST API Calls
- API Gateway → STT V2, SMR V2, NLP

### WebSocket Connections
- Clients → API Gateway → real-time events

### Message Queue (BullMQ + Redis)
- Long-running jobs (transcription, summarization)

### Database (PostgreSQL)
- All services via Prisma ORM (API Gateway)

---

## ⚙️ Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm build` | Build all services and packages |
| `pnpm dev:api` | Start API Gateway (port 3000) |
| `pnpm dev:stt-v2` | Start STT V2 (port 8861) |
| `pnpm dev:smr-v2` | Start SMR V2 (port 8862) |
| `pnpm dev:nlp` | Start NLP (port 8864) |
| `pnpm docker:dev:up` | Start infrastructure (PostgreSQL, Redis, MinIO, Qdrant) |
| `pnpm db:all` | Setup database (push, generate, seed) |
| `pnpm ok` | Full reset (db:all + build) |

See [SETUP.md](../../knowledge/SETUP.md) for complete command reference.

---

## 📖 Related Documentation

- [knowledge/README.md](../../knowledge/README.md) — Knowledge base index
- [knowledge/SETUP.md](../../knowledge/SETUP.md) — Local development setup
- [knowledge/DOCUMENTATION-PLAN.md](../../knowledge/DOCUMENTATION-PLAN.md) — Documentation restructuring plan

---

## 🎯 Codemap Generation

Codemaps are generated from the actual codebase structure and kept current with code changes.

**Convention**: Each codemap includes a "Last Updated" timestamp at the top to signal freshness.

**Tool**: [scripts/codemaps/generate.ts](../../scripts/codemaps/generate.ts) (generates all codemaps)

---

**Status**: ✅ Initialized | Documentation in progress across all services
