# TASK-304: Storage Integration Review, Refactor & Optimization Plan

| Field | Value |
|---|---|
| **Ticket** | TASK-304 |
| **Type** | Review / Refactor / Documentation |
| **Created** | 2026-05-26 |
| **Updated** | 2026-05-26 |
| **Status** | Review |
| **Related** | TASK-239 (Tenant Blob Storage — In Progress), TASK-302 (Secrets Migration), TASK-258 (Tenant Config Provisioning) |
| **Scope** | NestJS API, applications layer, domains layer, database schema, STT-v2 Python service |

---

## 1. Executive Summary

The HOPE-v2 storage stack today is a **single-provider, single-endpoint S3-compatible client** with **partial per-tenant bucket isolation** (TASK-239, still In Progress). The user-stated requirements call for three providers (self-hosted MinIO, AWS S3, Azure Storage) operating in either **shared** or **dedicated** topologies, plus six concrete consumer flows.

### Gap matrix against requirements

| Requirement | Status | Notes |
|---|---|---|
| Tenant admin can browse own buckets/dirs/files | **Partial** | `TenantBucketController` works; legacy `StorageController` bypasses tenant scoping |
| Doctor uploads batch audio (transcription) | **Implemented** | `POST /audio/transcription-jobs/transcribe`, multipart, 100 MB cap |
| Doctor uploads session attachments (PDF/images/lab) | **Missing** | `ContextItemType.ATTACHMENT` exists but no file-upload endpoint exists |
| Doctor uploads profile avatar | **Missing** | `avatarId` field exists; no endpoint wired |
| Live audio pipeline persists raw + processed | **Implemented** | Python `StoragePathResolver` covers all paths; uses `minio` SDK (not boto3) |
| Tenant admin uploads tenant config (logo, background) | **Missing** | Tenant config is K/V only; no file-upload endpoint or media fields on `TenantEntity` |
| Self-hosted MinIO — shared instance | **Implemented** | Default deployment |
| Self-hosted MinIO — dedicated instance per tenant | **Not supported** | No per-tenant endpoint field anywhere |
| AWS S3 — shared account | **Possible** (untested) | Works because MinIO uses S3 SDK, but no AWS-specific config plumbing |
| AWS S3 — dedicated account per tenant | **Not supported** | No per-tenant credential / endpoint routing |
| Azure Storage Account — shared | **Missing** | No `@azure/storage-blob` dependency anywhere |
| Azure Storage Account — dedicated | **Missing** | Same — Azure not integrated |

### Headline findings

1. **Only one S3-compatible client exists** — `@aws-sdk/client-s3` in NestJS, `minio` SDK in Python. **Azure Blob Storage is not implemented anywhere** (the only Azure code is for ASR and OpenAI). Provider selection is implicit via endpoint URL.
2. **`StorageAccessKey.secretAccessKey` is stored in plain text** despite the schema comment claiming "encrypted at application layer." `CryptoService` exists but is not wired into the create path.
3. **`StorageAccessKeyService.revokeKey(id)` does not verify tenant ownership** before deleting — this is an IDOR. Any tenant admin with another tenant's key UUID can revoke it.
4. **Legacy `StorageController` lists/reads/deletes any bucket** without tenant ownership checks — `/storage/buckets`, `/storage/buckets/:name/files`, `/storage/buckets/:name/files/:key` are unscoped.
5. **STT-v2 `StoragePathResolver` accepts `tenant_id` but never embeds it in keys**; `resolve_tenant_bucket()` always falls back to the global `hope-audio` bucket because the cache is never populated from the database. **In effect, every tenant's audio still lands in the global shared bucket.**
6. **No retention or lifecycle policies** are configured on any bucket — the `hope-audio-chunks` interim bucket grows unbounded.
7. **No presigned PUT URLs** — every upload streams through the Node.js process (100 MB hard cap). This is the wrong pattern for large media files.
8. **Three concrete consumer use cases are not implemented**: session attachments (PDF/images/lab), profile avatar, tenant branding files.

---

## 2. Scope & Methodology

### In scope

- All TypeScript code under `packages/applications/src/services/baseServices/storage/`, `packages/applications/src/services/storage-access-key/`, `packages/applications/src/services/tenant-bucket/`, `apps/api/src/modules/storage/`, `apps/api/src/modules/storage-access-key/`, `apps/api/src/modules/tenant-bucket/`
- Domain entities/factories/mappers/repositories for `StorageAccessKey` and `TenantBucket`
- Prisma schema files for storage models
- Python storage code in `apps/stt-v2/src/stt_v2/storage/` and `apps/stt-v2/src/stt_v2/core/storage/`
- All consumers identified across the 6 user-stated use cases

### Out of scope

- Browser-side `packages/types/src/storage.ts` (IndexedDB; different domain — but is **misnamed**; see Finding L1)
- Secret management plumbing (covered by TASK-302)

### Methodology

- Parallel exploration of three concern axes (core abstraction, use cases, provider/tenancy)
- Source-text verification of critical findings (revokeKey, mapper handlers, controller scoping)
- Cross-check against TASK-239 documentation (`docs/implementation/TASK-239-Tenant-Blob-Storage/README.md`)

---

## 3. Current Architecture

### 3.1 Layer map

```
HTTP / WebSocket
   │
   ▼
apps/api  (NestJS)
   │
   ├── StorageController                    ← legacy, global, mostly unscoped
   ├── TenantBucketController               ← tenant-scoped, from TASK-239
   ├── StorageAccessKeyController           ← tenant-scoped API key management
   ├── TranscriptionJobController           ← batch audio upload
   └── (no controller)                      ← session attachments, avatar, branding
   │
   ▼
packages/applications  (services)
   │
   ├── S3Service           (1 instance, AWS SDK v3)
   ├── S3HealthService
   ├── TenantBucketService
   ├── StorageAccessKeyService
   └── MediaService        (tracks Media records pointing at S3 URIs)
   │
   ▼
packages/domains
   │
   ├── TenantBucketEntity / Factory / Mapper / Repository
   ├── StorageAccessKeyEntity / Factory / Mapper / Repository
   └── MediaEntity         (FK to TenantBucket via bucketId)
   │
   ▼
packages/database  (Prisma)
   │
   └── core.TenantBucket, core.StorageAccessKey, core.Media

apps/stt-v2  (Python, separate process)
   │
   ├── MinioClient            (minio SDK, not boto3)
   ├── BlobService
   └── StoragePathResolver    (key conventions; accepts tenant_id but never uses it)
```

### 3.2 `S3Service` — the single concrete provider

Single class, single client, all providers funneled through it:

```42:62:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
@Injectable()
export class S3Service implements IS3Service, OnModuleInit {
  private readonly logger: Logger = new Logger(S3Service.name);
  private s3Client: S3Client | null = null;
  ...
  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) { ... }
```

Provider detection is a regex check on the endpoint string:

```260:266:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
  private isMinIOEndpoint(endpoint: string): boolean {
    if (!endpoint) return false;

    const minioPatterns = [/localhost/i, /127\.0\.0\.1/, /minio/i, /:9000$/, /:9001$/];

    return minioPatterns.some((pattern) => pattern.test(endpoint));
  }
```

