# TASK-318 — Storage Integrations, SDK File/Bucket Workflow & Multi-Tenancy Review

| Field | Value |
|---|---|
| **Ticket** | TASK-318-Storage-SDK-MultiTenancy-Review |
| **Type** | Review / Refactor / Optimization / Documentation |
| **Created** | 2026-05-30 |
| **Updated** | 2026-05-30 |
| **Status** | `In Progress` — Wave 1 implementation underway (see §15) |
| **Scope** | NestJS API (user + admin surfaces), `@arcaai/vox` SDK, applications + domains layers, Prisma schema, STT-v2 Python service, MinIO/S3/Azure providers |
| **Supersedes / refreshes** | [TASK-304 (Storage Integration Review, 2026-05-26)](../TASK-304-Storage-Integration-Review/README.md) — re-verified against current code (post TASK-305/307/310/317) |
| **Related** | TASK-239 (Tenant Blob Storage), TASK-305 (Multi-Tenancy Hardening ✅), TASK-307 (API Gateway Hardening ✅), TASK-310 (API Gateway Hygiene), TASK-317 (Vox SDK Multi-Tenancy ✅), TASK-302 (Secrets/Vault), TASK-301 (System-Config Assessment) |

> **Why a new ticket and not an update to TASK-304?** The user's request adds two dimensions TASK-304 did not cover — (a) the **`@arcaai/vox` SDK developer-facing file/bucket workflow API**, and (b) an explicit **end-user vs admin API split** — and TASK-304's findings were partly **stale** (several were closed/mitigated by TASK-305's tenant-scope Prisma extension and TASK-307's `@TenantOwnedResource` interceptor). Every finding below was **re-verified against the current tree on 2026-05-30**. If you'd prefer this folded into TASK-304 instead, say so and I'll merge it.

---

## 1. Executive Summary

HOPE's storage stack is a **single-provider, S3-compatible** design (one global MinIO/S3 endpoint), with **per-tenant *logical* bucket isolation** enforced primarily at the **application layer** (Prisma tenant-scope `$extends` + the `@TenantOwnedResource` interceptor), not at the storage layer. The requested target — **three providers (MinIO, AWS S3, Azure Storage) in shared *or* dedicated topologies**, six consumer flows, a complete SDK file/bucket workflow, and a clean user/admin API split — is **partially** met.

### 1.1 What changed since TASK-304 (freshness corrections)

| Area | TASK-304 said (2026-05-26) | Verified now (2026-05-30) |
|---|---|---|
| `revokeKey` IDOR (C1) | Critical, exploitable | **Mitigated** — `StorageAccessKey` is now in the tenant-scope `$extends` allow-list; `findById`/`softDelete` auto-filter by CLS `tenantId`. (No *explicit* service guard still — see F-2.) |
| Legacy `StorageController` unscoped (C3) | Critical, every route open | **Mostly fixed** — every `:name` route now carries `@TenantOwnedResource` (404 no-existence-leak). **Only `GET /storage/buckets` remains unscoped** (see F-1). |
| Admin bucket browse | "modern endpoints exist" | **Confirmed + richer** — `GET :id/tree` and `GET :id/presigned-url` (download) now exist on the admin controller. |
| SDK file/bucket API | (not covered) | **Exists** (`useStorage`, `FileTranscriptionService`, `useVoiceEmbedding`) but targets **only the legacy `/storage/...`** controller; no admin/key hooks; no presigned/resumable. |

### 1.2 Requirement → status matrix (current)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| R-a | Tenant admins browse buckets/dirs/files | **Implemented** | `TenantBucketController` (`admin/tenants/storage/buckets`) list / `:id` / `:id/tree` / `:id/presigned-url`, all `@TenantOwnedResource`-guarded. No SDK hook (F-7). |
| R-b | Doctor uploads batch audio (transcription) | **Implemented** | `POST /audio/transcription-jobs/transcribe` (100 MB cap) + SDK `FileTranscriptionService` (XHR progress). |
| R-c | Doctor uploads session attachments (PDF/img/lab) | **Missing** | No endpoint, no `ContextItem.mediaId` link (F-8). |
| R-d | Doctor uploads profile avatar | **Missing** | `UserProfile.avatarId` field exists; no upload endpoint (F-9). |
| R-e | Live pipeline persists raw + processed audio | **Implemented, not tenant-keyed** | STT-v2 writes raw + processed + transcript + metadata, but `tenant_id` is **not in the object key** and bucket routing falls back to the global bucket (F-10). |
| R-f | Tenant admins upload tenant config files (logo/bg) | **Missing** | Tenant config is K/V only; no media fields, no upload endpoint (F-11). |
| R-g | Self-hosted MinIO — shared | **Implemented** | Default deployment. |
| R-h | Self-hosted MinIO — dedicated per tenant | **Not supported** | No per-tenant `endpoint` field (F-3, F-12). |
| R-i | AWS S3 — shared | **Possible (untested)** | Works via `@aws-sdk/client-s3` + endpoint swap; no AWS-specific plumbing. |
| R-j | AWS S3 — dedicated per tenant | **Not supported** | No per-tenant credential/endpoint routing (F-3, F-12). |
| R-k | Azure Storage — shared | **Missing** | No `@azure/storage-blob` anywhere (F-4). |
| R-l | Azure Storage — dedicated | **Missing** | Same. |
| R-m | SDK developer file/bucket workflow API | **Partial** | `useStorage` (legacy routes only), no admin/key/attachment/avatar/presigned coverage (F-5..F-7). |
| R-n | API split: end-user group + admin group | **Partial** | Split exists by convention; legacy `storage/` controller blurs it (F-1, F-6). |
| R-o | Multi-tenancy | **Strong app-layer, weak storage-layer** | `$extends` + `@TenantOwnedResource` + CLS; storage-layer keys/credentials are shared (F-3, F-10). |

**8 of 12 provider×topology cells are unmet; 3 of 6 consumer flows are unimplemented; the SDK covers ~1 of the ~4 workflow groups developers need.**

### 1.3 Provider × topology matrix (verified)

