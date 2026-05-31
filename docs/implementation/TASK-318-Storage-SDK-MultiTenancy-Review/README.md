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
| R-c | Doctor uploads session attachments (PDF/img/lab) | **Implemented** (W3-D) | Upload via `storage.controller` → `Media`; linked through `addAttachment(…, mediaId)` (`ContextItem.mediaId`); **SMR reads + summarizes** the attachment (`smr-proxy` text extraction). Bespoke per-attachment upload endpoint not added (scope). |
| R-d | Doctor uploads profile avatar | **Missing** | `UserProfile.avatarId` field exists; no upload endpoint (F-9). |
| R-e | Live pipeline persists raw + processed audio | **Implemented + tenant-routed** (W3-B/C) | STT-v2 writes raw + processed + transcript + metadata; bucket now resolved by **AUDIO purpose** and a per-tenant `storage` descriptor routes the provider. (`tenant_id`-in-object-key is a separate STT-v2 path concern — F-10.) |
| R-f | Tenant admins upload tenant config files (logo/bg) | **Partial** | MISC default bucket now exists per tenant (W3-A) for backgrounds/avatars/images; dedicated tenant-config upload endpoint still absent (F-11). |
| R-g | Self-hosted MinIO — shared | **Implemented** | Default deployment. |
| R-h | Self-hosted MinIO — dedicated per tenant | **Implemented (backend)** (W2/W3-C) | Per-tenant `endpoint`+creds via `TenantStorageConfig`; descriptor propagated to STT-v2. Not yet exercised against a live dedicated instance. |
| R-i | AWS S3 — shared | **Implemented (backend)** | `@aws-sdk/client-s3` (TS) / `minio` SDK (Python) + endpoint swap. |
| R-j | AWS S3 — dedicated per tenant | **Implemented (backend)** (W2/W3-C) | Per-tenant credential/endpoint routing via `TenantStorageConfig` + descriptor. Not yet exercised against live AWS. |
| R-k | Azure Storage — shared | **Implemented (backend)** (W1/W3-C) | `@azure/storage-blob` (TS) + `azure-storage-blob` (Python). Not yet exercised against a live account. |
| R-l | Azure Storage — dedicated | **Implemented (backend)** (W2/W3-C) | Per-tenant Azure config via `TenantStorageConfig` + descriptor → STT-v2. Not yet exercised against a live account. |
| R-m | SDK developer file/bucket workflow API | **Partial** | `useStorage` (legacy routes only), no admin/key/attachment/avatar/presigned coverage (F-5..F-7, R9 not started). |
| R-n | API split: end-user group + admin group | **Partial** | Split exists by convention; legacy `storage/` controller blurs it (F-1, F-6). |
| R-o | Multi-tenancy | **Strong app-layer; storage-layer now per-tenant** | `$extends` + `@TenantOwnedResource` + CLS; storage provider/creds now per-tenant via `TenantStorageConfig` + descriptor (was shared). |