A real AWS S3 endpoint hitting `s3.amazonaws.com` is treated as "not MinIO," but there is no other branching. **There is no `StorageProvider` enum anywhere in the codebase** — provider is implicit.

### 3.3 Configuration sourcing

After TASK-302 Phase 3:

| Setting | Source |
|---|---|
| `S3_ENDPOINT`, `S3_REGION`, `S3_PUBLIC_BUCKET`, `S3_PRIVATE_BUCKET`, `S3_FORCE_PATH_STYLE`, `S3_REJECT_UNAUTHORIZED`, `S3_PRESIGNED_URL_EXPIRY`, `S3_MAX_RETRIES`, `S3_REQUEST_TIMEOUT` | `AppSettingsService` (DB-backed `GlobalSetting`) |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `SecretsService.getSecretSync(...)` (Vault-backed cache) |

```241:244:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
      accessKey: this.secretsService?.getSecretSync('S3_ACCESS_KEY') ?? '',
      secretKey: this.secretsService?.getSecretSync('S3_SECRET_KEY') ?? '',
```

**All tenants share one set of credentials.** There is no plumbing to obtain different credentials per tenant.

### 3.4 Tenant bucket model (TASK-239)

Two new tables in the `core` schema:

```4:47:packages/database/src/prisma/db_main/tenant-bucket.prisma
model TenantBucket {
    id              String   @id @default(uuid(7))
    tenantId        String
    name            String                              // Physical S3 bucket name
    slug            String                              // Logical name (tenant-facing)
    description     String?
    bucketType      TenantBucketType                    // SYSTEM or CUSTOM
    pathPattern     String @default("{yyyy}/{MM}/{dd}/{user_name}")
    resourceStatus  ResourceStatusType @default(ENABLED)
    tags            String[] @default([])
    Medias           Media[]
    StorageAccessKeys StorageAccessKey[] @relation("BucketAccessKeys")
    @@unique([tenantId, slug])
    @@unique([name])
    @@schema("core")
}
```

```49:93:packages/database/src/prisma/db_main/tenant-bucket.prisma
model StorageAccessKey {
    id              String   @id @default(uuid(7))
    tenantId        String
    name            String
    description     String?
    accessKeyId     String @unique
    secretAccessKey String                              // ⚠ Plain text — see Finding C2
    permissions     String[] @default(["read"])
    bucketIds       String[] @default([])
    expiresAt       DateTime?
    lastUsedAt      DateTime?
    lastUsedIp      String?
    ...
}
```

**Important**: `StorageAccessKey` has **no `endpoint`, `region`, `provider`, or `realCredentialsRef` field**, so it cannot route to a tenant-owned AWS account or a separate MinIO instance.

### 3.5 Bucket naming convention

```28:32:packages/domains/src/factories/generated/core/TenantBucketFactory.ts
function buildBucketName(tenantKey: string, slug: string): string {
  const sanitizedKey = sanitizeBucketName(tenantKey);
  const sanitizedSlug = sanitizeBucketName(slug);
  return `hope-${sanitizedSlug}-${sanitizedKey}`;
}
```

A tenant with `key=arcaai` gets `hope-audio-arcaai` and `hope-attachments-arcaai` provisioned automatically on tenant creation:

```5:12:packages/domains/src/factories/generated/core/TenantBucketFactory.ts
export const SYSTEM_BUCKET_SLUGS = {
  AUDIO: 'audio',
  ATTACHMENTS: 'attachments',
} as const;
```

`TenantService.create()` is hooked to `provisionSystemBuckets()` which calls `s3Service.createBucket()` + `setBucketPolicy()` with an IAM-style condition that requires the principal to have a `tenantId` tag — but **HOPE never tags its principals**, so this policy effectively denies all access in any real deployment.

### 3.6 Python STT-v2 storage

```7:7:apps/stt-v2/src/stt_v2/core/storage/minio_client.py
from minio import Minio
```

The Python service uses the dedicated **`minio` SDK**, not boto3. It cannot target native AWS S3 or Azure without rewriting.

The path resolver accepts `tenant_id` in every method signature but never embeds it in the object key — isolation is supposed to come from the bucket name:

```33:70:apps/stt-v2/src/stt_v2/storage/path_resolver.py
    def audio_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        ...
    ) -> str:
        ...
        if consultation_id:
            return f"{year}/{month}/{day}/consultations/{consultation_id}/{job_id}/raw/{safe_filename}"
        else:
            return f"{year}/{month}/{day}/jobs/{job_id}/raw/{safe_filename}"
```

And the bucket-resolution cache is never populated from the database:

```421:450:apps/stt-v2/src/stt_v2/storage/path_resolver.py
    def resolve_tenant_bucket(self, tenant_id: str, bucket_type: str) -> str:
        cache_key = f"{tenant_id}:{bucket_type}"
        if cache_key in self._tenant_bucket_cache:
            return self._tenant_bucket_cache[cache_key]

        defaults = {
            "audio": self.audio_bucket,
            "chunk": self.chunk_bucket,
            "model": self.model_bucket,
        }
        bucket = defaults.get(bucket_type, self.audio_bucket)
        logger.debug(
            "resolve_tenant_bucket fallback tenant=%s type=%s -> %s",
            tenant_id,
            bucket_type,
            bucket,
        )
        return bucket
```

**Net effect**: in production, all tenants' audio still lands in the single global `hope-audio` bucket. TASK-239's remaining work item *"Update STT-V2 Python service to use tenant-scoped bucket names"* is still open.

---

## 4. Use Case Analysis

### 4.1 Use Case A — Tenant admin browses buckets/directories/files

**Status: Partial.**

Two overlapping API surfaces:

| Surface | Path | Tenant-scoped? | Use it? |
|---|---|---|---|
| Legacy | `/api/v1/storage/buckets[/:name[/files[/:key]]]` | **No** (mostly) | Deprecate |
| Modern | `/api/v1/admin/tenants/storage/buckets[/:id[/tree]]` | Yes | **Use this** |

Legacy `StorageController` endpoints that are **not** tenant-scoped:

```47:53:apps/api/src/modules/storage/storage.controller.ts
  @Get('buckets')
  @CanRead('Storage')
  async listBuckets(): Promise<BucketInfoResponse[]> {
    return this.s3Service.listAllBuckets();
  }
```

```108:116:apps/api/src/modules/storage/storage.controller.ts
  @Get('buckets/:name/files')
  @CanRead('Storage')
  async listFiles(@Param('name') name: string, @Query('prefix') prefix?: string): Promise<unknown[]> {
    return this.s3Service.listFiles(name, prefix || '');
  }
```

```175:184:apps/api/src/modules/storage/storage.controller.ts
  @Get('buckets/:name/files/:key')
  @CanRead('Storage')
  async getFileInfo(@Param('name') bucketName: string, @Param('key') key: string): Promise<FileInfoResponse> {
    const url = await this.s3Service.signUrl(bucketName, key, 'get');
    return { key, url };
  }
```

```186:195:apps/api/src/modules/storage/storage.controller.ts
  @Delete('buckets/:name/files/:key')
  @CanDelete('Storage')
  async deleteFile(@Param('name') bucketName: string, @Param('key') key: string): Promise<DeleteFileResponse> {
    await this.s3Service.deleteFile(bucketName, key);
    return { deleted: true, key };
  }
```

