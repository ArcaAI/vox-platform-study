# HOPE Data & Domain Model

Last updated: 2026-07-04

Domain model reference derived from `packages/database/src/prisma/db_main/*.prisma` (Prisma 7, PostgreSQL, all models in the `core` schema) and the DDD layer in `packages/domains`. Companion documents: [overview.md](./overview.md), [../traceability-matrix.md](../traceability-matrix.md).

---

## 1. Schema Layout

- The Prisma schema is **split by domain file** under `packages/database/src/prisma/db_main/` (`schema.prisma` holds only the datasource/generator; models live in `tenant.prisma`, `consultation.prisma`, `harness.prisma`, etc.).
- Datasource: PostgreSQL with schemas `public` + `core` and the `vector` (pgvector) extension declared; every model is annotated `@@schema("core")`.
- Generated client output: `packages/database/src/generated/core-prisma-client` (Prisma 7 `prisma-client` provider; preview features: full-text search, pg extensions, relation joins, views, typed SQL).
- Connection: driver adapter in `packages/database/src/client.ts` (`PRISMA_PG_MAX` pool size, default 5). Prod/staging splits `DATABASE_URL` (PgBouncer 6432, transaction mode) from `DIRECT_URL` (un-pooled, used by Prisma Migrate via `resolveMigrationUrl` in `src/migration-url.ts`).
- For each model, `packages/domains` carries a generated entity / factory / mapper / model / repository quartet under `src/{entities,factories,mappers,models,repositories}/generated/core/`, plus handwritten repositories (e.g. `policy`, `role`, `role-policy`).

## 2. Standard Model Field Template

Every business model follows this column template (enforced by convention and code generators in `@arcaai/tools`):

| Section | Columns | Notes |
|---|---|---|
| Meta | `metaData` (`_metadata` JsonB), `version` (`_version`, default 1), `id` (uuid v7) | `version` drives optimistic locking → strong ETag / `If-Match` (428 on annotated routes) |
| Tenancy | `tenantId String` (indexed, no FK) | See §3 |
| Business fields | model-specific | |
| Resource status | `resourceStatus` (default `ENABLED`), `resourceStatusUpdatedAt/By` | Soft-delete/lifecycle — see §4 |
| Audit | `createdBy` (default system user `60000000-…`), `updatedBy`, `createdAt`, `updatedAt` | |
| Tags | `tags String[]` | where applicable |
| Indexes | `@@index`/`@@unique`, tenant-leading composites | e.g. `[tenantId, doctorId]` (TASK-305) |

Exceptions: high-volume/immutable rows (`AudioRecording`, `SummaryMeta`, `NamedEntity`, `HarnessAuditEvent`) omit parts of the template; `HarnessAuditEvent` is append-only WORM (no version/updatedAt/resourceStatus; UPDATE/DELETE revoked at the DB level, hash-chained).

`ResourceStatusType`: `ENABLED | DISABLED | SUSPENDED | ARCHIVED | DELETED` (SUSPENDED/ARCHIVED are operator hold/retire states with restore paths — TASK-387).

## 3. Multi-Tenancy Mechanics

- Every business row carries `tenantId` (string UUID, **no FK to Tenant** — keeps cross-schema writes cheap and allows the reserved system tenant).
- Reserved system tenant `00000000-0000-0000-0000-000000000000` owns platform-wide rows (system RBAC policies, system AI models, global settings namespace).
- Request flow: `UnifiedAuthGuard` resolves the user → CLS (`nestjs-cls`) stores `tenantId` → the **`tenantScopeFilter` Prisma client extension** (`packages/database/src/extensions/tenant-scope.ts`, wired by `TenantContextProviderModule` at bootstrap) injects tenant predicates into every query. Without CLS (CLI/seeds) it passes through as global-admin — the safe default for offline scripts.
- Defense in depth: `TenantOwnedResourceInterceptor` (+ `TenantOwnedResourceSseGuard` for `@Sse()` routes) re-asserts ownership per-request with a 404-over-403 posture; `BaseService` exposes `assertEqualTenants` / `assertParentInScope` / `assertUserBelongsToTenant`; tenant-leading composite indexes keep tenant-scoped scans efficient; cross-tenant regression suites live in `apps/api/tests/e2e/task-307-*` and `tests/cross-tenant/`.
- Tenant commercial plan: `Tenant.plan` (`ENTERPRISE | PRO | TRIAL | STARTER`, nullable) + `trialEndsAt`; entitlements resolve limits per plan with per-tenant overrides.

## 4. Soft-Delete Convention