| Provider | NestJS API | Python STT-v2 | Shared | Dedicated per tenant |
|---|---|---|---|---|
| **MinIO** | ✅ `@aws-sdk/client-s3` | ✅ native `minio` SDK | ✅ default | ❌ no per-tenant endpoint |
| **AWS S3** | ✅ (same SDK, swap endpoint) | ⚠️ `minio` SDK unreliable vs native AWS | ⚠️ possible, untested | ❌ no per-tenant creds/endpoint |
| **Azure Blob** | ❌ absent | ❌ absent | ❌ | ❌ |

### 1.4 Headline findings

1. **One physical storage backend, shared by all tenants.** Isolation is *logical* (DB `TenantBucket` rows + app-layer guards). There is **no `StorageProvider` enum, no `TenantStorageConfig`, no per-tenant `endpoint`/`region`/`credentialsRef`** — so dedicated MinIO/S3/Azure-per-tenant is structurally impossible today.
2. **`GET /storage/buckets` is the one remaining cross-tenant leak** — it calls `s3Service.listAllBuckets()` and returns every physical bucket name on the server, regardless of tenant.
3. **`StorageAccessKey.secretAccessKey` is stored in plaintext** (`randomBytes(32).base64url`), despite the schema comment "encrypted at application layer." No `@Secret`, no hash, no `CryptoService`.
4. **STT-v2 does not embed `tenant_id` in object keys** (batch *or* streaming) and only routes to a tenant bucket when the caller explicitly passes `audio_bucket_name`; otherwise everything lands in the global `hope-audio` bucket. The path_resolver **docstrings claim `tenant_id` is in the key — the code disagrees.**
5. **No presigned PUT (upload) anywhere** — every upload streams through Node.js (100 MB cap). Presigned *download* exists only on the admin controller.
6. **The SDK file/bucket API targets only the legacy end-user `/storage/...` controller** — there is no SDK surface for admin bucket management, storage access keys, attachments, avatars, or tenant branding, and no presigned/resumable upload helper.
7. **No retention/lifecycle policies** on any bucket (NestJS or Python) — `hope-audio-chunks` and raw audio grow unbounded.
8. **Name/slug contract inconsistency** on `POST /storage/buckets/:name/files`: the `@TenantOwnedResource` guard resolves `:name` by **physical name**, but the handler resolves it by **slug** with a raw-name fallback — slug callers 404 at the guard; the fallback is dead for cross-tenant but the contract is muddled.

---

## 2. Scope & Methodology

**In scope:** all storage code under `packages/applications/src/services/baseServices/storage/`, `.../storage-access-key/`, `.../tenant-bucket/`; `apps/api/src/modules/{storage,tenant-bucket,storage-access-key,streaming,voice-profile}`; the `@TenantOwnedResource` interceptor; the tenant-scope Prisma extension; `TenantBucket`/`StorageAccessKey`/`Media` schema + domain; `@arcaai/vox` storage/file surface; STT-v2 `storage/` + `streaming/` + `transcription/`.

**Out of scope (tracked elsewhere):** secrets/Vault plumbing (TASK-302); browser-side IndexedDB/localStorage isolation (TASK-317, closed); RLS rollout (TASK-302 Phase C).

**Method:** Four parallel read-only exploration passes (backend verification, SDK surface, API endpoint inventory, Python pipeline) cross-checked against TASK-304/305/307/317 docs, then **source-verified** for every load-bearing citation on 2026-05-30. No source code was modified.

---

## 3. Current Architecture (verified 2026-05-30)

### 3.1 Layer map

```
@arcaai/vox SDK (browser)
  • AgenticClient (fetch JSON / postFormData / uploadFormData-XHR)  → Authorization + X-API-Key + X-Tenant-ID
  • useStorage, FileTranscriptionService, useVoiceEmbedding
        │  (targets legacy /storage/* + /audio/* + /voice-profile/* only)
        ▼
apps/api  (NestJS, prefix /api/v1)
  ├─ END-USER group
  │   ├─ StorageController                  @ storage/                 (S3 ops + upload; @TenantOwnedResource on :name routes)
  │   ├─ TranscriptionJobController         @ audio/transcription-jobs (batch audio upload)
  │   └─ VoiceProfileController             @ voice-profile            (enrollment audio upload)
  └─ ADMIN group
      ├─ TenantBucketController             @ admin/tenants/storage/buckets   (@CanManage('Tenant'); list/tree/presigned/CRUD)
      └─ StorageAccessKeyController         @ admin/tenants/storage/keys      (key issue/list/revoke)
        │
        ▼
packages/applications
  ├─ S3Service (1 client, @aws-sdk/client-s3)   ├─ S3HealthService
  ├─ TenantBucketService                        ├─ StorageAccessKeyService
  └─ MediaService
        │
        ▼
packages/domains  →  TenantBucket / StorageAccessKey / Media (entities/factories/mappers/repos)
        │
        ▼
packages/database (Prisma)  →  core.TenantBucket, core.StorageAccessKey, core.Media
        + tenant-scope $extends (TASK-305) auto-injects where:{tenantId} for these models

apps/stt-v2 (Python, separate process)
  └─ minio SDK → BlobService → StoragePathResolver  (tenant_id threaded but NOT in key; bucket falls back to global)
```

### 3.2 Multi-tenancy enforcement stack (the real isolation boundary)

Isolation is **defense-in-depth at the application layer**, not the storage layer:

1. **Prisma tenant-scope `$extends`** (TASK-305) — `TenantBucket`, `StorageAccessKey`, `Media` are in the allow-list, so every read/write auto-injects `where: { tenantId }` and throws on cross-tenant mismatch:

```49:91:packages/database/src/extensions/tenant-scope.ts
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  // ...
  'TenantBucket',
  'StorageAccessKey',
  'Media',
]);
```

2. **`@TenantOwnedResource` interceptor** (TASK-307) — resolves the addressed resource and asserts `entity.tenantId === cls.tenantId`, returning a uniform **404 (no existence leak)** on mismatch:

```176:187:apps/api/src/common/tenant-owned-resource.interceptor.ts
  private async assertTenantScoped(
    finder: () => Promise<{ tenantId?: string | null } | null | undefined>,
    callerTenantId: string,
  ): Promise<void> {
    const entity = await this.safeResolve(finder);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    if (!entity.tenantId || entity.tenantId !== callerTenantId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }
```

3. **CASL permissions** — `@CanRead/@CanCreate/@CanDelete('Storage')` on end-user routes; `@CanManage('Tenant')` on the admin controller.

**The gap:** none of these reach the *storage backend*. Object keys, bucket credentials, and the physical endpoint are shared. A compromise of the global `S3_ACCESS_KEY` exposes every tenant's objects, and `listAllBuckets()` (F-1) bypasses all three layers.

### 3.3 `S3Service` — the single concrete provider

One client, provider inferred from the endpoint string (no enum):

```260:266:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
  private isMinIOEndpoint(endpoint: string): boolean {
    if (!endpoint) return false;
    const minioPatterns = [/localhost/i, /127\.0\.0\.1/, /minio/i, /:9000$/, /:9001$/];
    return minioPatterns.some((pattern) => pattern.test(endpoint));
  }
```

- Config: `S3_ENDPOINT/REGION/PUBLIC_BUCKET/PRIVATE_BUCKET/...` from `AppSettingsService` (DB); `S3_ACCESS_KEY/S3_SECRET_KEY` from `SecretsService` (Vault). **All tenants share one credential set.**
- `signUrl(...)` supports only `'get' | 'list'` — **no presigned PUT**. `listFiles` returns `any[]` with **no pagination** (truncates at 1000). `getFile` fully buffers (no stream).

### 3.4 Tenant bucket model & naming

`TenantBucket` (physical `name` + logical `slug`, `bucketType SYSTEM|CUSTOM`, `pathPattern`) and `StorageAccessKey` live in `core`. System buckets `hope-audio-{tenantKey}` and `hope-attachments-{tenantKey}` are auto-provisioned on tenant creation. **Neither table has `provider`/`endpoint`/`region`/`credentialsRef`/`containerName`/`lifecycleRules`** — confirming the single-backend constraint.

### 3.5 Python STT-v2

`minio` SDK (sync), global buckets `hope-audio` + `hope-audio-chunks`:

```84:91:apps/stt-v2/src/stt_v2/core/config/settings.py
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minio_admin"
    minio_secret_key: str = "minio_admin"
    minio_secure: bool = False
    minio_cert_check: bool = True
    minio_audio_bucket: str = "hope-audio"
    minio_chunk_bucket: str = "hope-audio-chunks"
```

`tenant_id` is threaded through the streaming session request and the Dramatiq batch payload, but the streaming key builder ignores it:

```207:222:apps/stt-v2/src/stt_v2/storage/path_resolver.py
    def _streaming_base(
        self,
        tenant_id: str,
        session_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Return the common prefix for all streaming paths.
        Format: ``{year}/{month}/{day}/streams/{session_id}``
        """
        safe_session = self._sanitize_path_segment(session_id)
        ts = timestamp or datetime.utcnow()
        # ... returns f"{year}/{month}/{day}/streams/{safe_session}"  ← no tenant_id
```

And bucket resolution falls back to the global default unless a per-job override was injected:

```421:450:apps/stt-v2/src/stt_v2/storage/path_resolver.py
    def resolve_tenant_bucket(self, tenant_id: str, bucket_type: str) -> str:
        cache_key = f"{tenant_id}:{bucket_type}"
        if cache_key in self._tenant_bucket_cache:
            return self._tenant_bucket_cache[cache_key]
        defaults = {"audio": self.audio_bucket, "chunk": self.chunk_bucket, "model": self.model_bucket}
        bucket = defaults.get(bucket_type, self.audio_bucket)
        # ... only populated by set_tenant_bucket() when audio_bucket_name is passed
        return bucket
```

**Live pipeline raw/processed flow** (`session_manager.py`): periodic 30 s snapshot uploads raw + processed chunks; finalize uploads `raw/complete.wav`, `processed/complete.wav`, `transcript.json`, `metadata.json`. Batch: API uploads raw before enqueue; worker uploads processed + transcript + metadata. All pass `tenant_id` but none key by it.

---

## 4. The Two API Groups — End-User vs Admin

### 4.1 Split mechanism (verified)

- **Global prefix** `api/v1`. **Admin** routes use `@Controller('admin/...')` + `@CanManage('Tenant')`; **end-user** routes use subject-scoped CASL (`@CanRead('Storage')`, `@Authorize([...])`). A **boot-time audit** refuses startup if any route lacks an auth decorator (TASK-302 Phase 0).

### 4.2 Consolidated endpoint inventory