The frontend `apps/ui-playground/src/features/admin/storage/index.tsx` already favors the modern endpoints, so legacy is callable but not surfaced. **It must be either deprecated and removed, or hardened with tenant ownership checks.** See Finding C3.

Frontend gaps (cosmetic, but on-brand):
- No delete or download button in the object browser UI
- No pagination on the tree view (`listFiles` fetches everything at once)

### 4.2 Use Case B — Doctor uploads batch audio

**Status: Implemented.**

```104:231:apps/api/src/modules/streaming/transcription-job.controller.ts
@Post('transcribe')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
async transcribeFile(@UploadedFile() file, @Body() body: TranscribeFileRequest)
```

- Endpoint: `POST /api/v1/audio/transcription-jobs/transcribe`
- Auth: `@Authorize()` (JWT)
- Multipart, 100 MB cap, allow-list MIME
- Path: `s3://hope-audio-{tenantKey}/{yyyy}/{MM}/[consultations/{cid}|jobs]/{jobId}/raw/{safeName}` (when tenant bucket exists, else `hope-audio`)
- Dispatches `transcribe_file` Dramatiq message; SSE stream on `/transcription-jobs/:id/stream`

Quirks:
- Path construction is **duplicated** between TypeScript and Python. The TS code at `apps/api/src/modules/streaming/transcription-job.controller.ts:185-193` must stay manually in sync with the Python `StoragePathResolver.audio_path()`. See Refactor R3.
- Server-streamed upload; no presigned PUT. See Optimization O1.

### 4.3 Use Case C — Doctor uploads session attachments (PDF / images / lab results)

**Status: Not implemented.**

The domain has `ContextItemType.ATTACHMENT`:

```14:14:packages/domains/src/enums/generated/ContextItemType.ts
  ATTACHMENT = 'ATTACHMENT',
```

The service has `addAttachment(consultationId, content?)`:

```717:725:packages/applications/src/services/consultation/context/context.service.ts
async addAttachment(consultationId: string, content?: string): Promise<ContextItemResponse> {
  return this.addContext(consultationId, {
    type: ContextItemType.ATTACHMENT,
    source: ContextItemSource.USER,
    content,
  });
}
```

But `content` is a text field on `ContextItem`. There is **no `mediaId` or `fileUri` field** on the entity, **no file-upload endpoint**, and **no link from a `ContextItem` to a `Media` row**.

The `hope-attachments-{tenantKey}` bucket *is* provisioned, but nothing writes to it via a doctor-facing flow.

To implement properly:
1. Add `mediaId String?` to `ContextItemEntity` (FK → Media)
2. Add `POST /api/v1/consultations/:id/attachments` accepting multipart file → uploads to attachments bucket → creates Media → creates ContextItem with `mediaId`
3. Add MIME allow-list (PDF, images, lab CSV/XML/JSON, etc.)
4. Document max file sizes per category

### 4.4 Use Case D — Doctor uploads profile avatar

**Status: Not implemented.**

The field exists in the entity and DTOs:

```16:16:packages/domains/src/entities/generated/core/UserProfileEntity.ts
  avatarId?: string | null;
```

```29:29:packages/applications/src/services/user/userProfile/dto/createUserProfile.request.ts
  avatarId?: string;
```

But there is **no endpoint accepting an avatar binary**, no `UserMediaController`, and `UserMediaService` contains only `NotImplementedException` stubs.

To implement properly:
1. Add `POST /api/v1/user/me/avatar` (multipart, image-only, ≤ 5 MB) → uploads to user/profile prefix → updates `User.avatarId`
2. Add automatic image resizing (thumb / mid / full) — see Optimization O5

### 4.5 Use Case E — Live audio pipeline (raw + processed)

**Status: Implemented, well-organized, but not actually tenant-isolated.**

The path resolver covers all expected paths:

```224:352:apps/stt-v2/src/stt_v2/storage/path_resolver.py
    streaming_raw_chunk_path()        → .../streams/{sid}/raw/chunk_{NNNN}.pcm
    streaming_processed_chunk_path()  → .../streams/{sid}/processed/chunk_{NNNN}.pcm
    streaming_raw_complete_path()     → .../streams/{sid}/raw/complete.wav
    streaming_processed_complete_path() → .../streams/{sid}/processed/complete.wav
    streaming_transcript_path()       → .../streams/{sid}/transcript.json
    streaming_metadata_path()         → .../streams/{sid}/metadata.json
```

**Critical isolation gap**: the `_streaming_base()` builder ignores `tenant_id` — it only embeds `{year}/{month}/{day}/streams/{sessionId}`. And the bucket selector falls back to the global default (Section 3.6 above). So in production, two tenants' streaming sessions end up in the same `hope-audio` bucket with no tenant qualifier in the key.

Two layers of mitigation are needed:
- **Short-term**: embed `tenant_id` in the key path (e.g. `tenants/{tenant_id}/streams/...`)
- **Long-term**: complete the TASK-239 remaining item to actually route to per-tenant buckets

No retention/lifecycle on the chunk bucket; see Finding M2.

### 4.6 Use Case F — Tenant admin uploads tenant config files

**Status: Not implemented.**

`TenantEntity` has only `name`, `key`, `description`:

```11:15:packages/domains/src/entities/generated/core/TenantEntity.ts
export interface ITenantEntity extends Omit<IBaseTaggedEntity, 'tenantId'> {
  name: string;
  key: string;
  description?: string | null;
}
```

There are no `logoUrl`, `backgroundUrl`, `primaryColor`, `favicon`, or `theme` fields. The only available knob is `GlobalSetting` key-value rows via `PATCH /api/v1/tenant/me/config`, which has no support for binary upload.

To implement properly:
1. Add `TenantBranding` table (`tenantId`, `logoMediaId`, `backgroundMediaId`, `faviconMediaId`, `primaryColor`, etc.) — or add fields directly to `TenantEntity`
2. Add `POST /api/v1/admin/tenants/me/branding/:assetType` (multipart) → uploads to `hope-attachments-{tenantKey}` under `/branding/{assetType}/` → sets corresponding `*MediaId`
3. Public read URL or short-lived presigned URL for the login page

---

## 5. Provider Support Analysis

### 5.1 Current matrix (verified)

| Provider | NestJS API | Python STT-v2 | Shared instance | Dedicated instance/account per tenant |
|---|---|---|---|---|
| MinIO | ✅ via `@aws-sdk/client-s3` | ✅ native `minio` SDK | ✅ default | ❌ no endpoint field |
| AWS S3 | ✅ via `@aws-sdk/client-s3` | ❌ `minio` SDK does not target AWS reliably | Possible (untested) | ❌ no per-tenant routing |
| Azure Blob Storage | ❌ no `@azure/storage-blob` anywhere | ❌ no Azure SDK | ❌ | ❌ |

### 5.2 Why "Azure support" is harder than it looks

Azure Blob Storage is **not** S3-compatible by default. You have three integration choices:

1. **Azure Blob Storage S3-compatible front-end** (preview/limited regions) — can use the existing `@aws-sdk/client-s3` with a different endpoint. Pros: minimal code change. Cons: feature gaps, regional availability, not officially GA in all clouds, no AAD integration.

