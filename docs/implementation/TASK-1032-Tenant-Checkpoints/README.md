# TASK-1032 — Tenant Checkpoints (backup, download, upload, restore)

| | |
|---|---|
| **Status** | Review — implemented and verified on `dev-2.2` (not pushed); cluster rollout awaits owner go (§7.4) |
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
| **L4** tenant lock | 1 | `tenant-checkpoint/lock/**`, `apps/api/src/guards/tenant-lock.guard.ts`, `@TenantLockExempt()` decorator, `SttWsGateway` open-path check, worker-session lock check | `sonnet` · high | Patterned on `app-settings:invalidate` + an existing guard; raised to high because it must also postpone in-process BullMQ jobs (§6.0 C-11) |
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

## 6. Implementation Plan — lane briefs

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (orchestrator)
> or superpowers:executing-plans (a lane executing its own brief). Steps use checkbox (`- [ ]`) syntax.
> Each lane reads §1–§5 (the spec), §6.0–§6.3, and **only its own lane section**.

**Goal:** platform and tenant admins can create, download, upload and category-selectively restore a
sealed checkpoint of one tenant, in place, on the same deployment.

**Architecture:** a declarative model registry drives a Postgres `COPY` export into a framed, chunked
AES-256-GCM archive (data key wrapped by Vault Transit, digest signed by Vault Ed25519), stored in a
platform bucket; restore verifies the seal, stages the checkpoint rows into temp tables and reconciles
them set-wise in one transaction under a hard tenant lock, after taking a safety checkpoint.

**Tech stack:** Prisma 7 / PostgreSQL 18, NestJS 11 + BullMQ, `pg` + `pg-copy-streams`, Node `crypto`
(AES-256-GCM, sha256), `hash-wasm` (Argon2id), Vault Transit, S3/MinIO multipart, Next.js 16 + TanStack
Query + `@arcaai/ui`.

**Spec:** this README, §1–§5. §6.0 lists the corrections found while planning; where they disagree, §6.0 wins.

### 6.0 Spec corrections found while planning (supersede §3)

| Id | Correction | Why |
|---|---|---|
| C-1 | The archive body is a **framed entry stream** (§6.2), not tar | tar needs each entry's size before its bytes; `COPY` output size is unknown until it ends. `tar-stream` is dropped from the deps |
| C-2 | Console route is **`(console)/(tenant)/checkpoints`** wrapped in `WorkingTenantGate` (tier 30–49) | that gate is the only console pattern giving super admins a pick-a-tenant state and the "Acting on" banner; no `(shared)` screen uses it |
| C-3 | `sourceDeploymentId` = **hex sha256 of the `hope-checkpoint-sign` public key** | the signing key already *is* the deployment identity; no new env var |
| C-4 | The passphrase is used **only inside the create request**: the API generates the data key, wraps it (Vault + optional Argon2id) and stores both wraps in `TenantCheckpoint.keyEnvelope`; jobs carry ids only | a passphrase in a BullMQ payload would sit in Redis |
| C-5 | A live `WorkflowRun` still `RUNNING` for a consultation the restore retired → existing status **`CANCELED`**, `_metadata.canceledBy = 'tenant-restore:<restoreId>'` | `WorkflowRunStatus` has no `ABANDONED`; no enum migration needed |
| C-6 | `KnowledgeChunk` is **derived**: captured, never reconciled. Post-commit, restored-or-changed `KnowledgeDocument`s are re-ingested from the checkpoint's decrypted chunk text; retired documents get their Qdrant vectors deleted | the raw document text is not persisted anywhere; the ingest job is the only path that writes chunks + vectors consistently |
| C-7 | Policies are `RECONCILE \| INSERT_ONLY \| RETIRE_ONLY \| CAPTURE_ONLY \| EXCLUDED`. WORM change logs are `CAPTURE_ONLY` (no `APPEND_ONLY`); credentials are `RETIRE_ONLY`; `User` + its children are `INSERT_ONLY` | a log category is never restored, so append-only was dead; RETIRE_ONLY is "never revive" stated as a policy |
| C-8 | The checkpoint bucket is created **by the worker at boot** (`ensureBucket()`, idempotent); the deployment repo only grants it in the `hope-platform-rw` policy | never re-run `minio-bootstrap` (it rotates a key Vault then holds stale) |
| C-9 | Agent spec caches are **TTL-only (15 s)**; the restore holds the lock for `POST_COMMIT_SETTLE_MS` after commit, ≥ the longest TTL of every in-process cache over a restored table | no invalidation channel exists for agents, origins, IdP, rate-limit rules |
| C-10 | `reason` is required on **every** restore (10–1000 chars) | stricter than D-5, one rule instead of two, every restore is force-audited anyway |
| C-11 | **In-process BullMQ jobs** of a locked tenant are postponed (not run, not failed) | the HTTP guard does not see queue workers inside the gateway |
| C-12 | `confirmationName` must equal the tenant's **current** `Tenant.name` | break-glass semantics: retype the target's name |
| C-13 | Verification gate order becomes: 1 magic + format → 2 header `sourceDeploymentId` = own `deploymentId()` (`FOREIGN_DEPLOYMENT`) → 3 signature → 4 `tenantId` (`WRONG_TENANT`) → 5 segments → 6 manifest → 7 duplicate | a foreign file would otherwise always fail the signature first and `FOREIGN_DEPLOYMENT` could never fire |

### 6.1 Global Constraints (every lane's requirements include these)

- **Merge target: `dev-2.2`** ⚠ owner wrote `main` on 2026-10-01 — confirm before W1 merges. The deployment repo merges to its own `main`.
- **No gating tests in lanes (owner rule, 2026-10-01).** A lane runs ONLY the test files it authors, RED then GREEN, with
  `pnpm --filter <pkg> exec vitest run <path>` (applications/domains/database/admin-console), or the single integration
  file named in its brief. Never `pnpm test`, `test:unit`, `lint`, `lint:all`, `typecheck`, `verify`, `build:apps`, e2e
  suites, or any `*:check`. The orchestrator merges everything into `dev-2.2` first, then runs the one gate pass (§6.7 W3).
- **Shared surfaces are orchestrator-only:** `pnpm install`/`add`, `db:push`, `db:migrate*`, `db:generate`, `test:db:reset`,
  `infra:*`, Docker, `apps/api/src/app.module.ts`, `apps/api/route-manifest.json`, `apps/api/openapi.json`, the portal,
  `packages/vox-node/src/resources/admin/**`, merges, branch switches.
- **Never** run `pnpm gen:mapper` or `gen:repository` (destructive/broken — rule 03).
- **Never `git stash`** in a worktree. Commit your own work on your lane branch; never commit to `dev-2.2`.
- Versions: Node ≥ 22.12, TypeScript 6.0, Prisma 7, NestJS 11, Next.js 16.3.4, React 19.2, Vitest 4, Playwright.
- New runtime deps (added by W0 only): `pg-copy-streams` + `@types/pg-copy-streams`, `hash-wasm`, `pg` + `@types/pg` in `@arcaai/applications`.
- **No new env vars.** Tunables are settings descriptors (§3.1). Code constants are allowed only for format facts:
  `CHECKPOINT_FORMAT_VERSION`, bucket name, Transit key names, segment size, error codes (all in `contracts.ts`).
- Every HTTP error the service raises carries a `code` field: `new ConflictException({ code, message })`.
- Cross-tenant miss = **404**; privilege failure = **403**; the SYSTEM tenant id `00000000-0000-0000-0000-000000000000` is refused (403 `SYSTEM_TENANT_NOT_CHECKPOINTABLE`).
- No ticket ids in code comments (pre-release rule). `// AUTH-NOTE:` marker on imperative privilege checks.
- Every mutation broadcasts a sys-event; downloads and restores are `forceAuditLog: true`.

### 6.2 Review Focus — inputs the spec implies but no happy-path test exercises

1. **In-process background jobs during a restore** (DNA ingest, knowledge ingest, async summary — BullMQ inside the gateway)
   for the locked tenant: expected **postponed** until unlock, never run mid-restore and never failed for good. → L4 Task 3.
2. **A row whose immutable content diverged** (DRAFT at checkpoint time, PUBLISHED with different content later): expected
   the live row is left untouched, the restore completes, and a `IMMUTABLE_DIVERGED` warning names model + id. → L6b Task 3.
3. **A browser multipart upload that is abandoned or completed with a missing/duplicate/out-of-order part list**: expected
   `complete` refuses with `UPLOAD_PARTS_INVALID`, and an idle upload is aborted by the sweeper after 24 h. → L3 Task 4, L6a Task 3.
4. **Wrong or forgotten passphrase in the offline opener**: expected a clear `PASSPHRASE_INVALID` message, non-zero exit,
   and **no partial plaintext left in `--out`**. → L3 Task 5.
5. **Tenant renamed or re-keyed between checkpoint and restore**: expected `confirmationName` checks the CURRENT name, and a
   header `tenantKey` that differs from the current key is NOT a failure (the `tenantId` is the authority). → L7 Task 3, L3 Task 3.

### 6.3 Lane protocol (identical for every writer lane)

**Worktree** (orchestrator creates it; the lane never runs `pnpm install`):

```bash
P=/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2
L=<lane>           # e.g. l3-archive
W=$P/../hope-v2-task-1032-$L
git -C $P worktree add $W -b task-1032/$L dev-2.2
ln -s $P/node_modules $W/node_modules
for d in $P/packages/*/node_modules $P/apps/*/node_modules; do rel=${d#$P/}; ln -s $d $W/$rel; done
ln -s $P/packages/database/src/generated/core-prisma-client $W/packages/database/src/generated/core-prisma-client
for d in $P/packages/*/dist; do rel=${d#$P/}; ln -s $d $W/$rel; done   # then DELETE the dist symlink of every package the lane modifies
cp $P/.env.dev $P/.env.test $W/
```

A lane that modifies a package which another package's test imports through `dist` rebuilds only that package:
`pnpm --filter <pkg> build` (a build to make imports resolve — not a gate).

**Return contract** — the lane's final message is DATA for the orchestrator, exactly these fields:

```
lane: <id>        branch: task-1032/<lane>        head: <sha>
files: <list of created/modified paths>
tests: <each test file> — RED output excerpt (the failing assertion) — GREEN output excerpt (pass count)
could_run_tests: yes | no (why)
deviations: <anything that differs from this brief, with the reason>   | none
findings: <defects or surprises found outside the lane boundary — reported, NOT fixed> | none
```

---

### 6.4 Wave 0 — orchestrator, inline, in the primary on `dev-2.2`

#### Task W0-1: Schema + migration

**Files:** create `packages/database/src/prisma/db_main/tenant-checkpoint.prisma`; modify `enums.prisma`,
`audit.prisma` (ResourceType); migration `<ts>_task_1032_tenant_checkpoint`.

- [ ] **Step 1:** append to `enums.prisma`:

```prisma
enum TenantCheckpointKind {
  MANUAL
  SAFETY

  @@schema("core")
}

enum TenantCheckpointOrigin {
  CREATED
  UPLOADED

  @@schema("core")
}

enum TenantCheckpointStatus {
  PENDING
  UPLOADING
  RUNNING
  READY
  FAILED
  CANCELLED

  @@schema("core")
}

enum TenantCheckpointCategory {
  CONFIG_CONTENT
  USERS_ACCESS
  CLINICAL

  @@schema("core")
}

enum TenantCheckpointRestoreStatus {
  PENDING
  LOCKING
  SAFETY_CHECKPOINT
  VERIFYING
  RECONCILING
  POST_COMMIT
  COMPLETED
  COMPLETED_WITH_WARNINGS
  FAILED

  @@schema("core")
}
```

- [ ] **Step 2:** create `tenant-checkpoint.prisma`:

```prisma
/// One sealed backup of one tenant. Object bytes live in the platform bucket
/// `hope-tenant-checkpoints`; this row is the durable job state (Redis is not durable).
model TenantCheckpoint {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))
  // multi tenant fields
  tenantId String
  // core (business) fields
  label               String
  kind                TenantCheckpointKind   @default(MANUAL)
  origin              TenantCheckpointOrigin @default(CREATED)
  status              TenantCheckpointStatus @default(PENDING)
  includesMedia       Boolean                @default(true)
  passphraseProtected Boolean                @default(false)
  /// { platform: <Vault hope-checkpoint ciphertext>, passphrase?: PassphraseWrap } — ciphertext only
  keyEnvelope         Json?                  @db.JsonB
  objectKey           String?
  uploadId            String?
  sizeBytes           BigInt?
  manifestDigest      String?
  /// { tables: [{ model, columns, rowCount }] } — lets the API answer SCHEMA_INCOMPATIBLE synchronously
  manifestSummary     Json?                  @db.JsonB
  schemaFingerprint   String?
  sourceDeploymentId  String?
  formatVersion       Int                    @default(1)
  /// { phase, tablesDone, tablesTotal, bytesWritten }
  progress            Json?                  @db.JsonB
  heartbeatAt         DateTime?
  cancelRequestedAt   DateTime?
  startedAt           DateTime?
  finishedAt          DateTime?
  expiresAt           DateTime?
  failureReason       String?
  failureDetail       String?
  // resource status fields
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?
  // audit fields
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  // relations
  restores TenantCheckpointRestore[] @relation("TenantCheckpointRestoreSource")

  @@index([tenantId], name: "TenantCheckpoint_tenantId_idx")
  @@index([tenantId, status], name: "TenantCheckpoint_tenantId_status_idx")
  @@index([status, heartbeatAt], name: "TenantCheckpoint_status_heartbeatAt_idx")
  @@schema("core")
}

/// One restore of a tenant from a checkpoint. While its status is between LOCKING and a terminal
/// state, the tenant is locked (423) — this row IS the lock.
model TenantCheckpointRestore {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))
  // multi tenant fields
  tenantId String
  // core (business) fields
  checkpointId       String
  categories         TenantCheckpointCategory[]
  reason             String
  status             TenantCheckpointRestoreStatus @default(PENDING)
  safetyCheckpointId String?
  /// [{ model, inserted, updated, retired }]
  counts             Json?                         @db.JsonB
  /// [{ code, message, detail? }]
  warnings           Json?                         @db.JsonB
  requestedBy        String
  heartbeatAt        DateTime?
  lockAcquiredAt     DateTime?
  lockReleasedAt     DateTime?
  startedAt          DateTime?
  finishedAt         DateTime?
  failureReason      String?
  failureDetail      String?
  // resource status fields
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?
  // audit fields
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  // relations
  checkpoint TenantCheckpoint @relation("TenantCheckpointRestoreSource", fields: [checkpointId], references: [id], onDelete: Restrict)

  @@index([tenantId], name: "TenantCheckpointRestore_tenantId_idx")
  @@index([checkpointId], name: "TenantCheckpointRestore_checkpointId_idx")
  @@index([tenantId, status], name: "TenantCheckpointRestore_tenantId_status_idx")
  @@schema("core")
}
```

- [ ] **Step 3:** append to `enum ResourceType` in `audit.prisma` (before `@@schema`), with a comment: `TenantCheckpoint` and `TenantCheckpointRestore`.
- [ ] **Step 4:** author the migration on a shadow DB (rule 02 recipe), name `task_1032_tenant_checkpoint`. Hand-append to
  the generated SQL the race guard (copy the way `AiRoutingPolicy_tenant_task_default_unique` was added — raw SQL in its migration):

```sql
-- At most one non-terminal restore per tenant: the database, not the service, decides the race.
CREATE UNIQUE INDEX "TenantCheckpointRestore_one_active_per_tenant"
  ON core."TenantCheckpointRestore" ("tenantId")
  WHERE "status" NOT IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED') AND "resourceStatus" <> 'DELETED';
```

  Also the `ALTER TYPE core."ResourceType" ADD VALUE` lines Prisma generates. Prove zero drift (rule 02 step 3), then `pnpm db:push` on dev and `pnpm db:generate`, `pnpm gen:model`.