- No hard deletes: `repository.softDelete(id)` sets `resourceStatus: DELETED` (+ `resourceStatusUpdatedAt/By`).
- The extended Prisma client (`getExtendedPrismaClient` from `@arcaai/database`) filters `DELETED` rows by default; the unscoped client (`getPlatformAdminPrismaClient_Unscoped`) bypasses filtering but is lint-banned outside seeds, database scripts, and test fixtures.
- Lifecycle transitions (`suspend`/`archive`/`restore` on tenants, enable/disable elsewhere) run through entity lifecycle methods so change tracking and sys-events fire.

## 5. Entity Groups

Grouped by owning module (schema file → API/service ownership). "Module" names reference `apps/api/src/modules/*` and `packages/applications/src/services/*`.

### 5.1 Tenancy & platform configuration

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `Tenant` | Customer organization; commercial plan + trial clock | referenced by `tenantId` everywhere (no FKs) | `tenant` |
| `TenantFrontendConfig` | One row per tenant — default frontend audio pipeline (ASR model, noise-cancel, VAD, diarization, capture/transcription modes) | `tenantId` unique | `tenant-frontend-config` |
| `GlobalSetting` | Namespaced key-value settings (typed via `ValueType`); secrets envelope-encrypted (`encryptedValue` via Vault Transit) | unique `[tenantId, name, key]` | `global-setting`, `globalSetting` service |
| `Department` | Clinical departments; prompt-config slots for department-default agents | ← `Consultation.departmentId`, ← `UserDepartment` | `department` |
| `PlanEntitlement` / `TenantEntitlement` / `TenantUsageMeter` | Plan-level entitlement matrix, per-tenant overrides/kill-switches, usage metering (`UsageMeterMetric`) | keyed by plan / tenantId | `entitlements`, `metering` |

### 5.2 Identity & access

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `User` | Platform user (clinician, admin); bcrypt password hash | → `UserSettings`, `UserProfile`, `UserMedia`, `UserDepartment`, `UserRoleAssignment`; ← `Consultation.doctorId` | `user` |
| `UserSettings` / `UserProfile` / `UserMedia` | Per-user namespaced settings, profile data, avatar/media links | → `User`, `Media` | `user` |
| `UserDepartment` | User ↔ department membership | → `User`, `Department` | `user` |
| `UserRoleAssignment` | User ↔ role binding (tenant-scoped) | → `User`, `Role` | `user`, `rbac` |
| `UserVoiceProfile` | Speaker-enrollment state; embedding lives in Qdrant | → `User` | `voice-profile` |
| `PasswordResetToken` | Hashed single-use reset tokens (forgot-password flow) | → `User` | `user` (password-reset controllers) |
| `ApiKey` | Hashed API keys (HMAC-SHA256 + pepper), scoped types/status, expiry enforcement | owner user/tenant | `api-key` |
| `Role` / `Policy` / `RolePolicy` | Policy-based RBAC: roles aggregate policies (`PermissionAction` × `ResourceType`, `PolicyScope`) | `RolePolicy` join; ← `UserRoleAssignment` | `rbac`, `authorization` |

### 5.3 Consultation & clinical content (core clinical domain)

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `Consultation` | Top-level encounter: patient (external id), doctor, department, visit chain, typed lifecycle `ConsultationStatus` (`OPEN → RECORDING → DRAFT_PENDING_SENSORS → PENDING_REVIEW → SIGNED / CLOSED / REOPENED`) | → `User` (doctor), `Department`, self (parent/child chain), ← `ContextItem`, `Highlight` | `consultation` |
| `ContextItem` | Polymorphic content container (`ContextItemType`: `AUDIO_RECORDING`, `TRANSCRIPT`, `WORKNOTE`, `CASE_NOTE`, `PRE_SUMMARY`, `RAW_SUMMARY`, `MODIFIED_SUMMARY`, `SIGNED_NOTE`, `NAMED_ENTITY`, `ATTACHMENT`); clinical text stored as Vault-Transit ciphertext (`encryptedContent`) | → `Consultation`; ← `AudioRecording`, `SummaryMeta`, `NamedEntity`, `ContextItemVersion`; soft refs `mediaId`, `dnaWritingStyleId` | `consultation` (context service) |
| `ContextItemVersion` | Append-only version history incl. clinician attestation (`attestedAt/By`, `attestationHash` → WORM audit) | → `ContextItem`; unique `[contextItemId, versionNumber]` | `consultation` |
| `AudioRecording` | Audio metadata per recording (duration/format/sampleRate); raw vs processed media refs (dual capture) | → `ContextItem`; soft refs `mediaId`, `rawMediaId`, `processedMediaId` → `Media` | `consultation`, `streaming` |
| `SummaryMeta` | 1:1 AI-generation provenance for summary items: model/prompt/tokens, harness sensor scores, gate decision, two-phase assurance timestamps, encrypted citations map / guardrail decisions | → `ContextItem` (unique) | `consultation` (summary service), harness |
| `NamedEntity` | NER results with ontology codes (`umlsCui`, `snomedCode`, `rxnormCode`, `icdCode`, `loincCode`), transcript span provenance, encrypted text | → `ContextItem` (container + transcript provenance relations) | `consultation`, nlp |
| `Highlight` | Doctor-authored W3C-annotation highlights (dual selectors), encrypted quote/note | → `Consultation`; soft ref `sourceContextItemId` | `consultation` (highlight service) |
| `Tag` | Free tags attached to summaries/items | referenced by tag arrays / tag service | `consultation` (tag service) |