2. **First-class `@azure/storage-blob` adapter** — implement a new `IBlobStorageProvider` interface and wire two concrete providers (`S3Provider`, `AzureBlobProvider`). Pros: clean abstraction, native AAD/managed identity support. Cons: more code, two SDKs to maintain.

3. **A proxy/gateway like MinIO Gateway for Azure** — Self-hosted MinIO can sit in front of Azure. Pros: keeps the existing code unchanged. Cons: MinIO deprecated all gateways in 2022; not recommended.

**Recommendation (Section 8)**: option 2 — introduce a provider abstraction.

### 5.3 Shared vs dedicated topology

The user's requirement is more nuanced than "support three providers":

| Topology | Meaning | Implementation today |
|---|---|---|
| Shared MinIO, prefix-isolated | One bucket, tenants share via key prefix | Not used — buckets-per-tenant model instead |
| Shared MinIO, bucket-per-tenant | One MinIO, one bucket per tenant | ✅ This is what TASK-239 implements |
| Dedicated MinIO per tenant | Each tenant gets its own MinIO instance (separate endpoint) | ❌ No per-tenant `endpoint` field |
| Shared AWS account, bucket-per-tenant | One AWS account, one bucket per tenant | Possible at MinIO swap, untested |
| Dedicated AWS account per tenant | Each tenant has own AWS account/credentials | ❌ No per-tenant credentials routing |
| Shared Azure storage account, container-per-tenant | One Azure account, one container per tenant | ❌ Azure not implemented |
| Dedicated Azure account per tenant | Each tenant brings own Azure account | ❌ Azure not implemented |

**Eight of twelve cells are missing.** The data model must be extended with provider, endpoint, region, and credential reference fields per tenant (or per logical bucket) — see Section 8.

### 5.4 The `StorageAccessKey` is not a real cloud credential

It is an **application-layer API key** (a HOPE-issued, HOPE-validated bearer token):

- Format: `accessKeyId = "HOPE" + 24 hex chars`, `secretAccessKey = 32 random bytes base64url`
- Stored in Postgres, validated by HOPE API in `validateKey()`
- Does **not** authenticate against MinIO/S3/Azure; the underlying cloud operations still use the global `S3_ACCESS_KEY/S3_SECRET_KEY`

This is a fine pattern for proxying tenant-scoped access through HOPE, but it must not be confused with real cloud IAM. The schema comments and remaining TASK-239 items ("MinIO policy enforcement per-tenant — bucket-level IAM") suggest intent to bridge these, which hasn't shipped.

---

## 6. Findings (Code Review)

Severity: **C** critical · **H** high · **M** medium · **L** low

### Critical

**C1 — `revokeKey(id)` lacks tenant ownership check (IDOR)**

`apps/api/src/modules/storage-access-key/storage-access-key.controller.ts` exposes `DELETE /admin/tenants/storage/keys/:id`. The service looks up the key by id but never verifies it belongs to the current tenant:

```77:91:packages/applications/src/services/storage-access-key/storage-access-key.service.ts
  async revokeKey(id: string): Promise<StorageAccessKeyResponse> {
    const key = await this.storageAccessKeyRepository.findById(id);
    if (!key) {
      throw new NotFoundException(`Storage access key ${id} not found`);
    }

    const deleted = await this.storageAccessKeyRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { name: deleted.name, accessKeyId: deleted.accessKeyId },
    });

    return StorageAccessKeyDtoMapper.toResponse(deleted);
  }
```

Any tenant admin who knows another tenant's `StorageAccessKey.id` (a UUIDv7 — guessable timestamp-ordered) can revoke it.

**Fix**:

```typescript
async revokeKey(id: string): Promise<StorageAccessKeyResponse> {
  const tenantId = this.tenantId;
  if (!tenantId) throw new BadRequestException('Tenant ID is required');

  const key = await this.storageAccessKeyRepository.findById(id);
  if (!key) throw new NotFoundException(`Storage access key ${id} not found`);
  if (key.tenantId !== tenantId) {
    throw new NotFoundException(`Storage access key ${id} not found`); // 404, not 403 (don't leak existence)
  }
  // ... rest unchanged
}
```

Add the same check to `getKeyById` if/when introduced.

**C2 — `StorageAccessKey.secretAccessKey` stored in plain text**

Schema comment lies. The mapper has no encrypt/decrypt handlers:

```62:66:packages/database/src/prisma/db_main/tenant-bucket.prisma
    // Credentials (encrypted at application layer)
    accessKeyId     String @unique
    secretAccessKey String
```

```23:26:packages/domains/src/mappers/generated/core/StorageAccessKeyEntityMapper.ts
export const StorageAccessKeyEntityMapperHandlers = createMapperHandlers<...>({
  $toPersistence: {},
  $toDomain: {},
});
```

The `@Secret()` decorator pattern exists (used on `GlobalSettingEntity`) but is not applied here. Anyone with DB read access — including replicas, backups, and SQL dumps — can extract all tenant secret keys in plaintext.

**Fix (in order of escalating effort)**:
1. Store only an HMAC-SHA256 hash + salt; validate by re-hashing the presented secret. **The secret is never recoverable** — display once on create, store hash only. This is the standard pattern (used by AWS IAM, GitHub PATs, etc.). Recommended.
2. Or, encrypt with `CryptoService` (AES-256-GCM) using a key from `SecretsService`. Allows recovery but expands the attack surface.

Either fix must be paired with a data migration that re-hashes/encrypts existing rows (or, since this is pre-production, just truncate the table and force re-issue).

**C3 — Legacy `StorageController` lacks tenant scoping**

The `/storage/buckets/...` endpoints (Section 4.1) accept any bucket name from the URL and act on it directly, with no `tenantId === bucket.tenantId` check. A doctor in tenant A who knows tenant B's bucket name `hope-audio-tenantb` can:

- `GET /storage/buckets/hope-audio-tenantb/files` — list everything
- `GET /storage/buckets/hope-audio-tenantb/files/some-key` — get presigned download
- `DELETE /storage/buckets/hope-audio-tenantb/files/some-key` — delete it
- `POST /storage/buckets/hope-audio-tenantb/files` — upload

Bucket names follow a predictable `hope-{slug}-{tenantKey}` convention, and `tenantKey` is the human-readable tenant identifier — trivially enumerable.

**Fix**: Resolve the requested bucket name to a `TenantBucket` row, verify `tenantBucket.tenantId === requestTenantId`, deny otherwise. Apply to **every** endpoint in `StorageController`, not just upload. Or — cleaner — deprecate `StorageController` entirely and route all client traffic through `TenantBucketController`.

**C4 — STT-v2 does not embed `tenant_id` in object keys and never resolves to tenant bucket**

See Section 4.5. Two tenants' audio sessions can collide in the same bucket with the same `streams/{sessionId}` prefix (UUIDs are unique in practice but the key is wrong by design — if a tenant gets compromised, attackers can list/exfiltrate `hope-audio/*/streams/*` for every tenant).

