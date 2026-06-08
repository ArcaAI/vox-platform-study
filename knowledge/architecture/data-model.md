# Data Model

The HOPE platform uses a domain-driven data architecture built on Prisma 7 with PostgreSQL 18. This document covers the entity model, persistence patterns, and conventions that underpin the system.

## Architecture Layers

```text
API Controllers (apps/api)
        │
        ▼
Application Services (packages/applications)
        │
        ▼
Domain Layer (packages/domains)
├── Entities     — Business logic and state
├── Factories    — Object creation with defaults
├── Mappers      — Entity ↔ Prisma model transformation
└── Repositories — Data access abstraction
        │
        ▼
Database Layer (packages/database)
├── Prisma Schema  — Model definitions
├── Prisma Client  — Generated type-safe queries
└── Soft-Delete    — Extension for automatic filtering
```

## Entity Relationship Overview

```text
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│    Tenant    │──1:N──│     User     │──1:N──│  UserRole    │
│              │       │              │       │  Assignment  │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       │ 1:N                  │ (doctorId)           │ N:1
       ▼                      ▼                      ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ Consultation │◄──────│ Consultation │       │     Role     │
│              │ parent│   (child)    │       │              │
│              │───1:N─┤              │       └──────┬───────┘
└──────┬───────┘       └──────────────┘              │ 1:N
       │                                             ▼
       │ 1:N                                  ┌──────────────┐
       ▼                                      │  RolePolicy  │──N:1──► Policy
┌──────────────┐                              └──────────────┘
│ ContextItem  │
├──────────────┤
│ type: enum   │──1:N──► AudioRecording
│ source: enum │──1:1──► SummaryMeta
│ content: text│──1:N──► NamedEntity
│              │──1:N──► ContextItemVersion
└──────────────┘
```

## Core Entities

### Consultation

Represents a medical consultation (visit) between a doctor and patient.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUIDv7 | Primary key |
| `tenantId` | String | Multi-tenant isolation |
| `patientId` | String | External patient reference |
| `doctorId` | String | FK to User |
| `departmentId` | String? | FK to Department |
| `appointmentDate` | Date | Visit date |
| `parentConsultationId` | String? | Self-referential for visit chains |
| `metadata` | JSONB | Extensible metadata |

**Consultation chains** link related visits. The root consultation has `parentConsultationId = NULL`; follow-up visits reference the root. `CASE_NOTE` context items are shared across all consultations in a chain.

### ContextItem

A polymorphic container for all content associated with a consultation.

| Type | Source | Description | Shared in Chain |
|------|--------|-------------|:---:|
| `TRANSCRIPT` | TRANSCRIPTION | Audio-to-text output | No |
| `WORKNOTE` | USER | Doctor's observations | No |
| `CASE_NOTE` | USER | Additional context notes | **Yes** |
| `PRE_SUMMARY` | AI | AI summary of case notes | No |
| `RAW_SUMMARY` | AI | Full consultation summary | No |
| `MODIFIED_SUMMARY` | USER | Edited summary | No |
| `AUDIO_RECORDING` | SYSTEM | Container for audio files | No |
| `ATTACHMENT` | USER | File attachments | No |
| `NAMED_ENTITY` | AI | NER results container | No |

ContextItem also tracks:
- `currentVersionNumber` (Int) — tracks the latest version
- `dnaWritingStyleId` (String?) — reference to DNA writing style
- `qdrantSynced` / `qdrantSyncedAt` — vector search sync status

### Supporting Entities

| Entity | Purpose |
|--------|---------|
| `AudioRecording` | Media reference (mediaId, duration, format, sample rate, channels, bitrate, language, sequenceNumber) |
| `SummaryMeta` | AI model metadata (model ID, token counts, context IDs used, processing time) |
| `NamedEntity` | Extracted medical entities (class, confidence, offset positions, normalizedText) |
| `ContextItemVersion` | Immutable content snapshots with diff support (versionNumber, contentDiff, changeReason, changeSummary) |

## Standard Model Fields

Every Prisma model inherits these fields from the `BaseEntity` pattern:

| Field Group | Fields | Description |
|-------------|--------|-------------|
| **Meta** | `metaData` (JSONB), `version` (Int), `id` (UUIDv7) | Internal metadata and identity |
| **Multi-tenant** | `tenantId` | Organization-level isolation |
| **Resource Status** | `resourceStatus`, `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy` | Soft-delete lifecycle |
| **Audit** | `createdBy`, `updatedBy`, `createdAt`, `updatedAt` | Who/when tracking |

### Resource Status Enum

| Status | Description |
|--------|-------------|
| `ENABLED` | Active record (default) |
| `DISABLED` | Temporarily deactivated |
| `ARCHIVED` | Historical, read-only |
| `DELETED` | Soft-deleted, filtered by default |

The `@arcaai/database` package provides a Prisma extension that automatically excludes `DELETED` records from `findMany`, `findFirst`, and `count` queries.

## Entity Hierarchy

Domain entities follow a class hierarchy with progressive capabilities:

```text
BaseEntity
    └── BaseAggregate           (+ Domain Events via EventEmitter2)
            └── BaseTenantEntity    (+ tenantId)
                    └── BaseTaggedEntity    (+ tags[])
```

### Change Tracking

