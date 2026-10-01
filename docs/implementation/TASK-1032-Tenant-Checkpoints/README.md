# TASK-1032 — Tenant Checkpoints (backup, download, upload, restore)

| | |
|---|---|
| **Status** | Pending — spec written, awaiting owner review before the implementation plan |
| **Type** | feature (full-stack: database → domain → services → API → console → infra) |
| **Branch** | `dev-2.2` (active) |
| **Rules** | 00, 01, 02, 03, 04, 05, 09, 13 (+07/10/11), 14 |
| **Scope of v1** | Restore purpose **A** — roll back the SAME tenant in place on the SAME deployment |
| **Later** | **B** cross-deployment move/copy, **C** clone into a new tenant (format is designed for both — §4.6) |

---

## 1. Requirement Analysis

Owner request (2026-10-01):

- A **tenant checkpoint** is a backup of one tenant: all users, agents, workflows, tenant-specific
  settings, all logs and data.
- Platform admins and tenant admins can **create** a checkpoint and **download** it.
- Platform admins and tenant admins can **restore** from a checkpoint and **upload** a checkpoint.
- All three restore purposes (A in place, B cross-deployment, C clone) must eventually be supported;
  **A ships first**.

### 1.1 Owner decisions recorded during design (2026-10-01)

| Id | Decision |
|---|---|
| D-1 | Restore purposes A, B and C are all in scope for the product; v1 delivers **A**. The archive format must carry what B/C need so no re-export is required later. |
| D-2 | **Selective by category** (A1). A checkpoint always captures everything; at restore time the admin picks categories: *Configuration & content*, *Users & access*, *Clinical data*. |
| D-3 | **Logs are captured, never rolled back.** Restore only appends a `TenantRestored` audit event. |
| D-4 | **P3 sealing** — platform-sealed (Vault-wrapped data key + Ed25519 signature) **plus** an optional admin passphrase (Argon2id) so the holder can open the file offline. Restore always requires a valid platform signature; a passphrase never authorises a restore. |
| D-5 | Permission matrix in §3.6 — notably **Clinical-data restore is platform-admin only**; everything else is open to a tenant admin on their own tenant with break-glass confirmation. |
| D-6 | **M1** — media (audio + attachments) included by default with a per-checkpoint toggle; BYO-storage (DEDICATED) tenants get pointers only. |
| D-7 | **No scheduled checkpoints in v1.** Manual only. Retention via settings. |
| D-8 | Engine approach **1**: declarative model registry + Postgres `COPY` export + set-based staging/reconcile restore, with a CI completeness gate. |
| D-9 | A **separate `checkpoint-worker` process** (gateway image, own entrypoint and Deployment). |
| D-10 | **Hard tenant lock (423)** for the duration of a restore. |
| D-11 | Restore re-inserts a **missing** global `User` from the (signed) checkpoint but never modifies an existing one; **revoked credentials are never revived**. |
| D-12 | Every restore first takes an automatic **safety checkpoint**, so a restore is itself undoable. |

### 1.2 Success criteria

1. An admin can create a checkpoint of a tenant, see its progress, and download a single sealed file.
2. The file cannot be read without the platform key or the passphrase, and cannot be altered without
   the restore refusing it with a named reason.
3. An admin can upload a sealed file produced by this deployment for this tenant and restore from it.
4. A restore of any subset of categories returns those categories to exactly the checkpoint state,
   leaves every other category and every other tenant byte-identical, and never rewinds the audit trail.
5. A failed restore changes nothing in the database; a successful one can be undone from its
   safety checkpoint.
6. A new Prisma model that nobody classified for checkpoints fails CI.

---

## 2. Current State Evaluation (verified 2026-10-01 against `dev-2.2@579be70c7`)

No tenant backup, export or `pg_dump` path exists. Platform DR is whole-cluster pgBackRest only.

### 2.1 Relational data

- **103 Prisma models**, all in schema `core`. `TENANT_SCOPED_MODELS` holds 86
  (`packages/database/src/extensions/tenant-scope.ts:52`), `SYSTEM_SHARED_READ_MODELS` 14 (`:419`).
  `ApiKey`, `ServiceAccount`, `TenantEntitlement` carry `tenantId` but are intentionally unscoped.
- **`User` is global** (`user.prisma:57`, no `tenantId`, `username`/`externalId` globally unique).
  Tenant membership is `UserRoleAssignment` + `UserDepartment`. Super admins are `User` rows too.
- Rows reached only through a parent FK: `UserProfile`/`UserSettings`/`UserMedia`/`PasswordResetToken`
  (→ `User`), `WebhookRunHistory` (→ `Webhook`), `RolePolicy` (→ `Role` + global `Policy`).
- **Mixed models** hold SYSTEM rows next to tenant rows (`AiModel`, `AiProviderConnection`,
  `AiRoutingPolicy`, `GlobalSetting`, `HarnessPolicy`, `RateLimitRule`, `WorkflowInvariantRule`,
  `McpServer`, `TenantStorageConfig`, `Role`). A checkpoint exports only `tenantId = <tenant>`.
- Hard FKs from tenant rows to SYSTEM rows: `Agent.modelId`, `AgentModelFallback.modelId`,
  `AiRoutingPolicy.modelId/providerConnectionId`, `UserRoleAssignment.roleId` (built-in roles).