| Method | Full path | Group | Decorators | `@TenantOwnedResource` | Notes |
|---|---|---|---|---|---|
| GET | `/api/v1/storage/buckets` | **user** | `@CanRead('Storage')` | ❌ | **F-1 leak** — `listAllBuckets()` |
| POST | `/api/v1/storage/buckets` | user | `@CanCreate('Storage')` | ❌ (registers to CLS tenant) | creates S3 bucket + `registerBucket()` |
| GET | `/api/v1/storage/buckets/:name` | user | `@CanRead('Storage')` | ✅ name | lists files inline |
| PATCH | `/api/v1/storage/buckets/:name` | user | `@CanUpdate('Storage')` | ✅ name | |
| DELETE | `/api/v1/storage/buckets/:name` | user | `@CanDelete('Storage')` | ✅ name | |
| GET | `/api/v1/storage/buckets/:name/files` | user | `@CanRead('Storage')` | ✅ name | no pagination |
| POST | `/api/v1/storage/buckets/:name/files` | user | `@CanCreate('Storage')` | ✅ name | **F-8 slug/name mismatch**; 100 MB |
| GET | `/api/v1/storage/buckets/:name/files/:key` | user | `@CanRead('Storage')` | ✅ name | presigned **GET** url; `:key` not traversal-checked |
| DELETE | `/api/v1/storage/buckets/:name/files/:key` | user | `@CanDelete('Storage')` | ✅ name | `:key` not traversal-checked |
| GET | `/api/v1/storage/health` | user | `@CanRead('Storage')` | — | leaks endpoint URL (L-4) |
| POST | `/api/v1/audio/transcription-jobs/transcribe` | user | `@Authorize()` | ✅ (job) | batch audio, 100 MB |
| POST | `/api/v1/voice-profile/enroll` | user | `@Authorize(['create','UserVoiceProfile'])` | ✅ (UserVoiceProfile) | multipart voice sample |
| GET | `/api/v1/admin/tenants/storage/buckets` | **admin** | `@CanManage('Tenant')`+`@CanRead('Storage')` | — (list scoped by service) | tenant's buckets |
| GET | `/api/v1/admin/tenants/storage/buckets/:id` | admin | `@CanRead('Storage')` | ✅ id | |
| GET | `/api/v1/admin/tenants/storage/buckets/:id/tree` | admin | `@CanRead('Storage')` | ✅ id | UI tree view |
| GET | `/api/v1/admin/tenants/storage/buckets/:id/presigned-url` | admin | `@CanRead('Storage')` | ✅ id | **download** only |
| POST | `/api/v1/admin/tenants/storage/buckets` | admin | `@CanCreate('Storage')` | — | custom bucket |
| DELETE | `/api/v1/admin/tenants/storage/buckets/:id` | admin | `@CanDelete('Storage')` | ✅ id | system buckets blocked |
| POST | `/api/v1/admin/tenants/storage/buckets/provision/:tenantId` | admin | `@CanManage('Tenant')` | — | provision system buckets |
| GET/POST/DELETE | `/api/v1/admin/tenants/storage/keys[...]` | admin | `@CanManage('Tenant')` + CASL | — (scoped by `$extends`) | issue/list/revoke access keys |

### 4.3 Group-level gaps

- The **legacy `StorageController`** blurs the split: it is end-user-facing but performs **direct S3 operations** (create/delete physical buckets, list-all) that belong in the admin plane. Recommendation: demote it to file CRUD against *owned* buckets, route all bucket lifecycle through the admin `TenantBucketController`, and fix F-1.
- **No admin file plane**: the admin controller can browse/tree/presign-download but cannot **upload** or **delete files** — admins must drop to the end-user controller. Add admin file ops or a shared upload service.
- **Missing endpoints** for three use cases (attachments, avatar, branding) — see §5.

---

## 5. Use Case Analysis (current)

| Use case | Status | Where / gap |
|---|---|---|
| **A. Admin browses buckets/dirs/files** | ✅ | `TenantBucketController` list/`:id`/`:id/tree`/`:id/presigned-url`. Gaps: no SDK hook (F-7); tree builds full prefix (O-6); presigned is download-only. |
| **B. Doctor batch audio** | ✅ | `POST /audio/transcription-jobs/transcribe` + SDK `FileTranscriptionService` (XHR progress). Path duplicated TS↔Python (F-13); server-streamed (O-1). |
| **C. Doctor session attachments** | ❌ | `ContextItemType.ATTACHMENT` + `addAttachment(content?)` exist, but `content` is text; **no `mediaId` link, no upload endpoint** (F-8 design). |
| **D. Doctor avatar** | ❌ | `UserProfile.avatarId` exists; **no upload endpoint / `UserMediaController`** (F-9). |
| **E. Live pipeline raw+processed** | ⚠️ | Implemented & well-structured, but **not tenant-keyed / not tenant-bucketed** by default (F-10); no lifecycle (F-14). |
| **F. Tenant branding files** | ❌ | Tenant config is K/V; **no media fields on `Tenant`, no upload endpoint** (F-11). |

---

## 6. `@arcaai/vox` SDK — File & Bucket Workflow

### 6.1 What exists today

- **`useStorage`** — buckets (list/get/create/delete) + files (list/upload/get/delete) + health, all via `STORAGE_ENDPOINTS`:

```469:481:packages/agentic-sdk-v2/src/core/constants.ts
export const STORAGE_ENDPOINTS = {
  LIST_BUCKETS: '/storage/buckets',
  GET_BUCKET: (name: string) => `/storage/buckets/${encodeURIComponent(name)}`,
  CREATE_BUCKET: '/storage/buckets',
  DELETE_BUCKET: (name: string) => `/storage/buckets/${encodeURIComponent(name)}`,
  LIST_FILES: (bucketName: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files`,
  UPLOAD_FILE: (bucketName: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files`,
  GET_FILE: (b, k) => `/storage/buckets/${encodeURIComponent(b)}/files/${encodeURIComponent(k)}`,
  DELETE_FILE: (b, k) => `/storage/buckets/${encodeURIComponent(b)}/files/${encodeURIComponent(k)}`,
  HEALTH: '/storage/health',
} as const;
```

- **`FileTranscriptionService`** — batch audio upload with XHR progress (`uploadFormData`).
- **`useVoiceEmbedding`** — multipart voice sample upload.
- **`AgenticClient`** — `postFormData` (fetch, no progress), `uploadFormData` (XHR progress); sends `Authorization` + `X-API-Key` + `X-Tenant-ID` on all transports.

### 6.2 SDK gaps (against "developers configure & build file/bucket workflows")

| # | Gap | Impact |
|---|---|---|
| F-5 | `useStorage` targets **only the legacy `/storage/...`** controller; its header even says "admin operations" but it calls end-user routes | No SDK access to the real admin plane; mislabeled |
| F-6 | **No SDK constants/hooks for** `admin/tenants/storage/buckets` (tree, presigned, provision) or `admin/tenants/storage/keys` | Admin bucket/key management not available to SDK consumers (`useStorageKeys`, `useTenantBuckets` absent) |
| F-7 | No presigned-upload helper, **no progress on `useStorage.uploadFile`** (uses `postFormData`, not XHR), no resumable/chunked upload | Large-file UX is poor; everything streams through the API |
| — | No attachment/avatar/branding workflow hooks (because backend endpoints are missing) | Use cases C/D/F have no SDK path |
| — | No "bucket-as-resource"/builder ergonomics — only flat imperative methods | Hard to compose multi-step workflows |

### 6.3 Target SDK shape (proposal)

Mirror the SDK's existing hook/resource patterns and the `08-vox-sdk.mdc` contract (access via hooks, `AgenticClient` for I/O, per-provider store):

```
@arcaai/vox storage surface (target)
├─ useStorage            → repoint to a unified façade (owned-bucket file CRUD)
├─ useTenantBuckets      → admin: list/get/tree/create/delete/provision  (admin/tenants/storage/buckets)
├─ useStorageKeys        → admin: issue/list/revoke                       (admin/tenants/storage/keys)
├─ useUpload             → presigned init→PUT→complete; progress; resumable for large media
├─ useAttachments        → consultation attachments (Use Case C)
├─ useAvatar             → profile avatar (Use Case D)
└─ useTenantBranding     → tenant logo/background (Use Case F)
```

`useUpload` is the keystone: a `{ init, putWithProgress, complete }` flow returning `{ uploadUrl, mediaId, key, expiresAt }`, with XHR progress and an optional multipart/resumable path for >100 MB media. All hooks reuse `AgenticClient` (so `X-Tenant-ID` + auth are automatic).

---

## 7. Provider Support Analysis

### 7.1 Why Azure is harder than "add an endpoint"

Azure Blob is **not** S3-compatible by default. Options: (1) Azure's S3-compat front-end (limited/preview, no AAD) — minimal code but feature gaps; (2) **first-class `@azure/storage-blob` adapter** behind a provider interface — clean, AAD/managed-identity, ADLS Gen2; (3) MinIO Azure gateway — **deprecated 2022, not recommended**. **Recommendation: option 2.**

### 7.2 Target abstraction (`IBlobStorageProvider`)

```typescript
// packages/applications/src/services/baseServices/storage/IBlobStorageProvider.ts
export enum StorageProvider { MINIO = 'MINIO', AWS_S3 = 'AWS_S3', AZURE_BLOB = 'AZURE_BLOB' }
export enum StorageTopology { SHARED = 'SHARED', DEDICATED = 'DEDICATED' }

export interface IBlobStorageProvider {
  readonly provider: StorageProvider;
  put(loc, data, opts?): Promise<void>;
  get(loc): Promise<Buffer>;
  getStream(loc): Promise<Readable>;          // O-4
  delete(loc): Promise<void>;
  list(loc, page): Promise<ListResult>;        // O-2 (paginated)
  copy(src, dst): Promise<void>;
  presign(loc, method: 'GET'|'PUT', ttl): Promise<PresignedUrl>;  // O-1
  createBucket(name, opts?): Promise<void>;
  deleteBucket(name): Promise<void>;
  setLifecycle(name, rules): Promise<void>;    // R-7
  healthCheck(): Promise<HealthStatus>;
}
// providers/{s3.provider.ts (AWS+MinIO), azure-blob.provider.ts}, factory.provider.ts (resolves by tenant)
```

### 7.3 Per-tenant provider config (new model)

```prisma
model TenantStorageConfig {
  id              String          @id @default(uuid(7))
  tenantId        String          @unique
  provider        StorageProvider                  // MINIO | AWS_S3 | AZURE_BLOB
  topology        StorageTopology                  // SHARED | DEDICATED
  endpoint        String?                          // MinIO / custom S3
  region          String?
  azureAccount    String?                          // AZURE_BLOB
  credentialsRef  String?                          // SecretsService/Vault key — NEVER the secret itself
  containerPrefix String?                          // shared-prefix mode
  resourceStatus  ResourceStatusType @default(ENABLED)
  @@schema("core")
}
```

Plus, on `TenantBucket`: `containerName String?` (Azure) and `lifecycleRulesJson Json?`. The provider **factory** resolves `tenantId → TenantStorageConfig`, fetches credentials lazily via `credentialsRef → SecretsService`, and caches the client per credentials tuple (O-8). Migration: backfill all tenants `{MINIO, SHARED}` → global config; ship S3 provider first, then Azure, then dedicated onboarding.

### 7.4 `StorageAccessKey` is an app-layer API key, not a cloud credential

`accessKeyId = "HOPE"+hex`, `secretAccessKey = base64url(32 bytes)`, validated by HOPE — it does **not** authenticate to MinIO/S3/Azure (those use the global creds). Fine as a proxy token, but must not be conflated with cloud IAM, and the secret must be **hashed, not stored plaintext** (F-2).

---

## 8. Findings (reconciled & severity-tagged)

Severity: **C** critical · **H** high · **M** medium · **L** low. Status: 🟥 open · 🟧 mitigated · 🟩 closed-since-304.

### Critical / High

| ID | Sev | Status | Finding | Location |
|---|---|---|---|---|
| **F-1** | C | 🟥 | `GET /storage/buckets` returns **all** physical buckets across tenants (no `@TenantOwnedResource`, no scoping) | `storage.controller.ts:48-54` |
| **F-2** | C | 🟥 | `secretAccessKey` stored **plaintext** (`randomBytes(32).base64url`); schema comment lies; no `@Secret`/hash/encrypt | `StorageAccessKeyFactory.ts:19-21`, `tenant-bucket.prisma:62-65` |
| **F-3** | C | 🟥 | No per-tenant provider routing — dedicated MinIO/S3/Azure impossible (no `TenantStorageConfig`, no `endpoint`/`region`/`credentialsRef`) | schema (gap) |
| **F-4** | H | 🟥 | **Azure Blob not implemented anywhere** (`@azure/storage-blob` absent) | repo-wide |
| **F-10** | H | 🟥 | STT-v2 omits `tenant_id` from object keys (batch+streaming) and falls back to global bucket unless `audio_bucket_name` injected; docstrings falsely claim tenant in key | `path_resolver.py:207-222, 421-450` |
| **F-2b** | H | 🟥 | `validateKey()` never updates `lastUsedAt`/`lastUsedIp` (defeats anomaly detection) | `storage-access-key.service.ts:93-103` |
| **C1-old** | C | 🟧 | `revokeKey` IDOR — **mitigated** by `$extends` auto-scoping `findById`; add an explicit guard for defense-in-depth | `storage-access-key.service.ts:77-91` |
| **C3-old** | C | 🟧 | Legacy controller scoping — **mostly fixed** by `@TenantOwnedResource`; residual = F-1 + F-8 | `storage.controller.ts` |

### Medium / Low

| ID | Sev | Status | Finding | Location |
|---|---|---|---|---|
| **F-8** | M | 🟥 | `uploadFile` name/slug inconsistency: guard checks `:name` by **name**, handler resolves by **slug** + raw fallback | `storage.controller.ts:128-157` |
| **F-13** | M | 🟥 | Storage paths duplicated across TS (`transcription-job.controller`) and Python (`path_resolver`) — drift risk | TS + Python |
| **F-14** | M | 🟥 | No lifecycle/retention on any bucket (NestJS or Python) — `hope-audio-chunks`, raw audio, `temp/*` grow unbounded | all buckets |
| **F-4b** | H | 🟥 | Double DI registration of `StorageAccessKeyService` (two instances) | `storage-access-key.service.module.ts:7-18` |
| **F-15** | M | 🟥 | `findActiveByTenant` filters expiry **in memory**, not SQL (`@@index([expiresAt])` unused) | `StorageAccessKeyRepository.ts:39-47` |
| **F-16** | M | 🟥 | `isMinIOEndpoint` regex too permissive (`/minio/`, `:9000`) — replace with explicit `S3_PROVIDER` | `s3.service.ts:260-266` |
| **F-17** | M | 🟥 | `listFiles` returns `any[]`, no pagination (silent 1000-key truncation) | `s3.service.ts` |
| **F-18** | M | 🟥 | Path-traversal check only on `uploadFile` key — `getFileInfo`/`deleteFile` `:key` unchecked | `storage.controller.ts:186-207` |
| **F-19** | H | 🟥 | TASK-239 IAM bucket policy (`aws:PrincipalTag/tenantId`) is **dead** in MinIO; set only for system buckets, never for custom | `tenant-bucket.service.ts:151-160` |
| **L-4** | L | 🟥 | `/storage/health` returns raw endpoint URL | `storage.controller.ts:210-226` |

---

## 9. Refactor Plan

Dependency-ordered; each step ships independently behind green CI.

### R1 — Close residual security gaps (1–2 days)
| Step | What | Files |
|---|---|---|
| R1.1 | Scope `GET /storage/buckets` to tenant-owned `TenantBucket` rows (stop calling `listAllBuckets()`) — **F-1** | `storage.controller.ts`, `tenant-bucket.service.ts` |
| R1.2 | Hash `secretAccessKey` (HMAC-SHA256 + salt; display-once) or encrypt via `CryptoService`; change `validateKey` to compare hashes; data migration — **F-2** | factory, service, mapper, schema |
| R1.3 | Add explicit `key.tenantId === this.tenantId` guard in `revokeKey` (defense-in-depth on top of `$extends`) — **C1** | `storage-access-key.service.ts` |
| R1.4 | Resolve `:name` consistently (name **or** slug, one finder) and drop the raw fallback; align guard + handler — **F-8** | `storage.controller.ts` |
| R1.5 | Embed `tenant_id` in STT-v2 keys (`tenants/{tenant_id}/{y}/{m}/{d}/...`); fix docstrings — **F-10 short-term** | `path_resolver.py` (+ tests) |
| R1.6 | Populate `_tenant_bucket_cache` from the API/DB (or require the gateway to pass the resolved bucket) so audio lands in the tenant bucket — **F-10 long-term** | `path_resolver.py`, batch worker, session manager |

### R2 — Cleanups (1 day)
F-4b (remove duplicate DI), F-2b (`lastUsedAt/Ip` async update), F-15 (SQL expiry filter), F-17 (`S3FileInfo` type + pagination), F-18 (central `sanitizeStorageKey()`), L-4 (health detail behind global-admin).

### R3 — Unify path construction (2–3 days) — **F-13**
Single source of truth (recommend a JSON schema under `packages/types/`) consumed by both `transcription-job.controller.ts` and `path_resolver.py`.

### R4 — Provider abstraction (1 week) — **F-4**
Introduce `IBlobStorageProvider` + `S3Provider` + `AzureBlobProvider` + factory (§7.2). `StorageProvider`/`StorageTopology` enums in `packages/types`.

### R5 — Per-tenant provider routing (1–2 weeks) — **F-3**
Add `TenantStorageConfig` (§7.3) + factory resolution + `credentialsRef → SecretsService`. Backfill `{MINIO, SHARED}`; ship Azure; ship dedicated onboarding UI.

### R6 — Missing use cases (1 week)
- **Attachments (C)**: `ContextItem.mediaId` FK + `POST /consultations/:id/attachments` (multipart, MIME allow-list).
- **Avatar (D)**: `POST /user/me/avatar` (image-only, ≤5 MB) → `UserProfile.avatarId`; resize thumb/mid/full (O-5).
- **Branding (F)**: `TenantBranding` model + `POST /admin/tenants/me/branding/:assetType`.

### R7 — Lifecycle & retention (2 days) — **F-14**
`setLifecycle()` on the provider; wire into provisioning. Defaults: `chunks/sessions/*`→24h, `streams/*/raw/chunk_*`→7d, `temp/*`→24h, `*/raw/*`→90d (configurable).

### R8 — Presigned PUT upload flow (3 days) — **O-1**
`signUploadUrl()` (PUT) + `POST /storage/uploads/init` → `{ uploadUrl, mediaId, key, expiresAt }` + `POST /storage/uploads/complete` (HeadObject verify) + bucket CORS docs + SDK `useUpload` helper.

### R9 — SDK storage workflow surface (3–4 days) — **F-5..F-7**
`useTenantBuckets`, `useStorageKeys`, `useUpload`, `useAttachments`, `useAvatar`, `useTenantBranding`; add admin endpoint constants; repoint `useStorage` and fix its mislabeled docstring.

---

## 10. Performance Optimizations

| ID | Area | Issue | Optimization |
|---|---|---|---|
| O-1 | Upload | All bytes traverse Node.js (≤100 MB) | Presigned PUT (R8) — direct-to-storage, lifts cap |
| O-2 | Listing | `listFiles` truncates at 1000 silently | Continuation-token pagination; expose `?cursor=&limit=` |
| O-3 | Key expiry | `findActiveByTenant` in-memory scan | SQL `WHERE expiresAt IS NULL OR expiresAt > NOW()` |
| O-4 | Reads | `getFile` always buffers | `getStream()` for pass-through |
| O-5 | Avatar | Full image every load | Resize thumb/mid/full on upload |
| O-6 | Tree | `getBucketTree` fetches full prefix | Delimiter `/` + lazy-load on expand |
| O-7 | Presign TTL | Fixed 3600 s | Per-purpose TTL (download/preview/share) |
| O-8 | Clients | New client per provider instance | LRU pool per credentials tuple |
| O-9 | STT chunks | Each chunk a separate `put_object` | Batch into 30 s WAV multipart |
| O-10 | STT SDK | `minio`-only (no Azure, weak pooling) | Move Python to `aioboto3` (+ Azure adapter) — aligns R3/R4 |

---

## 11. Target Architecture

```
clients (admin UI / doctor UI / SDK)
   │ presigned PUT/GET            │ control plane (init/complete/list/admin)
   ▼                              ▼
            apps/api (NestJS)
   END-USER plane                 ADMIN plane
   • file CRUD on owned buckets   • TenantBucketController (+upload/delete)
   • uploads/init|complete        • StorageAccessKeyController
   • attachments/avatar           • BrandingController
                  │
                  ▼
         BlobStorageService → BlobStorageProviderFactory ──(TenantStorageConfig)──►
                  │                         │
            S3Provider                AzureBlobProvider
            (MinIO / AWS S3)          (Azure Storage)
              shared / dedicated        shared / dedicated
```

**Key conventions — single source of truth** (`packages/types/storage-paths.*`, consumed by TS + Python):

```
{tenantId}/{yyyy}/{MM}/{dd}/
  ├─ jobs/{jobId}/{raw|processed}/{file}, transcript.{json|txt|vtt|srt}
  ├─ consultations/{cid}/{jobId}/{raw|processed}/{file}, transcript.*
  └─ streams/{sessionId}/{raw|processed}/{chunk_NNNN.pcm|complete.wav}, transcript.json, metadata.json
attachments/{tenantId}/{consultations/{cid}/{itemId}|users/{userId}/avatar/{size}|tenant/branding/{asset}}/{file}
temp/{tenantId}/{uuid}    # 24h lifecycle
```

---

## 12. Open Questions / Decisions Needed

| # | Question | Recommendation |
|---|---|---|
| 1 | Azure strategy: first-class adapter, S3-compat front-end, or out-of-scope? | First-class `@azure/storage-blob` adapter (§7.1 opt 2) |
| 2 | Dedicated topology: provision per-tenant infra, or "bring your own" credentials? | Bring-your-own first; provisioning later |
| 3 | `secretAccessKey`: recoverable, or display-once hash? | Display-once **hash-only** (industry standard) |
| 4 | Branding storage: new `TenantBranding` table, fields on `Tenant`, or K/V refs? | New `TenantBranding` model |
| 5 | Legacy `StorageController`: deprecate now or harden+deprecate? | Harden (F-1/F-8) now, deprecate next release |
| 6 | STT-v2 SDK: stay on `minio` + Azure branch, or unify on `aioboto3` + Azure? | Unify on `aioboto3` |
| 7 | Per-tenant MinIO IAM: automate `mc admin user add`, or rely on app-layer? | App-layer sufficient once F-1/F-8 fixed; defer real IAM |
| 8 | Retention defaults (7d/24h/90d) acceptable? | Start with defaults; per-tenant override via `setLifecycle()` |

---

## 13. Suggested Sequencing

```
Week 1   ─ R1 (security: F-1,F-2,F-8,F-10), R2 (cleanups)         ← unblock prod isolation
Week 2   ─ R3 (path unification), R7 (lifecycle)                   ← operational hygiene
Week 3-4 ─ R4 (provider abstraction)                              ← architecture
Week 5-6 ─ R5 (per-tenant config + Azure)                         ← multi-provider
Week 7   ─ R8 (presigned upload), R6 attachments                  ← scale + use case C
Week 8   ─ R6 avatar + branding, R9 (SDK surface)                 ← remaining use cases + SDK
```

---

## 14. Change History

| Date | Description | Files |
|---|---|---|
| 2026-05-30 | Initial review (TASK-318). Re-verified all TASK-304 findings against current code (post TASK-305/307/310/317); added SDK file/bucket workflow analysis and the end-user/admin API split; produced reconciled findings (F-1..F-19), refactor (R1..R9), optimization (O-1..O-10), and target architecture. No source modified. | This document |
| 2026-05-30 | **Wave 1 implementation kickoff.** Three file-disjoint streams launched in parallel in isolated git worktrees off `fix/2605-review`@`6041ff93`: **W1** provider abstraction (R4 — `IBlobStorageProvider` + S3 + Azure + config factory, official deps, additive); **W2** `StorageController` scoping (F-1, F-8, F-18); **W3** `StorageAccessKey` hardening (F-2, F-2b, F-4b, F-15). Decisions locked: Azure = first-class `@azure/storage-blob` adapter (OQ#1); secret = display-once HMAC hash (OQ#3). | (see §15) |
| 2026-05-30 | **Wave 1 integrated & verified** (working tree, not yet committed). Applied all three disjoint branches; `pnpm build:api` 8/8; domains 1084✅; applications 4488✅ (7 pre-existing TASK-307 auth failures, proven identical on base); api storage 22/22✅; 61 new provider tests; lint clean. Required one cross-stream fix: `@arcaai/types` ESM re-export extensions (`packages/types/src/index.ts`) — pre-existing latent bug exposed by W1's first runtime enum import. | W1+W2+W3 files, `packages/types/src/index.ts` |

---

## 15. Implementation Log — Wave 1

**Execution model:** parallel, file-disjoint workstreams, each in its **own isolated git worktree** (zero cross-impact on files or build artifacts), merged sequentially after self-verification, then integrated + verified together.

**Decision (your point 3):** the backend must run on **AWS S3 / MinIO _or_ Azure Storage**, chosen by a global `STORAGE_PROVIDER` config, behind one `IBlobStorageProvider` interface, using **official SDKs** (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, already present; `@azure/storage-blob`, newly added). Per-**tenant** provider routing (`TenantStorageConfig`, R5) is deliberately deferred to a later wave so this one stays additive and non-conflicting.

| Stream | Scope (findings) | Owned paths (disjoint) | Status |
|---|---|---|---|
| **W1** | R4 provider abstraction (relates F-4, F-16, F-17, O-2/O-4/O-8) | `packages/applications/.../baseServices/storage/**` (new), `packages/applications/package.json`, `packages/types/src/**` | ✅ Integrated & verified (`aecad240`) |
| **W2** | F-1 (bucket-list cross-tenant leak), F-8 (name/slug), F-18 (key traversal) | `apps/api/src/modules/storage/**` | ✅ Integrated & verified (`d5c2e08b`) |
| **W3** | F-2 (plaintext secret → hash, display-once), F-2b (`lastUsedAt/Ip`), F-4b (double DI), F-15 (SQL expiry) | `packages/domains/.../StorageAccessKey*`, `packages/applications/.../storage-access-key/**` | ✅ Integrated & verified (`781be39c`) |

**Deferred to coordinated follow-up waves** (require shared-file edits or cross-runtime key-convention changes — unsafe to parallelize here):
- **R5** per-tenant `TenantStorageConfig` + wiring existing `S3Service` consumers onto the abstraction (touches schema + many consumers).
- **F-10 / F-13 / R3** STT-v2 tenant-keyed paths + TS/Python single-source path schema (coordinated TS + Python + existing-object migration).
- **R7** lifecycle/retention wiring, **R8** presigned PUT end-to-end, **R9** SDK storage workflow surface, **R6** attachments/avatar/branding use cases.

**Out of this wave by design:** `revokeKey` explicit guard (C1) is already mitigated by the tenant-scope `$extends`; kept on the defense-in-depth backlog.

### 15.1 Integration & verification (2026-05-30)

The three disjoint branches were applied into the working tree (no file overlap — only `pnpm-lock.yaml` came from W1), `pnpm install` reconciled the Azure SDK, and the full chain was verified together:

| Check | Result |
|---|---|
| `pnpm build:api` (`types→database→domains→applications→api`) | ✅ **8/8 tasks**, tsc clean |
| `@arcaai/domains` full unit suite | ✅ **1084 passed**, 0 failed (2 skipped, 9 todo) |
| `@arcaai/applications` full unit suite | ✅ **4488 passed**; only **7 pre-existing** failures remain (see below) |
| `@arcaai/api` storage suite | ✅ **22/22** |
| W1 provider/factory/service unit tests | ✅ **61 new** (S3 19, Azure 20, factory 8, service 14), part of the applications pass |
| ReadLints on all touched files | ✅ no errors |

**Cross-stream fix required during integration — `@arcaai/types` ESM correctness.** W1 introduced the first *runtime* import of `@arcaai/types` (the `StorageProvider` enum) into `@arcaai/applications`. `@arcaai/types` is `"type": "module"` but `tsc` (moduleResolution `Bundler`) emitted **extensionless** re-exports in `dist/index.js` (`export * from './meeting'`), which Node's ESM loader rejects. This was a **pre-existing latent bug** (the package had only ever been consumed type-only) that would also crash `apps/api` at production boot. Fixed by adding explicit `.js` extensions to the 13 re-exports in `packages/types/src/index.ts` (the individual type files use `import type`, erased at runtime, so no other file needed changing). `Bundler` resolution accepts `.js` specifiers and maps them to `.ts`; consumers read `dist/index.d.ts` unaffected.

**Pre-existing failures (NOT introduced here, do not block this wave):** 7 tests in `authorization/policy.engine.no-usergroup`, `authorization/tenant-ability.regression`, and `userRoleAssignment.service.task307` fail with `TypeError: Cannot read properties of undefined (reading 'userRoleAssignment')` (a mocked-Prisma gap from the TASK-307 tenant-scope refactor). **Verified identical (7 failed | 14 passed) on the base `applications` package** (W2 worktree, which carries no `applications`/`types` changes) — confirming they are independent of this work. Recommend tracking under the TASK-307 lineage.

### 15.2 Operational notes / follow-ups

- **W3 (pre-prod data):** existing `StorageAccessKey` rows still hold **plaintext** secrets; since validation now compares a hash, **existing keys must be re-issued** (no backfill attempted — would require reading plaintext we no longer trust).
- **W1 config keys introduced:** `STORAGE_PROVIDER` (AppSettings; `minio` default \| `aws_s3` \| `azure_blob`); Azure adds `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_ENDPOINT_SUFFIX` (AppSettings) + `AZURE_STORAGE_CONNECTION_STRING` / `AZURE_STORAGE_ACCOUNT_KEY` (SecretsService). S3 reuses existing `S3_*` keys.
- **W1 Azure limitations (documented in code):** `setLifecycle()` throws `StorageNotSupportedError` (blob ILM is an account-level ARM/management-plane operation, absent from `@azure/storage-blob`); SAS presigning requires a shared-key/connection-string credential and is HTTPS-only (Azurite/local-HTTP would need relaxing).
- **Status:** integrated in the **working tree, not committed** (per repo policy — awaiting your go-ahead to commit). Worktree branches `task-318/w1|w2|w3-*` remain available.