> **Status note (2026-05-31):** rows above reflect Wave 1–3. The authoritative per-wave detail + evidence lives in **§15 (Wave 1)**, **§16 (Wave 2 — per-tenant routing)**, and **§17.9 (Wave 3 — cross-service integration)**. "Implemented (backend)" = wired + unit-verified in this repo; live-cloud (AWS/Azure) end-to-end testing is still outstanding.

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
| 2026-05-30 | **Wave 2 — R5 P5 admin API (additive).** New `apps/api` feature module `tenant-storage-config` exposing `/admin/tenants/storage/config` (GET list, GET `/effective`, PUT upsert, DELETE `:id`) mirroring `TenantBucketController` (`@CanManage('Tenant')` + `@Can*('Storage')`, reuses existing `Storage` subject — no seed changes). Registered `BlobStorageModule.forRoot()` in app-root `common[]` + `TenantStorageConfigModule` in `featureModules[]`; added `TenantStorageConfig` to the `@TenantOwnedResource` union + interceptor (tenant-scoped). `pnpm build:api` 8/8✅; new controller + interceptor-branch tests pass; lint clean. **P4 (consumer migration) + P1b (DB apply) remain gated.** | `apps/api/.../tenant-storage-config/**`, `app.module.ts`, `common/tenant-owned-resource.{decorator,interceptor}.ts` |
| 2026-05-30 | **Wave 2 — R5 per-tenant provider routing (P1–P3 of 6).** Added the `TenantStorageConfig` model/enums (`StorageProviderType`, `StorageTopologyType`) + FK + additive migration; full domain layer (entity/model/mapper/factory/repository) + tenant-scope allow-list; extended `BlobStorageProviderFactory` with `getProviderForBucket()` (per-bucket → tenant default → global/shared) + bounded provider cache + `invalidate()`; made `BlobStorageService` tenant-aware via CLS; made `BlobStorageModule` `@Global()` (single shared factory ⇒ cache coherence); added `TenantStorageConfigService` (CRUD) + DTOs. Added `ResourceType.TenantStorageConfig` (Prisma + TS) for audit attribution. Verified: domains build✅, applications build✅, storage+config tests **165/165**✅, lint clean. DB apply (P1b) + consumer migration (P4) + admin API (P5) pending. | `packages/database/.../tenant-bucket.prisma`, `audit.prisma`, `enums.prisma`, migration; `packages/domains/.../TenantStorageConfig*`, `ResourceType.ts`, tenant-scope; `packages/applications/.../storage/**`, `tenant-storage-config/**` |
| 2026-05-31 | **Wave 2 — R5 P1b + P4 complete; per-tenant routing now LIVE.** **P1b:** applied the additive schema to the (reset) dev DB — `prisma db push` reports *"already in sync"*; `TenantStorageConfig` table + both enums + `ResourceType.TenantStorageConfig` confirmed present. **P4:** migrated every file consumer off legacy `IS3Service` onto tenant-aware `IBlobStorageService` — `transcription-job.controller` (audio upload → `putObject`); `tenant-bucket.service` (browse → `listObjects`, presign → `presignGet`, provision/create → `createBucket`); `storage.controller` (create/delete bucket, list, upload, presign-get, delete). `S3Service` retained **only** for ops with no provider-agnostic equivalent: `setBucketPolicy` (best-effort SHARED-store hardening) + `updateBucket` (S3 metadata tags). Removed now-orphan `S3ServiceModule` from `streaming.module`. Verified: applications build✅, `pnpm build:api` **8/8**✅, tenant-bucket **26/26** + api storage/transcription **55/55**✅, lint clean; `dev:api` compiles **0 errors** and the **DI graph resolves** (boot then hit an *unrelated* `permission denied for schema core` — the Vault-managed runtime role lost its grants on the reset DB; re-run `packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql`). | `storage.controller.ts`, `transcription-job.controller.ts`, `streaming.module.ts`, `tenant-bucket.service.ts` (+ their 3 test files) |
| 2026-05-31 | **Wave 3 — cross-service storage integration complete (W3-A…W3-D).** End-to-end multi-provider storage across services + configurable per-tenant bucket purposes. **W3-A:** `TenantBucketPurpose` enum + `TenantBucket.purpose` (+ MISC system bucket, `findByPurpose`, `getDefaultBuckets`/`setDefaultBuckets`, admin `GET/PUT /admin/tenants/storage/buckets/defaults`). **W3-B:** `StorageDescriptor` resolved on the blob factory/service (snake_case, DEDICATED-only creds, `null` for SHARED) and propagated to STT-v2 — batch via `kwargs.storage`, streaming via a new POST `storage` field. **W3-C** (subagent, `apps/stt-v2`): provider abstraction (MinIO/AWS S3 via `minio`, Azure via `azure-storage-blob`) gated on the optional descriptor; no-descriptor path byte-for-byte unchanged. **W3-D:** `ContextItem.mediaId` soft reference + SMR proxy fetches the attachment from object storage and extracts text (text/JSON/XML/CSV native, PDF via `pdf-parse@1.1.1`, OCR deferred) and injects it; `mediaId` threaded through the add-context/attachment write path. Verified: `pnpm build:api` **8/8**✅; applications **661**✅ / domains **466**✅ / api streaming **95**✅ (incl. new descriptor + attachment tests); stt-v2 pytest **1845**✅. See §17.9 for deviations (factory-hosted descriptor vs. new service; app-layer purpose-uniqueness; `pdf-parse@1.1.1` vs v2). | See §17.9 "Files changed"; Prisma `enums/tenant-bucket/consultation.prisma`; `apps/api/package.json`; `apps/stt-v2/**` |

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