- **Immutability triggers** (`BEFORE UPDATE OR DELETE`, none on INSERT):
  `workflow_definition_immutability_guard`, `agent_immutability_guard`,
  `agent_model_fallback_immutability_guard`, `agent_assignment_change_worm_guard`,
  `document_template_version_immutability_guard`. Published content cannot be overwritten — restore
  must **reconcile** (retire + update mutable columns + insert), never delete-and-reinsert.
- **Partial unique indexes** that a restore can collide with: `Agent_tenant_slug_active_unique`,
  `UserVoiceProfile_userId_active_unique`, `ConsentGrant_tenant_patient_purpose_active_key`,
  `Consultation_encounterKey_uq`, `GlobalSetting` `(tenantId,key)`.
- **`HarnessAuditEvent`** is a per-tenant hash chain over ciphertext (`harnessAuditHash.ts`) — must
  be preserved byte-identical; it is a log, so it is never restored anyway.
- The WORM `REVOKE UPDATE/DELETE` the code comments describe did not survive the 2026-08-17 squash
  (`20260819120000_task_733…`); append-only is enforced by the app layer and the triggers only.
- No hypertables, no partitioning, no RLS. One pgvector column: `UserVoiceProfile.embedding`.
- Largest tables: `AuditLog`, `AiUsageEvent`, `AgentTrajectoryStep`, `WorkflowRun`,
  `TranscriptSegment`, `KnowledgeChunk`, usage rollups, `HarnessAuditEvent`.

### 2.2 Encryption

- Vault Transit keys are **shared, not per-tenant**: `hope-phi` (≈20 PHI columns, plus the `AuditLog`
  envelope DEK) and `hope-globalsetting` (`GlobalSetting.encryptedValue`,
  `AiProviderConnection.encryptedApiKey`, `TenantIdentityProvider.encryptedSecretRef`). Ciphertext
  is `vault:vN:` with a `keyVersion` column. Same-Vault restore (A) keeps ciphertext as-is.
- Environment-bound, non-Transit: `WorkflowWebhookSecret.encryptedSecret` (AES-GCM from
  `WEBHOOK_SECRET_PEPPER`), peppered hashes on `ApiKey`, `ServiceAccount`, `StorageAccessKey`,
  `Webhook`. Valid on the same deployment; a B problem.
- `VaultSecretsProvider` (`packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts:588-640`)
  has `encrypt`/`decrypt`/`decryptBatch` with a named key, **no `sign`/`verify`**.
- Vault kv is read-only to the app (`hope-app.hcl`); `credentialsRef`/`authRef` are pointers only.

### 2.3 State outside Postgres

- **Object storage**: each tenant has two system buckets `hope-<slug>-<tenantKey>` (`attachments`,
  `recordings`) plus custom buckets; `TenantBucket` rows own them, `Media` rows point at objects.
  DEDICATED (BYO) storage lives in the tenant's own account. Harness claim-check blobs live in the
  shared `harness-claim-check` bucket, content-addressed, reachable from `WorkflowRun.resultRef` and
  `AgentTrajectoryStep.payloadRef`. `hope-backups` is the platform pgBackRest bucket — not for this.
- **Qdrant**: one shared `knowledge_chunks` collection, tenant payload filter; vectors are derivable
  from `KnowledgeChunk.encryptedText` → re-index on restore, never captured.
- **Temporal**: run results are persisted to Postgres; in-flight state is not captured.
- **Redis**: cache/transient only (sessions, rate limits, BullMQ state). Kill-switches are `GlobalSetting`.

### 2.4 Platform surfaces to reuse

| Need | Exists at |
|---|---|
| Break-glass (password + typed name) | `packages/applications/src/services/rbac/breakGlass.ts`, `BreakGlassDto` (`apps/api/src/modules/rbac/dto/policy.dto.ts:100`) |
| Own-tenant pinning | `apps/api/src/shared/tenant-scope.ts` (`assertTenantInScope`, `resolveScopedTenantId`) |
| Tenant-pinned CASL subject | `seed/01-policy.ts` `tenant-full-access` (`conditions: { tenantId: '${context.tenantId}' }`) |
| Durable long-running job (heartbeat, cancel, DB-row state) | `packages/applications/src/services/ai-model/publish/ai-model-download.processor.ts` |
| Separate Node worker entrypoint | `apps/api/src/model-publisher.main.ts`, `pnpm publisher:dev` |
| Lock-protected sweep | `packages/applications/src/services/tenant-bucket/retention/tenant-storage-purge.service.ts` |
| Storage bypass for gated buckets | `BlobStorageProviderFactory` (as the purge service uses it) |
| Global maintenance 503 (no per-tenant logic) | `apps/api/src/interceptors/maintenance.interceptor.ts` |
| Console blob download | `apps/admin-console/src/shared/api/http.ts:250` `getBlob()` |
| Console import dialog | `apps/admin-console/src/features/workflow-studio/components/import-definition-dialog.tsx` |
| Tenant status SUSPENDED | exists but **not enforced** on the data plane — not usable as a lock |

---

## 3. Design

### 3.1 Components

**Data** (`packages/database`, domain trio in `packages/domains`)

`TenantCheckpoint` (tenant-scoped, OCC-written):

| Field | Notes |
|---|---|
| `label`, `kind` | `kind`: `MANUAL` \| `SAFETY` |
| `origin` | `CREATED` \| `UPLOADED` |
| `status` | `PENDING` → `RUNNING` → `READY` \| `FAILED` \| `CANCELLED`; uploads start at `UPLOADING` |
| `includesMedia`, `passphraseProtected` | |
| `objectKey`, `sizeBytes`, `manifestDigest` | in bucket `hope-tenant-checkpoints` |
| `schemaFingerprint`, `sourceDeploymentId`, `formatVersion` | |
| `manifestSummary` (Json) | per-table column list + row count — lets the API answer `SCHEMA_INCOMPATIBLE` synchronously |
| `heartbeatAt`, `cancelRequestedAt`, `failureReason`, `failureDetail` | durable job state (Redis is not durable) |
| `expiresAt` | from retention settings |
| `uploadId` | S3 multipart id while `UPLOADING` |