### 5.4 Speech-to-text & AI pipelines

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `AsrPipeline` / `AsrPipelineVersion` | Named ASR pipeline configs (model chain, VAD/diarization settings) with versioning | version → pipeline | `pipeline` (`audio/pipelines`), stt-v2 config reader |
| `AiModel` | AI model registry (source/format/download status; STT + LLM entries) | referenced by pipelines / SummaryMeta.aiModelId | `ai-model` |
| `TranscriptionJob` | Batch/streaming transcription job lifecycle (`TranscriptionJobStatus`, `TranscriptionJobType`, `TranscriptionMode`) | soft refs consultation/media | `streaming`, stt-v2 worker |

### 5.5 Clinical documentation harness & evaluation

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `HarnessPolicy` / `HarnessPolicyChange` | Versioned harness gate/sensor policy + change history | change → policy | `harness-admin`, `harness-policy` service |
| `PipelinePolicy` / `PipelinePolicyChange` | Realtime-pipeline toggle cascade (platform → tenant scope) | change → policy | `pipeline-policy-admin` |
| `GoldenSet` / `GoldenCase` | Curated evaluation datasets | case → set | `eval` service |
| `EvalRun` / `EvalScore` | Eval executions and per-case sensor scores | score → run/case | `eval` service |
| `HarnessAuditEvent` | Append-only WORM audit of harness actions (generate/gate/attest), hash-chained, encrypt-before-hash | soft refs consultation / contextItemVersion | `harness-audit` service |
| `KnowledgeDocument` / `KnowledgeChunk` | Institutional-RAG ingestion tracking (status; chunk descriptors — vectors live in Qdrant) | chunk → document | `knowledge` service, harness `/knowledge/ingest` |

### 5.6 Prompts & writing style

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `PromptTemplate` / `PromptVersion` | Prompt library ("agent instructions"): category/scope/status, versioning, department-default assignment | version → template; department prompt-config slots | `prompt-management` |
| `DnaWritingStyleReport` / `DnaWritingStyleVersion` | Per-doctor writing-style ("DNA") reports + versions used to personalize generation | version → report; `ContextItem.dnaWritingStyleId` soft ref | `dna-writing-style` |
| `DnaUsageRecord` / `PromptUsageRecord` | Usage tracking of DNA styles / prompts in generations | soft refs | `dna-writing-style`, `prompt-management` |

### 5.7 Storage & media

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `Media` | Object-storage metadata (name/uri/mime/size/hash); **bytes live in MinIO/S3, not Postgres** | → `TenantBucket`; ← `UserMedia`, referenced by `AudioRecording`/`ContextItem` | `storage`, `media` service |
| `TenantBucket` | Per-tenant bucket registry (`TenantBucketType`, `TenantBucketPurpose`) | ← `Media` | `tenant-bucket` |
| `TenantStorageConfig` | Per-tenant storage provider/topology config (`StorageProviderType`, `StorageTopologyType`) | tenant-scoped | `tenant-storage-config` |
| `StorageAccessKey` | Scoped storage access credentials | tenant-scoped | `storage-access-key` |

### 5.8 Audit, events & notifications

| Model | Purpose | Key relations | Owning module |
|---|---|---|---|
| `AuditLog` | Event-driven audit trail (actor, resource, action, correlation/causation ids); payloads envelope-encrypted (cached DEK + AES-256-GCM, DEK wrapped by Vault Transit) | resource refs by type/id | `audit-log`, `auditLog` service |
| `Notification` / `ResourceSubscription` | In-app notifications and resource subscriptions (`ResourceSubscriptionType`) | user/resource refs | `notification`, `resourceSubscription` services |
| `Webhook` / `WebhookRunHistory` | Tenant webhooks + delivery history (`WebhookRunStatus`) | history → webhook | `webhook` service |

### 5.9 Federated learning (dormant)

