# HOPE Knowledge Base

> Single source of truth for all technical documentation in the HOPE monorepo.

---

## Quick Navigation

### Getting Started

| Document | Description |
|----------|-------------|
| [Local Development Setup](./SETUP.md) | Prerequisites, environment setup, running services, testing, scripts reference |

### System Architecture

| Document | Description |
|----------|-------------|
| [Architecture Overview](./architecture/README.md) | System topology, tech stack, deployment model |
| [Data Model](./architecture/data-model.md) | Database schema, entity relationships, multi-tenancy |
| [Communication Patterns](./architecture/communication.md) | Inter-service communication (REST, WebSocket, Redis) |
| [Security](./architecture/security.md) | Authentication, RBAC, tenant isolation, audit logging |
| [Infrastructure](./architecture/infrastructure.md) | Docker, CI/CD, environment management |

### Backend Services (Apps)

| Service | Tech | Description |
|---------|------|-------------|
| [API Gateway](./api/README.md) | NestJS | Central gateway — auth, routing, WebSocket proxy |
| [STT V2](./stt-v2/README.md) | FastAPI | Speech-to-text — multi-model ASR, VAD, diarization |
| [SMR V2](./smr-v2/README.md) | FastAPI | Medical summarization — multi-LLM, specialty prompts |
| [NLP](./nlp/README.md) | FastAPI | Medical NLP — classification, NER, diagnosis |

### Agentic SDK

| Package | Description |
|---------|-------------|
| [Agentic SDK V2](./agentic-sdk-v2/README.md) | `@arcaai/vox` — React SDK for medical consultations |

### Client-Side Plugins

| Package | Description |
|---------|-------------|
| [Room](./room/README.md) | `@arcaai/room` — Audio processing framework with plugin architecture |
| [VAD](./vad/README.md) | `@arcaai/vad` — Voice Activity Detection (Silero VAD v5) |
| [Noise Filter](./noise-filter/README.md) | `@arcaai/noise-filter` — AI noise cancellation (RNNoise WASM) |
| [Med NER](./med-ner/README.md) | `@arcaai/med-ner` — Medical Named Entity Recognition |
| [Pipeline](./pipeline/README.md) | `@arcaai/pipeline` — Sequential/parallel processing infrastructure |

### Project Planning

| Document | Description |
|----------|-------------|
| [Project Brief & Requirements](./01_PROJECT_BRIEF_AND_REQUIREMENTS.md) | Business context, SOW, feature scope, success metrics |
| [Technical Architecture](./02_TECHNICAL_ARCHITECTURE.md) | System architecture, data model, communication patterns |
| [Quality Control](./03_QUALITY_CONTROL.md) | Testing strategy, CI/CD pipeline, coverage targets |
| [Access Control](./04_ACCESS_CONTROL.md) | Authentication, RBAC, tenant isolation, audit logging |
| [API List](./05_API_LIST.md) | Full API endpoint reference |
| [User Stories](./06_USER_STORIES.md) | 150 user stories across all platform areas with gap analysis cross-references |

### UI & Frontend

| Package | Description |
|---------|-------------|
| [UI](./ui/README.md) | `@arcaai/ui` — Shared component library (shadcn/ui + ElevenLabs UI + Tailwind CSS v4) |

### Core Infrastructure Packages

| Package | Description |
|---------|-------------|
| [Applications](./applications/README.md) | `@arcaai/applications` — Shared NestJS business logic services |
| [Database](./database/README.md) | `@arcaai/database` — Prisma ORM with PostgreSQL |
| [Domains](./domains/README.md) | `@arcaai/domains` — DDD entities, repositories, mappers |
| [Exceptions](./exceptions/README.md) | `@arcaai/exceptions` — Custom exception hierarchy |
| [Logger](./logger/README.md) | `@arcaai/logger` — Winston-based structured logging |
| [Tools](./tools/README.md) | `@arcaai/tools` — CLI tools and code generators |

---

## Documentation Standards

See [DOCUMENTATION-PLAN.md](./DOCUMENTATION-PLAN.md) for the full documentation standards, templates, and migration plan.

## Contributing

When adding or updating documentation:

1. Follow the template for your document type (app vs package) in the plan
2. Keep content evergreen — no ticket numbers, sprint dates, or changelogs
3. Include working code examples wherever possible
4. Cross-reference related documents using relative links
5. Update this index if you add a new folder