`TenantCheckpointRestore` (tenant-scoped): `checkpointId`, `categories` (enum array), `reason`,
`status` (`PENDING` → `LOCKING` → `SAFETY_CHECKPOINT` → `VERIFYING` → `RECONCILING` → `POST_COMMIT`
→ `COMPLETED` \| `COMPLETED_WITH_WARNINGS` \| `FAILED`), `safetyCheckpointId`, `counts` (Json, per
model: inserted/updated/retired), `warnings` (Json), `heartbeatAt`, `lockAcquiredAt`, `lockReleasedAt`,
`requestedBy`.

`ResourceType.TenantCheckpoint` and `ResourceType.TenantCheckpointRestore` in BOTH `audit.prisma`
(+ `ALTER TYPE … ADD VALUE` migration) and `packages/domains/src/enums/generated/ResourceType.ts`.

**Engine** — `packages/applications/src/services/tenant-checkpoint/`

| Dir | Responsibility |
|---|---|
| `registry/` | one descriptor per Prisma model (§3.4), completeness + trigger-parity + category-snapshot tests |
| `archive/` | `.hcp` writer/reader: header, tar, gzip, chunked AES-256-GCM, trailer (§3.2) |
| `sealing/` | data-key wrap/unwrap (Vault `hope-checkpoint`), sign/verify (Vault `hope-checkpoint-sign`), Argon2id passphrase wrap |
| `store/` | `checkpoint-store.ts` — the only code touching the checkpoint bucket: multipart write stream, read stream, presigned GET, presigned multipart parts, complete, abort, delete |
| `export/` | export processor, retention sweeper, stale-export sweeper |
| `restore/` | restore processor, staging loader, reconcile SQL generator, post-commit steps, stale-restore sweeper |
| `lock/` | `tenant-lock.service.ts` — lock state, per-process cache, Redis invalidation channel `tenant-lock:invalidate` |
| root | `ITenantCheckpointService`, `tenant-checkpoint.service.ts`, DTOs, DTO mapper, module |

**Worker** — `apps/api/src/checkpoint-worker.main.ts` (mirrors `model-publisher.main.ts`), queues
`JobQueue.TenantCheckpointExport` and `JobQueue.TenantCheckpointRestore`, concurrency 1 each. Root
script `checkpoint:dev` → `./scripts/dev-service.sh checkpoint-worker`; added to `stack:dev`.
DB access for `COPY` uses a direct `pg` connection on `DIRECT_URL` (Prisma cannot `COPY`).

**Platform**

- Vault Transit keys `hope-checkpoint` (`aes256-gcm96`, non-exportable) and `hope-checkpoint-sign`
  (`ed25519`, public key exportable) — `dev-init.sh`, `hope-app.hcl`, cluster policy.
- `ISecretsProvider` gains `sign(keyName, data)` / `verify(keyName, data, signature)`; Vault
  implements them; non-Vault providers throw `CHECKPOINT_SEALING_UNAVAILABLE` (fail closed — 503).
- Bucket `hope-tenant-checkpoints` in `platformBuckets.ts`, compose `minio-setup`,
  `tests/docker-compose.test.yml`, the cluster bucket bootstrap (via `minio-policy-sync`, never a
  `minio-bootstrap` re-run). Unquoted, like `hope-backups` (a refused write loses a backup).
- Settings descriptors (tenant → SYSTEM cascade, `open-to-default`):
  `tenantCheckpoint.retentionDays` (30), `tenantCheckpoint.maxRetained` (10),
  `tenantCheckpoint.maxUploadSizeGb` (50), `tenantCheckpoint.maxLockMinutes` (60).

**API** — `apps/api/src/modules/tenant-checkpoint/`, `@Controller('admin/tenants/:tenantId/checkpoints')`,
class-level `@ForbidApiKey()` + `@ForbidServiceAccount()` (JWT only in v1 → not in `hope.admin.*`).

| Route | Gate | Result |
|---|---|---|
| `POST /` `{label, includesMedia, passphrase?}` | `create:TenantCheckpoint` | 202, row `PENDING` |
| `GET /` | `read:TenantCheckpoint` | paginated list |
| `GET /:id` | `read:TenantCheckpoint` | row + progress |
| `POST /:id/cancel` | `update:TenantCheckpoint` | sets `cancelRequestedAt` |
| `POST /:id/download-url` | `read:TenantCheckpoint` | presigned GET, 15 min, **force-audited** |
| `DELETE /:id` | `delete:TenantCheckpoint` | soft-delete row + delete object |
| `POST /uploads` `{sizeBytes, filename}` | `create:TenantCheckpoint` | row `UPLOADING` + presigned part URLs |
| `POST /uploads/:id/complete` `{parts:[{partNumber, etag}]}` | `create:TenantCheckpoint` | completes multipart, enqueues verification |
| `POST /uploads/:id/abort` | `create:TenantCheckpoint` | aborts multipart, row `CANCELLED` |
| `POST /:id/restore` `{categories, reason, password, confirmationName}` | `manage:TenantCheckpoint` + break-glass | 202, `TenantCheckpointRestore` row |
| `GET /restores` / `GET /restores/:restoreId` | `read:TenantCheckpoint` | restore status |

