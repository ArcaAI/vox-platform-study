# Data Model & Entity Relationships

> **Package**: `@arcaai/database` (Prisma schemas) + `@arcaai/domains` (DDD layer)
> **Last Updated**: 2026-02-19

---

## Table of Contents

1. [Architecture Layers](#architecture-layers)
2. [Standard Model Fields](#standard-model-fields)
3. [Entity Relationship Diagram](#entity-relationship-diagram)
4. [Core Domain: Users and Tenancy](#core-domain-users-and-tenancy)
5. [RBAC Domain: Roles and Policies](#rbac-domain-roles-and-policies)
6. [Consultation Domain](#consultation-domain)
7. [STT Domain: AI Models and Pipelines](#stt-domain-ai-models-and-pipelines)
8. [Prompt and DNA Writing Style Domain](#prompt-and-dna-writing-style-domain)
9. [Supporting Domains](#supporting-domains)
10. [Enumerations Reference](#enumerations-reference)
11. [Prisma Schema Configuration](#prisma-schema-configuration)
12. [Multi-Tenancy Model](#multi-tenancy-model)
13. [Indexing Strategy](#indexing-strategy)

---

## Architecture Layers

```text
API Controllers (apps/api)
        │
        ▼
Application Services (packages/applications)
        │
        ▼
Domain Layer (packages/domains)
├── Entities     — Business logic, state, change tracking
├── Factories    — Object creation with ID generation and defaults
├── Mappers      — Entity ↔ Prisma model transformation
└── Repositories — Data access abstraction with query builder
        │
        ▼
Database Layer (packages/database)
├── Prisma Schema  — 18 schema files defining all models
├── Prisma Client  — Generated type-safe client
└── Soft-Delete    — Extension filtering DELETED records
```

---

## Standard Model Fields

Every Prisma model follows the **BaseEntity** pattern with these field groups:

```prisma
model Example {
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    tenantId String? @default("50000000-0000-0000-0000-000000000000")

    // ... business fields ...

    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?

    createdBy String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy String?
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    tags String[] @default([])

    @@index([tenantId], name: "Example_tenantId_idx")
    @@schema("core")
}
```

| Field Group | Fields | Description |
|-------------|--------|-------------|
| **Meta** | `metaData` (JSONB), `version` (Int, default 1), `id` (UUIDv7) | Internal metadata and identity |
| **Multi-tenant** | `tenantId` (String?, defaults to seed tenant) | Organization-level isolation |
| **Resource Status** | `resourceStatus` (enum, default ENABLED), `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy` | Soft-delete lifecycle |
| **Audit** | `createdBy`, `updatedBy`, `createdAt` (auto), `updatedAt` (auto) | Who/when tracking |
| **Tags** | `tags` (String[], default []) | Optional tagging (on BaseTaggedEntity models) |

### Resource Status Enum

| Status | Description |
|--------|-------------|
| `ENABLED` | Active record (default) |
| `DISABLED` | Temporarily deactivated |
| `ARCHIVED` | Historical, read-only |
| `DELETED` | Soft-deleted — filtered by the Prisma extension automatically |

---

## Entity Relationship Diagram

```text
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│    Tenant    │──1:N──│     User     │──1:N──│  UserRole    │
│              │       │              │       │  Assignment  │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       │ 1:N                  │ (doctorId)           │ N:1
       ▼                      ▼                      ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  Department  │       │ Consultation │◄──────│     Role     │
│              │       │              │ parent│              │
└──────────────┘       │              │───1:N─┤              │
                       └──────┬───────┘       └──────┬───────┘
                              │                      │ 1:N
                              │ 1:N                  ▼
                              ▼               ┌──────────────┐
                       ┌──────────────┐       │  RolePolicy  │──N:1──► Policy
                       │ ContextItem  │       └──────────────┘
                       ├──────────────┤
                       │ type: enum   │──1:N──► AudioRecording
                       │ source: enum │──1:1──► SummaryMeta
                       │ content: text│──1:N──► NamedEntity
                       │              │──1:N──► ContextItemVersion
                       └──────────────┘

┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  AiModel     │       │ AsrPipeline  │──1:N──│ Transcription│
│              │       │              │       │    Job       │
└──────────────┘       └──────────────┘       └──────────────┘

┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│DnaWriting    │──1:N──│DnaWriting    │       │ PromptUsage  │
│StyleReport   │       │StyleVersion  │       │   Record     │
└──────────────┘       └──────────────┘       └──────────────┘

┌──────────────┐       ┌──────────────┐
│PromptTemplate│──1:N──│PromptVersion │
└──────────────┘       └──────────────┘
```

---

## Core Domain: Users and Tenancy

### Tenant

Represents an organization in the multi-tenant system.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUIDv7 | Primary key |
| `name` | String | Organization name |
| `externalId` | String? | External system reference |

**Relations**: `Users[]`, `Departments[]`, `Consultations[]`

### User

Represents a system user (human or service account).

| Field | Type | Description |
|-------|------|-------------|
| `username` | String | Unique login identifier |
| `password` | String | Hashed password (bcryptjs) |
| `lastLoginAt` | DateTime? | Last login timestamp |
| `lastActiveAt` | DateTime? | Last activity timestamp |
| `externalId` | String? | External identity provider ID |
| `isServiceAccount` | Boolean | Whether this is a service account |
| `secret1`, `secret2` | String? | Refresh token secrets |
| `secret1Expiry`, `secret2Expiry` | DateTime? | Secret expiration dates |

**Relations**: `UserProfile`, `UserSettings[]`, `UserRoleAssignments[]`, `UserGroups[]`, `UserMedias[]`, `DoctorConsultations[]`, `DoctorDnaReports[]`

**Indexes**: `@@index([username])`

### UserProfile

One-to-one extension of User with personal details.

**Relations**: `User` (1:1)

### UserGroup

Hierarchical group for organizing users. Self-referential (`parentGroupId`) for nesting.

**Relations**: `ParentGroup`, `ChildGroups[]`, `Users[]`, `RoleAssignments[]`

### UserRoleAssignment

Junction table binding a User to a Role within a Tenant.

| Field | Type | Description |
|-------|------|-------------|
| `userId` | String | FK to User |
| `roleId` | String | FK to Role |
| `tenantId` | String? | Scoping (null = global) |

**Unique constraint**: `@@unique([userId, roleId, tenantId])`

---

## RBAC Domain: Roles and Policies

### Role

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Unique role name |
| `description` | String? | Human-readable description |
| `externalName` | String? | Display name for external use |
| `externalId` | String? | External identity provider reference |
| `isSystemRole` | Boolean | If true, cannot be modified |
| `parentRoleId` | String? | Self-referential for role hierarchy |

**Relations**: `ParentRole`, `ChildRoles[]`, `RolePolicies[]`, `UserRoleAssignments[]`, `UserGroupRoleAssignments[]`

**Unique constraint**: `@@unique([name])`

### Policy

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Unique policy name |
| `description` | String? | Human-readable description |
| `rules` | Json | CASL rule definitions (action, subject, conditions, inverted, reason, fields) |
| `scope` | PolicyScope | `GLOBAL` or `TENANT` |

**Relations**: `RolePolicies[]`

**Unique constraint**: `@@unique([name])`

### RolePolicy

Junction table binding Roles to Policies.

| Field | Type | Description |
|-------|------|-------------|
| `roleId` | String | FK to Role |
| `policyId` | String | FK to Policy |

**Unique constraint**: `@@unique([roleId, policyId])`

---

## Consultation Domain

### Consultation

Represents a medical consultation between a doctor and patient.

| Field | Type | Description |
|-------|------|-------------|
| `patientId` | String? | External patient reference |
| `appointmentDate` | DateTime? | Visit date |
| `doctorId` | String? | FK to User (doctor) |
| `departmentId` | String? | FK to Department |
| `parentConsultationId` | String? | Self-referential for visit chains |
| `metadata` | Json? | Extensible consultation metadata |

**Relations**: `Doctor` (User), `Department`, `ParentConsultation`, `ChildConsultations[]`, `ContextItems[]`

**Visit chains**: The root consultation has `parentConsultationId = NULL`; follow-up visits reference the root. `CASE_NOTE` context items are shared across the chain.

### ContextItem

Polymorphic container for all content associated with a consultation.

| Field | Type | Description |
|-------|------|-------------|
| `consultationId` | String | FK to Consultation |
| `type` | ContextItemType | Content type (see enum below) |
| `source` | ContextItemSource | Who created it (USER, AI, SYSTEM, TRANSCRIPTION) |
| `currentVersionNumber` | Int | Latest version number |
| `content` | Text? | Main content body |
| `dnaWritingStyleId` | String? | Reference to DNA writing style |
| `qdrantSynced` | Boolean | Whether synced to Qdrant vector DB |
| `qdrantSyncedAt` | DateTime? | Last sync timestamp |

**Relations**: `Consultation`, `AudioRecordings[]`, `SummaryMeta?`, `NamedEntities[]`, `Versions[]`

**Indexes**: `@@index([consultationId, type])`, `@@index([consultationId])`, `@@index([type])`

### Context Item Types

| Type | Source | Description | Shared in Chain |
|------|--------|-------------|:---:|
| `TRANSCRIPT` | TRANSCRIPTION | Audio-to-text output | No |
| `WORKNOTE` | USER | Doctor's observations | No |
| `CASE_NOTE` | USER | Additional context notes | **Yes** |
| `PRE_SUMMARY` | AI | Pre-processing summary | No |
| `RAW_SUMMARY` | AI | Full consultation summary | No |
| `MODIFIED_SUMMARY` | USER | Doctor-edited summary | No |
| `AUDIO_RECORDING` | SYSTEM | Container for audio files | No |
| `ATTACHMENT` | USER | File attachments | No |
| `NAMED_ENTITY` | AI | NER results container | No |

### AudioRecording

| Field | Type | Description |
|-------|------|-------------|
| `contextItemId` | String | FK to ContextItem |
| `mediaId` | String? | FK to Media |
| `duration` | Float? | Duration in seconds |
| `format` | String? | Audio format (wav, mp3, etc.) |
| `sampleRate` | Int? | Sample rate in Hz |
| `channels` | Int? | Number of audio channels |
| `bitrate` | Int? | Bitrate in bps |
| `language` | String? | Language code |
| `sequenceNumber` | Int? | Order within recording session |

### SummaryMeta

One-to-one metadata for AI-generated summaries.

| Field | Type | Description |
|-------|------|-------------|
| `contextItemId` | String | FK to ContextItem (unique) |
| `aiModelId` | String? | Model used for generation |
| `promptTokens` | Int? | Input token count |
| `completionTokens` | Int? | Output token count |
| `totalTokens` | Int? | Total token count |
| `processingTimeMs` | Int? | Generation time |
| `contextItemIds` | String[] | Source context items used |

### NamedEntity

Medical entities extracted by NER.

| Field | Type | Description |
|-------|------|-------------|
| `contextItemId` | String | FK to ContextItem |
| `entityClass` | String? | Entity classification |
| `text` | String? | Original text span |
| `normalizedText` | String? | Standardized text |
| `confidence` | Float? | Confidence score |
| `startOffset` | Int? | Character start position |
| `endOffset` | Int? | Character end position |

### ContextItemVersion

Immutable content snapshots with diff support.

| Field | Type | Description |
|-------|------|-------------|
| `contextItemId` | String | FK to ContextItem |
| `versionNumber` | Int | Sequential version number |
| `content` | Text? | Full content at this version |
| `contentDiff` | Text? | Diff from previous version |
| `changeReason` | String? | Why the change was made |
| `changeSummary` | String? | Brief description |
| `changedBy` | String? | User who made the change |

---

## STT Domain: AI Models and Pipelines

### AiModel

Registry of AI models for speech-to-text and other ML tasks.

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Human-readable model name |
| `slug` | String | Unique identifier (referenced in pipeline YAML) |
| `description` | String? | Model description |
| `category` | ModelCategory | MULTI_MODAL, VISION, NLP, AUDIO, TABULAR, UNKNOWN |
| `taskType` | ModelTaskType | Specific task (80+ values) |
| `modelType` | ModelType | BASE_MODEL, FINETUNED_MODEL, QUANTIZED_MODEL, UNKNOWN |
| `source` | AiModelSource | HUGGINGFACE, GITHUB, MLFLOW, LOCAL |
| `sourceUri` | String? | Download URI |
| `sourceRevision` | String? | Version/commit reference |
| `format` | AiModelFormat | SAFETENSOR, ONNX, NEMO, PYTORCH |
| `memorySizeMb` | Float? | Memory requirement |
| `computeType` | String? | Required compute type |
| `downloadStatus` | AiModelDownloadStatus | NOT_DOWNLOADED, DOWNLOADING, DOWNLOADED, DOWNLOAD_FAILED |
| `localPath` | String? | Local file path when downloaded |
| `downloadedAt` | DateTime? | When downloaded |
| `fileSizeMb` | Float? | File size on disk |
| `checksum` | String? | Integrity hash |

**Unique constraint**: `@@unique([tenantId, slug])`

### AsrPipeline

ASR pipeline configuration referencing AI models by slug.

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Pipeline name |
| `slug` | String | Unique pipeline identifier |
| `description` | String? | Pipeline description |
| `configYaml` | Text? | Pipeline configuration in YAML (references models by slug) |

**Relations**: `TranscriptionJobs[]`

**Unique constraint**: `@@unique([tenantId, slug])`

### TranscriptionJob

Tracks batch and streaming transcription jobs.

| Field | Type | Description |
|-------|------|-------------|
| `type` | TranscriptionJobType | BATCH or STREAMING |
| `status` | TranscriptionJobStatus | QUEUED, PROCESSING, COMPLETED, FAILED, CANCELLED, DEAD |
| `pipelineId` | String | FK to AsrPipeline |
| `progress` | Float? | Completion percentage |
| `startedAt` | DateTime? | Processing start |
| `completedAt` | DateTime? | Processing end |
| `result` | Json? | Transcription output |
| `error` | Json? | Error details if failed |
| `retryCount` | Int | Number of retry attempts |
| `maxRetries` | Int | Maximum retries allowed |

---

## Prompt and DNA Writing Style Domain

### PromptTemplate

AI prompt templates with versioning.

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Template name |
| `description` | String? | Template description |
| `content` | Text | Prompt content |
| `category` | PromptTemplateCategory | SYSTEM, SUMMARY, DNA_ANALYSIS, CUSTOM |
| `variables` | Json? | Expected variables |
| `currentVersionNumber` | Int | Latest version |
| `departmentId` | String? | FK to Department (optional) |

**Relations**: `Department`, `Versions[]`

**Unique constraint**: `@@unique([tenantId, name])`

### PromptVersion

Immutable snapshots of prompt template changes.

### DnaWritingStyleReport

Doctor writing style analysis results.

| Field | Type | Description |
|-------|------|-------------|
| `doctorId` | String | FK to User |
| `reportData` | Json | Analysis data |
| `styleText` | Text? | Generated style description |
| `isLatest` | Boolean | Whether this is the latest report |
| `currentVersionNumber` | Int | Latest version |

**Relations**: `Doctor` (User), `Versions[]`

**Indexes**: `@@index([doctorId, isLatest])`

### DnaWritingStyleVersion

Immutable snapshots of DNA writing style changes.

### DnaUsageRecord / PromptUsageRecord

Tracks usage of DNA writing styles and prompt templates in consultations.

---

## Supporting Domains

| Schema File | Models | Description |
|-------------|--------|-------------|
| `department.prisma` | `Department` | Medical department with prompt configuration (`code`, `name`, `defaultSummaryTemplate`, prompt references, `promptConfig` JSON). Self-referential hierarchy. Unique: `@@unique([tenantId, code])` |
| `apikey.prisma` | `ApiKey` | API key management (`keyHash`, `keyPrefix`, `keyChecksum`, `keyType`, `keyStatus`, `scopes` JSON, `allowedIps` JSON, `rateLimit`, `expiresAt`, `userId` FK). Indexed on `keyHash`, `keyPrefix`, `keyStatus` |
| `audit.prisma` | `AuditLog` | Audit trail (`action` enum, `eventType`, `resourceType`, `resourceId`, `responsibleUserId`, `responsibleIp`, `success`, `data` JSONB, `previousData` JSONB, `correlationId`, `causationId`) |
| `media.prisma` | `Media` | File metadata (name, URI, MIME type, hash) |
| `notification.prisma` | `Notification`, `ResourceSubscription` | User notifications and resource subscription tracking |
| `webhook.prisma` | `Webhook`, `WebhookRunHistory` | Webhook endpoints and execution history |
| `tag.prisma` | `Tag` | Resource tagging |
| `globalSetting.prisma` | `GlobalSetting` | System-wide key-value settings |
| `fedl.prisma` | `FedlClient`, `FedlRound`, `FedlUpdate`, `FedlModelVersion` | Federated learning models and training rounds |

---

## Enumerations Reference

### Core Enums

| Enum | Values |
|------|--------|
| `ResourceStatusType` | ENABLED, DISABLED, ARCHIVED, DELETED |
| `PermissionAction` | MANAGE, CREATE, READ, LIST, UPDATE, DELETE, ARCHIVE, EXPORT |
| `PolicyScope` | GLOBAL, TENANT |
| `AuditAction` | CREATE, READ, UPDATE, DELETE, ARCHIVE, LOGIN, LOGOUT |
| `ResourceType` | User, Tenant, Role, Policy, Consultation, ContextItem, Media, Department, ApiKey, AuditLog, Tag, Notification, Webhook, PromptTemplate, DnaWritingStyleReport, ... (38 total) |

### Consultation Enums

| Enum | Values |
|------|--------|
| `ContextItemType` | AUDIO_RECORDING, WORKNOTE, RAW_SUMMARY, MODIFIED_SUMMARY, PRE_SUMMARY, NAMED_ENTITY, TRANSCRIPT, CASE_NOTE, ATTACHMENT |
| `ContextItemSource` | USER, AI, SYSTEM, TRANSCRIPTION |

### API Key Enums

| Enum | Values |
|------|--------|
| `ApiKeyStatus` | ACTIVE, INACTIVE, REVOKED, EXPIRED |
| `ApiKeyType` | SDK, WEBHOOK, INTEGRATION, SERVICE_ACCOUNT |

### AI/ML Enums

| Enum | Values |
|------|--------|
| `ModelCategory` | MULTI_MODAL, VISION, NLP, AUDIO, TABULAR, UNKNOWN |
| `ModelType` | BASE_MODEL, FINETUNED_MODEL, QUANTIZED_MODEL, UNKNOWN |
| `AiModelSource` | HUGGINGFACE, GITHUB, MLFLOW, LOCAL |
| `AiModelFormat` | SAFETENSOR, ONNX, NEMO, PYTORCH |
| `AiModelDownloadStatus` | NOT_DOWNLOADED, DOWNLOADING, DOWNLOADED, DOWNLOAD_FAILED |
| `ModelTaskType` | 80+ values covering multimodal, vision, NLP, audio, and tabular tasks |

### Job Enums

| Enum | Values |
|------|--------|
| `TranscriptionJobType` | BATCH, STREAMING |
| `TranscriptionJobStatus` | QUEUED, PROCESSING, COMPLETED, FAILED, CANCELLED, DEAD |
| `ModelJobStatus` | SCHEDULED, RUNNING, COMPLETED, FAILED, CANCELLED |

### Other Enums

| Enum | Values |
|------|--------|
| `PromptTemplateCategory` | SYSTEM, SUMMARY, DNA_ANALYSIS, CUSTOM |
| `NotificationType` | STANDARD, LINK, ACTION |
| `WebhookRunStatus` | SUCCESS, FAILED |
| `ResourceSubscriptionType` | CREATOR, SUBSCRIBER, MENTIONED |
| `ValueType` | String, Integer, Float, Double, Decimal, Boolean, Json, Date, DateTime, Array, Uuid, Binary, Enum, Hstore, Inet, Citext, Interval |

---

## Prisma Schema Configuration

### Datasource

```prisma
datasource db {
  provider = "postgresql"
  schemas  = ["public", "core"]
}
```

### Generator

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../../generated/core-prisma-client"
  previewFeatures = [
    "fullTextSearchPostgres",
    "postgresqlExtensions",
    "relationJoins",
    "views",
    "typedSql"
  ]
}
```

### Schema Files (18 total)

| File | Models |
|------|--------|
| `schema.prisma` | Datasource + generator configuration |
| `enums.prisma` | All enumeration definitions |
| `user.prisma` | User, UserProfile, UserSettings, UserGroup, UserRoleAssignment, UserGroupRoleAssignment, UserMedia |
| `tenant.prisma` | Tenant |
| `rbac.prisma` | Role, Policy, RolePolicy |
| `consultation.prisma` | Consultation, ContextItem, AudioRecording, SummaryMeta, NamedEntity, ContextItemVersion |
| `stt.prisma` | AsrPipeline, AiModel, TranscriptionJob |
| `department.prisma` | Department |
| `apikey.prisma` | ApiKey |
| `audit.prisma` | AuditLog |
| `media.prisma` | Media |
| `notification.prisma` | Notification, ResourceSubscription |
| `webhook.prisma` | Webhook, WebhookRunHistory |
| `tag.prisma` | Tag |
| `globalSetting.prisma` | GlobalSetting |
| `dna-writing-style.prisma` | DnaWritingStyleReport, DnaWritingStyleVersion, DnaUsageRecord, PromptUsageRecord |
| `prompt-template.prisma` | PromptTemplate, PromptVersion |
| `fedl.prisma` | FedlClient, FedlRound, FedlUpdate, FedlModelVersion |

All models use `@@schema("core")`.

---

## Multi-Tenancy Model

Every tenant-aware entity includes a `tenantId` field with a default value pointing to the seed tenant (`50000000-0000-0000-0000-000000000000`).

Isolation is enforced at multiple levels:

1. **CASL Policy Conditions** — RBAC rules inject `{ tenantId: "${context.tenantId}" }` into ability checks
2. **Prisma Extension** — the `tenantScopeFilter` extension injects `tenantId` into Prisma `where` clauses (and write `data`) for every tenant-scoped model
3. **Unique Constraints** — Many models use `@@unique([tenantId, ...])` to prevent cross-tenant collisions (e.g., department codes, pipeline slugs, prompt names)

Users with global role assignments (`tenantId: null` in `UserRoleAssignment`) have cross-tenant access (Super Admin only).

---

## Indexing Strategy

### Standard Indexes

- Every tenant-aware model has `@@index([tenantId])` for multi-tenant queries
- Named using pattern: `ModelName_fieldName_idx`

### Composite Indexes

Used for common query patterns:
- `Consultation`: `[tenantId, doctorId]`, `[tenantId, departmentId]`, `[tenantId, patientId]`
- `ContextItem`: `[consultationId, type]`, `[consultationId]`, `[type]`
- `ApiKey`: `[keyHash]`, `[keyPrefix, keyStatus]`, `[userId]`, `[expiresAt]`
- `DnaWritingStyleReport`: `[doctorId, isLatest]`
- `AuditLog`: `[tenantId, responsibleUserId]`, `[resourceType, resourceId]`

### Unique Constraints

Tenant-scoped uniqueness enforced where applicable:
- `Role`: `@@unique([name])`
- `Policy`: `@@unique([name])`
- `Department`: `@@unique([tenantId, code])`
- `AsrPipeline`: `@@unique([tenantId, slug])`
- `AiModel`: `@@unique([tenantId, slug])`
- `PromptTemplate`: `@@unique([tenantId, name])`

---

## Related Documentation

- [Database Package (README)](./README.md) — Client configuration, soft-delete extension, migration workflow, seeding
- [DDD Patterns](./02_DDD_PATTERNS.md) — Entity hierarchy, repositories, mappers, factories, query builder
- [Seed Data Reference](./seed-data.md) — Seed constants, execution order, test fixtures
