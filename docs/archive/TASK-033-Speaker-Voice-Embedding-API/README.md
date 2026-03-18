# TASK-033: Speaker Voice Embedding API

- **Ticket**: TASK-033
- **Created**: 2026-02-21
- **Last Updated**: 2026-02-21 (quality pass)
- **Status**: Completed
- **Depends On**: STT-V2 diarization pipeline (complete), Qdrant infrastructure (complete)
- **Blocks**: TASK-034 gap F1-06 (Voice Embedding toggle on Setup page)
- **Related Tickets**: TASK-032 (SDK V2 Frontend Demo — defined this task's scope), TASK-034 (Frontend Gap Remediation — deferred F1-06 pending this)

---

## Requirement Analysis

### Business Context

FEAT-01 (Setup & Configuration) item 3 requires doctors to record a voice sample for personalized speaker recognition during local diarization. When a doctor records their voice, the system extracts a speaker embedding vector and stores it in Qdrant. During subsequent transcription sessions, the STT-V2 diarization pipeline compares incoming audio against stored embeddings to identify the doctor's speech vs. the patient's speech.

### What Exists Today

The **infrastructure and ML pipeline are fully operational** — what's missing is the **user-facing API layer** connecting the frontend to the embedding pipeline.

| Component | Status | Location |
|-----------|--------|----------|
| Qdrant vector DB | Running | `infrastructure/docker/docker-compose.dev.yml` — `hope-qdrant` container (v1.16) |
| Qdrant collection | Initialized | `stt_speaker_embeddings` — 512-dim cosine, payload indexes on `tenant_id`, `speaker_id`, `consultation_id` |
| Pyannote embedding model | Loaded | `apps/stt-v2/src/stt_v2/diarization/embedding_service.py` — `pyannote/embedding` (512-dim) |
| Speaker identifier | Working | `apps/stt-v2/src/stt_v2/diarization/speaker_identifier.py` — orchestrates extraction + Qdrant search |
| Speaker embedding store | Working | `apps/stt-v2/src/stt_v2/core/vectorstore/speaker_store.py` — upsert, search, delete, tenant isolation |
| Qdrant client manager | Working | `apps/stt-v2/src/stt_v2/core/vectorstore/client.py` — async pooled connection |
| MinIO object storage | Running | S3-compatible, `IS3Service` in `packages/applications/` |
| NestJS file upload pattern | Established | `FileInterceptor`, `ParseFilePipe`, `MaxFileSizeValidator` (see `storage.controller.ts`) |
| Frontend "Coming Soon" UI | Placeholder | `vite-app/src/pages/setup.tsx` line 431, `nextjs-app/src/app/setup/_content.tsx` |

### What's Missing

1. **API Gateway endpoints** — No REST endpoints for voice embedding management on the users resource
2. **User-to-speaker mapping** — No database field linking a User to their speaker embedding ID in Qdrant
3. **SDK hook** — No `useVoiceEmbedding` hook in `@arcaai/vox`
4. **Frontend wiring** — "Coming Soon" badge needs replacement with functional recording UI

### Acceptance Criteria

1. `POST /api/v1/users/:id/voice-embedding` accepts an audio file, extracts the embedding via STT-V2, stores in Qdrant, and returns embedding metadata
2. `GET /api/v1/users/:id/voice-embedding` returns embedding status (exists/not exists, created date, vector dimensions)
3. `DELETE /api/v1/users/:id/voice-embedding` removes the embedding from Qdrant and clears the user's embedding reference
4. All endpoints enforce JWT auth + RBAC (`CanUpdate('User')` for POST/DELETE, `CanRead('User')` for GET)
5. Multi-tenant isolation — embeddings are scoped by `tenant_id` in Qdrant payloads
6. Audio validation — only accepts WAV/MP3/M4A/FLAC/WebM, max 10 MB, min 5 seconds duration
7. SDK hook `useVoiceEmbedding` exposes `upload`, `getStatus`, `remove` methods
8. Frontend Setup page replaces "Coming Soon" with functional record/upload UI
9. Both Vite and Next.js example apps have the working voice embedding section

---

## Current State Evaluation

### Qdrant Infrastructure

The Qdrant instance is configured in Docker Compose with the `stt_speaker_embeddings` collection initialized by `infrastructure/docker/scripts/init-qdrant-collections.py`:

- **Collection**: `stt_speaker_embeddings`
- **Vector size**: 512 dimensions (Pyannote embedding output)
- **Distance**: Cosine similarity
- **Payload indexes**: `tenant_id` (tenant isolation), `speaker_id`, `consultation_id`, `created_at`
- **HNSW config**: Global index disabled (`m=0`), payload-based index (`payload_m=16`) for multi-tenant performance

### STT-V2 Embedding Service

The `EmbeddingService` (`apps/stt-v2/src/stt_v2/diarization/embedding_service.py`):

- Uses `pyannote/embedding` HuggingFace model
- Extracts 512-dimensional speaker embeddings from audio samples
- Thread-safe with lock-based synchronization
- Auto-detects GPU (CUDA/MPS) with CPU fallback
- Supports single-segment and batch extraction

### Speaker Embedding Store

The `SpeakerEmbeddingStore` (`apps/stt-v2/src/stt_v2/core/vectorstore/speaker_store.py`):

- `upsert_embedding(tenant_id, speaker_id, embedding, metadata)` — stores embedding with tenant scope
- `search_similar(tenant_id, embedding, threshold=0.7, limit=5)` — cosine similarity search within tenant
- `get_speakers_for_tenant(tenant_id)` — list all speakers
- `delete_speaker(tenant_id, speaker_id)` — remove all embeddings for a speaker
- All operations filter by `tenant_id` for multi-tenant isolation

### Existing Controller Patterns

The `users.controller.ts` uses:
- `@ApiTags('users')`, `@Controller('users')`
- Policy decorators: `@CanRead('User')`, `@CanCreate('User')`, `@CanUpdate('User')`, `@CanDelete('User')`
- `@ApiEndpoint` custom decorator for Swagger
- Domain layer: `IUserService` → `UserDtoMapper`

The `storage.controller.ts` uses (for file upload):
- `@UseInterceptors(FileInterceptor('file'))`
- `@ApiConsumes('multipart/form-data')`
- `ParseFilePipe` with `MaxFileSizeValidator` and `FileTypeValidator`
- Returns presigned URLs for download

### Database Schema

The `User` model in Prisma has no voice embedding fields. Related models:
- `UserMedia` — links users to media files (can store voice samples)
- `UserSettings` — key-value settings (can store embedding metadata)

---

## Implementation Plan

### Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐
│   Frontend   │     │   API Gateway        │     │  STT-V2      │
│   (Vite/     │────▶│   (NestJS)           │────▶│  (FastAPI)   │
│    Next.js)  │     │                      │     │              │
│              │     │  POST /users/:id/    │     │  POST        │
│  Record or   │     │    voice-embedding   │     │  /internal/  │
│  upload WAV  │     │                      │     │  embeddings/ │
│              │     │  1. Validate file    │     │  extract     │
│              │     │  2. Store in MinIO   │     │              │
│              │     │  3. Call STT-V2      │     │  1. Load     │
│              │     │  4. Store in Qdrant  │     │     pyannote │
│              │     │     (via STT-V2)     │     │  2. Extract  │
│              │     │  5. Update user      │     │     embedding│
│              │     │     metadata         │     │  3. Return   │
└──────────────┘     └─────────────────────┘     │     512-dim  │
                              │                   └──────────────┘
                              │
                    ┌─────────▼──────────┐
                    │     Qdrant         │
                    │  (Vector DB)       │
                    │                    │
                    │  Collection:       │
                    │  stt_speaker_      │
                    │  embeddings        │
                    │                    │
                    │  tenant_id filter  │
                    └────────────────────┘
```

### Phase 1: Backend — STT-V2 Embedding Extraction Endpoint

**Files**:
- Create: `apps/stt-v2/src/stt_v2/api/routes/embedding_routes.py`
- Modify: `apps/stt-v2/src/stt_v2/api/app.py` (register routes)

**What to implement**:

Internal endpoint for the API Gateway to call:

```
POST /internal/embeddings/extract
  Content-Type: multipart/form-data
  Body: { file: <audio_file>, tenant_id: string, speaker_id: string }
  Response: { embedding: float[512], duration_seconds: float, model: string }
```

This endpoint:
1. Receives the audio file from the API Gateway
2. Loads it into memory (resamples to 16kHz mono if needed)
3. Extracts the 512-dim embedding via `EmbeddingService`
4. Returns the raw embedding vector

Authentication: API Key guard (same pattern as `/internal/stt/*` callbacks).

**Why separate from upsert?** The API Gateway owns the Qdrant write (via STT-V2's `SpeakerEmbeddingStore`) to maintain a single source of truth for user-to-speaker mapping. Alternatively, the STT-V2 service can handle the full upsert if a `speaker_id` and `tenant_id` are provided — this is the simpler approach since `SpeakerEmbeddingStore.upsert_embedding()` already exists.

**Recommended approach**: Full upsert in STT-V2:

```
POST /internal/embeddings/upsert
  Content-Type: multipart/form-data
  Body: { file: <audio_file>, tenant_id: string, speaker_id: string, metadata: JSON }
  Response: { speaker_id: string, embedding_id: string, dimensions: 512, created_at: ISO8601 }

DELETE /internal/embeddings/{speaker_id}?tenant_id=xxx
  Response: { deleted: true }

GET /internal/embeddings/{speaker_id}?tenant_id=xxx
  Response: { speaker_id: string, exists: boolean, created_at?: ISO8601, dimensions?: 512 }
```

### Phase 2: Backend — API Gateway Controller

**Files**:
- Create: `apps/api/src/modules/user/voice-embedding.controller.ts`
- Modify: `apps/api/src/modules/user/user.module.ts` (register controller)

**Endpoints**:

```typescript
@ApiTags('users')
@Controller('users')
export class VoiceEmbeddingController {

  @Post(':id/voice-embedding')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @CanUpdate('User')
  async uploadVoiceEmbedding(
    @Param('id') userId: string,
    @UploadedFile(new ParseFilePipe({
      validators: [
        new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
        new FileTypeValidator({ fileType: /^audio\/(wav|mpeg|mp4|flac|webm|x-wav|x-m4a)$/ }),
      ],
    })) file: Express.Multer.File,
  ): Promise<VoiceEmbeddingResponse> {
    // 1. Verify user exists and belongs to request tenant
    // 2. Store audio file in MinIO (private bucket, path: voice-samples/{tenantId}/{userId}.wav)
    // 3. Forward file to STT-V2 POST /internal/embeddings/upsert
    //    with tenant_id from request context, speaker_id = userId
    // 4. Store embedding metadata in UserSettings (key: 'voice-embedding-status')
    // 5. Return response with embedding status
  }

  @Get(':id/voice-embedding')
  @CanRead('User')
  async getVoiceEmbeddingStatus(
    @Param('id') userId: string,
  ): Promise<VoiceEmbeddingStatusResponse> {
    // 1. Check UserSettings for voice-embedding-status
    // 2. Optionally verify with STT-V2 GET /internal/embeddings/{userId}
    // 3. Return status (exists, created_at, dimensions, audio_file_key)
  }

  @Delete(':id/voice-embedding')
  @CanUpdate('User')
  async removeVoiceEmbedding(
    @Param('id') userId: string,
  ): Promise<void> {
    // 1. Call STT-V2 DELETE /internal/embeddings/{userId}?tenant_id=xxx
    // 2. Delete audio file from MinIO
    // 3. Remove UserSettings voice-embedding-status entry
  }
}
```

**DTOs**:

```typescript
interface VoiceEmbeddingResponse {
  userId: string;
  speakerId: string;
  embeddingId: string;
  dimensions: number;
  createdAt: string;
  audioFileKey: string;
}

interface VoiceEmbeddingStatusResponse {
  userId: string;
  exists: boolean;
  createdAt?: string;
  dimensions?: number;
  audioFileKey?: string;
}
```

### Phase 3: SDK — `useVoiceEmbedding` Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts` (add `VOICE_EMBEDDING_ENDPOINTS`)
- Modify: `packages/agentic-sdk-v2/src/hooks/index.ts` (export)
- Modify: `packages/agentic-sdk-v2/src/core.ts` (export)
- Modify: `packages/agentic-sdk-v2/src/types/index.ts` (export types)

**Constants**:

```typescript
VOICE_EMBEDDING_ENDPOINTS = {
  UPLOAD: (userId: string) => `/users/${userId}/voice-embedding`,
  STATUS: (userId: string) => `/users/${userId}/voice-embedding`,
  REMOVE: (userId: string) => `/users/${userId}/voice-embedding`,
}
```

**Hook**:

```typescript
interface UseVoiceEmbedding {
  status: VoiceEmbeddingStatus | null;
  isLoading: boolean;
  isUploading: boolean;
  error: Error | null;
  upload: (userId: string, audioFile: File | Blob) => Promise<VoiceEmbeddingResponse>;
  getStatus: (userId: string) => Promise<VoiceEmbeddingStatus>;
  remove: (userId: string) => Promise<void>;
}
```

### Phase 4: Frontend — Wire Up Setup Page

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx`
- Modify: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/setup/_content.tsx`

**What to implement**:

Replace the "Coming Soon" badge and disabled button in `UserSettingsCard` with:

1. **Status display**: Show "Embedded" (green badge) or "Not Embedded" (grey badge) based on `useVoiceEmbedding().getStatus()`
2. **Record button**: "Record My Voice" button that:
   - Uses `MediaRecorder` API to record 10 seconds of audio
   - Shows a countdown timer during recording
   - Displays a sound level meter
   - On completion, calls `useVoiceEmbedding().upload(userId, blob)`
3. **Upload alternative**: "Upload Audio File" link for pre-recorded samples
4. **Remove button**: "Remove Embedding" (destructive) with `ConfirmDialog`
5. **Status indicators**: Shows embedding metadata (created date, dimensions)

### Phase 5: Testing

**Unit tests (TDD)**:
- STT-V2 embedding extraction endpoint tests
- API Gateway controller tests (mock STT-V2 calls)
- SDK `useVoiceEmbedding` hook tests
- Frontend component tests

**Integration tests**:
- End-to-end: Upload WAV → extract embedding → store in Qdrant → verify retrieval
- Multi-tenant isolation: Embedding from Tenant A not visible to Tenant B
- Delete flow: Remove embedding → verify Qdrant cleanup → verify MinIO cleanup

### Deployment Considerations

- **Qdrant**: Already running in Docker Compose, no changes needed
- **STT-V2**: New internal endpoint, requires service restart
- **API Gateway**: New controller, requires service restart
- **MinIO**: New bucket path (`voice-samples/`), auto-created on first upload
- **HuggingFace token**: Required for `pyannote/embedding` model download (already configured in STT-V2)

---

## Implementation Summary

### Methodology: Test-Driven Development (Red-Green-Refactor)

All four phases were implemented using strict TDD — tests were written first, verified to fail for the right reason, then minimal production code was written to make them pass.

### Phase 1: STT-V2 Internal Embedding Endpoints (Python/FastAPI)

**Files created:**
- `apps/stt-v2/src/stt_v2/embedding/__init__.py` — Module package
- `apps/stt-v2/src/stt_v2/embedding/api/__init__.py` — API subpackage
- `apps/stt-v2/src/stt_v2/embedding/api/routes.py` — Internal embedding API routes
- `apps/stt-v2/tests/unit/test_embedding_routes.py` — 16 unit tests

**Files modified:**
- `apps/stt-v2/src/stt_v2/main.py` — Registered `embedding_router`

**Endpoints implemented:**
| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/embeddings/upsert` | Upload audio, extract 512-dim embedding, store in Qdrant |
| GET | `/internal/embeddings/{speaker_id}?tenant_id=X` | Check embedding existence |
| DELETE | `/internal/embeddings/{speaker_id}?tenant_id=X` | Remove speaker embedding |

**Test coverage:** 33 tests covering happy paths, validation errors (missing fields, short audio, 4s boundary, corrupted WAV, empty file), exact 5s boundary acceptance, stereo WAV downmixing, metadata forwarding (valid JSON, invalid JSON, JSON array, omitted), Qdrant store failure on upsert and delete, multi-tenant isolation (tenant-B cannot see tenant-A speakers), `created_at` timestamp conversion (epoch integer, string passthrough, None), GET with multiple speakers picking correct one, GET not returning dimensions when not found, and service-not-initialized scenarios. All pass.

### Phase 2: NestJS API Gateway Controller

**Files created:**
- `apps/api/src/modules/user/voice-embedding.controller.ts` — REST controller proxying to STT-V2
- `apps/api/tests/unit/voice-embedding.controller.test.ts` — 8 unit tests

**Files modified:**
- `apps/api/src/modules/user/users.module.ts` — Registered `VoiceEmbeddingController`, imported `HttpModule` and `S3ServiceModule`

**Endpoints implemented:**
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/users/:id/voice-embedding` | `@CanUpdate('User')` | Upload + S3 storage + STT-V2 upsert |
| GET | `/users/:id/voice-embedding` | `@CanRead('User')` | Status check via STT-V2 |
| DELETE | `/users/:id/voice-embedding` | `@CanUpdate('User')` | Delete from STT-V2 + S3 cleanup |

**Test coverage:** 20 tests covering S3 storage, STT-V2 proxy calls, error propagation, graceful S3 failure handling, `tenant_id` propagation to STT-V2 on all 3 endpoints, correct S3 path construction with tenantId, `audioFileKey` presence/absence based on embedding existence, STT-V2 delete failure propagation, S3 upload failure preventing STT-V2 call, STT-V2 503 status code propagation, complete response DTO verification (all fields), and delete operation sequencing (STT-V2 before S3). All pass.

### Phase 3: SDK `useVoiceEmbedding` Hook

**Files created:**
- `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts` — React hook with `upload`, `getStatus`, `remove`
- `packages/agentic-sdk-v2/src/hooks/__tests__/useVoiceEmbedding.test.ts` — 9 unit tests

**Files modified:**
- `packages/agentic-sdk-v2/src/core/constants.ts` — Added `VOICE_EMBEDDING_ENDPOINTS`
- `packages/agentic-sdk-v2/src/hooks/index.ts` — Exported hook
- `packages/agentic-sdk-v2/src/core.ts` — Exported hook and types
- `packages/agentic-sdk-v2/src/types/index.ts` — Exported types

**Hook interface:**
```typescript
interface UseVoiceEmbeddingReturn {
  status: VoiceEmbeddingStatus | null;
  isLoading: boolean;
  isUploading: boolean;
  error: Error | null;
  upload: (userId: string, audioFile: File | Blob) => Promise<VoiceEmbeddingResponse>;
  getStatus: (userId: string) => Promise<VoiceEmbeddingStatus>;
  remove: (userId: string) => Promise<void>;
}
```

**Test coverage:** 19 tests covering initial state, upload (happy path, error, status update, error clearing on retry, isUploading reset on failure, error re-throw), getStatus (happy path, error, isLoading reset on failure), remove (happy path, status clearing, error, isLoading reset on failure, error re-throw), SDK not initialized (all 3 methods), null logger. All pass.

### Phase 4: Frontend Setup Page Wiring

**Files modified:**
- `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx` — Replaced "Coming Soon" with functional UI
- `packages/agentic-sdk-v2/examples/nextjs-app/src/app/setup/_content.tsx` — Same replacement

**UI features implemented:**
1. **Status badge** — "Embedded" (green) / "Not Embedded" (grey)
2. **Record button** — Uses `MediaRecorder` API for 10-second recording with countdown + progress bar
3. **File upload** — Hidden file input for uploading pre-recorded audio
4. **Remove button** — With confirm dialog
5. **Metadata display** — Vector dimensions and creation date
6. **Error display** — Red banner for API errors
7. **Loading states** — Spinner during upload/processing

### Test Results Summary

| Suite | Tests | Status |
|-------|-------|--------|
| STT-V2 embedding routes (Python) | 33 | All pass |
| API Gateway controller (TypeScript) | 20 | All pass |
| SDK useVoiceEmbedding hook (TypeScript) | 19 | All pass |
| **Total** | **72** | **All pass** |

---

## Change History

### Initial Implementation — 2026-02-21

- Implemented all 4 phases using TDD methodology
- 33 unit tests written and passing across 3 codebases
- "Coming Soon" placeholder replaced with functional UI in both Vite and Next.js apps
- No database migrations required (uses Qdrant + MinIO, both already configured)

### Quality Pass — 2026-02-21

Audited all implementation files against the plan's acceptance criteria and added missing coverage:

**Bugs fixed:**
- `MINIMUM_AUDIO_DURATION_S` corrected from `3.0` to `5.0` per AC6 (min 5 seconds)
- `metadata` form param was accepted but never forwarded to `speaker_store.upsert_embedding()` — now parsed as JSON and forwarded
- `GET /internal/embeddings/{speaker_id}` now returns `created_at` from Qdrant's stored timestamp payload (converted from epoch integer to ISO 8601)
- Qdrant store failure during upsert now caught and returned as HTTP 500 instead of an unhandled exception

**Tests added (13 new):**
- STT-V2: boundary at 4s (rejected), exact 5s (accepted), metadata forwarding, Qdrant store failure, `created_at` in GET response, multi-tenant isolation verification
- API Gateway: `tenant_id` propagation on POST/GET/DELETE, S3 path construction with tenantId, `audioFileKey` presence/absence, STT-V2 delete error propagation

**Test totals:** 22 Python + 15 TypeScript (API) + 9 TypeScript (SDK) = **46 tests, all green**

### Edge Case Coverage Pass — 2026-02-21

Audited all tests against the 5 testing anti-patterns (testing mocks instead of real code, test pollution, blind mocking, incomplete mocks, afterthought tests) and added comprehensive edge case coverage.

**Bug found and fixed:**
- `DELETE /internal/embeddings/{speaker_id}` did not wrap `speaker_store.delete_speaker()` in try/except — Qdrant failures caused unhandled RuntimeError instead of controlled HTTP 500

**Tests added (26 new):**

STT-V2 (11 new → 33 total):
- Corrupted WAV bytes (non-WAV data → 400)
- Empty file (0 bytes → 400)
- Stereo WAV downmixing (2-channel → mono, accepted)
- Invalid metadata JSON (broken string → treated as None)
- JSON array metadata (non-dict → treated as None)
- Omitted metadata (no field → None)
- GET: multiple speakers in tenant (picks correct one)
- GET: `created_at` as None (not in payload → None in response)
- GET: `created_at` as string (passthrough without conversion)
- GET: dimensions not returned when speaker not found
- DELETE: store exception → HTTP 500

API Gateway (5 new → 20 total):
- S3 upload failure prevents STT-V2 call
- STT-V2 503 status propagation
- Complete response DTO verification (all 6 fields)
- Complete GET response DTO verification (all 4 fields)
- Delete operation sequencing (STT-V2 called before S3)

SDK Hook (10 new → 19 total):
- Upload updates status with embedding data
- Upload clears previous error on retry
- Upload resets isUploading on failure
- Upload re-throws error for caller
- getStatus resets isLoading on failure
- Remove sets error on failure
- Remove resets isLoading on failure
- Remove re-throws error for caller
- SDK not initialized: upload throws
- SDK not initialized: remove throws

**Test totals:** 33 Python + 20 TypeScript (API) + 19 TypeScript (SDK) = **72 tests, all green**