Every handler calls `assertTenantInScope(tenantId)` (404 for a foreign tenant). The SYSTEM tenant is
refused (`assertNotSystemTenant`). Lock-exempt: `GET` routes on this controller only.

**Console** — `apps/admin-console`, feature `src/features/tenant-checkpoints/`, route
`(console)/(shared)/checkpoints` (super admins via `WorkingTenantGate`, tenant admins their own),
nav entry `required: [['read','TenantCheckpoint']]`. Tenant detail links to it (one authoritative
editor). `ScreenTemplate` + `AdminDataGrid` list, `DetailDrawer` for a checkpoint, a create sheet
(label, include-media toggle, optional passphrase + confirm), an upload dialog (browser → presigned
multipart parts, progress, abort), a restore dialog (category checkboxes, *Clinical data* rendered
only for super admins, reason, password, typed tenant name), restore-history tab with polling.

**Tenant lock** — guard `apps/api/src/guards/tenant-lock.guard.ts`, registered after
`UnifiedAuthGuard`. While a `TenantCheckpointRestore` for the CLS tenant is between `LOCKING` and
its terminal state, every request carrying that tenant context — JWT, API key, service account,
internal callbacks from harness/STT, STT session opens on `SttWsGateway` — gets **423 Locked**
`{ code: 'TENANT_RESTORE_IN_PROGRESS', restoreId }`. Exempt: `@TenantLockExempt()` (the checkpoint
`GET` routes, health). Per-process cache, invalidated on `tenant-lock:invalidate`; cache TTL 5 s as
a backstop.

### 3.2 Archive format (`.hcp`, `formatVersion: 1`)

```
HEADER   (plaintext, length-prefixed JSON)
         magic "HOPECKPT", formatVersion, checkpointId, tenantId, tenantKey, sourceDeploymentId,
         createdAt, schemaFingerprint, includesMedia,
         keys: { platform: <data key wrapped by Vault hope-checkpoint>,
                 passphrase?: { kdf: "argon2id", salt, m, t, p, wrapped } }
BODY     (encrypted) chunked AES-256-GCM over a tar stream, 64 KiB plaintext segments,
         nonce = 7-byte random prefix ‖ 4-byte big-endian counter ‖ 1-byte last-segment flag;
         header bytes are the AAD of segment 0 (binds header to body)
TRAILER  (plaintext) sha256(header ‖ body), Ed25519 signature by Vault hope-checkpoint-sign over that digest
```

Tar entries:

| Entry | Content |
|---|---|
| `manifest.json` | formatVersion, schemaFingerprint (migration ledger names + per-table column list), per table `{columns, rowCount, sha256}`, per media object `{bucketId, key, size, sha256}`, claim-check `{sha256, size}`, Transit key versions observed per ciphertext column, `notCaptured[]` (Vault kv values, BYO bytes, Qdrant vectors, Temporal history) |
| `tenant.json` | the `Tenant` row — reference only, never restored |
| `db/<Model>.csv.gz` | `COPY (SELECT <cols> FROM core."<Model>" WHERE <scope predicate>) TO STDOUT (FORMAT csv, HEADER)` — header row = column names for by-name mapping; text format round-trips `bytea`, `jsonb`, `vector` |
| `media/<bucketId>/<objectKey>` | tenant-bucket objects referenced by `Media` rows (only if `includesMedia`, only for SHARED topology) |
| `claimcheck/<sha256>` | blobs referenced by this tenant's `WorkflowRun.resultRef` / `AgentTrajectoryStep.payloadRef` (only if `includesMedia`) |

All tables are read inside ONE `REPEATABLE READ READ ONLY` transaction (consistent snapshot).

**Verification gate** — runs at upload completion and again before every restore; streams the file once:

1. magic + `formatVersion` supported → else `UNSUPPORTED_FORMAT`
2. recompute sha256, Vault `transit/verify` the trailer → else `SIGNATURE_INVALID`
3. header `tenantId` = target tenant → else `WRONG_TENANT`; `sourceDeploymentId` = this deployment → else `FOREIGN_DEPLOYMENT` (v1 is A-only)
4. unwrap data key, authenticate every segment (truncation, reorder, flip) → else `CORRUPT_SEGMENT`
5. every manifest sha256 matches its entry → else `MANIFEST_MISMATCH`
6. (upload only) `checkpointId` not already present in the tenant → else `DUPLICATE`

A failed gate writes nothing to tenant tables.

**Offline opener** — `pnpm checkpoint:open <file> --out <dir> [--public-key <pem>]`: prompts for the
passphrase, writes the plaintext tar, reports *signature present, not verified* unless given the
exported public key. No network, no Vault.

### 3.3 Flows

**Create.** `POST` → row `PENDING` → export job. Worker: `RUNNING`, heartbeat every 15 s,
snapshot transaction, stream tables → gzip → tar → encrypt → multipart upload; then media via
`BlobStorageProviderFactory`; trailer; `READY` with size, digest, `manifestSummary`, `expiresAt`.
Cancel is polled between tables and between objects → abort multipart → `CANCELLED`.

**Download.** Presigned GET (15 min, `Content-Disposition: attachment; filename="<tenantKey>-<createdAt>-<id>.hcp"`).
Every issuance is a force-audited `ResourceViewed`.