---

## 16. Implementation Log — Wave 2 (R5: per-tenant provider routing)

**Goal (your clarification):** the **backend** handles all file management; each tenant runs on **S3 _or_ Azure** per its configuration; **by default every tenant shares one configuration**. Implemented as per-tenant + per-bucket overrides layered over the global/shared provider.

**Resolution precedence** (read path, in `BlobStorageProviderFactory.getProviderForBucket`):

```
per-bucket override (TenantStorageConfig where bucketId = <bucket>)
  → tenant default (TenantStorageConfig where bucketId IS NULL)
    → global/shared provider (STORAGE_PROVIDER env, the W1 default)
```

A `topology = SHARED` row resolves straight to the global provider; `DEDICATED` builds a tenant-owned S3/Azure client from the row + a `credentialsRef` (a **SecretsService key name**, never the raw secret — credentials stay in the secrets manager).

| Phase | Scope | Key files | Status |
|---|---|---|---|
| **P1 DB** | `TenantStorageConfig` model, `StorageProviderType`/`StorageTopologyType` enums, FK→`TenantBucket`, additive migration; `ResourceType.TenantStorageConfig` (enum + `ALTER TYPE … ADD VALUE`) | `tenant-bucket.prisma`, `enums.prisma`, `audit.prisma`, `migrations/20260530160000_add_tenant_storage_config/` | ✅ authored + **applied** (P1b: `db push` in sync) |
| **P2 Domain** | entity/model/mapper/factory/repository (`findTenantDefault`/`findForBucket`/`findAllByTenant`) + barrels + tenant-scope allow-list + `CoreDatabaseModule` registration + unit tests | `packages/domains/src/**/TenantStorageConfig*`, `extensions/tenant-scope.ts` | ✅ build + tests pass |
| **P3 Service+Factory** | factory `getProviderForBucket()` + bounded FIFO cache + `invalidate()`; tenant-aware `BlobStorageService` (CLS); `@Global()` `BlobStorageModule` (shared singleton factory); `TenantStorageConfigService` CRUD + DTOs + module | `storage/providers/blob-storage.provider.factory.ts`, `storage/blob-storage.service.ts`, `storage/blob-storage.module.ts`, `tenant-storage-config/**` | ✅ build + **165/165** storage tests |

