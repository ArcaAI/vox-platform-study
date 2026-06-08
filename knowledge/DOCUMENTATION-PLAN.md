# HOPE Knowledge Base — Documentation Restructure Plan

> **Created**: 2026-02-19
> **Status**: Planning
> **Goal**: Clean up legacy docs and create a structured, current, best-practice knowledge base that the team can build in parallel.

---

## Table of Contents

1. [Overview](#overview)
2. [Folder Structure](#folder-structure)
3. [Document Standards](#document-standards)
4. [Workstream Assignments](#workstream-assignments)
5. [Dependency Graph](#dependency-graph)
6. [Per-Folder Scope](#per-folder-scope)
7. [Migration Checklist](#migration-checklist)

---

## Overview

### Why

The existing `docs/` directory contains 110+ files spread across implementation tickets, project plans, requirement prompts, and architecture documents. Much of this content:

- Mixes ticket-level implementation logs with evergreen reference docs
- Has stale references (e.g. sprint roadmaps referencing Q2 2024)
- Lacks consistent structure across apps and packages
- Makes onboarding and cross-team reference difficult

### What

Create a new **`knowledge/`** directory as the single source of truth for all technical documentation, organized by app/package. Each folder follows the same template so any team member can navigate any part of the system.

### Principles

- **One folder per deployable unit or shared package**
- **Evergreen content only** — no ticket logs, sprint plans, or changelogs in knowledge base
- **Self-contained** — each folder has everything needed to understand, develop, and operate that component
- **Parallel-friendly** — each folder can be written independently by a different person

---

## Folder Structure

```
knowledge/
├── DOCUMENTATION-PLAN.md          ← this file
├── README.md                      ← knowledge base index & navigation
│
├── architecture/                  ← cross-cutting system architecture
│   ├── README.md                  ← system overview, tech stack, deployment topology
│   ├── data-model.md              ← database schema & entity relationships
│   ├── communication.md           ← inter-service communication patterns
│   ├── security.md                ← auth, RBAC, secrets management
│   └── infrastructure.md          ← Docker, CI/CD, environments
│
├── api/                           ← NestJS API Gateway
├── smr-v2/                        ← Summarization Service V2
├── stt-v2/                        ← Speech-to-Text Service V2
├── nlp/                           ← NLP Service
├── guardrail/                     ← Guardrail Service (content safety + medical validation)
├── harness/                       ← Clinical Documentation Harness (FastAPI + Temporal)
├── agentic-sdk-v2/                ← @arcaai/vox SDK
│
├── applications/                  ← @arcaai/applications package
├── database/                      ← @arcaai/database (Prisma)
├── domains/                       ← @arcaai/domains (DDD layer)
├── exceptions/                    ← @arcaai/exceptions
├── logger/                        ← @arcaai/logger
│
├── ui/                            ← @arcaai/ui (shared component library)
├── playground/                    ← apps/ui-playground (SDK playground + admin console)
│
├── med-ner/                       ← @arcaai/med-ner plugin
├── noise-filter/                  ← @arcaai/noise-filter plugin
├── pipeline/                      ← @arcaai/pipeline package
├── room/                          ← @arcaai/room package
├── tools/                         ← @arcaai/tools (code generators)
└── vad/                           ← @arcaai/vad plugin
```

---

## Document Standards

Every folder **MUST** contain a `README.md` with the following sections:

### For Apps (api, smr-v2, stt-v2, nlp)

| Section | Description |
|---------|-------------|
| **Overview** | What the service does, 2-3 sentences |
| **Architecture** | Internal architecture diagram/description |
| **Tech Stack** | Framework, language, key dependencies with versions |
| **Getting Started** | Prerequisites, environment setup, how to run locally |
| **Configuration** | Environment variables table (name, type, default, description) |
| **API Reference** | Endpoints, WebSocket events, request/response schemas |
| **Testing** | How to run tests, coverage targets, test categories |
| **Deployment** | Docker build, environment-specific notes |
| **Observability** | Logging, metrics, tracing, health endpoints |
| **Troubleshooting** | Common issues and solutions |

### For Packages (applications, database, domains, etc.)

| Section | Description |
|---------|-------------|
| **Overview** | What the package provides, 2-3 sentences |
| **Installation** | How to add as a workspace dependency |
| **Architecture** | Internal structure and design patterns |
| **API Reference** | Key exports, classes, functions, hooks |
| **Usage Examples** | Code snippets showing common usage patterns |
| **Configuration** | Any configurable options |
| **Testing** | How to run package tests |
| **Contributing** | How to extend or modify the package |

### Optional Additional Files

Each folder may also include:

- `api-reference.md` — detailed API docs when too large for README
- `architecture.md` — detailed architecture when complex
- `configuration.md` — full environment variable reference
- `examples.md` — extended code examples
- `assets/` — diagrams, screenshots

---

## Workstream Assignments

The work is organized into **5 parallel workstreams** that can be executed simultaneously.

### Workstream 1: Architecture & Cross-Cutting (1 person)

> **Depends on**: Nothing (can start immediately)
> **Blocked by**: Nothing
> **Estimated effort**: 2-3 days

| Task | Source Material | Output |
|------|----------------|--------|
| System overview | `docs/technical-architecture-overview.md`, `docs/project-structure.md`, `docs/tech-stack.md` | `knowledge/architecture/README.md` |
| Data model | `docs/data-model/*.md`, Prisma schema | `knowledge/architecture/data-model.md` |
| Communication patterns | `docs/COMMUNICATION_AND_DATA_TRANSFER.md` | `knowledge/architecture/communication.md` |
| Security & RBAC | `docs/RBAC_IMPLEMENTATION_AND_USAGE.md`, `docs/RBAC_BEST_PRACTICES.md`, `docs/SEC-*` | `knowledge/architecture/security.md` |
| Infrastructure | `docs/infrastructure-setup.md`, `infrastructure/docker/`, CI/CD configs | `knowledge/architecture/infrastructure.md` |
| Knowledge base index | All folders | `knowledge/README.md` |

### Workstream 2: Backend Services — API & SMR (1-2 people)

> **Depends on**: Nothing (can start immediately)
> **Blocked by**: Nothing
> **Estimated effort**: 3-4 days

| Task | Source Material | Output |
|------|----------------|--------|
| API Gateway | `apps/api/docs/*`, `apps/api/README.md`, `docs/CONSULTATION_WORKFLOW.md` | `knowledge/api/README.md` + supplementary files |
| SMR V2 | `apps/smr/docs/*`, `apps/smr/README.md`, `docs/implementation/TASK-023-*` | `knowledge/smr-v2/README.md` + supplementary files |

### Workstream 3: Backend Services — STT & NLP (1-2 people)

> **Depends on**: Nothing (can start immediately)
> **Blocked by**: Nothing
> **Estimated effort**: 3-4 days

| Task | Source Material | Output |
|------|----------------|--------|
| STT V2 | `apps/stt-v2/README.md`, `docs/implementation/STT-*`, `docs/implementation/TASK-005` through `TASK-020` | `knowledge/stt-v2/README.md` + supplementary files |
| NLP | `apps/nlp/docs/*`, `apps/nlp/README.md` | `knowledge/nlp/README.md` + supplementary files |

### Workstream 4: SDK & Client-Side Packages (1-2 people)

> **Depends on**: Nothing (can start immediately)
> **Blocked by**: Nothing
> **Estimated effort**: 3-4 days

| Task | Source Material | Output |
|------|----------------|--------|
| Agentic SDK V2 | `docs/agentic-sdk-v2/*`, `packages/agentic-sdk-v2/README.md`, `docs/implementation/SDK-*` | `knowledge/agentic-sdk-v2/README.md` + supplementary files |
| UI | `packages/ui/`, `components.json`, Storybook stories | `knowledge/ui/README.md` |
| Room | `packages/room/README.md` | `knowledge/room/README.md` |
| VAD | `packages/vad/README.md` | `knowledge/vad/README.md` |
| Noise Filter | `packages/noise-filter/README.md` | `knowledge/noise-filter/README.md` |
| Med NER | `packages/med-ner/README.md` | `knowledge/med-ner/README.md` |
| Pipeline | `packages/pipeline/README.md` | `knowledge/pipeline/README.md` |

### Workstream 5: Core Infrastructure Packages (1-2 people)

> **Depends on**: Nothing (can start immediately)
> **Blocked by**: Nothing
> **Estimated effort**: 2-3 days

| Task | Source Material | Output |
|------|----------------|--------|
| Applications | `packages/applications/README.md`, source code analysis | `knowledge/applications/README.md` |
| Database | `packages/database/README.md`, Prisma schema, `docs/data-model/*` | `knowledge/database/README.md` |
| Domains | `packages/domains/README.md`, `docs/data-model/*` | `knowledge/domains/README.md` |
| Exceptions | `packages/exceptions/` source code | `knowledge/exceptions/README.md` |
| Logger | `packages/logger/README.md` | `knowledge/logger/README.md` |
| Tools | `packages/tools/README.md` | `knowledge/tools/README.md` |

---

## Dependency Graph

```
Workstream 1 (Architecture)  ──────┐
Workstream 2 (API + SMR)     ──────┤
Workstream 3 (STT + NLP)     ──────┼── All run in parallel ──► Final Review & Cross-linking
Workstream 4 (SDK + Plugins) ──────┤
Workstream 5 (Core Packages) ──────┘
```

**No hard dependencies between workstreams.** Each workstream can proceed independently.

After all workstreams are complete, a **final review pass** should:
1. Verify all cross-references between docs are correct
2. Ensure consistent terminology across all folders
3. Update `knowledge/README.md` index with all final paths
4. Review for completeness against the codebase

---

## Per-Folder Scope

### `knowledge/architecture/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | System overview diagram, tech stack summary, deployment topology, service dependency map |
| `data-model.md` | Prisma schema overview, entity relationships, soft-delete pattern, multi-tenancy model |
| `communication.md` | HTTP REST (API↔services), WebSocket (real-time STT), Redis (job queues, caching), event-driven patterns |
| `security.md` | JWT + OIDC + API Key auth flows, RBAC policy model (CASL), tenant isolation, audit logging |
| `infrastructure.md` | Docker Compose (dev + test), GitHub Actions CI, GitLab CI, environment variable management, Vault integration |

### `knowledge/api/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | NestJS gateway overview, module structure, multi-auth (JWT/OIDC/API Key), RBAC guards, microservice proxy pattern, WebSocket gateways, rate limiting |
| `api-reference.md` | All REST endpoints grouped by module (auth, user, consultation, STT, SMR, NLP, harness, monitoring), request/response schemas |
| `configuration.md` | Full env var table from `apps/api/` |

### `knowledge/smr-v2/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Medical summarization service overview, multi-LLM support (Azure OpenAI + Ollama), sync/async processing, specialty-specific prompts, Celery job queue |
| `api-reference.md` | REST endpoints, WebSocket events, SSE streams |
| `configuration.md` | Env var table |

### `knowledge/stt-v2/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | High-availability STT overview, multi-model ASR (Whisper ONNX, NeMo, Azure), Silero VAD v5, Pyannote diarization, Qdrant speaker embeddings, Dramatiq job queue, streaming architecture |
| `api-reference.md` | REST + WebSocket endpoints |
| `configuration.md` | Env var table, model configuration, pipeline YAML format |

### `knowledge/nlp/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Medical NLP overview, text classification (11 emotions), token classification (Medical NER), medical diagnosis (41 diseases), text correction (SymSpell), multi-language support |
| `api-reference.md` | REST + WebSocket endpoints |

### `knowledge/guardrail/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Content-safety + medical-context validation overview, LLM engine selection (LM Studio / Granite Guardian default, Ollama/Azure/Bedrock), SMR integration, per-tenant DB config, endpoints |

### `knowledge/harness/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Clinical Documentation Harness overview, Temporal workflow/activity mapping, guides→generate→sensors→gate loop, tool reuse (STT/NLP/SMR/Qdrant), config, internal endpoints |

### `knowledge/agentic-sdk-v2/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | SDK overview, architecture (plugin system), `AgenticProvider`, `useArca` hook, core vs plugins bundle |
| `api-reference.md` | Full API reference (providers, hooks, processors, events) |
| `examples.md` | SDK usage examples and common integration patterns |
| `migration-guide.md` | v1 → v2 migration guide |

### `knowledge/ui/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Component library overview, shadcn/ui configuration (Vega style, green theme, Tabler icons), component catalog (40+ shadcn, 17 ElevenLabs, domain-specific), hooks, testing (Playwright CT), Storybook, build pipeline |

### `knowledge/playground/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | `apps/ui-playground` overview — SDK playground + admin console (under `src/features/admin/*`), TanStack Router, port 5175 |
| `01..05_*.md` | Per-surface guides (auth/impersonation, consultation, audio/transcription, pre-summary/summary, DNA writing style) |

### `knowledge/applications/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Shared NestJS services layer, service catalog (auth, consultation, tenant, prompt-management, DNA writing style, etc.), authorization/RBAC integration, decorator patterns |

### `knowledge/database/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Prisma 7 setup, PostgreSQL connection, soft-delete extension, generated client usage, migration workflow, seeding |

### `knowledge/domains/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | DDD layer overview, entity pattern, repository pattern, mapper pattern, factory pattern, unit of work, query builder, domain events |

### `knowledge/exceptions/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Custom exception hierarchy, usage patterns, NestJS integration |

### `knowledge/logger/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Winston-based logging, transports (console, file rotation, S3), structured logging patterns |

### `knowledge/med-ner/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Medical NER plugin, Transformers.js integration, entity types, model selection, React hook API |

### `knowledge/noise-filter/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | RNNoise WebAssembly noise cancellation, plugin API, React hook, browser compatibility |

### `knowledge/pipeline/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Sequential/parallel pipeline infrastructure, stage API, orchestrator pattern, event system |

### `knowledge/room/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Audio processing framework, plugin architecture, `RoomProvider`, `ProcessorPipeline`, track management |

### `knowledge/tools/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Prisma Commander CLI, code generators (entity, mapper, repository, factory, controller, service), dev token generator |

### `knowledge/vad/`

| Document | Content to Extract/Create |
|----------|---------------------------|
| `README.md` | Voice Activity Detection plugin, Silero VAD v5, ONNX runtime, timing parameters, React hook |

---

## Migration Checklist

After all workstreams are complete, verify:

- [ ] Every folder in the structure above has a `README.md`
- [ ] All README files follow the standard template for their category (app vs package)
- [ ] No broken cross-references between documents
- [ ] All environment variable tables match current `.env.example` files
- [ ] API reference documents match actual route definitions in code
- [ ] `knowledge/README.md` index links to every sub-folder
- [ ] Old `docs/` content reviewed — nothing critical was missed
- [ ] Technical accuracy spot-checked by someone familiar with each component

---

## What Happens to Old Docs?

The existing `docs/` directory is **not deleted** during this process. After the knowledge base is complete and verified:

1. `docs/implementation/` — Keep as historical ticket records (read-only archive)
2. `docs/REQs/` — Keep as requirements/prompts reference
3. `docs/PROJECT/` — Keep as project management artifacts
4. Root-level `docs/*.md` — Superseded by `knowledge/architecture/` content; can be archived
5. `docs/agentic-sdk-v2/` — Superseded by `knowledge/agentic-sdk-v2/`; can be archived
6. `docs/data-model/` — Superseded by `knowledge/architecture/data-model.md` + `knowledge/domains/`; can be archived