**Upload.** `POST /uploads` validates `sizeBytes ≤ maxUploadSizeGb`, creates the row (`UPLOADING`,
`uploadId`) and returns presigned part URLs (64 MiB parts); the browser uploads straight to MinIO.
`complete` finishes the multipart upload and enqueues the verification gate → `READY` or
`FAILED(<reason>)`. A sweeper aborts uploads idle for 24 h.

**Restore** — synchronous checks, in order, then 202:

1. break-glass (`checkBreakGlass`: 428 missing, 401 wrong password, 400 wrong name)
2. `CLINICAL` in `categories` and caller not super admin → 403 `CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN`
3. checkpoint not `READY` → 409 `CHECKPOINT_NOT_READY`
4. any export or restore `RUNNING` for the tenant → 409 `TENANT_CHECKPOINT_BUSY`
5. `manifestSummary` cannot map onto current columns → 409 `SCHEMA_INCOMPATIBLE` (names the columns)

Worker steps:

1. **LOCKING** — publish the lock, wait a 5 s drain grace.
2. **SAFETY_CHECKPOINT** — full checkpoint `kind: SAFETY` (media included iff `CLINICAL` selected).
3. **VERIFYING** — re-run the verification gate on the source checkpoint.
4. Upload media bytes that are missing from their buckets (idempotent puts).
5. **RECONCILING** — staging + reconcile for all selected categories in **ONE transaction** (§3.5); commit.
6. **POST_COMMIT** — invalidate settings/agent caches; bump per-user not-before for affected
   members; re-index the tenant's Qdrant knowledge chunks; mark live `RUNNING` `WorkflowRun` rows
   of retired consultations `ABANDONED_BY_RESTORE`.
   Failures here → `COMPLETED_WITH_WARNINGS` with the list.
7. Release the lock; force-audited `TenantRestored` sys-event (categories, reason, counts, safety id).

**Failure.** Anything before commit → rollback, unlock, `FAILED`, database unchanged. A worker
crash: Postgres rolls back the open transaction on connection loss; the stale-restore sweeper sees
the stale heartbeat, marks `FAILED`, releases the lock. A lock older than `maxLockMinutes` is force-
released and the restore marked `FAILED(LOCK_TIMEOUT)`.

**Retention.** Daily lock-protected sweep: delete objects past `retentionDays` or beyond
`maxRetained` (newest first). Never auto-deleted: the newest `READY` checkpoint, and any `SAFETY`
checkpoint younger than 7 days. Manual delete is confirmed in the console and audited.

### 3.4 Model registry

```ts
export type CheckpointCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL' | 'LOGS' | 'EXCLUDED';
export type CheckpointPolicy = 'RECONCILE' | 'APPEND_ONLY' | 'CAPTURE_ONLY' | 'EXCLUDED';

export interface CheckpointModelDescriptor {
  model: string;                       // Prisma model name = table name in schema core
  category: CheckpointCategory;
  policy: CheckpointPolicy;
  scope:
    | { kind: 'tenantColumn' }                                  // WHERE "tenantId" = $1
    | { kind: 'parent'; fk: string; parent: string }            // WHERE fk IN (SELECT id FROM parent WHERE <parent scope>)
    | { kind: 'tenantMembers' }                                 // User and its children: users with a membership in the tenant
    | { kind: 'none' };                                         // EXCLUDED
  softDelete: boolean;                 // false ⇔ listed in MODELS_WITHOUT_SOFT_DELETE
  immutableColumns?: string[];         // must equal the trigger's guarded columns
  immutableWhen?: string;              // SQL predicate, e.g. `"status" IN ('PUBLISHED','DEPRECATED')`
  retire?: 'softDelete' | 'hardDelete' | 'revoke' | 'never';
  selfFk?: string;                     // e.g. parentConsultationId — orders inserts
  insertOnly?: boolean;                // users: insert when missing, never update
}
```

Tests that gate CI:

- **completeness** — the set of descriptor models equals the Prisma DMMF model set;
- **trigger parity** — `immutableColumns` equals the guarded column list parsed from the trigger SQL in `migrations/`;
- **soft-delete parity** — `softDelete` agrees with `MODELS_WITHOUT_SOFT_DELETE`;
- **category snapshot** — a literal table of model → category/policy; moving a model is a deliberate test change.

### 3.5 Restore semantics

Per selected category, per model, inside the single restore transaction:

1. **Stage** — `CREATE TEMP TABLE stg_<Model> (LIKE core."<Model>" INCLUDING DEFAULTS) ON COMMIT DROP`;
   `COPY … FROM STDIN (FORMAT csv, HEADER)` with the checkpoint's column list (by-name mapping;
   columns the checkpoint lacks take defaults; checkpoint columns the table lacks are dropped).
2. **Retire** (children first) — live in-scope rows absent from staging: `softDelete` → set
   `resourceStatus='DELETED'`, `resourceStatusUpdatedAt=now()`, `resourceStatusUpdatedBy=<restore actor>`,
   `_version=_version+1`; models without soft delete → `DELETE`; `retire: 'revoke'` → credential revoked.
   Also clears `isActive` where the model has it, so partial unique slots free up before inserts.
3. **Update** — rows in both: every restorable column ← staging, except `immutableColumns` (when
   `immutableWhen` holds), `id`, `tenantId`; `_version = live._version + 1` (never rewound — stale
   `If-Match` gets 412).
4. **Insert** (parents first, `selfFk` ordered) — staging rows absent live.