**Fix**:
- Short-term: `_streaming_base` becomes `f"tenants/{tenant_id}/{year}/{month}/{day}/streams/{session_id}"`
- Long-term: populate `_tenant_bucket_cache` by querying the `TenantBucket` table at session start (or pass the bucket name explicitly in the WS handshake)

### High

**H1 — `validateKey()` never updates `lastUsedAt` or `lastUsedIp`**

```93:103:packages/applications/src/services/storage-access-key/storage-access-key.service.ts
  async validateKey(accessKeyId: string): Promise<{ tenantId: string; permissions: string[]; bucketIds: string[] } | null> {
    const key = await this.storageAccessKeyRepository.findByAccessKeyId(accessKeyId);
    if (!key) return null;
    if (key.isExpired) return null;

    return {
      tenantId: key.tenantId as string,
      permissions: key.permissions,
      bucketIds: key.bucketIds,
    };
  }
```

The fields exist on the schema (`lastUsedAt`, `lastUsedIp`) but are never written. This defeats anomaly detection (e.g. dormant key suddenly active from a new IP). Recommend an async fire-and-forget update from the validation path or a queue-based usage tracker (avoid hot-path writes if validation rate is high).

**H2 — No presigned PUT URLs (every upload streams through Node.js)**

All upload paths use `FileInterceptor` (Multer) → `S3Service.putFile()` (Buffer). For 100 MB files this means:

- A copy of the file in Node.js memory
- Time-to-first-byte determined by server bandwidth, not client-to-S3 bandwidth
- 100 MB cap is itself a workaround — production batch audio can be 200+ MB

**Fix**: Introduce `signUploadUrl(bucketName, fileKey, contentType?)` and a workflow:
1. Client `POST /storage/uploads/init` with metadata → server returns presigned PUT URL
2. Client uploads directly to S3/MinIO/Azure
3. Client `POST /storage/uploads/complete` with the upload key → server creates `Media` row, kicks off downstream job

Browser CORS configuration on the buckets is required; document this.

**H3 — `StorageController.uploadFile` falls back to raw bucket name on slug miss**

```143:146:apps/api/src/modules/storage/storage.controller.ts
    const tenantBucket = await this.tenantBucketService.getBucketBySlug(bucketName);
    const resolvedBucketName = tenantBucket?.name ?? bucketName;
```

If a caller passes a slug that doesn't exist on the current tenant (e.g. another tenant's slug, or just `hope-audio-tenantb` directly), the controller uploads to that bucket. Combined with C3, this is the upload counterpart to the listing IDOR.

**Fix**: throw 404 when no `TenantBucket` matches; never fall back.

**H4 — `StorageAccessKeyService` doubly-registers itself in DI**

```7:18:packages/applications/src/services/storage-access-key/storage-access-key.service.module.ts
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    { provide: IStorageAccessKeyService, useClass: StorageAccessKeyService },
    StorageAccessKeyService,
  ],
  exports: [IStorageAccessKeyService, StorageAccessKeyService],
})
```

Two NestJS provider tokens, two instances. Any in-memory state (caches, throttle counters) splits between them. Consumers may inject either token and get different objects.

**Fix**:

```typescript
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [{ provide: IStorageAccessKeyService, useClass: StorageAccessKeyService }],
  exports: [IStorageAccessKeyService],
})
```

Update consumers to inject `@Inject(IStorageAccessKeyService)` consistently.

**H5 — TASK-239 IAM bucket policy is dead code**