| Model | Purpose | Status |
|---|---|---|
| `FedlClient` / `FedlRound` / `FedlUpdate` / `FedlModelVersion` | Federated-learning round/update/model tracking | Schema present; **no `apps/` service currently consumes it** (legacy of the removed FedL/MLflow apps — kept for future re-introduction) |

## 6. Sys-Event & Audit Mechanics

Verified against `packages/applications/src/services/sysEvent/` and `services/auditLog/`.

1. Every service mutation calls `BaseService.broadcastSysEvent(...)` (e.g. `ResourceCreated` / `ResourceUpdated` / `ResourceDeleted`).
2. `SysEventService` enqueues two BullMQ jobs:
   - `JobQueue.AuditLog` → `AuditLogProcessor` persists an `AuditLog` row (envelope-encrypted payloads; correlation id from CLS; READ-event throttling via `event-throttle.service`).
   - `JobQueue.SysEvent` → downstream fan-out (webhooks, resource subscriptions/notifications).
3. `AuditRetentionServiceModule` runs a scheduled purge that bounds `AuditLog` growth (TASK-336 OB-05).
4. Impersonation actions are additionally captured by the `ImpersonationAuditInterceptor` at the gateway.
5. Clinical attestation events bypass this pipeline and write **synchronously** to `HarnessAuditEvent` (append-only, hash-chained, UPDATE/DELETE revoked): the `ContextItemVersion.attestationHash` anchors the signed note to its WORM event.

## 7. PHI Encryption (Data Encryption Initiative)

- Free-text clinical content is **not stored in plaintext**. TASK-369 Phase 6 dropped the plaintext columns; Vault Transit (key `hope-phi`) ciphertext columns are the system of record: `ContextItem.encryptedContent`, `ContextItemVersion.encrypted{Content,ContentDiff,ChangeSummary,FieldChanges}`, `NamedEntity.encrypted{Text,NormalizedText,Metadata}`, `Highlight.encrypted{Exact,Prefix,Suffix,Note}`, `SummaryMeta.encrypted{CitationsMap,GuardrailDecisions}` — each with a `keyVersion`/`contentKeyVersion` column for rotation.
- Coded/ontology columns (`snomedCode`, `icdCode`, etc.), offsets, and scores remain plaintext (non-free-text, needed for queries).
- `GlobalSetting.encryptedValue` holds Transit-encrypted secrets (key `hope-globalsetting`).
- High-volume `AuditLog` uses local envelope encryption (per-process DEK wrapped once by Transit) instead of per-row Vault calls; `HarnessAuditEvent` encrypts before hashing so the WORM chain covers ciphertext.
- Reads decrypt on the fly into transient entity fields; media bytes rely on object-storage SSE + TLS instead of field encryption (see `Media` model comments).

## 8. Data Lifecycle — What Lives Where

| Store | Data | Notes |
|---|---|---|
| PostgreSQL (`core` schema) | All relational/business data listed above; Temporal state in dedicated `temporal` / `temporal_visibility` databases on the same instance (dev) | PHI columns Transit-encrypted; LUKS at rest in prod; PgBouncer transaction pooling in prod |
| MinIO / S3 | Audio recordings (raw + processed), generated audio, document attachments, backups | Buckets: `recordings`, `generated-audio`, `documents`, `backups` (+ legacy `mlflow`); per-tenant buckets via `TenantBucket`; referenced by `Media.uri`; SSE (KES/KMS) in prod |
| Qdrant | Speaker embeddings (`stt_speaker_embeddings`, 512-dim wespeaker), institutional-RAG knowledge chunks (dense + sparse), prompt/DNA writing-style collections | Row-side tracking in `UserVoiceProfile`, `KnowledgeDocument`/`KnowledgeChunk`; `ContextItem.qdrantSynced` flags semantic-search sync |
| Redis | BullMQ queues (DB 0), cache + rate-limit counters (DB 1), STT audio/control/result streams (DB 2), SMR task streams (DB 3), Celery (DB 4, legacy), Dramatiq broker (DB 5) | Ephemeral; persistence disabled in dev so no PHI lands on disk; live-doc session stats TTL 300 s |
| Vault | Static secrets (KV v2 `secret/hope/*`), Transit keys (`hope-globalsetting`, `hope-phi`), dynamic PG credentials (database engine) | HA Raft cluster with Transit auto-unseal in prod; `SECRETS_PROVIDER=env` default in local dev |
| Retention | `AuditLog` — scheduled purge (audit-retention service); STT streaming sessions/resume buffers — bounded in-memory + Redis TTL; everything else — soft-deleted, never hard-deleted | `HarnessAuditEvent` and `ContextItemVersion` are append-only by design (clinical record) |