| Category | Models (abridged — the registry is authoritative) | Policy |
|---|---|---|
| **Configuration & content** | Agent, AgentModelFallback, AgentAssignment, PromptTemplate, PromptVersion, WorkflowDefinition, WorkflowAssignment, WorkflowTestFixture, WorkflowWebhookSecret, WorkflowInvariantRule (tenant rows), ConsultationContextSchema(+Version), DocumentTemplate(+Version), Department, GoldenSet, GoldenCase, KnowledgeDocument, KnowledgeChunk, TenantNlpTaskInstructions, Tag, AiProviderConnection, AiRoutingPolicy, GlobalSetting, TenantGuardrailPolicy, TenantStorageConfig, TenantBucket, TenantFrontendConfig, TenantAllowedOrigin, TenantIdentityProvider(+Domain), HarnessPolicy, RateLimitRule, Webhook, McpServer, AiModel (tenant BYO rows) | RECONCILE; post-commit cache invalidation + Qdrant re-index |
| **Users & access** | UserRoleAssignment, UserDepartment, Role (tenant custom) + RolePolicy, ApiKey, ServiceAccount, StorageAccessKey; `User` + `UserProfile`/`UserSettings` | memberships RECONCILE; `User` and children `insertOnly` (missing ⇒ insert, existing ⇒ untouched, never a password/profile write); credentials `retire: 'revoke'` and **never revived** (a credential revoked/deleted after the checkpoint stays revoked; one created after it is revoked); post-commit not-before bump for every affected member |
| **Clinical data** (platform admin only) | Consultation, ContextItem, ContextItemVersion, AudioRecording, SummaryMeta, NamedEntity, Highlight, TranscriptSegment, DocumentSection, TranscriptionJob, Media, UserMedia, UserVoiceProfile, ConsentGrant, DnaWritingStyleReport(+Version), EvalRun, EvalScore, GateEditExemplar, Notification, ResourceSubscription | RECONCILE; missing media bytes re-uploaded; bytes of retired `Media` left in place (the safety checkpoint references them); live `WorkflowRun` rows still `RUNNING` for a consultation the restore retired → `ABANDONED_BY_RESTORE` (the run table itself is a log and is never restored) |
| **Logs** | AuditLog, HarnessAuditEvent, AgentTrajectoryStep, WorkflowRun, AiUsageEvent, AiUsageOutbox, AiUsageRollupHourly/Daily, TenantUsageMeter, TenantPlanHistory, BillingInvoice(+Line), BillingAdjustment, DnaUsageRecord, PromptUsageRecord, WebhookRunHistory, UserChangelogAcknowledgement; WORM change logs HarnessPolicyChange, AgentAssignmentChange, WorkflowAssignmentChange, AgentPromotion | CAPTURE_ONLY; WORM change logs APPEND_ONLY (insert missing, never update/delete) |
| **Excluded** | Tenant (captured to `tenant.json` only), PlanEntitlement, TenantEntitlement, AiModel (SYSTEM rows), AiPriceBook, ModelResidencyPolicy, ServiceRelease, ServiceInstance, ChangelogEntry, Policy, Fedl* (4), PasswordResetToken | EXCLUDED |

Cross-tenant invariant: every statement carries the tenant predicate; the integration suite asserts a
second tenant's rows are byte-identical before and after every restore.

### 3.6 Permission matrix

| Action | Tenant admin (own tenant only) | Platform admin |
|---|---|---|
| Create / list / get / download / cancel | ✅ | ✅ any tenant |
| Upload | ✅ — accepted only if produced by this deployment for this tenant | ✅ |
| Restore *Configuration & content* | ✅ break-glass | ✅ break-glass |
| Restore *Users & access* | ✅ break-glass | ✅ break-glass |
| Restore *Clinical data* | ❌ 403 | ✅ break-glass + mandatory reason |
| Delete | ✅ | ✅ |

CASL: new subject `TenantCheckpoint`; `tenant-full-access` gains
`{ action: 'manage', subject: 'TenantCheckpoint', conditions: { tenantId: '${context.tenantId}' } }`;
SUPER_ADMIN is covered by `manage:all`. The Clinical rule is an imperative 403 in the service
(`// AUTH-NOTE:` on the route) — a 403 privilege boundary, not the 404-over-403 tenancy posture.

### 3.7 Designed for B and C (not built in v1)

The manifest already carries what a remapper needs: column lists, slugs alongside ids for every
SYSTEM reference (`AiModel.slug`, built-in `Role.name`), Transit key versions per ciphertext column,
`sourceDeploymentId`, and the exportable signing public key. B adds: trust a peer's public key,
re-wrap Transit ciphertext (decrypt on source / re-encrypt on target), re-hash peppered credentials
(or force re-issue). C adds: an id remap table and tenantId rewrite through the same registry.

### 3.8 Out of scope for v1

B and C; scheduled checkpoints; service-account / API-key access; capturing Vault kv secret values;
copying BYO-storage bytes; resuming a failed export; restoring logs.

---

## 4. Implementation Plan — lanes, tiers, waves

Detailed per-lane briefs (exact files, RED test, commands, return contract) are produced by the
writing-plans step after this spec is approved. This section fixes the **partition, the dependency
waves and the model/effort tier per lane**, per `14-multi-agent-worktrees.md` §1.

### 4.1 Principles applied

- **Partition by directory**, one writer per file. The shared surfaces — migration, `pnpm install`,
  `db:push`/`db:generate`, `app.module.ts`, generated artifacts (route manifest, OpenAPI, portal),
  merges — belong to the **orchestrator only**.