```150:170:packages/applications/src/services/tenant-bucket/tenant-bucket.service.ts
      await this.s3Service.setBucketPolicy(bucket.name, {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          Resource: [`arn:aws:s3:::${bucket.name}`, `arn:aws:s3:::${bucket.name}/*`],
          Condition: { StringEquals: { 'aws:PrincipalTag/tenantId': tenantId } },
        }],
      });
```

The policy permits a principal **if** it has a `tenantId` tag equal to the bucket's tenant. But the only IAM principal hitting MinIO is the global `S3_ACCESS_KEY` service account — and HOPE does not tag it per-request. **In practice this policy denies all access**, which is fine in dev because the global service account also has admin override, but it is misleading: the operational guarantee comes from HOPE's application-layer scoping, not from the bucket policy.

**Fix**: Either implement per-tenant MinIO service accounts (`mc admin user add ...` automation tied to tenant lifecycle), or remove the policy and document the actual security boundary clearly.

### Medium

**M1 — No retention/lifecycle policies on any bucket**

- `hope-audio-chunks` accumulates streaming PCM chunks indefinitely
- Raw upload bytes are retained even after `processed/complete.wav` is generated
- Failed batch jobs leave `raw/{file}` and `metadata.json` orphaned

**Fix**: Apply MinIO ILM / S3 Lifecycle rules:
- `streams/*/raw/chunk_*.pcm` → expire 7 days after session completion
- `chunks/sessions/*` → expire 24 hours
- `jobs/*/raw/*` and `consultations/*/jobs/*/raw/*` → expire 90 days (configurable)
- Models → retain forever

Wire into provisioning so new tenant buckets receive lifecycle on creation.

**M2 — No retention/lifecycle policies on temp paths either**

`StoragePathResolver.temp_path()` (`apps/stt-v2/src/stt_v2/storage/path_resolver.py:385-402`) writes to `temp/...` with no TTL.

**Fix**: lifecycle rule `temp/*` → 24h expiry.

**M3 — `isMinIOEndpoint` regex is too permissive**

```260:266:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
    const minioPatterns = [/localhost/i, /127\.0\.0\.1/, /minio/i, /:9000$/, /:9001$/];
```

Any company with `minio` in its domain (e.g. `minio.example.com`), or any internal endpoint on port 9000 (CockroachDB, Etcd HTTPS), will be misclassified. This leaks into `disableHostPrefix`, `rejectUnauthorized`, and connection-test logic.

**Fix**: replace heuristic with an explicit `S3_PROVIDER` config setting (`MINIO | AWS | AZURE_BLOB_S3_COMPAT | CUSTOM`).

**M4 — `findActiveByTenant` filters expiry in memory**

```11:48:packages/domains/src/repositories/generated/core/StorageAccessKeyRepository.ts
findActiveByTenant(tenantId)  // ENABLED keys filtered by !isExpired (app-layer filter)
```

Fetches all enabled keys, then filters in TypeScript. The `@@index([expiresAt])` index exists but is unused.

**Fix**: push the filter to the SQL query — `WHERE expiresAt IS NULL OR expiresAt > NOW()`.

**M5 — `listFiles` returns `any[]`**

```461:505:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
  public async listFiles(bucketName: string, path: string): Promise<any[]> {
    ...
    const files = response.Contents.map((item) => ({
      key: item.Key ?? 'No Key',
      size: item.Size ?? 0,
      lastModified: item.LastModified,
      etag: item.ETag,
    }));
```

The shape is known and stable.

**Fix**: Define `S3FileInfo { key: string; size: number; lastModified?: Date; etag?: string }` and use it as the return type. Export from the package.

**M6 — `listFiles` has no pagination**

`ListObjectsV2Command` returns up to 1000 keys by default. The code does not consume the continuation token. Calling `listFiles` on a large prefix silently truncates.

**Fix**: implement paginated listing with `MaxKeys`, `ContinuationToken`, and an upper bound. Expose page size and continuation token to the API.

**M7 — Path traversal protections are inconsistent**

`storage.controller.ts:140` checks `/[.]{2}|[/\\]/.test(fileKey)`. But:
- `getFileInfo` does not check `key`
- `deleteFile` does not check `key`
- `S3Service.createBucket` checks bucket name; `S3Service.signUrl` does not

**Fix**: centralize a `sanitizeStorageKey()` helper and apply consistently. Also forbid `..` in nested segments (current check only catches `..` adjacent to `/` or `\`).

**M8 — Storage paths duplicated across TypeScript and Python**

The batch upload path is constructed at `apps/api/src/modules/streaming/transcription-job.controller.ts:185-193`; the same convention is reimplemented at `apps/stt-v2/src/stt_v2/storage/path_resolver.py:33-70`. Drift is inevitable.

**Fix**: define a single source of truth — either a Python-generated TS module (cross-compile) or a small shared schema (e.g. a JSON file consumed by both runtimes), or define paths exclusively in Python and have the TS side proxy through STT-v2 for path generation when needed.

### Low

**L1 — `packages/types/src/storage.ts` is misnamed**

It contains browser IndexedDB types (`AudioFileMetadata`, `StorageConfig`, `BackupOptions`, etc.) — nothing to do with cloud storage. **Rename** to `packages/types/src/browser-recording-storage.ts` (or move to `packages/agentic-sdk-v2`) to avoid confusion. Reserve `storage.ts` for cloud storage shared types (provider enum, presigned URL response shapes, etc.).

**L2 — `S3Service.testConnection` has odd fallback behavior**

```755:802:packages/applications/src/services/baseServices/storage/s3/s3.service.ts
  public async testConnection(): Promise<boolean> {
    ...
    if (config.isMinIO) {
      ...
      if (bucketName) {
        await s3.send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }));
      } else {
        await s3.send(new ListObjectsV2Command({ Bucket: 'test-bucket', MaxKeys: 1 }));
      }
    } else {
      await s3.send(new ListObjectsV2Command({ Bucket: this.getPublicBucketName() || 'test-bucket', MaxKeys: 1 }));
    }
```

Falling back to a literal `'test-bucket'` is fragile (false negatives if no such bucket exists, false positives if one accidentally does). Prefer `HeadBucketCommand` against `config.publicBucket` (or `ListBucketsCommand` if no buckets are configured).

**L3 — Examples folder ships in `index.ts`**

`packages/applications/src/services/baseServices/storage/s3/examples/usage-example.ts` and `minio-example.ts` are useful, but they import from `@nestjs/common` and have `@Injectable` decorators. Confirm they are excluded from the published bundle and from `tsc --noEmit` runs. If not, they should live under `__examples__/` or be `.md` doc snippets.

**L4 — Health endpoint leaks endpoint URL**

```197:213:apps/api/src/modules/storage/storage.controller.ts
  async checkHealth() {
    ...
    return {
      ...
      endpoint: health.details.endpoint,
      publicBucket: health.details.publicBucket,
      privateBucket: health.details.privateBucket,
      ...
    };
  }
```

The health endpoint is behind `@CanRead('Storage')`, but returns the raw S3 endpoint URL. For shared deployments this is mostly fine, but for a hosted SaaS the endpoint is internal infrastructure detail.

**Fix**: Return `{ healthy: true, provider: 'MinIO', region: 'us-east-1' }` and omit `endpoint`. Require global-admin role for the detailed view.

---

## 7. Refactor Plan

Reordered into a logical sequence (dependencies first). Each step is small enough to ship independently.

### R1 — Close the critical security gaps (1–2 days)

| Step | What | Files |
|---|---|---|
| R1.1 | Add tenant ownership check to `revokeKey` | `packages/applications/.../storage-access-key.service.ts` |
| R1.2 | Switch `secretAccessKey` to HMAC-SHA256 hash storage; change `validateKey` to compare hashes | service + factory + schema |
| R1.3 | Add tenant scoping to `StorageController.listFiles` / `getFileInfo` / `deleteFile` / `getBucket` | controller |
| R1.4 | Reject upload when slug doesn't match tenant bucket (no fallback) | `StorageController.uploadFile` |
| R1.5 | Embed `tenant_id` in STT-v2 streaming key path | `path_resolver.py` (+ tests) |
| R1.6 | Update STT-v2 to query `TenantBucket` (or accept bucket name from caller) so audio actually lands in tenant bucket | `path_resolver.py`, batch worker, streaming session |

### R2 — Fix the small but distracting issues (1 day)

| Step | What | Files |
|---|---|---|
| R2.1 | Remove duplicate `StorageAccessKeyService` DI registration | `storage-access-key.service.module.ts` |
| R2.2 | Update `lastUsedAt`/`lastUsedIp` on successful validation | `storage-access-key.service.ts` |
| R2.3 | Push expiry filter to SQL in `findActiveByTenant` | `StorageAccessKeyRepository.ts` |
| R2.4 | Replace `any[]` with `S3FileInfo` type | `IS3Service.ts`, `s3.service.ts` |
| R2.5 | Centralize `sanitizeStorageKey()` helper | new util + use everywhere |
| R2.6 | Add pagination to `listFiles` | `s3.service.ts` + controllers + DTOs |
| R2.7 | Rename `packages/types/src/storage.ts` to `browser-recording-storage.ts` | one file + barrel |

### R3 — Unify and harden path construction (2–3 days)

Pick **one** of the following:

| Option | What | Pros | Cons |
|---|---|---|---|
| 3a | Single TypeScript path resolver, compile to a small JSON schema or constants file consumed by Python | Shared source of truth | Build coupling |
| 3b | Define paths only in Python; have NestJS call an STT-v2 internal endpoint to mint the next key | One owner of the convention | Adds an extra hop on every upload |
| 3c | Shared YAML schema with codegen for both runtimes | Idiomatic in both languages | More tooling |

Recommendation: **3a** — small JSON file under `packages/database/src/prisma/db_main/seed/storage-paths.json` or `packages/types/src/storage-paths.json`, consumed by both `transcription-job.controller.ts` and `path_resolver.py`.

### R4 — Introduce provider abstraction (1 week)

Introduce a `BlobStorageProvider` interface in `packages/applications/src/services/baseServices/storage/`:

```typescript
// packages/applications/src/services/baseServices/storage/IBlobStorageProvider.ts
export interface BlobLocator { provider: StorageProvider; bucket: string; key: string }
export interface PresignedUrl { url: string; expiresAt: Date; method: 'GET' | 'PUT' }
export interface IBlobStorageProvider {
  readonly provider: StorageProvider;
  put(loc: BlobLocator, data: Buffer, opts?: PutOptions): Promise<void>;
  get(loc: BlobLocator): Promise<Buffer>;
  delete(loc: BlobLocator): Promise<void>;
  list(loc: { bucket: string; prefix: string }, page: PageOptions): Promise<ListResult>;
  copy(src: BlobLocator, dst: BlobLocator): Promise<void>;
  presign(loc: BlobLocator, method: 'GET' | 'PUT', expiresInSec: number): Promise<PresignedUrl>;
  createBucket(name: string, opts?: BucketOptions): Promise<void>;
  deleteBucket(name: string): Promise<void>;
  setLifecycle(name: string, rules: LifecycleRule[]): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

Concrete providers:

```
packages/applications/src/services/baseServices/storage/
├── IBlobStorageProvider.ts
├── providers/
│   ├── s3.provider.ts         (@aws-sdk/client-s3 — AWS S3 + MinIO)
│   ├── azure-blob.provider.ts (@azure/storage-blob — Azure Storage)
│   └── factory.provider.ts    (resolves provider by tenant config)
└── blob-storage.service.ts    (delegates to factory.getProvider(tenantId))
```

`StorageProvider` enum lives in `packages/types/src/storage.ts` (after R2.7 rename, the file is freed up):

```typescript
export enum StorageProvider {
  MINIO = 'MINIO',
  AWS_S3 = 'AWS_S3',
  AZURE_BLOB = 'AZURE_BLOB',
}
```

### R5 — Multi-tenant provider routing (1–2 weeks)

Extend the schema to support **per-tenant provider config**:

```prisma
model TenantStorageConfig {
  id              String           @id @default(uuid(7))
  tenantId        String           @unique
  provider        StorageProvider                       // MINIO | AWS_S3 | AZURE_BLOB
  topology        StorageTopology                       // SHARED | DEDICATED
  endpoint        String?                               // for MinIO / custom S3
  region          String?
  azureAccount    String?                               // for AZURE_BLOB
  credentialsRef  String?                               // SecretsService key
  containerPrefix String?                               // for shared-prefix mode
  resourceStatus  ResourceStatusType @default(ENABLED)
  // ...
  @@schema("core")
}

enum StorageTopology {
  SHARED      // share infrastructure with other tenants
  DEDICATED   // dedicated endpoint/account/bucket
}
```

Then the factory:

```typescript
// factory.provider.ts (sketch)
async getProvider(tenantId: string): Promise<IBlobStorageProvider> {
  const cfg = await this.tenantConfigRepo.findByTenantId(tenantId);
  if (!cfg) return this.globalDefaultProvider;

  switch (cfg.provider) {
    case StorageProvider.MINIO:
    case StorageProvider.AWS_S3:
      return this.makeS3Provider(cfg);
    case StorageProvider.AZURE_BLOB:
      return this.makeAzureProvider(cfg);
  }
}
```

Where credentials are resolved by `credentialsRef → SecretsService.getSecret(ref)`.

Migration plan:
1. Ship R4 with one provider (S3) and a no-op `TenantStorageConfig` table
2. Backfill all tenants with `{provider: MINIO, topology: SHARED}` pointing at the global config
3. Ship Azure provider
4. Ship dedicated-account onboarding flow (admin UI)

### R6 — Implement missing use cases (1 week each)

| Use case | Endpoint | Estimated effort |
|---|---|---|
| Session attachments | `POST /api/v1/consultations/:id/attachments` (multipart) | 2 days (incl. ContextItem mediaId, MIME allow-list) |
| Profile avatar | `POST /api/v1/user/me/avatar` (multipart, image-only) | 1 day |
| Tenant branding | `POST /api/v1/admin/tenants/me/branding/:assetType` | 2 days (incl. new TenantBranding model or fields) |

Each piggybacks on the existing `attachments` bucket (or a new `branding` bucket type for tenant assets).

### R7 — Lifecycle and retention (2 days)

| Step | What |
|---|---|
| R7.1 | Add `setLifecycle()` to provider interface |
| R7.2 | Wire `provisionSystemBuckets()` to apply default ILM rules |
| R7.3 | Default rules: `chunks/sessions/*` → 24h, `streams/*/raw/chunk_*.pcm` → 7d, `temp/*` → 24h, `raw/*` → 90d configurable |
| R7.4 | Add admin endpoint to view/edit per-bucket lifecycle |

### R8 — Presigned PUT upload flow (3 days)

| Step | What |
|---|---|
| R8.1 | Add `signUploadUrl()` to provider interface (`PUT` mode) |
| R8.2 | New endpoint `POST /api/v1/storage/uploads/init` → returns `{ uploadUrl, mediaId, fileKey, expiresAt }` |
| R8.3 | New endpoint `POST /api/v1/storage/uploads/complete` → validates upload, finalizes Media row |
| R8.4 | Bucket CORS configuration documented per provider |
| R8.5 | SDK helper for browser-side upload (resumable for large files) |

---

## 8. Target Architecture

```
                                ┌───────────────────────────────────────────────┐
                                │ HTTP / WebSocket clients                       │
                                │ (admin UI, doctor UI, mobile)                  │
                                └─┬─────────────────┬───────────────────────────┘
                                  │                 │
                                  │ presigned       │ control plane
                                  │ PUT/GET         │ (init/complete/list)
                                  │                 ▼
                                  │   ┌───────────────────────────────────┐
                                  │   │ apps/api (NestJS)                  │
                                  │   │  • TenantBucketController          │
                                  │   │  • StorageAccessKeyController      │
                                  │   │  • StorageUploadsController (new)  │
                                  │   │  • AttachmentsController (new)     │
                                  │   │  • AvatarController (new)          │
                                  │   │  • BrandingController (new)        │
                                  │   └─┬─────────────────────────────────┘
                                  │     │
                                  │     ▼
                                  │   ┌───────────────────────────────────┐
                                  │   │ BlobStorageService                 │
                                  │   │ (delegates to provider factory)    │
                                  │   └─┬─────────────────────────────────┘
                                  │     │ tenantId
                                  │     ▼
                                  │   ┌───────────────────────────────────┐
                                  │   │ BlobStorageProviderFactory         │
                                  │   │ ↳ TenantStorageConfig lookup       │
                                  │   └─┬───────────────┬─────────────────┘
                                  │     │               │
                                  │     ▼               ▼
                                  │   ┌────────┐    ┌────────────┐
                                  │   │ S3Prov │    │ AzureBlob  │
                                  │   │ ider   │    │ Provider   │
                                  │   └─┬──────┘    └─────┬──────┘
                                  │     │                 │
                                  ▼     ▼                 ▼
                ┌─────────────────────────┐  ┌──────────────────────────────┐
                │ MinIO (shared / dedi)   │  │ Azure Storage Account        │
                │  AWS S3 (shared / dedi) │  │  (shared / dedicated)        │
                └─────────────────────────┘  └──────────────────────────────┘
```

### Per-tenant config (one row per tenant)

```
┌──────────────────────────────────────────────────┐
│ TenantStorageConfig                              │
├──────────────────────────────────────────────────┤
│ tenantId       │  arcaai                         │
│ provider       │  MINIO / AWS_S3 / AZURE_BLOB    │
│ topology       │  SHARED / DEDICATED             │
│ endpoint       │  https://s3.eu-west-1.amazonaws │
│ region         │  eu-west-1                      │
│ azureAccount   │  null                           │
│ credentialsRef │  vault://tenants/arcaai/aws-key │
│ containerPrefix│  null  (for shared-prefix mode) │
└──────────────────────────────────────────────────┘
```

`credentialsRef` is a key into `SecretsService`; the actual secret is in Vault. The provider factory resolves credentials lazily on first use per tenant and caches the client.

### Per-tenant buckets (existing `TenantBucket` table extended)

Add a `containerName` field for Azure (where "bucket" is called "container"), and a `lifecycleRulesJson` field for retention config:

```prisma
model TenantBucket {
  // existing fields...
  containerName       String?  // Azure: container name (lowercase, 3-63 chars)
  lifecycleRulesJson  Json?    // [{ prefix, expiresIn }, ...]
}
```

### Key conventions (single source of truth)

```
{tenantId}/{yyyy}/{MM}/{dd}/...
  ├── jobs/{jobId}/raw/{filename}
  ├── jobs/{jobId}/processed/{filename}
  ├── jobs/{jobId}/transcript.{json|txt|vtt|srt}
  ├── consultations/{cid}/{jobId}/raw/{filename}
  ├── consultations/{cid}/{jobId}/processed/{filename}
  ├── consultations/{cid}/{jobId}/transcript.{...}
  ├── streams/{sessionId}/raw/chunk_NNNN.pcm
  ├── streams/{sessionId}/raw/complete.wav
  ├── streams/{sessionId}/processed/chunk_NNNN.pcm
  ├── streams/{sessionId}/processed/complete.wav
  ├── streams/{sessionId}/transcript.json
  └── streams/{sessionId}/metadata.json

attachments/{tenantId}/
  ├── consultations/{cid}/{contextItemId}/{filename}
  ├── users/{userId}/avatar/{size}.png
  └── tenant/branding/{assetType}/{filename}

temp/{tenantId}/{uuid}    # 24h TTL via lifecycle
```

Path convention is owned by **one** file (e.g. `packages/types/src/storage-paths.json`) and consumed by both TS and Python (Refactor R3).

---

## 9. Performance Optimizations

| ID | Area | Issue | Optimization |
|---|---|---|---|
| O1 | Upload throughput | All bytes traverse the Node.js process (≤100 MB) | Presigned PUT (Refactor R8). Direct-to-S3 cuts API CPU/RAM by ~98 % for large files and lifts the 100 MB cap to S3's 5 TB per object. |
| O2 | Listing | `listFiles` fetches up to 1000 keys then stops silently | Stream with continuation token; expose `?cursor=` and `?limit=` to clients (Refactor R2.6). |
| O3 | `findActiveByTenant` | In-memory expiry filter scans all enabled keys | Push to SQL `WHERE expiresAt IS NULL OR expiresAt > NOW()` (Refactor R2.3). |
| O4 | `getFile` | Always materializes to Buffer | Add `getFileStream(loc): Readable` for forwarding through controllers; cuts memory for large transcripts. |
| O5 | Avatar | Single original image served on every page load | On upload, resize to `thumb (64×64)`, `mid (256×256)`, `full (≤1024×1024)`; persist all three; serve the smallest sufficient size via CDN/presigned. |
| O6 | Tree view | `getBucketTree` fetches full prefix then builds tree client-side | Use delimiter `/` paginated listing; lazy-load children on expand. |
| O7 | Presigned URLs | Fixed 1-hour expiry (`DEFAULT_PRESIGNED_URL_EXPIRY = 3600`) | Make expiry per-call configurable (download links shouldn't be the same as user-share links). Add `purpose` parameter (download | preview | share). |
| O8 | Connection reuse | A new `S3Client` per provider instance (one in current code, several in target architecture) | Pool clients per tenant/credentials tuple with LRU eviction (`max=50`, `idle=10m`). |
| O9 | STT-v2 chunk writes | Every chunk is a separate `put_object` call | Batch chunks into 30-second WAV blobs with multipart upload — fewer round-trips, fewer keys. |
| O10 | Read-after-write | Strong consistency assumed for new uploads | Use `If-None-Match: *` + `HeadObject` retries for upload-then-immediate-read paths (e.g. transcription worker picking up just-uploaded file). MinIO is strongly consistent; AWS S3 became strongly consistent in 2020; Azure container read-after-write is strong. Document this assumption. |
| O11 | STT-v2 Python SDK | `minio` SDK only — cannot use boto3 connection pooling or multipart features cleanly | Migrate Python to a single S3-compatible client (`boto3` or `aioboto3`). This aligns with Refactor R3 and future Azure support. |

---

## 10. Open Questions / Decisions Needed

Before implementation begins, please confirm:

| # | Question | Recommendation |
|---|---|---|
| 1 | **Azure integration strategy**: first-class `@azure/storage-blob` adapter, Azure S3-compat front-end, or out-of-scope? | First-class adapter (Section 5.2 option 2). It's the only path with managed identity + AAD + ADLS Gen2 hierarchical namespace support. |
| 2 | **Dedicated topology granularity**: per-tenant endpoint/account, or per-environment? E.g. is "dedicated MinIO instance per tenant" something we provision per tenant, or is it just "the tenant brings their own credentials to their own infra"? | "Bring your own" is far simpler. Build that first; provisioning per-tenant infrastructure can come later. |
| 3 | **`secretAccessKey` recovery**: do tenant admins need to view a key again after creation? | No — display once, hash-only storage (Finding C2 fix 1). This is industry standard. |
| 4 | **Branding storage**: new `TenantBranding` table, or fields on `TenantEntity`, or `GlobalSetting` rows with media references? | New `TenantBranding` model — keeps the `Tenant` model clean and enables future versioning (e.g. light/dark theme variants). |
| 5 | **Presigned upload validation**: how do we verify the client actually uploaded what they claimed before creating the `Media` row? | `HeadObject` after `complete` to verify presence + size; ETag check optional. |
| 6 | **Retention defaults**: are 7d/24h/90d defaults acceptable, or do specific tenants need custom values? | Start with defaults; expose via `setLifecycle()` for tenant-level overrides. |
| 7 | **Legacy `StorageController`**: deprecate immediately, or harden + deprecate over one release? | Harden first (close C3), deprecate next release. The UI does not use it, but external consumers might. |
| 8 | **STT-v2 SDK migration**: stay on `minio` SDK and add Azure as a second branch, or move to a unified `aioboto3` + add Azure? | Unified `aioboto3` — same direction as NestJS. |
| 9 | **Per-tenant MinIO IAM**: do we automate `mc admin user add` per tenant, or rely entirely on application-layer scoping? | Application-layer is sufficient if R1.3/H3/C3 are fixed. Defer real MinIO IAM until a compliance audit demands it. |

---

## 11. Suggested Sequencing

If we plan to ship this incrementally:

```
Week 1   ─  R1 (security gaps), R2 (cleanups)            ← unblock production
Week 2   ─  R3 (path unification), R7 (lifecycle)        ← operational hygiene
Week 3-4 ─  R4 (provider abstraction)                     ← architecture work
Week 5-6 ─  R5 (per-tenant provider config + Azure)      ← multi-provider
Week 7   ─  R8 (presigned upload), R6.1 (attachments)    ← scale + new use case
Week 8   ─  R6.2 (avatar), R6.3 (branding)               ← remaining use cases
```

Each week is checkpoint-gated with green CI and verifiable behavior changes — no big-bang merge.

---

## 12. Change History

| Date | Description | Files |
|---|---|---|
| 2026-05-26 | Initial comprehensive review (TASK-304) | This document |