All property setters call `setProperty()`, which records modifications in an internal `_changes` map. This enables efficient partial updates — only changed fields are persisted.

```typescript
user.username = 'newname';
user.hasChanges;  // true
user.changes;     // { username: 'newname' }
```

### Resource Lifecycle Methods

| Method | Resulting Status |
|--------|-----------------|
| `enable()` | ENABLED |
| `disable()` | DISABLED |
| `archive()` | ARCHIVED |
| `delete()` | DELETED |
| `reinstate()` | DISABLED |
| `recoverFromDelete()` | DISABLED |

## DDD Patterns

### Factory Pattern

All entities are created through factories that set defaults and generate IDs:

```typescript
ConsultationFactory.CreateNewVisit({ patientId, doctorId, tenantId, ... })
ConsultationFactory.CreateRevisit({ parentConsultationId, ... })
ContextItemFactory.CreateRawSummary({ consultationId, content, ... })
ContextItemVersionFactory.CreateUserEditVersion({ content, changedBy, ... })
```

### Repository Pattern

Repositories abstract data access behind a consistent interface:

| Method | Description |
|--------|-------------|
| `findAll(props)` | Paginated query with filtering and sorting |
| `findById(id)` | Single entity by primary key |
| `findFirst(props)` | First matching entity |
| `count(props)` | Count matching records |
| `create(entity)` | Persist new entity (full `toPersistence()`) |
| `update(id, entity)` | Partial update (only `toPersistenceChanges()`) |
| `softDelete(id)` | Set `resourceStatus` to DELETED |
| `$()` / `query()` | Fluent query builder |

### Mapper Pattern

Mappers convert between domain entities and Prisma models:

- `toPersistence(entity)` — Full entity → database row
- `toPersistenceChanges(entity)` — Only changed fields → partial update
- `toDomainEntity(model)` — Database row → domain entity

### Unit of Work Pattern

Transaction management is handled through `UnitOfWorkService`, which provides a transactional Prisma client scoped to the current request.

### Query Builder

Repositories expose a fluent query builder via `$()`:

```typescript
const users = await userRepository.$()
    .Where({ username: { contains: 'john' } })
    .Include({ UserProfile: true })
    .OrderBy(['createdAt'], 'desc')
    .Take(10)
    .ToList();
```

## Multi-Tenancy Model

Every tenant-aware entity includes a `tenantId` field. Tenant isolation is enforced at two levels:

1. **RBAC Policy Conditions** — CASL rules inject `tenantId` filters into ability checks (see [Security](./security.md))
2. **Repository Queries** — the `tenantScopeFilter` Prisma extension injects `tenantId` into Prisma `where` clauses for every tenant-scoped read/write

## Code Generation

Domain classes are auto-generated from Prisma schemas using `packages/tools`:

```bash
pnpm gen:model          # Generate data models
pnpm gen:entity         # Generate entity classes
pnpm gen:mapper         # Generate mappers
pnpm gen:repository     # Generate repositories
pnpm gen:factory        # Generate factories
pnpm gen:service        # Generate service modules
pnpm gen:controller     # Generate API controllers
```

The `prisma-commander` tool manages schema operations across all database domains:

```bash
pnpm gen:prisma push --all --force    # Push all schemas
pnpm gen:prisma generate --all        # Generate all clients
```

## Database Infrastructure

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Primary DB | PostgreSQL 18 | Multi-tenant relational storage |
| Schema Mgmt | Prisma Migrate | Forward-only migrations with rollback |
| Driver Adapter | `@prisma/adapter-pg` | Prisma 7 PostgreSQL adapter (replaces built-in driver) |
| Identifiers | UUIDv7 | Time-sortable, globally unique IDs |
| DB Schemas | `public`, `core` | PostgreSQL schemas used within the database |

## STT Domain Models

The database includes models for the Speech-to-Text service pipeline:

| Entity | Purpose |
|--------|---------|
| `AsrPipeline` | ASR pipeline configuration (name, slug, YAML config referencing models by slug) |
| `AiModel` | AI model registry (source, format, download status, resource requirements) |
| `TranscriptionJob` | Transcription job tracking (status, progress, timing, results, retry handling) |

TranscriptionJob statuses: `QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`, `DEAD`.

## Additional Domain Models

Other Prisma schema files define:

| Schema File | Models |
|-------------|--------|
| `tenant.prisma` | `Tenant`, `Department` |
| `apikey.prisma` | `ApiKey` (SDK/webhook/integration/service account keys) |
| `webhook.prisma` | `Webhook`, `WebhookRunHistory` |
| `notification.prisma` | `Notification` |
| `tag.prisma` | `Tag` |
| `media.prisma` | `Media`, `UserMedia` |
| `fedl.prisma` | Federated learning models (legacy schema; no live `apps/fedl` service) |
| `dna-writing-style.prisma` | `DnaWritingStyleReport` |
| `globalSetting.prisma` | `GlobalSetting` (also stores per-tenant guardrail engine/model config) |
| `prompt-template.prisma` | Prompt template management |
| `harness.prisma` | Clinical Documentation Harness workflow / provenance models |
| `knowledge.prisma` | Knowledge ingestion / RAG documents |

## Related Documentation

- [System Architecture](./README.md) — Overall system overview
- [Communication Patterns](./communication.md) — How services interact with data
- [Security](./security.md) — RBAC and tenant isolation