- **Contracts first.** §3.1 (API shapes), §3.2 (archive layout) and §3.4 (descriptor type) are fixed
  here so lanes in the same wave never wait on each other's code — the console lane starts in Wave 1
  against the documented API contract.
- **Tier per stage, effort per stage.** Mechanical lanes run `sonnet` at `low`; patterned-but-subtle
  lanes `sonnet` at `medium`/`high`; the three lanes whose output is a security or data-loss verdict
  (crypto/sealing, registry classification, reconcile engine) run `opus`. Nothing needs `fable`: the
  architecture is decided, and what remains is careful execution against a fixed spec.
- **Owner rule (no gates before the full merge).** Each lane runs only its own RED→GREEN test files;
  the full gate pass runs once, after everything is merged on `dev-2.2`.
- **Worktrees** are siblings of the primary (`../hope-v2-task-1032-<lane>`), branched from `dev-2.2`
  after Wave 0 is committed; `node_modules` is **symlinked** from the primary, never `pnpm install`-ed
  inside a worktree; `.env.dev`/`.env.test` copied in.
- **Integration tests share one test DB**, so in Wave 2 only lane L6b runs DB-backed tests; the
  orchestrator owns `test:db:reset`.
- Fan-out is capped at **6 concurrent lanes** — the most whose reports can actually be re-verified.

### 4.2 Waves

```
W0  orchestrator (inline)  ── schema, migration, enums, deps, queues ── commit
        │
W1  ┌─ L1 domain trio ─┐ ┌─ L2 registry ─┐ ┌─ L3 archive+sealing+store ─┐ ┌─ L4 tenant lock ─┐ ┌─ L5 platform plumbing ─┐ ┌─ L9 console ─┐
        │  merge W1 (orchestrator)                                                                                           (L9 continues)
W2  ┌─ L6a export ─┐ ┌─ L6b restore/reconcile ─┐ ┌─ L7 service+API ─┐ ┌─ L10 deployment repo ─┐                              │
        │  merge W2 + L9 (orchestrator)                                                                                       ┘
W3  orchestrator (inline) ── worker entrypoint, app.module wiring, artifacts regen, ONE full gate pass
        │
W4  ┌─ R1 security review ─┐ ┌─ R2 data-integrity review ─┐ ┌─ R3 completeness review ─┐   then orchestrator live proof
```

### 4.3 Lane table

| Lane | Wave | Owns (write boundary) | Tier · effort | Why this tier |
|---|---|---|---|---|
| **W0** orchestrator | 0 | `db_main/tenant-checkpoint.prisma`, `enums.prisma`, `audit.prisma` + migration `task_1032_tenant_checkpoint`, `ResourceType.ts`, `JobQueue.enum.ts`, `pnpm install` of new deps (`pg-copy-streams`, `tar-stream`, an Argon2id implementation — OD-1), `gen:model` | session model, inline | Shared surfaces; small; spawning costs more than doing |
| **L1** domain trio | 1 | `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/TenantCheckpoint*` (+Restore), barrels, `core.database.module.ts`, `packages/database/src/extensions/tenant-scope.ts` | `sonnet` · low | Mechanical, exemplar `AiRoutingPolicy*`; mapper OCC strip spelled out in the brief |
| **L2** registry | 1 | `tenant-checkpoint/registry/**` | `opus` · medium | ~103 classification calls are the security/data-loss verdict of the whole feature (rule 14: never downshift the deciding stage); medium because the inventory in §2 is supplied |
| **L3** archive + sealing + store | 1 | `tenant-checkpoint/{archive,sealing,store}/**`, `vault-secrets.provider.ts` + `ISecretsProvider` (`sign`/`verify`), other providers' fail-closed stubs, `scripts/checkpoint-open.ts` + root `checkpoint:open` script | `opus` · high | Streaming AEAD, nonce discipline, signature binding and tamper cases — a subtle crypto bug is silent and fatal |
| **L4** tenant lock | 1 | `tenant-checkpoint/lock/**`, `apps/api/src/guards/tenant-lock.guard.ts`, `@TenantLockExempt()` decorator, `SttWsGateway` open-path check | `sonnet` · medium | Patterned on `app-settings:invalidate` + an existing guard; the subtle part (which paths carry tenant context) is listed in the brief |
| **L5** platform plumbing | 1 | `dev-init.sh`, `hope-app.hcl`, compose `minio-setup`, `tests/docker-compose.test.yml`, `platformBuckets.ts`, settings-registry descriptors, `seed/01-policy.ts` (CASL), `.env.sample`s if any | `sonnet` · low | Copy-the-neighbour edits across known files |
| **L9** console | 1→2 | `apps/admin-console/src/features/tenant-checkpoints/**`, `src/app/(console)/(shared)/checkpoints/**`, `nav-config.ts` + its pinned test, tenant-detail link, console Playwright spec | `sonnet` · medium | Heavily patterned (ScreenTemplate, DetailDrawer, break-glass dialog exists in `features/rbac`); rule density is high but specified; codes against §3.1, so it spans W1–W2 without blocking |
| **L6a** export | 2 | `tenant-checkpoint/export/**` (processor, retention sweeper, stale-export + idle-upload sweepers) | `opus` · medium | Snapshot correctness + streaming back-pressure; unit-tested with mocked `pg`/store, no DB |
| **L6b** restore / reconcile | 2 | `tenant-checkpoint/restore/**` + its integration suite | `opus` · high | The data-loss verdict: SQL generation against triggers, partial uniques, self-FKs, credential non-revival, cross-tenant byte-identity. The ONLY Wave-2 lane allowed to touch the test DB |
| **L7** service + API | 2 | `tenant-checkpoint/` root (service, `ITenantCheckpointService`, DTOs, mapper, module), `apps/api/src/modules/tenant-checkpoint/**`, API unit tests, hand-written e2e depth spec + `*cross-tenant*.spec.ts` | `sonnet` · high | Patterned controller/service, but authz ordering (break-glass, Clinical 403, 404-over-403, busy/schema 409) needs care — reviewed by R1 at `opus` |
| **L10** deployment repo | 2 | `~/Desktop/igglo/ARCAAI/hope-v2-deployment`: `checkpoint-worker` Deployment, Vault policy for the two keys, bucket in policy-sync, overlay wiring; `kustomize build overlays/dev` | `sonnet` · medium | Rule 09 is dense but the change is additive and CI-checked by that repo's eight gates |
| **W3** orchestrator | 3 | `checkpoint-worker.main.ts`, `dev-service.sh` target, `stack:dev`, root `checkpoint:dev`, `app.module.ts`, regenerate the five artifacts, full gate pass | session model, inline | Shared surfaces + integration judgement |
| **R1** security review | 4 | read-only | `opus` · high | Lens: authz matrix, break-glass ordering, tenant pinning, upload trust chain, crypto |
| **R2** data-integrity review | 4 | read-only | `opus` · high | Lens: reconcile vs triggers/uniques, cross-tenant isolation, rollback-on-failure, lock coverage |
| **R3** completeness review | 4 | read-only | `sonnet` · medium | Lens: registry classification vs §3.5, docs, settings, nav, artifacts |
| **Live proof** | 4 | — | orchestrator | §5 step list on a real local stack |