**Design decisions taken (noted, not blocking):**
1. **`BlobStorageModule` is now `@Global()` with a single `forRoot()`** (W1's `forFeature()` removed — it was unused). A single factory instance is mandatory so the read-path cache and `TenantStorageConfigService.invalidate()` operate on the **same** cache. Mirrors the existing `@Global() AppSettingsModule` pattern.
2. **Credentials are referenced, never stored.** `TenantStorageConfig.credentialsRef` holds a SecretsService key; `SecretsService` is read-only here, so DEDICATED credentials must be provisioned out-of-band (Vault/AWS/Azure). DTO responses expose only the key *name*.
3. **`ResourceType.TenantStorageConfig`** added to both the Prisma enum (`audit.prisma`, via `ALTER TYPE … ADD VALUE IF NOT EXISTS`) and the TS enum, so config mutations emit first-class audit `SysEvent`s (avoids the "missing SysEvent after mutation" anti-pattern).
4. **Additive & non-breaking (through P3):** the legacy `S3Service` and all consumers were left untouched until P4; per-tenant routing went live once consumers moved to `IBlobStorageService` (**P4, done — see §16.2**) and the modules were registered at the app root (P5).

**Verification (actual):** `pnpm build --filter @arcaai/domains` ✅; `pnpm build --filter @arcaai/applications` ✅ (7/7); `vitest run src/services/baseServices/storage src/services/tenant-storage-config` → **8 files / 165 tests passed** (W1 145 + 20 new: 8 factory-tenant, 11 service, 1 service-delegation). Pre-existing TASK-307 auth failures (7) remain, proven unrelated in Wave 1. Lint clean on all touched files.

### 16.1 P5 — Admin API (done, additive)

New feature module `apps/api/src/modules/tenant-storage-config/` exposing **`/admin/tenants/storage/config`** (mirrors `TenantBucketController`: class `@CanManage('Tenant')`, method `@Can*('Storage')`, reuses the existing `Storage` CASL subject — **no seed changes**):

| Method | Route | Auth | Notes |
|---|---|---|---|
| `GET` | `/admin/tenants/storage/config` | `@CanRead('Storage')` | list tenant configs (`?includeDisabled=true`) |
| `GET` | `/admin/tenants/storage/config/effective` | `@CanRead('Storage')` | resolve effective config (`?bucketId=`) |
| `PUT` | `/admin/tenants/storage/config` | `@CanUpdate('Storage')` | upsert (omit `bucketId` ⇒ tenant default) |
| `DELETE` | `/admin/tenants/storage/config/:id` | `@CanDelete('Storage')` + `@TenantOwnedResource` | soft-delete |

Wiring: `BlobStorageModule.forRoot()` added to the app-root `common[]` (after `CommonServiceModule`); `TenantStorageConfigModule` added to `featureModules[]`. `TenantStorageConfig` registered in the `@TenantOwnedResource` union + interceptor (tenant-scoped `findById`). **Verified:** `pnpm build:api` **8/8** ✅; api tests for the new controller + the modified interceptor + storage/tenant-bucket suites **all pass** (new: 6 controller + 2 interceptor branch tests); lint clean.

### 16.2 P1b + P4 — completed (2026-05-31)

**P1b — schema applied.** The DB was reset + reseeded (`pnpm db:all`, exit 0); `prisma db push` then reported **"The database is already in sync with the Prisma schema."** The new `TenantStorageConfig` table, `StorageProviderType` / `StorageTopologyType` enums, and the `ResourceType.TenantStorageConfig` value are present. No DROP/DELETE/TRUNCATE was run.

**P4 — consumers migrated; routing live.** Every runtime file path now resolves its provider per-tenant via `IBlobStorageService` (→ `BlobStorageProviderFactory.getProviderForBucket`):

| Consumer | Was (`IS3Service`) | Now (`IBlobStorageService`) |
|---|---|---|
| `transcription-job.controller` | `putFile` | `putObject` |
| `tenant-bucket.service` · browse | `listFiles` | `listObjects().objects` |
| `tenant-bucket.service` · presign | `signUrl(…, 'get')` | `presignGet({…, expiresInSeconds: 3600})` |
| `tenant-bucket.service` · provision/create | `createBucket` | `createBucket` |
| `storage.controller` · buckets | `createBucket` / `deleteBucket` | `createBucket` / `deleteBucket` |
| `storage.controller` · files | `listFiles` / `putFile` / `signUrl` / `deleteFile` | `listObjects` / `putObject` / `presignGet` / `deleteObject` |

**`S3Service` retained only where the provider abstraction has no equivalent** (both S3/MinIO-only, both best-effort and tenant-routing-agnostic):
- `setBucketPolicy` — tenant-isolation IAM policy on the **SHARED** store (`tenant-bucket.service.provisionSystemBuckets`). Azure containers are private by default and have no bucket-policy concept; for a `DEDICATED` Azure/S3 tenant this is a harmless no-op (the call is wrapped in try/catch + warn). Hardening a dedicated tenant's own store is deferred (R6-adjacent).
- `updateBucket` — description/status stored as S3 bucket **tags** (`storage.controller.updateBucket`). No provider-agnostic metadata API; bucket metadata arguably belongs on the `TenantBucket` row (future cleanup).

Orphan cleanup: `S3ServiceModule` was removed from `streaming.module` (its only consumer there, `transcription-job.controller`, no longer injects `IS3Service`; `IBlobStorageService` is `@Global()`). `storage.module` keeps `S3ServiceModule` for the two retained ops + `S3HealthService`.

**Verification (actual):**

| Check | Result |
|---|---|
| `pnpm build --filter @arcaai/applications` (tsc) | ✅ clean |
| `pnpm build:api` (`types→…→api`) | ✅ **8/8** |
| `vitest` `tenant-bucket.service` | ✅ **26/26** |
| `vitest` api `storage.controller.task318-w2` + `transcription-job.controller` | ✅ **55/55** |
| ReadLints on all touched files | ✅ no new errors (2 **pre-existing** strict-TS warnings remain in `tenant-bucket.service.test.ts`: `...actual` spread + `patientsFolder?.children` — not authored here) |
| `dev:api` boot | ✅ tsc **0 errors**, **DI graph resolves** (no `UnknownDependenciesException`) |

**⚠️ Operational follow-up (NOT a code defect, blocks local `dev:api`):** after boot the app crashed with `Error: permission denied for schema core`. The privileged migrate/seed role (`postgres`, from `DATABASE_URL`) can write, but the **runtime** Prisma connection uses a **Vault-managed role** that lost its grants on the freshly-recreated `core` schema during the DB reset. Re-apply the grants (e.g. `packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql`, or your normal post-reset Vault DB-role bootstrap) before running the API. Unit tests + builds are unaffected (they don't use the Vault role).

**Remaining R5 niceties (optional, non-blocking):** dedicated-tenant bucket-policy/ACL hardening; moving bucket metadata off S3 tags onto `TenantBucket`; presigned-PUT upload flow (O-1 / R8); SDK `useStorage` surface (R9).

---

## 17. Wave 3 — Cross-service storage integration (IMPLEMENTED 2026-05-31)

> **Status: COMPLETE.** All four workstreams (W3-A…W3-D) landed and verified — see the implementation summary in **§17.9**. The plan below (§17.1–17.8) is retained as the design of record; deviations are called out in §17.9.

**Goal (user, 2026-05-31):** make storage work end-to-end across the Python services and add a configurable per-tenant "bucket purpose" model:
- STT can **read** uploaded files for batch processing.
- STT can **write** raw audio + processed audio (streaming).
- SMR can **read** an uploaded consultation attachment for summarization.
- A **default audio bucket** + a **default misc bucket** (tenant background / avatars / images) exist per tenant, auto-created at tenant creation.
- Tenant admin can **configure** the default bucket for (a) audio and (b) consultation attachments.

### 17.1 Decisions locked by user
| # | Decision | Choice |
|---|---|---|
| D1 | Python per-tenant I/O for Azure tenants | **Full Azure in Python**: propagate `provider + endpoint + credentials` to the worker; add `azure-storage-blob` + a provider abstraction to stt-v2. |
| D2 | Scope | **All** (purpose model + misc bucket + admin config + Python I/O + SMR attachment read). |
| D3 | SMR attachment read | **NestJS-assembled**: API fetches the file, extracts text, passes text to SMR. SMR stays text-in/text-out. |

### 17.2 Verified current state (evidence)
- stt-v2 object storage = `minio` SDK only (`apps/stt-v2/pyproject.toml:48`); `azure-cognitiveservices-speech` is ASR, **not** Blob. **No Vault/secret client** — creds from bare env vars (`core/config/settings.py:84-91`).
- Single SDK touchpoints to abstract: `BlobService._upload_bytes` / `_download_bytes`; tenant bucket injected by `StoragePathResolver.set_tenant_bucket(tenant_id, "audio", name)` (`storage/path_resolver.py:441-461`).
- Batch dispatch = positional Dramatiq args **+ empty `kwargs:{}`** (`transcriptionRealtime.service.ts:358-379`); actor `transcribe_file(...)` (`transcription/workers/transcribe_file.py:33-44`). Streaming dispatch = internal HTTP POST body (`streamingSession.service.ts:66-84` → `streaming/api/schemas.py:8-24`).
- Bucket purpose today = slug string only; `getBucketBySlug('audio')` in `transcription-job.controller.ts:178-186, 288-290`. `CreateDefaultSystemBuckets` makes only `audio` + `attachments` (`TenantBucketFactory.ts:5-8`); no purpose field on `TenantBucket`.
- `ContextItem(ATTACHMENT)` has **no `mediaId`** link (`consultation.prisma`); `Media.uri = s3://bucket/key` (`media.prisma`); no TS text-extraction lib in any `package.json`.

### 17.3 Contract — the storage descriptor (TS → Python)
A single JSON object resolved per `(tenantId, bucket)` in NestJS and sent to Python. **SHARED tenants omit credentials** (Python uses its env-configured default client — unchanged from today); only **DEDICATED** tenants embed resolved credentials.
```jsonc
// AS BUILT — snake_case keys so the JSON maps 1:1 onto the Python worker schema
// (no key translation layer). See IBlobStorageProvider.StorageDescriptor.
{
  "provider": "minio" | "aws_s3" | "azure_blob",
  "bucket": "<physical bucket/container name>",
  // S3 / MinIO (DEDICATED only):
  "endpoint": "https://…", "region": "us-east-1", "force_path_style": true,
  "access_key_id": "…", "secret_access_key": "…",
  // Azure (DEDICATED only):
  "account_name": "…", "endpoint_suffix": "core.windows.net",
  "connection_string": "…", "account_key": "…"
}
```
Resolved by `BlobStorageProviderFactory.resolveDescriptorForBucket()` (reusing `resolveConfig()` + `loadCredentials()` + `TenantStorageConfig`) and exposed via `IBlobStorageService.resolveDescriptor(bucket)`. Batch → carried in `kwargs.storage` (no positional reshuffle). Streaming → new `storage` field in the POST body. **Deviation from plan:** resolution lives on the existing factory/service rather than a separate `StorageDescriptorService` — the factory already owns config + credential resolution, so a new service would have been an empty pass-through.

### 17.4 Workstreams (file-disjoint, parallelizable)
**W3-A — Bucket-purpose model + misc bucket + admin config (TS-only, additive)**
1. DB: add enum `TenantBucketPurpose {AUDIO, ATTACHMENTS, MISC, CUSTOM}` + `purpose` column on `TenantBucket` (default `CUSTOM`); partial unique index `(tenantId, purpose)` for non-CUSTOM. Migration + `db push`.
2. Domain: regenerate model/entity/mapper; add `TenantBucketRepository.findByPurpose(tenantId, purpose)`.
3. Factory + seed: add `MISC: 'misc'` to `SYSTEM_BUCKET_SLUGS`; set `purpose` on the 3 system buckets in `CreateDefaultSystemBuckets` + `seed/05a-tenant-bucket.ts`.
4. Service: `TenantBucketService.getBucketByPurpose()`, `setBucketPurpose()` (move purpose, clear previous holder).
5. Admin API: `GET/PUT /admin/tenants/storage/defaults` (set audio + attachment default bucket); guarded by existing CASL `Storage`.

**W3-B — Descriptor resolution + propagation (TS)**
1. `StorageDescriptorService.resolveForBucket(tenantId, bucketName)`.
2. Batch: `transcription-job.controller.ts` resolve audio bucket by **purpose** (fallback slug), attach descriptor to `dispatchDramatiqJob` → `kwargs.storage`.
3. Streaming: `createStreamSession` resolve by purpose + descriptor → `streamingSession.service.ts` adds `storage` to POST body + DTO.

**W3-C — stt-v2 multi-provider (Python)**
1. Add `azure-storage-blob` to `pyproject.toml`.
2. New `core/storage/providers/{base,s3_provider,azure_provider,factory}.py` (ABC: `put_bytes/get_bytes/ensure_bucket/object_exists`). `factory.get_provider(descriptor)` with LRU cache keyed by descriptor identity; no-descriptor → current env/minio default.
3. Refactor `BlobService` to resolve provider from a per-tenant descriptor registry (mirror `set_tenant_bucket` → add `set_tenant_storage(tenant_id, descriptor)`); route `_upload_bytes/_download_bytes` through provider.
4. Consume descriptor: batch actor adds `storage: dict | None = None` kwarg → `set_tenant_storage`; streaming `schemas.py` + `routes.py` + `session_manager.create_session` add `storage`.
5. Settings: add `STORAGE_PROVIDER` + Azure default fields for the global/SHARED default client.

**W3-D — SMR attachment summarization (NestJS-assembled)**
1. DB: add `mediaId String?` FK on `ContextItem` → `Media` (migration + `db push`); regenerate domain.
2. Text extraction: add `pdf-parse` (PDF) + native UTF-8 (text); **decision needed** on images (OCR) — see 17.6.
3. `smr-proxy.controller.ts`: un-comment `ATTACHMENT` in `TYPE_LABEL_MAP`; in `assemblePrompt`, for ATTACHMENT items with empty `content`, resolve `Media → parse uri → IBlobStorageService.getObject → extract text → inject`.
4. Wire an upload path that links an attachment `Media` to its `ContextItem` (currently absent).

### 17.5 Migrations (additive, reviewed before apply)
- `TenantBucket.purpose` + enum `TenantBucketPurpose` + partial unique index.
- `ContextItem.mediaId` nullable FK.
- Backfill: set `purpose` on existing system buckets by slug (`audio`→AUDIO, `attachments`→ATTACHMENTS).

### 17.6 Open sub-decisions (defaults chosen; flag for review)
| # | Topic | Proposed default |
|---|---|---|
| S1 | Secret transport to workers | NestJS embeds resolved creds in descriptor **only for DEDICATED tenants**; SHARED sends none. (Redis-at-rest exposure for batch noted; Vault-in-Python deferred.) |
| S2 | "bucket **or** folder" default | Implement at **bucket** granularity (purpose). Folder granularity = existing `TenantBucket.pathPattern`; not re-modeled now. |
| S3 | Image/OCR attachments | **PDF + text now**; images/DOCX = pluggable extractor, OCR **deferred** (or delegate to NLP/Python later). |
| S4 | AWS S3 in Python | Reuse `minio` SDK for both `minio` + `aws_s3` (S3-compatible); `azure-storage-blob` for Azure. |

### 17.7 Risks
- Secrets in Redis (batch) for DEDICATED tenants → mitigate with short msg TTL; harden later via Vault-in-Python.
- stt-v2 resolver/registry are **in-memory** & lost on restart → descriptor must be re-sent per job/session (already the model for bucket).
- ContextItem→attachment linkage is greenfield (no existing upload wires a Media to an ATTACHMENT item).

### 17.8 Order & parallelization
W3-A and W3-C have no file overlap → parallel. W3-B depends on W3-A (purpose resolver) + defines the contract W3-C consumes → land contract shape first. W3-D is independent (separate files) → parallel. Suggested: **wave 1** = W3-A + W3-C scaffolding (provider abstraction) + W3-D schema; **wave 2** = W3-B propagation + W3-C consumption + W3-D assemble; **wave 3** = integrated tests + docs.

### 17.9 Implementation summary (completed 2026-05-31)

**W3-A — Bucket-purpose model + misc bucket + admin config (TS)**
- DB: `TenantBucketPurpose {AUDIO, ATTACHMENTS, MISC, CUSTOM}` enum + `TenantBucket.purpose` column (default `CUSTOM`) + index `(tenantId, purpose)`. Applied via `db push`.
  - **Deviation:** plain (non-unique) index + **application-layer** "≤1 non-CUSTOM bucket per (tenantId, purpose)" enforcement (`TenantBucketService.assignPurpose` clears the previous holder), mirroring the existing `TenantStorageConfig` tenant-default rule. A declarative Prisma *partial* unique index isn't expressible without raw SQL; app-layer enforcement matches the codebase convention.
- Domain: hand-edited `TenantBucket` model/entity/factory; added `TenantBucketRepository.findByPurpose()`. `TenantBucketPurpose` TS enum added to `enums/generated`.
- Factory + seed: added `MISC` system bucket; `CreateDefaultSystemBuckets` now provisions audio + attachments + misc and stamps `purpose`; `seed/05a-tenant-bucket.ts` backfills purpose on upsert.
- Service + admin API: `getBucketByPurpose`, `getDefaultBuckets`, `setDefaultBuckets`; `GET/PUT /admin/tenants/storage/buckets/defaults` (CASL `Storage`).

**W3-B — Descriptor resolution + propagation (TS)**
- `StorageDescriptor` contract on `IBlobStorageProvider`; `BlobStorageProviderFactory.resolveDescriptorForBucket()` (returns `null` for SHARED/global) + `IBlobStorageService.resolveDescriptor(bucket)`.
- Batch (`transcription-job.controller.transcribeFile`): resolves the audio bucket **by purpose → slug fallback**, resolves the descriptor, and passes it through `dispatchBatchJob → dispatchDramatiqJob` into `kwargs.storage` (empty `{}` for SHARED).
- Streaming (`createStreamSession`): same purpose-first resolution + descriptor → new optional `storage` field on `CreateStreamingSessionRequest` → `storage` in the STT-v2 POST body.

**W3-C — stt-v2 multi-provider (Python)** — delegated to a background subagent; confined to `apps/stt-v2`.
- `azure-storage-blob>=12.23.0` added; provider abstraction `core/storage/providers/{base,s3_provider,azure_provider,factory}.py` (S3 path serves both `minio` + `aws_s3`).
- `BlobService` routes per-tenant via `path_resolver.set_tenant_storage`/`resolve_tenant_storage`; no-descriptor path is **byte-for-byte unchanged** (falls back to the env-default MinIO client + bucket name).
- Descriptor consumed by the batch actor (`transcribe_file` `storage` kwarg) and streaming (`schemas.py`/`routes.py`/`session_manager.create_session`). Global-default Azure settings added to `settings.py`.
- Evidence: **1845 passed** (2 pre-existing ML-weight tests deselected; confirmed unrelated); ruff clean.

**W3-D — SMR attachment summarization (NestJS-assembled)**
- DB: `ContextItem.mediaId String?` soft reference (matches the existing `dnaWritingStyleId` reference-ID convention; no hard FK) + index. Applied via `db push`; domain model/entity/factory hand-edited.
- Read path: `smr-proxy.controller.assemblePrompt` labels `ATTACHMENT`, and for ATTACHMENT items with a `mediaId` resolves `Media → parse s3://bucket/key → IBlobStorageService.getObject → extractTextFromBuffer → inject`. Extraction is pluggable: text/JSON/XML/CSV decode natively; `application/pdf` via lazy `pdf-parse`; images/Office return `null` (skipped, OCR deferred). A single unreadable attachment **never fails** the request (logged + skipped); injected text capped at `ATTACHMENT_TEXT_LIMIT` (200k chars).
  - **Deviation:** used **`pdf-parse@1.1.1`** (CJS + DefinitelyTyped `@types/pdf-parse`), not the latest v2 — v2 is ESM-first and pulls native `@napi-rs/canvas`, a poor fit for the API's `module: commonjs` / `moduleResolution: node` build and heavier to deploy for a text-only need.
- Write path (enabling linkage): `mediaId` threaded through `AddContextRequest` → `addContext` → `ContextItemFactory.CreateContextItem/CreateAttachment`; `addAttachment(consultationId, content?, mediaId?)`; exposed on `ContextItemResponse` + mapper. The existing upload (`storage.controller`) → `Media` → `addAttachment(…, mediaId)` flow now links a file to a consultation; a bespoke upload endpoint was intentionally **not** added (scope).

**Resolved sub-decisions (from §17.6):** S1 — creds embedded in the descriptor for DEDICATED only, SHARED sends `null`; S2 — bucket-granularity purpose; S3 — PDF + text now, pluggable extractor, OCR deferred; S4 — Python reuses the MinIO SDK for `minio` + `aws_s3`, `azure-storage-blob` for Azure.

**Verification (evidence):**
- Builds: `pnpm build:api` → **8/8 successful** (database → domains → applications → api).
- Unit tests: `@arcaai/applications` **661 passed** (context / storage / stt / tenant-bucket); `@arcaai/domains` **466 passed** (entities / factories); `@arcaai/api` streaming controllers **95 passed** (incl. new W3-B descriptor + W3-D attachment-read/skip tests).
- `apps/stt-v2` pytest **1845 passed** (subagent).

**Files changed (TS):** `IBlobStorageProvider.ts`, `blob-storage.provider.factory.ts`, `blob-storage.service.ts`, `IBlobStorageService.ts`, `transcription-job.controller.ts`, `transcriptionRealtime.service.ts`, `streaming-session.dto.ts`, `streamingSession.service.ts`, `smr-proxy.controller.ts`; consultation context `add-context.request.ts` / `context.service.ts` / `context.dto.mapper.ts` / `context-item.response.ts`; `ContextItemFactory.ts` + `ContextItem{Model,Entity}.ts`; tenant-bucket `service` / `controller` / DTOs / repo / factory / seed; Prisma `enums.prisma`, `tenant-bucket.prisma`, `consultation.prisma`; `apps/api/package.json` (`pdf-parse`). **Python:** confined to `apps/stt-v2` (see W3-C).

**Known follow-ups (unchanged from §17.7):** Redis-at-rest exposure of DEDICATED creds for batch (short TTL now; Vault-in-Python later); stt-v2 descriptor registry is in-memory (re-sent per job/session by design); image OCR / Office text extraction deferred.