- [ ] **Step 5:** `packages/domains/src/enums/generated/ResourceType.ts`: add `TenantCheckpoint = 'TenantCheckpoint'` and `TenantCheckpointRestore = 'TenantCheckpointRestore'` with a comment block. Add the five new enums to `packages/domains/src/enums/generated/` (one file each, barrel lines in `enums/generated/index.ts`, copy `AiRoutingPolicyStatus`'s file shape).
- [ ] **Step 6:** `JobQueue.enum.ts`: add `TenantCheckpointExport = 'TenantCheckpointExport'` and `TenantCheckpointRestore = 'TenantCheckpointRestore'`; `queue-concurrency.ts`: both `1`, NOT in `DB_BOUND_QUEUES` (they use their own `pg` pool).
- [ ] **Step 7:** deps in `packages/applications/package.json`: `pg`, `pg-copy-streams`, `hash-wasm`; dev: `@types/pg`, `@types/pg-copy-streams`. `pnpm install` from the primary root.

#### Task W0-2: Shared contracts (every lane imports these; nobody else edits them)

**Files:** create `packages/applications/src/services/tenant-checkpoint/contracts.ts`,
`packages/applications/src/services/tenant-checkpoint/db/checkpoint-pg.ts`.

- [ ] **Step 1:** write `contracts.ts`:

```ts
import type { Readable, Writable } from 'node:stream';

// ---- format facts -------------------------------------------------------------------------
export const CHECKPOINT_FORMAT_VERSION = 1 as const;
export const CHECKPOINT_MAGIC = 'HOPECKPT' as const;
export const CHECKPOINT_BUCKET = 'hope-tenant-checkpoints' as const;
export const CHECKPOINT_WRAP_KEY = 'hope-checkpoint' as const;
export const CHECKPOINT_SIGN_KEY = 'hope-checkpoint-sign' as const;
export const CHECKPOINT_SEGMENT_BYTES = 64 * 1024;
export const CHECKPOINT_UPLOAD_PART_BYTES = 64 * 1024 * 1024;
export const TENANT_LOCK_CHANNEL = 'tenant-lock:invalidate' as const;
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000' as const;

// ---- categories & registry ------------------------------------------------------------------
export type CheckpointCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL' | 'LOGS' | 'EXCLUDED';
export type RestorableCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL';
export const RESTORABLE_CATEGORIES: readonly RestorableCategory[] = ['CONFIG_CONTENT', 'USERS_ACCESS', 'CLINICAL'];

export type CheckpointPolicy = 'RECONCILE' | 'INSERT_ONLY' | 'RETIRE_ONLY' | 'CAPTURE_ONLY' | 'EXCLUDED';

export type CheckpointScope =
  | { kind: 'tenantColumn'; column?: string }          // WHERE "<column ?? tenantId>" = $tenantId
  | { kind: 'parent'; fk: string; parent: string }     // WHERE "<fk>" IN (SELECT "id" FROM <parent> WHERE <parent scope>)
  | { kind: 'tenantMembers' }                          // User: id IN (role assignments ∪ user departments of the tenant)
  | { kind: 'none' };                                  // EXCLUDED

export type CheckpointRetire =
  | { kind: 'softDelete' }                             // resourceStatus='DELETED', stamps, _version+1
  | { kind: 'hardDelete' }                             // only for models without soft delete and without triggers
  | { kind: 'revoke'; setSql: string }                 // e.g. `"resourceStatus" = 'DELETED', "revokedAt" = now()`
  | { kind: 'never' };

export interface CheckpointModelDescriptor {
  model: string;                      // Prisma model name
  table?: string;                     // only when @@map differs (Fedl*)
  category: CheckpointCategory;
  policy: CheckpointPolicy;
  scope: CheckpointScope;
  softDelete: boolean;                // false ⇔ in MODELS_WITHOUT_SOFT_DELETE
  retire: CheckpointRetire;
  immutableColumns?: readonly string[];   // equals the trigger's guarded columns
  immutableWhen?: string;                 // SQL over the LIVE row alias "l", e.g. `l."status" IN ('PUBLISHED','DEPRECATED')`
  derivedFrom?: string;                   // KnowledgeChunk → 'KnowledgeDocument'
  notes?: string;
}

/** Run SQL with positional params ($1…). Implemented over `pg` (worker) or Prisma $queryRawUnsafe (API). */
export type SqlQuery = <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<T[]>;

// ---- archive --------------------------------------------------------------------------------
export interface PassphraseWrap {
  kdf: 'argon2id';
  salt: string;       // base64, 16 bytes
  m: number;          // KiB
  t: number;
  p: number;
  nonce: string;      // base64, 12 bytes
  wrapped: string;    // base64, AES-256-GCM(dataKey) ‖ tag
}
export interface KeyEnvelope { platform: string; passphrase?: PassphraseWrap }

export interface CheckpointHeader {
  magic: typeof CHECKPOINT_MAGIC;
  formatVersion: number;
  checkpointId: string;
  tenantId: string;
  tenantKey: string;
  sourceDeploymentId: string;
  createdAt: string;           // ISO
  schemaFingerprint: string;
  includesMedia: boolean;
  noncePrefix: string;         // base64, 7 bytes
  keys: KeyEnvelope;
}

export interface ManifestTable { model: string; columns: string[]; rowCount: number; sha256: string }
export interface ManifestObject { entry: string; size: number; sha256: string }
export interface CheckpointManifest {
  formatVersion: number;
  schemaFingerprint: string;
  tables: ManifestTable[];
  media: (ManifestObject & { bucketId: string; key: string })[];
  claimChecks: (ManifestObject & { contentKey: string })[];
  transitKeyVersions: Record<string, number>;   // "<Model>.<column>" → max vN seen
  notCaptured: string[];
}
export type ManifestSummary = { tables: { model: string; columns: string[]; rowCount: number }[] };

export interface CheckpointArchiveWriter {
  /** Streams one entry, sequentially; resolves with plaintext sha256 (hex) and length. */
  writeEntry(name: string, body: Readable | Buffer): Promise<{ sha256: string; bytes: number }>;
  /** Writes `manifest.json` as the final entry, the end marker and the trailer; ends the sink. */
  finish(manifest: CheckpointManifest): Promise<{ sizeBytes: number; digestHex: string; manifestDigestHex: string }>;
  abort(error: Error): Promise<void>;
}
export interface CheckpointArchiveReader {
  readonly header: CheckpointHeader;
  /** Entries in archive order, `manifest.json` excluded; consume each body fully before the next. */
  entries(): AsyncIterable<{ name: string; body: Readable }>;
  /** Available once entries() has completed. */
  manifest(): CheckpointManifest;
}
export interface VerifiedArchive { header: CheckpointHeader; manifest: CheckpointManifest; sizeBytes: number }

// ---- sealing --------------------------------------------------------------------------------
export interface ICheckpointSealing {
  generateDataKey(): Promise<{ plaintext: Buffer; platformWrapped: string }>;
  unwrapPlatform(wrapped: string): Promise<Buffer>;
  wrapWithPassphrase(dataKey: Buffer, passphrase: string): Promise<PassphraseWrap>;
  unwrapWithPassphrase(wrap: PassphraseWrap, passphrase: string): Promise<Buffer>;
  sign(digest: Buffer): Promise<string>;
  verify(digest: Buffer, signature: string): Promise<boolean>;
  deploymentId(): Promise<string>;
}
export const ICheckpointSealing = Symbol('ICheckpointSealing');

// ---- store ----------------------------------------------------------------------------------
export interface ICheckpointStore {
  ensureBucket(): Promise<void>;
  objectKey(tenantId: string, checkpointId: string): string;              // `${tenantId}/${checkpointId}.hcp`
  openWriteStream(key: string): { stream: Writable; done: Promise<{ sizeBytes: number }>; abort(): Promise<void> };
  openReadStream(key: string): Promise<Readable>;
  presignDownload(key: string, filename: string, ttlSeconds: number): Promise<string>;
  createUpload(key: string): Promise<{ uploadId: string }>;
  presignUploadParts(key: string, uploadId: string, partCount: number, ttlSeconds: number): Promise<{ partNumber: number; url: string }[]>;
  completeUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<{ sizeBytes: number }>;
  abortUpload(key: string, uploadId: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export const ICheckpointStore = Symbol('ICheckpointStore');

// ---- lock -----------------------------------------------------------------------------------
export interface TenantLockState { locked: boolean; restoreId?: string }
export interface ITenantLockService {
  state(tenantId: string): Promise<TenantLockState>;
  /** Drop every node's cached state for the tenant (publishes on TENANT_LOCK_CHANNEL). */
  publishChange(tenantId: string): Promise<void>;
}
export const ITenantLockService = Symbol('ITenantLockService');
export const TENANT_LOCKING_STATUSES = ['LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'RECONCILING', 'POST_COMMIT'] as const;

// ---- runners (worker side) -----------------------------------------------------------------
export interface ICheckpointExportRunner { run(checkpointId: string): Promise<void> }
export const ICheckpointExportRunner = Symbol('ICheckpointExportRunner');
export interface ICheckpointVerifyRunner { run(checkpointId: string): Promise<void> }
export const ICheckpointVerifyRunner = Symbol('ICheckpointVerifyRunner');
export interface CheckpointExportJob { kind: 'create' | 'verify-upload'; checkpointId: string; tenantId: string }
export interface CheckpointRestoreJob { restoreId: string; tenantId: string }

export interface ReconcileCount { model: string; inserted: number; updated: number; retired: number }
export interface RestoreWarning { code: string; message: string; detail?: Record<string, unknown> }

// ---- errors ---------------------------------------------------------------------------------
export type CheckpointFailureReason =
  | 'UNSUPPORTED_FORMAT' | 'SIGNATURE_INVALID' | 'WRONG_TENANT' | 'FOREIGN_DEPLOYMENT'
  | 'CORRUPT_SEGMENT' | 'MANIFEST_MISMATCH' | 'DUPLICATE' | 'PASSPHRASE_INVALID'
  | 'SEALING_UNAVAILABLE' | 'UPLOAD_PARTS_INVALID' | 'SCHEMA_INCOMPATIBLE'
  | 'EXPORT_FAILED' | 'RESTORE_FAILED' | 'LOCK_TIMEOUT' | 'WORKER_LOST' | 'CANCELLED';

export class CheckpointError extends Error {
  constructor(
    readonly reason: CheckpointFailureReason,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}
```

- [ ] **Step 2:** write `db/checkpoint-pg.ts` — the first production raw `pg` pool; worker-only:

```ts
import { Pool } from 'pg';
import type { SqlQuery } from '../contracts';

/** Direct (un-pooled) connection for COPY; Prisma cannot COPY. Worker process only, max 2. */
export function createCheckpointPool(env: NodeJS.ProcessEnv = process.env): Pool {
  const url = env.DIRECT_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) throw new Error('checkpoint worker needs DIRECT_URL or DATABASE_URL');
  return new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000, application_name: 'hope-checkpoint-worker' });
}

export function sqlQueryOver(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): SqlQuery {
  return async <T,>(sql: string, params: readonly unknown[] = []) => (await client.query(sql, [...params])).rows as T[];
}
```

  (In Vault mode the DB credential comes from `VAULT_PRISMA_FACTORY`; W3 checks whether the worker must obtain the `pg` URL from that factory instead and adapts `createCheckpointPool` — recorded as a W3 step.)
- [ ] **Step 3:** barrel `tenant-checkpoint/index.ts` exporting `./contracts`. Commit:

```bash
git add packages/database packages/domains/src/enums packages/applications/package.json pnpm-lock.yaml packages/applications/src/services/tenant-checkpoint packages/applications/src/services/baseServices/redis/queue-concurrency.ts
git commit -m "feat(task-1032): checkpoint schema, enums, queues, deps and shared contracts"
```

- [ ] **Step 4:** re-check HEAD is still what W0 started from plus W0's commit (second-writer rule); create the six W1 worktrees (§6.3); start the test infra (`pnpm infra:test:up`, `pnpm test:db:reset`) so L6b can use it in W2.

---

### 6.5 Wave 1 lanes (parallel)

#### L1 — Domain trio · `sonnet` · effort low

**Rules:** 00, 01, 03, 14. **Owns:** `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/TenantCheckpoint*.ts` and
`TenantCheckpointRestore*.ts`, the four barrels' new lines, `packages/domains/src/common/databaseServices/core/core.database.module.ts`,
`packages/database/src/extensions/tenant-scope.ts`. **Must not touch:** anything else; never run `gen:mapper`/`gen:repository`.

**Interfaces — produces:** `TenantCheckpointEntity`, `TenantCheckpointFactory.CreateTenantCheckpoint(props)`,
`TenantCheckpointRepository` (+ the same four for `TenantCheckpointRestore`) with these custom methods:

```ts
// TenantCheckpointRepository
findByTenant(tenantId: string, opts: { skip: number; take: number; kind?: 'MANUAL' | 'SAFETY' }, tx?: unknown): Promise<{ rows: TenantCheckpointEntity[]; total: number }>;
findRunningByTenant(tenantId: string, tx?: unknown): Promise<TenantCheckpointEntity[]>;          // status IN (PENDING, UPLOADING, RUNNING)
findStale(heartbeatBefore: Date, tx?: unknown): Promise<TenantCheckpointEntity[]>;                 // status RUNNING AND heartbeatAt < x, any tenant (worker)
findExpired(now: Date, tx?: unknown): Promise<TenantCheckpointEntity[]>;                           // status READY AND expiresAt < now, any tenant (worker)
// TenantCheckpointRestoreRepository
findActiveByTenant(tenantId: string, tx?: unknown): Promise<TenantCheckpointRestoreEntity | null>; // status NOT terminal
findByTenant(tenantId: string, opts: { skip: number; take: number }, tx?: unknown): Promise<{ rows: TenantCheckpointRestoreEntity[]; total: number }>;
findStaleActive(heartbeatBefore: Date, tx?: unknown): Promise<TenantCheckpointRestoreEntity[]>;    // non-terminal AND heartbeatAt < x
```

`sizeBytes` is `BigInt` in Prisma; the entity exposes it as `number | null` (convert in the mapper `$toDomain`/`$toPersistence` handlers — safe below 2^53).

- [ ] **Task 1 / Step 1 — failing test** `packages/domains/src/repositories/generated/core/__tests__/tenant-checkpoint.mapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TenantCheckpointFactory } from '../../../../factories';
import { TenantCheckpointEntityMapper } from '../../../../mappers';

describe('TenantCheckpoint mapper', () => {
  it('never writes _version and maps sizeBytes number ↔ bigint', () => {
    const entity = TenantCheckpointFactory.CreateTenantCheckpoint({ tenantId: 't-1', label: 'before upgrade' });
    entity.sizeBytes = 1234;
    const row = TenantCheckpointEntityMapper.getInstance().toPersistence(entity) as Record<string, unknown>;
    expect(row).not.toHaveProperty('version');
    expect(row.sizeBytes).toBe(1234n);
    const back = TenantCheckpointEntityMapper.getInstance().toDomainEntity({ ...row, version: 3 } as never);
    expect(back.sizeBytes).toBe(1234);
    expect(back.status).toBe('PENDING');
    expect(back.kind).toBe('MANUAL');
  });
});
```

- [ ] **Step 2:** run `pnpm --filter @arcaai/domains exec vitest run src/repositories/generated/core/__tests__/tenant-checkpoint.mapper.test.ts` → FAIL (module not found).
- [ ] **Step 3:** hand-author entity/factory/mapper/repository ×2 copying `AiRoutingPolicy*` (paths in §2.4 / rule 03); mapper keeps `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields`; repository delegate names `'tenantCheckpoint'` / `'tenantCheckpointRestore'`; the "any tenant" worker methods use the passed `tx` or `this.db` without a tenant filter and say so in a JSDoc line.
- [ ] **Step 4:** register both repositories in `core.database.module.ts` (import + `repositories` array); add barrel lines (entity, factory, mapper, repository, model barrels — `gen:model` already wrote the model files).
- [ ] **Step 5:** add both models to `TENANT_SCOPED_MODELS` under a `// tenant-checkpoint.prisma` banner.
- [ ] **Step 6:** add a second test file `tenant-checkpoint-restore.mapper.test.ts` asserting `categories` round-trips as a string array and `version` is stripped; RED → implement → GREEN. Commit `feat(task-1032/l1): TenantCheckpoint + TenantCheckpointRestore domain trio`.

#### L2 — Model registry · `opus` · effort medium

**Rules:** 00, 01, 02, 03, 14 + this spec §2.1, §3.4, §3.5, §6.0 C-6/C-7. **Owns:** `packages/applications/src/services/tenant-checkpoint/registry/**`.
**Must not touch:** anything outside that directory.

**Interfaces — consumes:** `contracts.ts` types. **Produces:**

```ts
// registry/registry.ts
export const CHECKPOINT_REGISTRY: readonly CheckpointModelDescriptor[];
export function descriptorFor(model: string): CheckpointModelDescriptor;           // throws on unknown
export function tableName(d: CheckpointModelDescriptor): string;                   // `core."${d.table ?? d.model}"`
// registry/scope.ts
/** WHERE-clause over alias `alias` for this descriptor; tenant id is always `$1`. Recurses through `parent`. */
export function scopePredicate(d: CheckpointModelDescriptor, alias: string): string;
// registry/order.ts
export interface FkEdge { child: string; parent: string; column: string }
export function loadFkEdges(query: SqlQuery): Promise<FkEdge[]>;                    // pg_constraint, schema core
/** Parents before children over the given models; self-edges ignored (a single INSERT…SELECT satisfies them). */
export function insertOrder(models: readonly string[], edges: readonly FkEdge[]): string[];
// registry/schema.ts
export function currentColumns(query: SqlQuery, tables: readonly string[]): Promise<Record<string, string[]>>;
export function schemaFingerprint(query: SqlQuery): Promise<string>;               // sha256 over migration names + sorted column lists
export interface CompatibilityProblem { model: string; column: string; problem: 'NOT_NULL_WITHOUT_DEFAULT' | 'TABLE_MISSING' }
export function checkCompatibility(summary: ManifestSummary, query: SqlQuery): Promise<CompatibilityProblem[]>;
```

Classification is taken from §3.5 with C-6/C-7 applied. Specific calls the lane must encode (the verdicts of this feature):

| Model(s) | category · policy · retire |
|---|---|
| `User` | USERS_ACCESS · INSERT_ONLY · never · scope `tenantMembers` |
| `UserProfile`, `UserSettings` | USERS_ACCESS · INSERT_ONLY · never · scope `parent` → `User` |
| `ApiKey`, `ServiceAccount`, `StorageAccessKey` | USERS_ACCESS · RETIRE_ONLY · `revoke` (read each model for its revocation columns; `ServiceAccount`/`ApiKey` are unscoped in Prisma but carry `tenantId` → `tenantColumn`) |
| `UserRoleAssignment`, `UserDepartment` | USERS_ACCESS · RECONCILE · per soft-delete flag |
| `Role` | USERS_ACCESS · RECONCILE · scope `tenantColumn` (SYSTEM built-ins excluded by the predicate) |
| `RolePolicy` | USERS_ACCESS · RECONCILE · scope `parent` → `Role`, hardDelete |
| `KnowledgeChunk` | CONFIG_CONTENT · CAPTURE_ONLY · never · `derivedFrom: 'KnowledgeDocument'` |
| `Agent`, `WorkflowDefinition`, `AgentModelFallback`, `DocumentTemplateVersion` | RECONCILE · softDelete (or `never` where the trigger forbids every UPDATE — read it) · `immutableColumns` + `immutableWhen` from the trigger |
| `AgentAssignmentChange`, `WorkflowAssignmentChange`, `HarnessPolicyChange`, `AgentPromotion`, `HarnessAuditEvent` | LOGS · CAPTURE_ONLY |
| `PasswordResetToken`, `Tenant`, `TenantEntitlement`, `PlanEntitlement`, `AiPriceBook`, `ModelResidencyPolicy`, `ServiceRelease`, `ServiceInstance`, `ChangelogEntry`, `Policy`, `FedlClient`, `FedlRound`, `FedlUpdate`, `FedlModelVersion` | EXCLUDED · scope `none` |
| `AiModel` | CONFIG_CONTENT · RECONCILE · `tenantColumn` (BYO rows only — the SYSTEM rows never match `$1`) |
| `TenantCheckpoint`, `TenantCheckpointRestore` | EXCLUDED (a checkpoint never contains checkpoints) |

- [ ] **Task 1 / Step 1 — failing test** `registry/__tests__/registry.completeness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Prisma, MODELS_WITHOUT_SOFT_DELETE } from '@arcaai/database';
import { CHECKPOINT_REGISTRY } from '../registry';

describe('checkpoint registry', () => {
  it('describes every Prisma model exactly once', () => {
    const models = Object.values(Prisma.ModelName).sort();
    const described = CHECKPOINT_REGISTRY.map((d) => d.model).sort();
    expect(described).toEqual(models);
  });

  it('agrees with MODELS_WITHOUT_SOFT_DELETE', () => {
    for (const d of CHECKPOINT_REGISTRY) {
      expect({ model: d.model, softDelete: d.softDelete }).toEqual({ model: d.model, softDelete: !MODELS_WITHOUT_SOFT_DELETE.has(d.model) });
    }
  });

  it('never soft-deletes a model without soft delete and never restores an EXCLUDED/LOGS model', () => {
    for (const d of CHECKPOINT_REGISTRY) {
      if (!d.softDelete) expect(d.retire.kind, d.model).not.toBe('softDelete');
      if (d.category === 'LOGS') expect(d.policy, d.model).toBe('CAPTURE_ONLY');
      if (d.category === 'EXCLUDED') expect([d.policy, d.scope.kind], d.model).toEqual(['EXCLUDED', 'none']);
    }
  });
});
```

  If `MODELS_WITHOUT_SOFT_DELETE` is not exported from the `@arcaai/database` root barrel, import it from its module path and record that under `deviations`.
- [ ] **Step 2:** run `pnpm --filter @arcaai/applications exec vitest run src/services/tenant-checkpoint/registry/__tests__/registry.completeness.test.ts` → FAIL.
- [ ] **Step 3:** write `registry.ts` — one descriptor per model, grouped by category with a banner comment per group, every `notes` field explaining any non-obvious call.
- [ ] **Step 4:** GREEN. Commit.
- [ ] **Task 2 — trigger parity.** Test `registry.trigger-parity.test.ts`: read every `migration.sql` under `packages/database/src/prisma/db_main/migrations/` in name order; for each of the five guard functions take the LAST `CREATE OR REPLACE FUNCTION <name>` body; extract every `"<col>" IS DISTINCT FROM` column; assert the set equals the guarded model's `immutableColumns`. Map: `workflow_definition_immutability_guard` → WorkflowDefinition, `agent_immutability_guard` → Agent, `agent_model_fallback_immutability_guard` → AgentModelFallback (refuses all UPDATE/DELETE while the parent Agent is published → `immutableWhen` over the parent), `document_template_version_immutability_guard` → DocumentTemplateVersion (refuses ALL update/delete → policy RECONCILE with `retire: never` and an `immutableWhen` of `true`), `agent_assignment_change_worm_guard` → AgentAssignmentChange (CAPTURE_ONLY, so asserted absent from restore). RED → implement → GREEN → commit.
- [ ] **Task 3 — scope predicates.** Test `scope.test.ts` with literal expectations:

```ts
expect(scopePredicate(descriptorFor('Agent'), 's')).toBe('s."tenantId" = $1');
expect(scopePredicate(descriptorFor('WebhookRunHistory'), 's')).toBe(
  's."webhookId" IN (SELECT p."id" FROM core."Webhook" p WHERE p."tenantId" = $1)');
expect(scopePredicate(descriptorFor('User'), 's')).toBe(
  's."id" IN (SELECT "userId" FROM core."UserRoleAssignment" WHERE "tenantId" = $1 UNION SELECT "userId" FROM core."UserDepartment" WHERE "tenantId" = $1)');
expect(() => scopePredicate(descriptorFor('Tenant'), 's')).toThrow(/EXCLUDED/);
```

  (Nested parents alias `p`, `p2`, … so a two-level parent stays valid SQL; add a case for `UserProfile` → `User`.) RED → implement → GREEN → commit.
- [ ] **Task 4 — insert order.** Test `order.test.ts`: `insertOrder(['ContextItem','Consultation','AudioRecording'], [{child:'ContextItem',parent:'Consultation',column:'consultationId'},{child:'AudioRecording',parent:'ContextItem',column:'contextItemId'},{child:'Consultation',parent:'Consultation',column:'parentConsultationId'}])` returns `['Consultation','ContextItem','AudioRecording']`; a cycle between two distinct tables throws naming both. `loadFkEdges` SQL:

```sql
SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, a.attname AS column
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
WHERE c.contype = 'f' AND c.connamespace = 'core'::regnamespace
```

  (strip the `core."…"` quoting to model names). RED → implement → GREEN → commit.
- [ ] **Task 5 — compatibility.** Test `schema.test.ts` with a fake `SqlQuery`: a summary column absent from the table → no problem (dropped); a live `NOT NULL` column with no default absent from the summary → `NOT_NULL_WITHOUT_DEFAULT`; a summary table absent live → `TABLE_MISSING`. `checkCompatibility` reads `information_schema.columns` (`is_nullable`, `column_default`, `is_identity`). RED → implement → GREEN → commit.

#### L3 — Archive, sealing, store, offline opener · `opus` · effort high

**Rules:** 00, 01, 04, 09, 14. **Owns:** `tenant-checkpoint/{archive,sealing,store}/**`,
`packages/applications/src/services/baseServices/_meta/secrets/{SecretsService.ts,providers/vault-secrets.provider.ts}` (sign/verify/public key),
`packages/applications/src/services/baseServices/storage/providers/{IBlobStorageProvider.ts,s3-blob.provider.ts,azure-blob.provider.ts}` (multipart + streaming put),
`scripts/checkpoint-open.ts`, root `package.json` script line `"checkpoint:open"`.
**Must not touch:** the registry, processors, API, console.

**Archive byte layout (normative):**

```
file    := HEADER BODY TRAILER
HEADER  := "HOPECKPT" (8 bytes) ‖ u32be headerLen ‖ headerJson (UTF-8, CheckpointHeader)
BODY    := SEGMENT*      each SEGMENT := u32be cipherLen ‖ AES-256-GCM(ciphertext ‖ 16-byte tag)
           plaintext of segment i is ≤ 64 KiB of the ENTRY STREAM; nonce_i = noncePrefix(7) ‖ u32be(i) ‖ lastFlag(1: 0x00 | 0x01)
           AAD of segment 0 = the HEADER bytes; AAD of every other segment = empty
ENTRY STREAM := ENTRY* END
ENTRY   := 0x01 ‖ u16be nameLen ‖ name ‖ CHUNK* ‖ u32be 0      (CHUNK := u32be len ‖ bytes, len > 0)
END     := 0x00
TRAILER := "HCPTRAIL" ‖ 32-byte sha256(HEADER ‖ BODY) ‖ u16be sigLen ‖ signature (UTF-8 "vault:v1:…")
```

`manifest.json` is always the LAST entry. The data key is 32 random bytes from `crypto.randomBytes`.

**Interfaces — produces** (all exported from `tenant-checkpoint/index.ts` by W3; the lane exports them from its own dirs):

```ts
// archive/writer.ts
export function createArchiveWriter(args: {
  header: Omit<CheckpointHeader, 'magic' | 'formatVersion' | 'noncePrefix'>;   // keys already filled by the caller
  dataKey: Buffer;
  sink: Writable;
  sealing: Pick<ICheckpointSealing, 'sign'>;
}): CheckpointArchiveWriter;
// archive/reader.ts
export function readHeader(source: Readable): Promise<{ header: CheckpointHeader; rest: Readable }>;
export function openArchive(source: Readable, dataKey: Buffer): Promise<CheckpointArchiveReader>;
// archive/verify.ts — the §3.2 gate; `open` is called twice (pass 1: digest + signature, pass 2: decrypt)
export function verifyArchive(args: {
  open: () => Promise<Readable>;
  expectTenantId: string;
  sealing: ICheckpointSealing;
  existingCheckpointIds?: ReadonlySet<string>;     // upload only → DUPLICATE
}): Promise<VerifiedArchive>;
// sealing/checkpoint-sealing.ts
@Injectable() export class CheckpointSealing implements ICheckpointSealing { constructor(secrets: SecretsService) }
// store/checkpoint-store.ts
@Injectable() export class CheckpointStore implements ICheckpointStore { constructor(factory: BlobStorageProviderFactory) }
// SecretsService additions
supportsSigning(): boolean;
sign(keyName: string, data: Buffer): Promise<string>;               // transit/sign/<key>, input base64; returns "vault:v1:…"
verify(keyName: string, data: Buffer, signature: string): Promise<boolean>;   // transit/verify/<key>
publicKey(keyName: string): Promise<string>;                        // transit/keys/<key> → keys[latest].public_key
```

`SecretsService.sign`/`verify`/`publicKey` throw `CheckpointError('SEALING_UNAVAILABLE', …)` when the provider is not Vault (same
runtime capability check as `encrypt`). Argon2id parameters: `m = 65536` KiB, `t = 3`, `p = 1` (hash-wasm `argon2id`, 32-byte output).

- [ ] **Task 1 — round trip.** Test `archive/__tests__/archive.roundtrip.test.ts` using an in-memory fake sealing:

```ts
import { PassThrough, Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createArchiveWriter } from '../writer';
import { openArchive } from '../reader';
import { fakeSealing, collect, baseHeader, manifestFor } from './helpers';

describe('archive round trip', () => {
  it('returns every entry byte-identical, in order, with the manifest last', async () => {
    const dataKey = randomBytes(32);
    const sink = new PassThrough();
    const bytes = collect(sink);
    const w = createArchiveWriter({ header: baseHeader(), dataKey, sink, sealing: fakeSealing() });
    const big = randomBytes(300 * 1024);                     // spans several 64 KiB segments
    const a = await w.writeEntry('db/Agent.csv.gz', Readable.from([big.subarray(0, 1000), big.subarray(1000)]));
    await w.writeEntry('media/b1/2026/10/01/x.wav', Buffer.from('tiny'));
    await w.finish(manifestFor([{ model: 'Agent', sha256: a.sha256 }]));
    const r = await openArchive(Readable.from(await bytes), dataKey);
    const seen: [string, Buffer][] = [];
    for await (const e of r.entries()) seen.push([e.name, Buffer.concat(await e.body.toArray())]);
    expect(seen.map(([n]) => n)).toEqual(['db/Agent.csv.gz', 'media/b1/2026/10/01/x.wav']);
    expect(seen[0][1].equals(big)).toBe(true);
    expect(r.manifest().tables[0].sha256).toBe(a.sha256);
  });
});
```

  `helpers.ts` (same dir) provides `fakeSealing()` (AES key wrap with a fixed test key; `sign` = HMAC; `deploymentId` = `'test-deployment'`), `collect(stream): Promise<Buffer>`, `baseHeader()`, `manifestFor(tables)`. RED → implement writer + reader → GREEN → commit.
- [ ] **Task 2 — tamper matrix.** Test `archive/__tests__/archive.tamper.test.ts`, one `it` per row; each builds a valid archive then mutates it and calls `verifyArchive`:

| Mutation | Expected `reason` |
|---|---|
| first 8 bytes changed | `UNSUPPORTED_FORMAT` |
| `formatVersion` 99 in header | `UNSUPPORTED_FORMAT` |
| one byte flipped in BODY | `SIGNATURE_INVALID` (digest differs) |
| one byte flipped AND trailer re-signed with the fake key (passphrase-holder forgery path) | `CORRUPT_SEGMENT` |
| last segment dropped, re-signed | `CORRUPT_SEGMENT` (no last-flag segment) |
| segments 2 and 3 swapped, re-signed | `CORRUPT_SEGMENT` |
| header `tenantId` swapped to tenant B, re-signed, verified with `expectTenantId` = B | `CORRUPT_SEGMENT` (segment-0 AAD binds the header) |
| valid archive, `expectTenantId` = other tenant | `WRONG_TENANT` |
| header `sourceDeploymentId` ≠ `sealing.deploymentId()` | `FOREIGN_DEPLOYMENT` |
| manifest sha256 for an entry altered before sealing | `MANIFEST_MISMATCH` |
| `existingCheckpointIds` contains the header id | `DUPLICATE` |

  Gate order is exactly C-13 (§6.0), which supersedes §3.2. RED → implement `verify.ts` → GREEN → commit.
- [ ] **Task 3 — sealing.** Test `sealing/__tests__/checkpoint-sealing.test.ts` with a stub `SecretsService` (records calls): `generateDataKey` returns 32 bytes and calls `encrypt(…, 'hope-checkpoint')`; `wrapWithPassphrase`→`unwrapWithPassphrase` round-trips; a wrong passphrase rejects with `PASSPHRASE_INVALID`; `deploymentId()` = hex sha256 of `publicKey('hope-checkpoint-sign')` and is memoised; a non-Vault provider → `SEALING_UNAVAILABLE`. Also `vault-secrets.provider` unit test for `sign`/`verify`/`publicKey` against a stub node-vault client asserting paths `transit/sign/hope-checkpoint-sign`, `transit/verify/hope-checkpoint-sign`, `transit/keys/hope-checkpoint-sign` and base64 input. RED → implement → GREEN → commit.
- [ ] **Task 4 — store.** Test `store/__tests__/checkpoint-store.test.ts` with a fake provider: `objectKey('t','c') === 't/c.hcp'`; `presignDownload` passes `ResponseContentDisposition: attachment; filename="<name>"`; `completeUpload` with parts `[2,1]`, `[1,1]`, `[]` or a gap rejects `UPLOAD_PARTS_INVALID` before calling the provider; `ensureBucket` calls `createBucket` only when `bucketExists` is false. Extend `IBlobStorageProvider` with optional `putObjectStream`, `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`; implement in `s3-blob.provider.ts` (copy `ai-model/publish/model-store.ts:142-185`; presign parts with the provider's `presignClient` so URLs use the public endpoint); `azure-blob.provider.ts` throws `Error('checkpoint multipart is S3-only')`. RED → implement → GREEN → commit.
- [ ] **Task 5 — offline opener.** Test `scripts/__tests__/checkpoint-open.test.ts` (run with `pnpm exec vitest run scripts/__tests__/checkpoint-open.test.ts` from the root): build a passphrase-sealed archive with the fake sealing into a tmp file; `openCheckpointFile({ file, out, passphrase })` writes every entry under `out/` with entry names as relative paths and refuses names containing `..` or starting with `/`; a wrong passphrase rejects `PASSPHRASE_INVALID` and leaves `out/` absent; output reports `signature: present, not verified` without `--public-key`, `verified` with the right PEM, `INVALID` with another. The CLI wrapper reads the passphrase from a TTY prompt (no echo) or `HOPE_CHECKPOINT_PASSPHRASE` for non-interactive use; no network. Root script `"checkpoint:open": "tsx scripts/checkpoint-open.ts"` (use whatever TS runner existing root scripts use — check `package.json`). RED → implement → GREEN → commit.

#### L4 — Tenant lock · `sonnet` · effort high

**Rules:** 00, 01, 04, 05, 14. **Owns:** `tenant-checkpoint/lock/**`, `apps/api/src/guards/tenant-lock.guard.ts` (+ test),
`apps/api/src/decorators/tenant-lock-exempt.decorator.ts` (+ re-export in `apps/api/src/decorators/index.ts`),
`apps/api/src/modules/streaming/stt-ws.gateway.ts` (the open-path check only), and the shared worker-session helper in
`packages/applications/src/common/worker-session*` (lock check only). **Must not touch:** `app.module.ts` (W3 registers the guard).

**Interfaces — consumes:** `ITenantLockService`, `TENANT_LOCK_CHANNEL`, `TENANT_LOCKING_STATUSES`, `TenantCheckpointRestoreRepository.findActiveByTenant` (L1, same wave — it does not exist in your worktree: inject it with `@Inject(TenantCheckpointRestoreRepository)` imported from `@arcaai/domains` and type the test double with a local `interface ActiveRestoreReader { findActiveByTenant(tenantId: string): Promise<{ id: string; status: string } | null> }`; report it as an expected unresolved import — W3 resolves it after L1 merges).
**Produces:**

```ts
// lock/tenant-lock.service.ts
@Injectable() export class TenantLockService implements ITenantLockService, OnModuleInit
// per-process Map<tenantId, { state, expiresAt }>, TTL 5 s; subscribes TENANT_LOCK_CHANNEL via RedisSubscriberService
// (copy app-settings:invalidate — appSettings.service.ts:561/586); publishChange → IRedisCacheService.publish
// lock/tenant-lock.module.ts — exports ITenantLockService
// lock/tenant-locked.error.ts
export class TenantLockedError extends Error { constructor(readonly tenantId: string, readonly restoreId?: string) }
// apps/api: @TenantLockExempt() sets metadata TENANT_LOCK_EXEMPT_KEY
export const TENANT_LOCK_EXEMPT_KEY = 'tenantLockExempt';
// guard → HttpException(423) body { statusCode: 423, code: 'TENANT_RESTORE_IN_PROGRESS', message, restoreId }
```

- [ ] **Task 1 — service.** Test `lock/__tests__/tenant-lock.service.test.ts`: state comes from `findActiveByTenant` (status ∈ `TENANT_LOCKING_STATUSES` ⇒ locked; `PENDING` ⇒ not locked); second call within 5 s does not hit the repository; a channel message for the tenant drops the cache; `publishChange` publishes `{ tenantId }`; a repository error ⇒ `locked: false` is NOT acceptable — it rethrows (fail closed: the guard turns it into 503). RED → implement → GREEN → commit.
- [ ] **Task 2 — guard.** Test `apps/api/src/guards/__tests__/tenant-lock.guard.test.ts`:

```ts
it('423s a request whose CLS tenant is locked', async () => {
  const guard = new TenantLockGuard(reflectorReturning(false), clsWith({ tenantId: 'T' }), lockService({ T: { locked: true, restoreId: 'R' } }));
  await expect(guard.canActivate(httpContext())).rejects.toMatchObject({ status: 423, response: { code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' } });
});
it('lets an exempt handler through', async () => { /* reflector returns true → resolves true, lock never queried */ });
it('ignores requests with no tenant context', async () => { /* tenantId undefined → true */ });
it('ignores non-http contexts (ws is checked in the gateway)', async () => { /* getType() === 'ws' → true */ });
it('fails closed with 503 when the lock state cannot be read', async () => { /* lockService.state rejects → ServiceUnavailableException, code TENANT_LOCK_UNAVAILABLE */ });
```

  The guard reads `this.cls.get('tenantId')` (pattern: `tenant-owned-resource.interceptor.ts:65`). Before writing it, confirm how internal routes (`/api/v1/internal/*`, harness/STT callbacks carrying `X-Tenant-Id`) populate CLS `tenantId`, and state the answer in the report; if they do not, the guard also reads the validated `X-Tenant-Id` the same way that path's auth does, and the test gains a case for it. RED → implement → GREEN → commit.
- [ ] **Task 3 — background jobs (Review Focus 1).** Find the shared helper processors use to enter a tenant (`createWorkerSession` / `runJobInContext` under `packages/applications/src/common/`). Test: when the tenant is locked, the helper throws `TenantLockedError` BEFORE running the job body; then make each BullMQ `WorkerHost` path that uses the helper translate `TenantLockedError` into a postponement — `await job.moveToDelayed(Date.now() + 30_000, token); throw new DelayedError();` (BullMQ's documented pattern; the job keeps its attempt count). If processors do not receive `token`, implement the translation once in the helper's caller layer and list every processor it covers in the report. The checkpoint queues themselves are exempt (they hold the lock). RED → implement → GREEN → commit.
- [ ] **Task 4 — STT socket.** In `SttWsGateway.handleConnection`, after the ticket is consumed and `stored.tenantId` is known, a locked tenant closes the socket with code `4423` and reason `TENANT_RESTORE_IN_PROGRESS` before any session state is created. Test in the gateway's existing test file style. RED → implement → GREEN → commit.

#### L5 — Platform plumbing · `sonnet` · effort low

**Rules:** 00, 01, 09, 14. **Owns:** `infrastructure/docker/configs/vault/{dev-init.sh,test-init.sh}`, `infrastructure/docker/configs/vault/policies/hope-app.hcl`,
`infrastructure/docker/docker-compose.yml` (minio-setup), `tests/docker-compose.test.yml` (minio init), `packages/domains/src/utils/platformBuckets.ts` (+ its test),
`packages/applications/src/services/settings-registry/descriptors/tenant-checkpoint.descriptors.ts` + its line in `registry.ts`,
`packages/database/src/prisma/db_main/seed/01-policy.ts`.

- [ ] **Task 1 — Vault.** `dev-init.sh` and `test-init.sh`: after the `hope-phi` block, create `hope-checkpoint` (`vault write -f transit/keys/hope-checkpoint` + config `min_decryption_version=1 deletion_allowed=false exportable=false`) and `hope-checkpoint-sign` (`vault write transit/keys/hope-checkpoint-sign type=ed25519` + config `deletion_allowed=false`). `hope-app.hcl`: `transit/encrypt/hope-checkpoint`, `transit/decrypt/hope-checkpoint` (`update`), `transit/sign/hope-checkpoint-sign`, `transit/verify/hope-checkpoint-sign` (`update`), `transit/keys/hope-checkpoint-sign` (`read`). No test (shell config); `bash -n` both scripts and paste the output.
- [ ] **Task 2 — bucket.** Test first in the existing `platformBuckets` test: `isPlatformBucket('hope-tenant-checkpoints')` is true. Add the constant with a `/** … */` comment; add `/usr/bin/mc mb minio/hope-tenant-checkpoints --ignore-existing;` to compose (no double quotes in comments inside that block) and `/usr/bin/mc mb --ignore-existing local/hope-tenant-checkpoints;` to the test compose. RED → GREEN → commit.
- [ ] **Task 3 — settings.** Test `settings-registry/descriptors/__tests__/tenant-checkpoint.descriptors.test.ts`: the four keys exist in `HOPE_SETTINGS_REGISTRY` with defaults 30 / 10 / 50 / 60, `failMode: 'open-to-default'`, `dataType: 'number'`, tenant-overridable (`maxScope: 'tenant'`, `globalOnly: false` — copy an existing tenant-overridable descriptor's shape), and `validate` rejects 0, negatives and non-integers (`maxLockMinutes` max 240, `maxUploadSizeGb` max 500). Export the key constants `TENANT_CHECKPOINT_RETENTION_DAYS_KEY`, `TENANT_CHECKPOINT_MAX_RETAINED_KEY`, `TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY`, `TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY` and `TENANT_CHECKPOINT_DEFAULTS`. RED → GREEN → commit.
- [ ] **Task 4 — CASL.** In `tenant-full-access` add `{ action: 'manage', subject: 'TenantCheckpoint', conditions: { tenantId: '${context.tenantId}' } }` next to `TenantTelemetry`. If a seed conformance test pins the rule list, update it in the same commit. Commit.

#### L9 — Console · `sonnet` · effort medium (spans W1 → W2)

**Rules:** 00, 01, 07, 10, 11, 12, 13, 14 + skills `web-accessibility`, `shadcn-ui`. **Owns:** `apps/admin-console/src/features/tenant-checkpoints/**`,
`apps/admin-console/src/app/(console)/(tenant)/checkpoints/**` (`page.tsx`, `loading.tsx`), `src/shared/navigation/nav-config.ts` + `__tests__/nav-config.test.ts`
(one entry + its pinned row), the tenant-detail link in `src/features/tenants/components/tenant-detail-screen.tsx`, `apps/admin-console/tests/e2e/tenant-checkpoints.spec.ts`.

**API contract (from §3.1; the backend lands in W2 — code against this):** base `admin/tenants/${tenantId}/checkpoints`, through `@/shared/api`.

```ts
export type CheckpointStatus = 'PENDING' | 'UPLOADING' | 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED';
export interface TenantCheckpoint {
  id: string; tenantId: string; label: string; kind: 'MANUAL' | 'SAFETY'; origin: 'CREATED' | 'UPLOADED';
  status: CheckpointStatus; includesMedia: boolean; passphraseProtected: boolean; sizeBytes: number | null;
  progress: { phase: string; tablesDone: number; tablesTotal: number; bytesWritten: number } | null;
  createdAt: string; createdBy: string | null; expiresAt: string | null; heartbeatAt: string | null;
  failureReason: string | null; failureDetail: string | null; version: number;
}
export type RestoreStatus = 'PENDING' | 'LOCKING' | 'SAFETY_CHECKPOINT' | 'VERIFYING' | 'RECONCILING' | 'POST_COMMIT' | 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED';
export type RestoreCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL';
export interface TenantCheckpointRestore {
  id: string; checkpointId: string; categories: RestoreCategory[]; reason: string; status: RestoreStatus;
  safetyCheckpointId: string | null; counts: { model: string; inserted: number; updated: number; retired: number }[] | null;
  warnings: { code: string; message: string; detail?: Record<string, unknown> }[]; requestedBy: string;
  createdAt: string; lockAcquiredAt: string | null; lockReleasedAt: string | null; failureReason: string | null; failureDetail: string | null; version: number;
}
// GET    ''                         → Paginated<TenantCheckpoint>   (?page,&limit,&kind)
// POST   ''                         { label, includesMedia, passphrase? }            → 202 TenantCheckpoint
// GET    ':id'                      → TenantCheckpoint
// POST   ':id/cancel'               → 202 TenantCheckpoint
// POST   ':id/download-url'         → { url, expiresAt, filename }
// DELETE ':id'                      → 204
// POST   'uploads'                  { filename, sizeBytes }                           → 201 { checkpoint, uploadId, partSizeBytes, parts: {partNumber,url}[], expiresAt }
// POST   'uploads/:id/complete'     { parts: {partNumber, etag}[] }                  → 202 TenantCheckpoint
// POST   'uploads/:id/abort'        → 202 TenantCheckpoint
// POST   ':id/restore'              { categories, reason, password, confirmationName } → 202 TenantCheckpointRestore
// GET    'restores'                 → Paginated<TenantCheckpointRestore>
// GET    'restores/:restoreId'      → TenantCheckpointRestore
// 423 on mutations while a restore runs: { code: 'TENANT_RESTORE_IN_PROGRESS', restoreId }
```

Screen contract: `WorkingTenantGate` → `Tabs` → `ScreenTemplate contentMode="fill"` (exemplars `features/harness-policy/components/harness-policy-screen.tsx`, `features/api-keys/components/api-keys-screen.tsx`). Tabs `Checkpoints` | `Restore history`. Header actions: **Create checkpoint** (sheet: label*, include-media switch default on, optional passphrase + confirm with a "store it safely — it cannot be recovered" note), **Upload checkpoint** (dialog: `.hcp` file input showing name/size, per-part progress, Abort). Grid columns: label, kind badge, origin, status badge (`READY` default, `FAILED` destructive, running states secondary with progress text), size, created, expires. Row → `DetailDrawer` (meta, failure reason, actions: Download, Restore…, Cancel when running, Delete with confirm). Restore → `BreakGlassDialog` (`src/shared/confirm/break-glass-dialog.tsx`) extended IN THE FEATURE (wrapping, not forking) with category checkboxes — *Clinical data* rendered only when `isSuperAdmin`, with a destructive warning — and a required reason textarea; `confirmationName` = current tenant name. Polling: `refetchInterval` 3 s while any visible row or restore is non-terminal. A 423 anywhere shows the persistent banner "Restore in progress — this tenant is read-only until it finishes" in the `statusBanner` slot. Nav entry: domain = the domain of the existing `/tenant-profile` entry, `tier: '30-49'`, `required: [['read','TenantCheckpoint'],['manage','TenantCheckpoint']]`, `order` = that domain's highest order + 1, label `Checkpoints`; update the pinned table row.

- [ ] **Task 1 — api layer.** Test `features/tenant-checkpoints/api/__tests__/upload.test.ts` for the pure upload driver `uploadInParts(file, init, putPart)`: slices `file` by `partSizeBytes`, calls `putPart(url, blob)` per part, collects the `ETag` response header, returns parts sorted by `partNumber`; a missing `ETag` throws `UPLOAD_ETAG_MISSING` (MinIO CORS must expose it — Review Focus 3); an abort signal stops further parts. RED → implement `client.ts`, `hooks.ts`, `keys.ts`, `types.ts`, `upload.ts` → GREEN → commit.
- [ ] **Task 2 — restore dialog.** Test `components/__tests__/restore-dialog.test.tsx`: Clinical checkbox absent for a tenant admin, present for a super admin; submit disabled until ≥ 1 category, reason ≥ 10 chars, password, and the typed name; 401/400/403/409 render in-dialog (not toasts); success → `toast.success` and the restore-history tab. RED → implement → GREEN → commit.
- [ ] **Task 3 — screen + route + nav.** Tests: `components/__tests__/checkpoints-screen.test.tsx` (skeleton while loading, `Empty` state with "Create your first checkpoint", running row shows progress, 423 banner) and the nav pinned-row update. RED → implement page, `loading.tsx` (skeleton matching the grid), screen, drawer, sheets → GREEN → commit.
- [ ] **Task 4 — e2e spec (authored, NOT run by the lane).** `tests/e2e/tenant-checkpoints.spec.ts` in the `api-keys.spec.ts` shape: create → wait READY → download URL → restore CONFIG_CONTENT with break-glass → restore history shows COMPLETED; axe light + dark. The orchestrator runs it in W3. Commit.

---

### 6.6 Wave 2 lanes (start after the W1 merges; L9 continues)

#### L6a — Export, verify-upload, sweepers · `opus` · effort medium

**Rules:** 00, 01, 04, 14. **Owns:** `tenant-checkpoint/export/**`. **Must not touch:** `restore/`, the registry, archive internals.

**Interfaces — consumes:** registry (`CHECKPOINT_REGISTRY`, `scopePredicate`, `tableName`, `schemaFingerprint`, `currentColumns`), archive (`createArchiveWriter`, `verifyArchive`), `ICheckpointSealing`, `ICheckpointStore`, `createCheckpointPool`/`sqlQueryOver`, L1 repositories, `BlobStorageProviderFactory`, `IAppSettingsService`, `IRedisCacheService`. **Produces:**

```ts
@Injectable() export class CheckpointExportRunner implements ICheckpointExportRunner { run(checkpointId: string): Promise<void> }
@Injectable() export class CheckpointVerifyRunner implements ICheckpointVerifyRunner { run(checkpointId: string): Promise<void> }
@Processor(JobQueue.TenantCheckpointExport, { concurrency: QUEUE_CONCURRENCY[JobQueue.TenantCheckpointExport] })
export class CheckpointExportProcessor extends WorkerHost   // job.data: CheckpointExportJob → runner by kind
@Injectable() export class CheckpointSweeper   // every 5 min (@Cron): stale RUNNING exports (heartbeat > 2 min) → FAILED(WORKER_LOST) + abort;
                                               // UPLOADING idle > 24 h → abortUpload + CANCELLED;
                                               // daily: retention (§3.3) under Redis lock 'tenant-checkpoint-retention:lock' (copy tenant-storage-purge.service.ts:305-320)
export class CheckpointExportModule   // providers above + exports ICheckpointExportRunner, ICheckpointVerifyRunner
```

Export algorithm (`run`):
1. Load the row; if not `PENDING` → return (idempotent re-delivery). Set `RUNNING`, `startedAt`; heartbeat every 15 s writing `heartbeatAt` + `progress` with `updateWithVersion` (OCC conflicts on heartbeat are swallowed, as `ai-model-download.processor.ts:563-580`).
2. Unwrap the data key from `keyEnvelope.platform`.
3. One `pg` client: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`. `schemaFingerprint`; for every descriptor whose policy ≠ `EXCLUDED`, in `CHECKPOINT_REGISTRY` order: `COPY (SELECT <current columns quoted> FROM <table> s WHERE <scopePredicate(d,'s')>) TO STDOUT (FORMAT csv, HEADER)` with `$1` substituted as a quoted literal of the validated UUID tenant id (COPY takes no bind params — validate `^[0-9a-f-]{36}$` first) → gzip → `writeEntry('db/<Model>.csv.gz')`; count rows by counting CSV records via the gzip-input side (a CSV-aware counter: quoted newlines!). Also `tenant.json` from `SELECT row_to_json(t) FROM core."Tenant" t WHERE id = $1`.
4. Collect `transitKeyVersions`: for each column whose name starts with `encrypted` or equals a known ciphertext column, `SELECT max(substring(col::text from 'vault:v([0-9]+):')::int)` within the same snapshot.
5. `COMMIT`. If `includesMedia`: for each `Media` row of the tenant (from the snapshot result — collect `(bucketId, key)` during step 3 via a separate `SELECT` inside the same transaction, before COMMIT), resolve the bucket's descriptor; DEDICATED → push to `notCaptured`; else stream the object → `writeEntry('media/<bucketId>/<key>')`. Claim-check: `WorkflowRun.resultRef` / `AgentTrajectoryStep.payloadRef` of the tenant → content keys (read `apps/harness/src/harness/temporal/claim_check.py` for the ref format) → `harness-claim-check` bucket → `claimcheck/<contentKey>`; a missing object → `notCaptured`.
6. Between every table and every object: re-read `cancelRequestedAt`; set → `writer.abort`, `store` abort, `CANCELLED`.
7. `finish(manifest)`; row `READY`, `sizeBytes`, `manifestDigest`, `manifestSummary`, `schemaFingerprint`, `sourceDeploymentId`, `objectKey`, `finishedAt`, `expiresAt = now + retentionDays` (setting resolved for the tenant); broadcast `ResourceUpdated` (`ResourceType.TenantCheckpoint`).
8. Any error → `FAILED`, `failureReason` (the `CheckpointError.reason` or `EXPORT_FAILED`), `failureDetail` = message (no stack, no PHI), store abort.

Verify-upload (`CheckpointVerifyRunner.run`): `verifyArchive({ open: () => store.openReadStream(key), expectTenantId, sealing, existingCheckpointIds })` → `READY` with header/manifest-derived fields (`label` stays the uploader's, `kind: MANUAL`, `origin: UPLOADED`, `keyEnvelope` = header keys) or `FAILED(reason)`.

- [ ] **Task 1 — export runner (unit, no DB).** Test `export/__tests__/export-runner.test.ts` with fakes (`fakeQuery` that serves COPY streams per table from fixtures, in-memory store and sealing from L3's `archive/__tests__/helpers.ts` — import, don't copy): the archive contains one entry per non-EXCLUDED descriptor in registry order, then media, then the manifest; `rowCount` counts a CSV field containing a quoted newline as ONE row; the tenant id is refused if not a UUID; cancel between tables → `CANCELLED` and `store.abort` called; a thrown error → `FAILED(EXPORT_FAILED)` with no stack in `failureDetail`; a DEDICATED bucket's media → `notCaptured` and no read attempted. RED → implement → GREEN → commit.
- [ ] **Task 2 — verify runner.** Test `export/__tests__/verify-runner.test.ts`: a valid uploaded archive → `READY` with `origin: UPLOADED` and `manifestSummary` filled; a `WRONG_TENANT` archive → `FAILED` with `failureReason: 'WRONG_TENANT'` and nothing else written. RED → implement → GREEN → commit.
- [ ] **Task 3 — sweeper (Review Focus 3).** Test `export/__tests__/sweeper.test.ts`: stale RUNNING → `FAILED(WORKER_LOST)`; UPLOADING with `updatedAt` 25 h ago → `abortUpload` + `CANCELLED`; retention deletes past-`expiresAt` and beyond-`maxRetained` READY rows but never the newest READY row nor a SAFETY row younger than 7 days; a held Redis lock → skipped. RED → implement → GREEN → commit.

#### L6b — Restore / reconcile · `opus` · effort high · the ONLY lane allowed to use the test DB

**Rules:** 00, 01, 02, 03, 04, 14. **Owns:** `tenant-checkpoint/restore/**` (+ `restore/__tests__/integration/**`). **Must not touch:** anything else; never `test:db:reset` (the orchestrator reset it in W0).

**Interfaces — consumes:** everything L6a consumes + `ICheckpointExportRunner` (safety checkpoint), `ITenantLockService`, `IJwtRevocationService.revokeAllForUser`, `IAppSettingsService.refreshCache`, the knowledge ingest queue (`JobQueue.IngestKnowledgeDocument`, payload `IngestKnowledgeDocumentJobPayload`) and `knowledge-vector-cleanup.client.ts`, `SecretsService.decryptBatch(…, 'hope-phi')`. **Produces:**

```ts
// restore/sql.ts — pure, unit-tested
export function stagingTable(d: CheckpointModelDescriptor): string;                       // pg_temp."stg_<Model>"
export function retireSql(d: CheckpointModelDescriptor, ctx: { actorId: string }): string | null;
export function updateSql(d: CheckpointModelDescriptor, columns: readonly string[]): string | null;
export function insertSql(d: CheckpointModelDescriptor, columns: readonly string[]): string | null;
export function divergedSql(d: CheckpointModelDescriptor, columns: readonly string[]): string | null;  // ids whose immutable cols differ on an immutable live row
// restore/reconciler.ts
export class CheckpointReconciler {
  reconcile(client: PoolClient, args: {
    tenantId: string; categories: readonly RestorableCategory[]; reader: CheckpointArchiveReader;
    actorId: string; restoreId: string;
  }): Promise<{ counts: ReconcileCount[]; warnings: RestoreWarning[]; touchedUserIds: string[]; knowledge: { reingest: string[]; retired: string[] }; retiredConsultationIds: string[] }>;
}
// restore/restore.runner.ts, restore/restore.processor.ts (@Processor(JobQueue.TenantCheckpointRestore)), restore/restore-sweeper.ts, restore/restore.module.ts
export const POST_COMMIT_SETTLE_MS: number;   // ≥ max TTL of every in-process cache over a restored table (C-9); list each cache + TTL in a comment
```

SQL semantics (columns = intersection of checkpoint columns and live columns, excluding `version`/`_version` handled explicitly; every statement carries the scope predicate with `$1` = tenant id):

```sql
-- retire (softDelete), children first:
UPDATE <table> l SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now(),
       "resourceStatusUpdatedBy" = $2, "_version" = l."_version" + 1 [, "isActive" = false  -- when the column exists]
 WHERE <scope(l)> AND l."resourceStatus" <> 'DELETED'
   AND NOT EXISTS (SELECT 1 FROM <stg> s WHERE s."id" = l."id");
-- update (RECONCILE only), parents first:
UPDATE <table> l SET "<c>" = s."<c>", …, "_version" = l."_version" + 1
  FROM <stg> s
 WHERE s."id" = l."id" AND <scope(l)>
   AND NOT (<immutableWhen over l> AND (<any immutable col IS DISTINCT FROM s.col>))   -- diverged rows skipped → warning
   AND (<any restorable col IS DISTINCT FROM s.col>);                                   -- untouched rows keep their _version
-- (update SET list never includes "id", "tenantId", the immutable columns when immutableWhen holds, or "_version" from staging)
-- insert (RECONCILE and INSERT_ONLY), parents first:
INSERT INTO <table> (<cols>) SELECT <cols> FROM <stg> s
 WHERE NOT EXISTS (SELECT 1 FROM <table> l WHERE l."id" = s."id");
```

Staging: `CREATE TEMP TABLE <stg> (LIKE <table> INCLUDING DEFAULTS) ON COMMIT DROP` then `COPY <stg> (<checkpoint columns ∩ live>) FROM STDIN (FORMAT csv, HEADER)`; columns the checkpoint has but live lacks are removed from the CSV stream on the fly. Staging rows whose `tenantId` (or scope) is not the target tenant ⇒ abort with `RESTORE_FAILED` (defence in depth: the archive is signed, but the staging must still prove scope: `SELECT count(*) FROM <stg> s WHERE NOT (<scope(s)>)` must be 0).

Restore runner order = §3.3 worker steps 1–7 with: lock publish via `restoreRepo.update(status LOCKING, lockAcquiredAt)` + `lock.publishChange`; settle `5 s`; safety checkpoint = create a `TenantCheckpoint` row (`kind: SAFETY`, `includesMedia = categories ⊇ CLINICAL`, `keyEnvelope` from `sealing.generateDataKey()`) and `await exportRunner.run(id)` inline; verify; media re-upload; reconcile in one `BEGIN … COMMIT` on a `pg` client; post-commit (settings `refreshCache` + `ResourceUpdated(GlobalSetting)` sys-event; `revokeAllForUser` per `touchedUserIds`; knowledge: delete vectors of `retired`, enqueue ingest per `reingest` with text = the document's checkpoint `KnowledgeChunk.encryptedText` decrypted (`hope-phi`, batch) and joined by `\n\n` in `chunkIndex` order — first read the ingest processor and, if it does not replace prior chunks, delete the document's live chunks before enqueueing; `WorkflowRun` RUNNING of `retiredConsultationIds` → `CANCELED` + `_metadata.canceledBy`); wait `POST_COMMIT_SETTLE_MS` since commit; unlock (`lockReleasedAt`, status terminal, `publishChange`); force-audited `ResourceUpdated` on the restore with categories, reason, counts, safety id. Heartbeat every 15 s throughout. Restore sweeper (every minute): non-terminal with heartbeat > 2 min or `lockAcquiredAt` older than `maxLockMinutes` → `FAILED(WORKER_LOST | LOCK_TIMEOUT)`, `lockReleasedAt`, `publishChange`.

- [ ] **Task 1 — SQL builders (unit).** Test `restore/__tests__/sql.test.ts` with literal SQL expectations for: a soft-delete RECONCILE model (`Department`), a no-soft-delete model (`PromptVersion` → `DELETE`), an `INSERT_ONLY` model (`User` → `retireSql` and `updateSql` null), a `RETIRE_ONLY` model (`ApiKey` → only `retireSql`, using its `revoke.setSql`), `Agent` (`updateSql` contains the `NOT (… IS DISTINCT FROM …)` immutable guard, and `divergedSql` non-null), and a `CAPTURE_ONLY` model (all null). RED → implement → GREEN → commit.
- [ ] **Task 2 — integration harness.** Create `restore/__tests__/integration/reconcile.integration.test.ts` using the `connection-default-lifecycle.integration.test.ts` shape (`describe.skipIf(!enabled)`, throwaway tenant ids `1032a000-0000-4000-8000-000000001032` and a second tenant `1032b000-…`, raw-SQL cleanup of both before each test and after all). Helper `seedTenant(id)` inserts a minimal graph (Department, PromptTemplate + version, Agent DRAFT + PUBLISHED, Role + UserRoleAssignment for a fresh User, ApiKey, Consultation → ContextItem with `parentConsultationId` self-ref, Media row in a fake bucket id, AuditLog row). Helper `checkpointOf(id)` runs the REAL export path against the test DB with the fake store/sealing; `restore(id, categories)` runs the reconciler on a pool client. Run: `HOPE_INTEG_DB=1 npx dotenv -e .env.test -- npx vitest run --config vitest.integration.config.ts packages/applications/src/services/tenant-checkpoint/restore/__tests__/integration/reconcile.integration.test.ts`.
- [ ] **Task 3 — the integration cases (RED first, one `it` each, then implement until GREEN):**
  1. CONFIG_CONTENT alone: change a Department name, add a new PromptTemplate, retire nothing → restore → name back, new template `DELETED`, Consultation and its ContextItems unchanged.
  2. Published Agent created after the checkpoint → `DELETED` (not removed); the `Agent_tenant_slug_active_unique` slot is free and the checkpoint's active version is active again.
  3. **Review Focus 2:** Agent DRAFT at checkpoint, then published with different `instruction` → restore leaves it published and unchanged; warnings contain `IMMUTABLE_DIVERGED` with its id; restore status `COMPLETED_WITH_WARNINGS`.
  4. Every updated row's `_version` is live+1; rows identical to the checkpoint keep their `_version`.
  5. USERS_ACCESS: an ApiKey revoked after the checkpoint stays revoked; one created after it is revoked; the existing User's `password` and profile are byte-identical; a User hard-deleted after the checkpoint (delete its rows in the test) is re-inserted with its role assignment; `touchedUserIds` lists exactly the users whose assignments changed.
  6. CLINICAL: a Consultation created after the checkpoint (with a child having `parentConsultationId`) → both `DELETED`; a deleted ContextItem returns; its `retiredConsultationIds` are reported.
  7. AuditLog / HarnessAuditEvent rows are identical before and after every case (logs never restored).
  8. A forced failure in the middle (a test-only hook throws after the third model) → zero diff in every table of the tenant.
  9. The second tenant's rows in every touched table are byte-identical (`md5(string_agg(row::text …))` per table) before and after every case.
  10. Schema drift: a checkpoint CSV with an extra unknown column restores; a staging row carrying another tenant's id aborts `RESTORE_FAILED`.
- [ ] **Task 4 — runner + processor + sweeper (unit, fakes).** Test `restore/__tests__/restore-runner.test.ts`: status sequence `LOCKING → SAFETY_CHECKPOINT → VERIFYING → RECONCILING → POST_COMMIT → COMPLETED`; `publishChange` called at lock and at unlock; a verify failure → `FAILED`, lock released, reconciler never called; a post-commit failure → `COMPLETED_WITH_WARNINGS`; unlock happens no earlier than `POST_COMMIT_SETTLE_MS` after commit (fake clock); sweeper releases a stale lock. RED → implement → GREEN → commit.

#### L7 — Service + API · `sonnet` · effort high

**Rules:** 00, 01, 04, 05, 14. **Owns:** `tenant-checkpoint/` root files (`ITenantCheckpointService.ts`, `tenant-checkpoint.service.ts`, `tenant-checkpoint.service.module.ts`, `tenant-checkpoint.dto.mapper.ts`, `dto/**`, `__tests__/tenant-checkpoint.service*.test.ts`),
`apps/api/src/modules/tenant-checkpoint/**`, `apps/api/src/openapi/tags.ts` (one tag), `apps/api/tests/e2e/tenant-checkpoints.spec.ts`, `apps/api/tests/e2e/tenant-checkpoints-cross-tenant.spec.ts`.
**Must not touch:** `app.module.ts` (W3), generated artifacts (W3).

**Interfaces — consumes:** L1 repositories, `ICheckpointSealing`, `ICheckpointStore`, `checkCompatibility` (with a `SqlQuery` over `CoreDatabaseService.baseClient.$queryRawUnsafe`), `checkBreakGlass`, `isSuperAdmin`, `TenantSettingsService.resolve`, BullMQ queues `TenantCheckpointExport` / `TenantCheckpointRestore`, the user repository + bcrypt verify used by `role.service.ts:560`. **Produces:** the §3.1 route table with the §6.5-L9 JSON contract, `ITenantCheckpointService` symbol + module.

Service rules: every method first `assertNotSystem(tenantId)` (403 `SYSTEM_TENANT_NOT_CHECKPOINTABLE`); controllers call `assertTenantInScope(cls.get('user'), tenantId, 'notfound')` first. `create`: `generateDataKey` → optional `wrapWithPassphrase` (passphrase 12–256 chars) → row `PENDING` with `keyEnvelope` → enqueue `{ kind: 'create' }` with `jobId = checkpointId` → 202. A running export or active restore for the tenant → 409 `TENANT_CHECKPOINT_BUSY`. `downloadUrl`: READY only (409 `CHECKPOINT_NOT_READY`), TTL 900 s, filename `<tenantKey>-<yyyyMMdd-HHmm>-<id8>.hcp`, `ResourceViewed` with `forceAuditLog: true`. `uploads`: `sizeBytes ≤ maxUploadSizeGb` (413 `CHECKPOINT_TOO_LARGE`), part count = ceil(size / `CHECKPOINT_UPLOAD_PART_BYTES`), presigned TTL 6 h. `restore` order = §3.3 checks 1–5 (break-glass → Clinical 403 `CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN` with `// AUTH-NOTE:` → READY → busy (also catch the partial-unique violation on insert as 409 `TENANT_CHECKPOINT_BUSY`) → compatibility 409 `SCHEMA_INCOMPATIBLE` with `problems`) → row `PENDING` → enqueue `{ restoreId }` → 202. Break-glass `expectedName` = current `Tenant.name`; the outcome is audited like `role.service.ts`. Controller: class `@ApiTags('tenant-checkpoints')`, `@ForbidApiKey()`, `@ForbidServiceAccount()`, `@Controller('admin/tenants/:tenantId/checkpoints')`; handlers `@CanRead/@CanCreate/@CanUpdate/@CanDelete/@CanManage('TenantCheckpoint')`; `GET` handlers carry `@TenantLockExempt()` (from L4 — imported by name, resolved after merge); 202 handlers use `@Post` + `@HttpCode(HttpStatus.ACCEPTED)` (not `@ApiEndpoint`); every handler `@ApiOperation` summary + description and ≥ one 4xx `@ApiResponse`; static paths (`uploads`, `restores`) declared before `:id`.

- [ ] **Task 1 — service unit tests** `__tests__/tenant-checkpoint.service.test.ts` (mock repos, queues, sealing, store, EventEmitter2, ClsService — exemplar `department/__tests__`): create stores a `keyEnvelope` with `platform` and (with passphrase) `passphrase`, never the passphrase itself, and the queued job payload contains only ids; SYSTEM tenant → 403; busy → 409; download on RUNNING → 409; upload over the limit → 413; every mutation broadcasts a sys-event. RED → implement → GREEN → commit.
- [ ] **Task 2 — restore checks.** `__tests__/tenant-checkpoint.service.restore.test.ts`: missing password → 428; wrong password → 401; wrong name → 400; **Review Focus 5:** the expected name is the tenant's CURRENT name (rename the fake tenant between create and restore); tenant admin + CLINICAL → 403 `CLINICAL_RESTORE_REQUIRES_PLATFORM_ADMIN`; super admin + CLINICAL passes; not READY → 409; busy → 409; incompatibility → 409 with `problems`; reason < 10 chars → 400; checks run in exactly that order (a wrong password AND Clinical-by-tenant-admin → 401, not 403). RED → implement → GREEN → commit.
- [ ] **Task 3 — controller unit test** `apps/api/src/modules/tenant-checkpoint/__tests__/tenant-checkpoint.controller.test.ts`: a tenant admin calling another tenant's `:tenantId` → 404 for every route; metadata check via `Reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, Controller])` that each handler declares the expected action; `ForbidApiKey`/`ForbidServiceAccount` on the class; `TENANT_LOCK_EXEMPT_KEY` on GET handlers only. RED → implement controller, DTOs (class-validator + `@ApiProperty` on every field; `categories` `@ArrayMinSize(1) @ArrayUnique() @IsIn([...], { each: true })`), module, tag → GREEN → commit.
- [ ] **Task 4 — e2e specs (authored, NOT run by the lane).** `tenant-checkpoints.spec.ts` (hand-written depth, `rbac.spec.ts` shape): tenant admin 404 on a foreign tenant; CLINICAL 403 for a tenant admin; break-glass 428/401/400; an archive uploaded for tenant A into tenant B ends `FAILED` / `WRONG_TENANT`; 423 on a mutation while a restore runs; GET status routes 200 during it. `tenant-checkpoints-cross-tenant.spec.ts` (`tenant-bucket-cross-tenant.spec.ts` shape): every by-id route probed cross-tenant → 404, body without "tenant". Commit.

#### L10 — Deployment repo · `sonnet` · effort medium

**Rules:** 09 (whole file) + the deployment repo's `README.md` and `docs/deployment-runbook.md`. **Repo:** `~/Desktop/igglo/ARCAAI/hope-v2-deployment`, worktree `../hope-v2-deployment-task-1032` on branch `task-1032/checkpoint-worker` from `main`.
**Owns:** `deployment/k8s/base/checkpoint-worker.yaml` (new), `base/kustomization.yaml` (one line), `base/vault.yaml` (policy paths + the `for k in …` key list + a sign-key creation line), `out-of-band/minio-bootstrap.yaml` ConfigMap policy JSON for `hope-platform-rw` (bucket ARN added — the ConfigMap only; the Job is NOT re-run), any overlay patch the new Deployment needs to match `model-publisher`.

- [ ] **Task 1 — Deployment.** Copy `base/model-publisher.yaml` → `checkpoint-worker.yaml`: name `hope-checkpoint-worker`, container `checkpoint-worker`, args `[node, --import, ./apps/api/dist/instrumentation.js, apps/api/dist/checkpoint-worker.main.js]`, `OTEL_SERVICE_NAME=hope-checkpoint-worker`, same envFrom/env (incl. `DIRECT_URL` if the publisher omits it — check `hope-api` for where `DIRECT_URL` comes from and mirror it), no staging volume (streams only), requests `cpu 250m / memory 512Mi`, limits `cpu "2" / memory 2Gi`, `strategy: Recreate`, `terminationGracePeriodSeconds: 120`, NetworkPolicy copied from the publisher with egress to Postgres, Redis, Vault, MinIO (the `hope-minio` Service) and DNS only. Image `hope-v2/api` (the overlays already rewrite it).
- [ ] **Task 2 — Vault + MinIO policy.** `base/vault.yaml`: add the five policy paths from L5 Task 1; add `hope-checkpoint` to the `for k in hope-globalsetting hope-phi` creation loop and a separate idempotent creation of `hope-checkpoint-sign` with `{"type":"ed25519"}`. `minio-bootstrap.yaml` ConfigMap: `hope-platform-rw.json` gains `arn:aws:s3:::hope-tenant-checkpoints` + `/*` with `s3:CreateBucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`; MinIO CORS must expose `ETag` to the console origin for browser multipart (Review Focus 3) — find where CORS is configured (`MINIO_API_CORS_ALLOW_ORIGIN` or equivalent in `base/silo.yaml`) and report the current value; do not change it without stating why.
- [ ] **Task 3 — prove render.** `kustomize build deployment/k8s/overlays/dev > /tmp/dev.yaml` and grep the new Deployment + policy lines; paste the excerpt (this is the lane's own artifact check, not a gate). Commit on the lane branch. **Do not push** — the orchestrator pushes after the owner's go, and documents the manual steps (apply the ConfigMap, run `minio-policy-sync`, the Vault policy apply) in the runbook section of this README.

---

### 6.7 Wave 3 — orchestrator integration (primary, `dev-2.2`)

- [ ] Merge in order L5 → L1 → L4 → L3 → L2 (W1, done before W2 starts), then L6a → L6b → L7 → L9 (W2), each with `git merge --no-ff task-1032/<lane>`; resolve conflicts in the primary; re-check HEAD before each merge (second writer).
- [ ] Worker: `apps/api/src/checkpoint-worker.main.ts` (copy `model-publisher.main.ts`) + `apps/api/src/checkpoint-worker/checkpoint-worker.module.ts` (imports as `ModelPublisherWorkerModule` + `TenantLockModule`, `CheckpointExportModule`, `CheckpointRestoreModule`, `BullModule.registerQueue` ×2; boot hook `ICheckpointStore.ensureBucket()`); `createCheckpointPool` reconciled with `VAULT_PRISMA_FACTORY` in Vault mode; `scripts/dev-service.sh` target `checkpoint-worker` (copy the `publisher` block); root `"checkpoint:dev": "./scripts/dev-service.sh checkpoint-worker"`; `scripts/dev-stack.sh` `DEFAULT_SERVICES` + `ALL_SERVICES` gain `checkpoint-worker`.
- [ ] `app.module.ts`: import `TenantCheckpointModule`; register `{ provide: APP_GUARD, useClass: TenantLockGuard }` directly after `UnifiedAuthGuard`; confirm both queues are in `queueNames`.
- [ ] `tenant-checkpoint/index.ts` barrel exports + `@arcaai/applications` root barrel.
- [ ] `pnpm gen:entity` + `pnpm gen:factory` (reconcile + coverage), then `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` (expected no-op for the SDK) — in a no-dist-symlink worktree per the TASK-983 recipe, merged back.
- [ ] **The one gate pass** (a bash script, not zsh): `pnpm lint:all`, `pnpm typecheck:all`, `pnpm --filter @arcaai/domains test`, `pnpm --filter @arcaai/applications test`, `pnpm --filter @arcaai/database test`, `pnpm test:unit`, `HOPE_INTEG_DB=1 pnpm test:integration`, `pnpm --filter @arcaai/admin-console build lint test`, `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`, `pnpm gen:model:check`/`gen:entity:check`/`gen:factory:check`; then `pnpm test:up:api` + e2e (`task-776-route-authz-matrix.spec.ts`, `tenant-checkpoints*.spec.ts`) with `RESET_DB=false`; console e2e with `API_URL=http://localhost:8868 ADMIN_CONSOLE_URL=http://localhost:5176`. Failures in `packages/ui` are out of scope (owner directive). Defects found → fixed in the primary by the orchestrator, or bounced to a fix lane with the failing output.

### 6.8 Wave 4 — reviews (read-only, parallel) and live proof

| Reviewer | Tier | Lens and the questions it must answer with file:line |
|---|---|---|
| R1 security | `opus` · high | authz order (break-glass before privilege), tenant pinning on every route, 404 vs 403, upload trust chain (can a tenant admin get any row of another tenant or any global `User` field written?), crypto (nonce reuse, AAD binding, signature over the full digest, passphrase never persisted/logged), PHI in logs/`failureDetail` |
| R2 data integrity | `opus` · high | reconcile vs every trigger and partial unique, scope predicate on every statement, cross-tenant byte identity, rollback on failure, lock coverage (HTTP, internal, WS, BullMQ, Temporal callbacks), `POST_COMMIT_SETTLE_MS` vs real cache TTLs |
| R3 completeness | `sonnet` · medium | every model classified as §3.5/§6.0 say, every §3.1 route/setting/nav item present, docs + README summary, deployment-repo diff matches §6.6 L10 |

Findings are data: the orchestrator verifies each against the code before acting. Then the **live proof** (§5) on the local stack, with evidence (screenshots, restore rows, row counts) recorded in §7.

---

## 7. Implementation Summary

Implemented on `dev-2.2` by the orchestrator plus 11 lane/fix agents (W0–W4 per §4/§6), merged through
`merge(task-1032): …` commits; feature range `b0ddb7436..HEAD`. **Not pushed.** The deployment-repo
branch `task-1032/checkpoint-worker` (worktree `../hope-v2-deployment-task-1032`) is **not merged and not
pushed** — it waits for the owner's rollout go.

### 7.1 What shipped

| Area | Where |
|---|---|
| Schema | `tenant-checkpoint.prisma` (`TenantCheckpoint`, `TenantCheckpointRestore`), 5 enums, 2 `ResourceType` values, migration `20261001151400_task_1032_tenant_checkpoint` (+ partial unique `TenantCheckpointRestore_one_active_per_tenant`) |
| Domain | `TenantCheckpoint*` / `TenantCheckpointRestore*` entity/factory/mapper/repository (cross-tenant scans read through `baseClient`) |
| Engine | `packages/applications/src/services/tenant-checkpoint/` — `contracts.ts`, `registry/` (all 105 models classified; completeness, trigger-parity, soft-delete, unique-key tests), `archive/` (framed entry stream, chunked AES-256-GCM, signed trailer, C-13 gate), `sealing/` (Vault wrap + Ed25519 sign from key **v1**, Argon2id passphrase), `store/` (S3 multipart, length-signed presigned parts), `export/` (snapshot COPY export, verify-upload, sweepers), `restore/` (staging + set-wise reconcile in ONE `REPEATABLE READ` transaction; safety checkpoint exported from that transaction's snapshot), `lock/` (tenant lock, `tenant-restore.completed` cache invalidation), the service + DTOs |
| API | `admin/tenants/:tenantId/checkpoints` (12 routes, JWT-only, tag `tenant-checkpoints`), `TenantLockGuard` (423, after `UnifiedAuthGuard`), `InternalTenantLockGuard` (503 + `Retry-After`, CLINICAL restores only), STT WS open check |
| Worker | `apps/api/src/checkpoint-worker.main.ts` + `checkpoint-worker/` module; `pnpm checkpoint:dev`; in `stack:dev` |
| Console | `(console)/(tenant)/checkpoints` — list, create (dialog), upload (browser multipart), download, restore (break-glass + categories; Clinical for super admins only), restore history, 423 banner |
| Platform | Vault keys `hope-checkpoint`, `hope-checkpoint-sign` (dev-init, test-init, `hope-app.hcl`), bucket `hope-tenant-checkpoints` (platformBuckets, compose, test compose; created by the worker at boot), 4 settings, CASL `manage:TenantCheckpoint` for tenant admins, `pnpm checkpoint:open` offline opener, env `HOPE_CHECKPOINT_PASSPHRASE` (CLI only) |
| Artifacts | route manifest, OpenAPI, portal, vox-node admin regenerated (the controller is listed as machine-unreachable) |

### 7.2 Decisions taken during implementation (rulings; full log `.superpowers/sdd/TASK-1032/progress.md`)

- C-14 `ConsentGrant` is INSERT_ONLY (a withdrawn consent is never revived); `FederatedIdentity` INSERT_ONLY; `UserMedia` scoped via `Media`.
- Secret columns are never exported (User `password`/`secret1`/`secret2`, credential hashes/verifiers): a user re-created by a restore gets an unusable password and must reset it (narrows D-11).
- Secrets never travel back in time: live secret columns are preserved on update; a re-inserted row comes back without its secret (`SECRET_REQUIRES_REENTRY`).
- SUPER_ADMIN role assignments are never touched; platform-governed rows (rate-limit rules, super-admin routing keys, `globalOnly` settings, platform harness keys) are skipped unless a platform admin requested the restore.
- Unique-slot conflicts no longer fail a restore: the claimant is skipped with `UNIQUE_SLOT_HELD`; a published row whose content diverged is left fully untouched (`IMMUTABLE_DIVERGED`).
- Rows referenced by a live row of an UNSELECTED category are not retired (`CROSS_CATEGORY_REFERENCE`); a retired consultation frees its encounter key (`_metadata.retiredExternalRef`).
- The internal (machine) lock blocks only CLINICAL restores, with 503 + `Retry-After`; the public API keeps the hard 423 for every category (D-10).
- Media in platform fallback buckets is re-uploaded put-if-absent only.
- Parked (accepted, documented): retention-purged PHI can return with a clinical restore (R2 M-5, owner policy question); WORM change logs are not appended by a restore (the restore audit event records it); `revokeAllForUser` signs a member out in every tenant.

### 7.3 Evidence (final, on `dev-2.2@0ad683ea0`, 2026-10-02)

| Check | Result |
|---|---|
| Builds `database`, `domains`, `applications`, `api`; `gen:model/entity/factory:check` | green |
| `@arcaai/database` / `@arcaai/domains` / `@arcaai/applications` tests | green — applications 1098 files passed |
| `pnpm test:unit` | **1989 files, 29 035 tests passed, 0 failed** |
| `pnpm lint:all` | green |
| Console build, lint, unit tests | green (401 files) |
| `pnpm typecheck:all` | TS green; **4 mypy errors in `apps/stt` streaming files this ticket never touched — pre-existing, out of scope** |
| Restore integration suite (own config, isolated test DB) | **29 passed** |
| API e2e: route authz matrix (730 routes) + checkpoint depth + cross-tenant, live worker, parallel workers | **45 passed, 0 failed, 0 skipped** (API reported version `0ad683ea`) |
| Console e2e: axe light + dark (0 violations), create → READY → download → restore → history | **4 passed, 0 skipped** |
| Live proof on a **migrated** DB (triggers present), real API + worker + Vault | create → READY → download → offline open (password column empty) → CONFIG restore (config back, newer consultation kept) → CLINICAL restore (consultation retired) → safety-checkpoint restore (consultation back); audit rows written. Script + output kept in the session scratchpad |
| Reviews | security (R1: 3 Important), data integrity (R2: 2 Critical, 7 Important), completeness (R3: 2 ❌) → fix wave FX-A/FX-B → scoped re-review: 20 addressed, 2 partial, 7 parked by ruling, 2 new Important (N-1 lock bypass via query string, N-2 job scope) → fixed in a narrow round 3 |

Known residuals (parked, documented): no per-tenant cap on concurrent uploads (each is size-bounded); media objects are re-uploaded (put-if-absent) before the restore's own signature re-check; retention-purged PHI can return with a clinical restore; WORM change logs are not appended by a restore; password hashes already present in `AuditLog.data` (pre-existing, already readable through the audit API) travel inside the sealed archive. Test-infra note: the isolated test Postgres runs on a 512 MB tmpfs that repeated integration runs can fill ("No space left on device").

Pre-existing gap found on the way: `pnpm test:db:reset` seeds nothing unless `RUN_SEED=all` is set (`.env.test` does not set it).

### 7.4 Rollout (cluster) — owner go required

1. Push `dev-2.2` (CI builds the api image carrying `checkpoint-worker.main.js`; promote-dev pins it).
2. Rebase `task-1032/checkpoint-worker` onto the deployment repo's current `origin/main` (it was cut from a local `main` carrying an unrelated unpushed TASK-1031 commit), merge, push → Argo syncs `hope-checkpoint-worker`.
3. Vault (live, manual — provisioning only runs at first init): `vault write -f transit/keys/hope-checkpoint`; `vault write transit/keys/hope-checkpoint-sign type=ed25519` (**never trim version 1** — the deployment id derives from it); `vault policy write hope-app` from the updated `hope-vault-policies` ConfigMap; verify encrypt/sign/read-key with a hope-app AppRole login.
4. MinIO: apply only the updated `hope-minio-bootstrap` ConfigMap (policy `hope-platform-rw` gains the bucket), run `out-of-band/minio-policy-sync.yaml` under a fresh Job name — **never re-run `minio-bootstrap`**. The worker creates the bucket at boot. Confirm MinIO CORS exposes `ETag` to the console origin (browser multipart needs it).
5. Verify: rollout status, worker logs, one checkpoint create → READY from the console.

## 8. Change History

| Date | Change |
|---|---|
| 2026-10-01 | Ticket opened; design agreed with the owner (D-1…D-12); spec + lane plan written. Status Pending — awaiting spec review. |
| 2026-10-01 | Owner approved the spec and OD-1…OD-3 (recommendations). Owner rule restated: lanes run no gating tests; the orchestrator merges everything, then runs one gate pass. §6 implementation plan (lane briefs, C-1…C-13 corrections) written. |