Concurrency: W1 = 6 lanes (L1–L5, L9); W2 = 4 new lanes (L6a, L6b, L7, L10) + L9 still running;
W4 = 3 read-only reviewers. `opus` is spent on 6 of 13 agent runs (L2, L3, L6a, L6b, R1, R2) — the
lanes whose output is a crypto, classification, snapshot-consistency or data-loss verdict; every
mechanical or patterned lane runs `sonnet`.

### 4.4 Merge order

W1: L5 → L1 → L4 → L3 → L2 (registry last: it imports nothing, but its parity tests read the
migrations W0 wrote). W2: L6a → L6b → L7 → L9 → L10 (separate repo, merged on its own `main`
after the owner's go). Each merge is into `dev-2.2` from the primary checkout; worktrees are removed
only after their merge commit exists (rule 14 §5).

### 4.5 Open decisions for the owner

| Id | Question | Recommendation |
|---|---|---|
| OD-1 | Argon2id implementation for the passphrase wrap (also used by the offline CLI) | `hash-wasm` (pure WASM, no native build in the Docker image); alternative `@node-rs/argon2` (native, faster) |
| OD-2 | Bucket quota on `hope-tenant-checkpoints` in the cluster | Unquoted, like `hope-backups`; disk pressure is watched via the existing node alerts |
| OD-3 | Should the Users & access restore also restore a user's *global* `resourceStatus` when the user was deleted platform-wide after the checkpoint? | No — a global user deletion is a platform decision; the restore re-creates the membership and reports the user as inactive |

---

## 5. Verification (definition of done)

- Lane RED→GREEN tests as listed per lane; then ONE full gate pass on `dev-2.2`:
  `pnpm lint:all`, `pnpm typecheck:all`, `pnpm --filter @arcaai/domains test`,
  `pnpm --filter @arcaai/applications test`, `pnpm test:unit`, `pnpm test:integration`,
  `pnpm test:e2e` (incl. `task-776-route-authz-matrix.spec.ts`),
  `pnpm --filter @arcaai/admin-console build lint test`, `pnpm api:openapi:check`,
  `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`, `gen:model/entity/factory` checks.
- Integration (L6b): seeded tenant → checkpoint → mutate → restore each category alone → row
  equality; published agent/workflow retired not deleted; active-slug partial unique; `_version`
  bumped; revoked key stays revoked; existing global `User` untouched; missing user re-inserted;
  `HarnessAuditEvent` chain unchanged; self-FKs; forced mid-reconcile failure ⇒ zero diff; second
  tenant byte-identical. Schema drift: extra/missing column restores; new NOT NULL without default ⇒
  `SCHEMA_INCOMPATIBLE`.
- Archive (L3): round-trip; passphrase wrap; flipped byte, truncation, reordered segment, swapped
  header tenant, foreign deployment, bad signature ⇒ each named reason; offline CLI opens a sealed file.
- Lock (L4 + e2e): 423 for JWT, internal callback, STT open; `GET` status routes exempt; stale lock released.
- API (L7): matrix auto-coverage; depth spec — tenant admin 404 on a foreign tenant, `CLINICAL` 403
  for a tenant admin, break-glass 428/401/400, foreign-tenant upload ⇒ `WRONG_TENANT`; cross-tenant spec.
- Console (L9): unit tests for screen states and the restore dialog; Playwright create → download →
  upload → restore; axe 0 violations; both themes.
- **Live proof** (local stack): checkpoint the Global tenant with media → download → open offline
  with the passphrase → break an agent and add a consultation → restore *Configuration & content*
  (agent back, consultation kept) → restore *Clinical data* (consultation retired) → restore the
  safety checkpoint (everything back).

---

## 6. Implementation Summary

_Pending — filled in after implementation._

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-01 | Ticket opened; design agreed with the owner (D-1…D-12); spec + lane plan written. Status Pending — awaiting spec review. |
