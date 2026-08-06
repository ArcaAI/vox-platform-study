# Batch Transcription — Compat & API Reference

**Package**: `@arcaai/vox` &middot; **Entry points**: `@arcaai/vox/compat` (SDK surface) + `apps/api` (gateway) &middot; **Version**: 2.0.1

> Verified directly against source — `packages/agentic-sdk-v2/src/compat/`, `packages/agentic-sdk-v2/src/core/FileTranscriptionService.ts`, `apps/api/src/modules/streaming/transcription-job.controller.ts`, `apps/api/src/modules/streaming/dto/transcription-job.dto.ts` (2026-08-03).
>
> This document is a companion to [`Compat-API-Reference.md`](Compat-API-Reference.md), split out because batch
> transcription is the one compat capability that spans **two** contracts: the SDK hooks a consuming app calls
> (**Part A**), and the gateway REST/SSE surface those hooks call over the wire (**Part B**). Everything else in
> the compat SDK is covered by the main reference.

## Table of Contents

- [Overview](#overview)
- [Part A — Compat SDK surface](#part-a--compat-sdk-surface)
  - [A.1 Single-file upload — frozen v1 members](#a1-single-file-upload--frozen-v1-members)
  - [A.2 Multi-file queue — `useArcaBatchTranscription`](#a2-multi-file-queue--usearcabatchtranscription)
- [Part B — REST API reference](#part-b--rest-api-reference)
  - [B.1 Base path, auth & tenancy model](#b1-base-path-auth--tenancy-model)
  - [B.2 Endpoints](#b2-endpoints)
  - [B.3 Request/response shapes](#b3-requestresponse-shapes)
  - [B.4 SSE event contract](#b4-sse-event-contract)
  - [B.5 Error surface](#b5-error-surface)
- [Out of scope](#out-of-scope)
- [Source file index](#source-file-index)
- [Related docs](#related-docs)

## Overview

"Batch transcription" = uploading a pre-recorded audio file and getting a transcript back, as opposed to the live
streaming path (`useAudioCapture`/`useArcaSpeechToText` capturing a live mic). Two SDK members implement it on the
compat surface, at two different scales:

| Member | Scale | v1 ancestor |
| --- | --- | --- |
| `useArcaSpeechToText().uploadAudioFile()` / `.getTranscriptionStatus()` | single file, poll-based status | Yes — frozen v1 members (TASK-560 §5), wired for real in TASK-603 |
| `useArcaBatchTranscription()` | many files, one queue, per-file progress + live streamed results | No — additive, v2-native (TASK-603) |

Both call the **same** gateway surface underneath: `TranscriptionJobController`
(`apps/api/src/modules/streaming/transcription-job.controller.ts`), mounted at
`/api/v1/audio/transcription-jobs`. Part B documents that surface once, since both compat members are thin
adapters over it — nothing here is compat-specific at the wire level.

## Part A — Compat SDK surface

### A.1 Single-file upload — frozen v1 members

On `useArcaSpeechToText` (full hook signature in [`Compat-API-Reference.md` §3](Compat-API-Reference.md#3-usearcaspeechtotext)):

```ts
uploadAudioFile: (file: File, language: string, provider?: string) => Promise<string>; // → job id
getTranscriptionStatus: (taskId: string) => Promise<unknown>; // → TranscriptionJobResponse
isUploading: boolean;
uploadProgress: number; // 0–100
```

| Before TASK-603 | After TASK-603 |
| --- | --- |
| `uploadAudioFile`/`getTranscriptionStatus` threw `"not supported"` | Both real — upload via `FileTranscriptionService`, status via a job read |
| `isUploading` hardcoded `false` | Reflects the in-flight upload |
| `uploadProgress` hardcoded `0` | Reflects the in-flight upload, `0`–`100` |

**Behavior:**
- Uploads to `POST /api/v1/audio/transcription-jobs/transcribe` (multipart) through `FileTranscriptionService`, and
  resolves to the **job id** — v1 resolved to its task id, so the call site is unchanged.
- **`provider` is a pipeline override**, not an ASR provider name. v1's third argument named an ASR provider
  (`'azure' | 'whisper'`); v2 expresses the engine as a pipeline, so a non-empty `provider` is used as the
  `pipelineId` for that one upload. Omitted, the pipeline comes from `options.pipelineId` on the hook (the same
  value the live path uses). Neither present → nothing is uploaded against a guessed engine.
- `isUploading`/`uploadProgress` track the in-flight upload; a failure lands on `error` and calls `onError`.
- **Single-file, exactly as v1 shaped it.** For many files with per-file progress and live streamed results, use
  [`useArcaBatchTranscription`](#a2-multi-file-queue--usearcabatchtranscription) instead — this pair is not going
  to grow a queue.

### A.2 Multi-file queue — `useArcaBatchTranscription`

A **compat-entry hook with no v1 ancestor** (same category as `useArcaSttProvider`) — v1 only ever had the
single-file pair above. Must be imported from `@arcaai/vox/compat`, not `@arcaai/vox/core` (see
[Entry-bundle isolation](Compat-API-Reference.md#entry-bundle-isolation) in the main reference — importing the
"same" hook from a different entry inside a compat-provided tree throws).

```ts
function useArcaBatchTranscription(props?: {
  options?: { pipelineId?: string; language?: string; consultationId?: string }; // defaults per enqueue
  concurrency?: number; // default 2 — bounds uploads AND open SSE streams
  onJobCompleted?: (item: BatchQueueItem) => void;
  onError?: (error: ErrorInfo, itemId: string) => void;
}): {
  items: BatchQueueItem[];
  enqueue: (files: File[] | FileList, options?: BatchTranscriptionOptions) => string[]; // → queue-item ids
  cancel: (itemId: string) => void;
  retry: (itemId: string) => void;
  remove: (itemId: string) => void;
  clear: () => void;
  isUploading: boolean;
  isStreaming: boolean;
  activeCount: number;
  error: ErrorInfo | null;
};

interface BatchQueueItem {
  id: string; // client-side queue id (NOT the job id — that exists only after upload)
  fileName: string;
  size: number; // bytes
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';
  uploadProgress: number; // 0–100, upload only — backend progress is `job.progress`
  jobId: string | null;
  segments: BatchTranscriptSegment[]; // streamed, in arrival order
  text: string; // joined FINAL segments while streaming; the job's own resultText once completed
  error: string | null;
  job: TranscriptionJobResponse | null; // last payload seen — upload response, then the terminal read
  usedFallbackPipelineId: string | null; // TASK-614 — set when the primary ASR failed and the
  //                                        job was re-run on the tenant fallback; null on the
  //                                        normal path and before completion
}

interface BatchTranscriptSegment {
  text: string;
  isFinal: boolean;
  startTime?: number;
  endTime?: number;
  speakerId?: string;
  speakerLabel?: string;
}
```

```tsx
const batch = useArcaBatchTranscription({ options: { pipelineId, language: 'ml-en' } });
<input type="file" multiple accept="audio/*" onChange={(e) => batch.enqueue(e.target.files ?? [])} />;
```

#### How it runs

1. `POST /api/v1/audio/transcription-jobs/transcribe` (multipart, XHR progress via
   `FileTranscriptionService.uploadAndTranscribeWithProgress`) → a job id.
2. `new SSEClient(transcriptionJobScopeFor(jobId), apiClient, logger)` connects to
   `GET /api/v1/audio/transcription-jobs/:id/stream` — `chunk`/`status`/`complete`/`error` events append to
   `segments` (see [B.4](#b4-sse-event-contract) for the wire shapes).
3. On terminal completion (`complete` event, or `status` reporting `COMPLETED`/`FAILED`) the job is **re-read
   once** (`GET /api/v1/audio/transcription-jobs/:id`) and `item.text` becomes its `resultText` — streamed chunks
   can be partial (and a reconnect can have dropped some entirely), so the read-back is the authoritative
   transcript. If the read-back itself fails, the item still completes with whatever was streamed rather than
   being downgraded to `failed`.

#### Two things that are easy to get wrong

- **SSE construction is `new SSEClient(scope, apiClient, logger)` — the 3-argument form.** The legacy 1-argument
  `new SSEClient(logger)` is explicitly blocked inside `openWithTicket` and resolves to a permanent connection
  failure. The deprecated `apps/ui-playground/src/hooks/use-file-transcription.ts:101` still constructs it this
  way, which is why its batch stream never delivers a transcript — do not copy that file.
- **The ticket scope is per job — `transcription_job:<jobId>`** (`transcriptionJobScopeFor()` in
  `src/core/constants.ts`), because the route declares
  `@StreamScope({ namespace: 'transcription_job', param: 'id' })`. A generic/free-form scope string is rejected
  with a **401**, not a warning.

Both are locked by `packages/agentic-sdk-v2/src/compat/__tests__/useArcaBatchTranscription.test.ts` — do not
"simplify" either.

#### Concurrency

A slot is held for the **whole lifecycle** — upload **and** result stream, not just the upload — so `concurrency`
(default `2`) also bounds how many SSE connections are open at once. Files past the cap sit in `pending` until a
slot frees. The cap exists to bound open sockets and backend load, not just to throttle bandwidth.

#### Other behavior

- Named SSE events (`chunk`/`status`/`complete`/`error`) and the generic `onMessage` envelope are **both** wired.
  `EventSource` routes named events exclusively to their own listeners, so this cannot double-count a segment or
  a completion.
- `cancel(itemId)` aborts an in-flight upload, or — if the job already exists on the backend — calls
  `POST /:id/cancel` and tears down the stream. `retry(itemId)` resets the item to `pending` and re-runs it from
  the top (a fresh upload; the old job id is discarded). `remove`/`clear` tear down transport handles before
  dropping the row(s).
- `File` objects are deliberately **not** exposed on `BatchQueueItem` — `retry` keeps the original `File` in an
  internal ref so re-running an item never asks the caller to re-pick the file.

## Part B — REST API reference

Both compat members above call the same gateway controller. This section documents that controller once, as a
standalone REST/SSE reference — useful whether you're calling it from the compat SDK, the native (non-compat) SDK,
or directly.

### B.1 Base path, auth & tenancy model

- **Base path**: `/api/v1/audio/transcription-jobs` (`TranscriptionJobController`, `apps/api`).
- **Auth**: `@ApiBearerAuth()` + class-level `@Authorize()` (no ability argument) — every route requires an
  authenticated caller; no per-route ability is declared beyond that.
- **Tenancy**: `getTenantId()` resolves the caller's active tenant (CLS `tenantId`, elevated by a global admin's
  `X-Tenant-Id` header, else the JWT's own `tenantId`) and throws `400` if none resolves — "Tenant context is
  required." **There is no SYSTEM-tenant fallback.**
- **Ownership scope — two different postures on the same controller, read the route table carefully:**
  - `GET /:id`, `GET /:id/stream`, `POST /:id/cancel`, `POST /:id/retry` carry
    `@TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })` — a cross-tenant id **404s**
    (existence not leaked), the standard 404-over-403 posture.
  - `cancel`/`retry` go further: they're **creator-scoped** inside the service (`cancelJobForOwner`/
    `retryJobForOwner`), not merely tenant-scoped — a same-tenant peer cannot cancel or retry a job they did not
    create. The tenant-boundary decorator and the creator check are two independent gates.
  - `GET /` (list), `GET /stats`, `GET /status/:status`, `GET /consultation/:consultationId` are **owner-scoped**
    reads (the caller's own jobs only) — there is a separate tenant-wide admin view at
    `/admin/audio/transcription-jobs` (`admin-transcription-job.controller.ts`) for cross-user visibility within a
    tenant.
- **Pipeline ownership**: every route that accepts a `pipelineId` (`transcribeFile`, `createStreamSession`) calls
  `assertPipelineOwnership()` first — an unknown or cross-tenant pipeline id is reported as a generic
  `404 Pipeline ${id} not found`, never distinguished from "doesn't exist", so pipeline enumeration across tenants
  isn't possible.

### B.2 Endpoints

Batch-transcription-relevant routes only (the controller also owns the WS streaming-session routes — out of scope
here; see `08-vox-sdk.md`'s live-provider-switch coverage instead):

| Method & path | Purpose | Auth/scope note |
| --- | --- | --- |
| `POST /transcribe` | Upload a file and queue it for batch transcription (multipart) | Tenant-scoped; dispatches to the STT Dramatiq worker |
| `GET /:id` | Read one job | `@TenantOwnedResource` — cross-tenant 404 |
| `GET /:id/stream` | SSE stream of job events | `@TenantOwnedResource` + `@StreamScope('transcription_job', 'id')` — accepts `Authorization: Bearer` **or** `?ticket=` |
| `POST /:id/cancel` | Cancel a job | `@TenantOwnedResource` + creator-scoped in the service |
| `POST /:id/retry` | Retry a failed job | `@TenantOwnedResource` + creator-scoped in the service |
| `GET /` | List the caller's own jobs, paginated (`page`, `limit`) | Owner-scoped |
| `GET /stats` | Status counts for the caller's own jobs | Owner-scoped |
| `GET /status/:status` | Caller's own jobs filtered by status | Owner-scoped |
| `GET /consultation/:consultationId` | Caller's own jobs for a consultation | Owner-scoped |
| `GET /language-modes` | STT language-mode catalog (TASK-587) | Read-only, not tenant-scoped; class-level `@Authorize()` is sufficient |

Not batch-specific but present on the same controller: `POST /` (generic job create), `POST /batch` (create a
batch job record without the upload step — used internally by `transcribeFile`), `POST /streaming` (streaming job
record), plus the `stream/session/*` WebSocket-session routes.

#### `POST /transcribe` — step by step (server side)

1. Validate the multipart `file` is present, ≤ `MAX_FILE_SIZE` (100 MB), and its MIME type is in
   `ALLOWED_AUDIO_MIMES`.
2. Resolve the caller's tenant; assert pipeline ownership.
3. Create the job row (`status: QUEUED`) via `TranscriptionJobService.createBatchJob`.
4. Resolve the tenant's audio bucket (configured purpose → `recordings` slug → legacy `audio` slug → the
   `hope-audio` global default) and build the storage path
   (`<year>/<month>/[consultations/<consultationId>/]jobs?/<jobId>/raw/<sanitizedFilename>` — mirrors STT-v2's
   `StoragePathResolver`).
5. Upload the file buffer to that path via `IBlobStorageService`.
6. Resolve a per-tenant storage descriptor (only non-`null` for a DEDICATED S3/Azure tenant; `null` = the worker
   uses its env-default client) and dispatch a Dramatiq message to the `stt_batch` queue.
7. On any failure in steps 4–6, the job is marked `FAILED` (`errorCode: 'SETUP_ERROR'`) and the original error is
   rethrown — the client sees the real HTTP error, not a silently queued job that will never process.
8. Respond `201` with `{ id, status, sseUrl, audioUri }` immediately — the job continues processing
   asynchronously; the client subscribes to `sseUrl` (or polls `GET /:id`) for progress.

### B.3 Request/response shapes

```ts
// POST /transcribe — multipart/form-data fields
interface TranscribeFileRequest {
  pipelineId?: string; // OPTIONAL since TASK-614. Slug ([A-Za-z0-9][A-Za-z0-9-]*) or UUID v4.
  //                      Omit to use the tenant's default pipeline: the gateway resolves
  //                      tenant-default → configured STT fallback, and 409s when it has
  //                      neither. It never guesses a pipeline.
  consultationId?: string; // UUID, optional
  language?: string; // ISO 639-1, e.g. 'en', 'vi', 'auto' — optional pipeline override
}

// 201 response
interface BatchTranscribeResponse {
  id: string; // job id
  status: string; // 'QUEUED' at creation
  sseUrl: string; // '/api/v1/audio/transcription-jobs/{id}/stream'
  audioUri: string; // 's3://<bucket>/<path>' — where the file landed
}

// GET /:id
enum TranscriptionJobType { BATCH = 'BATCH', STREAMING = 'STREAMING' }
enum TranscriptionJobStatus { QUEUED, PROCESSING, COMPLETED, FAILED, CANCELLED, DEAD }

interface TranscriptionJobResponse {
  id: string;
  jobType: TranscriptionJobType;
  pipelineId: string;
  status: TranscriptionJobStatus;
  progress: number; // 0–100
  retryCount: number;
  maxRetries: number;
  tenantId: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  consultationId?: string | null;
  contextItemId?: string | null;
  mediaId?: string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  resultText?: string | null; // the authoritative transcript once COMPLETED
  resultMetadata?: Record<string, unknown> | null;
  errorMessage?: string | null;
  errorCode?: string | null; // e.g. 'SETUP_ERROR' for an upload/dispatch failure
  workerId?: string | null;
  createdBy?: string | null;
  pipeline?: AsrPipelineResponse; // present only when the read includes it
}
```

**Constants** (`apps/api/src/modules/streaming/dto/transcription-job.dto.ts`):

| Constant | Value | Notes |
| --- | --- | --- |
| `MAX_FILE_SIZE` | `100 * 1024 * 1024` (100 MB) | Enforced both by `FileInterceptor`'s `limits.fileSize` and again explicitly in the handler (the second check produces the friendlier `"File size XMB exceeds maximum of YMB"` message) |
| `ALLOWED_AUDIO_MIMES` | `audio/wav`, `audio/wave`, `audio/x-wav`, `audio/mpeg`, `audio/mp3`, `audio/mp4`, `audio/x-m4a`, `audio/ogg`, `audio/flac`, `audio/x-flac`, `audio/webm`, `audio/aac` | Checked against the multipart part's declared MIME, not sniffed from content |
| `PIPELINE_ID_PATTERN` | slug `^[A-Za-z0-9][A-Za-z0-9-]*$` or UUID v4 | Rejects arbitrary strings, paths, SQL fragments, and a bare `-` |

> A 60-minute recording at typical uncompressed WAV rates can exceed 100 MB — the size ceiling is a proxy for
> "reasonable upload," not a duration guarantee. There is currently no server-side audio-duration check on this
> route (see [Out of scope](#out-of-scope) for related, not-yet-merged work).

### B.4 SSE event contract

`GET /:id/stream` is a NestJS `@Sse()` route. Two ways to authenticate it:

1. `Authorization: Bearer <jwt>` — works if the caller already holds a session.
2. A single-use **stream ticket**: `POST /api/v1/auth/stream-ticket` with body `{ scope: "transcription_job:<jobId>" }`
   → `{ ticket, expiresAt, scope }` (TTL **30 seconds**), then open the SSE connection at
   `?ticket=<ticket>`. This is what `SSEClient`'s 3-argument constructor does internally — see
   [A.2](#a2-multi-file-queue--usearcabatchtranscription) for why the scope must be exactly
   `transcription_job:<jobId>` (`@StreamScope({ namespace: 'transcription_job', param: 'id' })` on the route
   compares against it verbatim; anything else is a 401).

Named events emitted on the stream (consumed by `useArcaBatchTranscription` and `SSEClient.onEvent`):

| Event | Payload (JSON) | Meaning |
| --- | --- | --- |
| `chunk` | `{ text, isFinal?, startTime?, endTime?, speakerId? \| speaker?, speakerLabel? }` | One transcript segment. `isFinal` defaults to `true` when omitted. |
| `status` | `{ status: string }` | A status transition. Only `COMPLETED`/`FAILED` (case-insensitive) are acted on by the compat consumer; other values are informational. |
| `complete` | — (payload not required) | Terminal success signal — triggers the authoritative `GET /:id` read-back. |
| `error` | `{ message?: string }` | Terminal failure — surfaced as the item's error text (falls back to a generic message if `message` is absent). |

A generic/unnamed `message` frame (no named event) is also accepted, carrying the same shape as one of the above —
`EventSource` only routes a frame to `onEvent('chunk', ...)`/etc. when it has a matching `event:` line, so a
consumer wired for both named events and `onMessage` cannot double-count a frame that arrives named.

Every payload may be delivered either bare (`{ text: "..." }`) or wrapped in an envelope (`{ type: "chunk", data: { text: "..." } }`) — both shapes are unwrapped identically before parsing (unwrap `data` if present, else use the payload as-is).

### B.5 Error surface

| Status | When | Body/notes |
| --- | --- | --- |
| `400` | No file on `POST /transcribe`; file exceeds `MAX_FILE_SIZE`; MIME not in the allow-list; no tenant context resolves; empty `sessionId`/`id` path param | Message names the specific cause (e.g. exact size vs. ceiling) |
| `401` | SSE ticket scope mismatch (`?ticket=` doesn't match `transcription_job:<id>`); missing/expired ticket | Enforced by the `@StreamScope` guard before the handler runs |
| `404` | Cross-tenant job/pipeline id; unknown job/pipeline id | 404-over-403 — no existence leak, whether the true cause is "wrong tenant" or "doesn't exist" |
| `500` | Storage upload or Dramatiq dispatch fails after the job row was created | The job is marked `FAILED` (`errorCode: 'SETUP_ERROR'`) before the error is rethrown — never a silently stuck `QUEUED` row |

Cancel/retry additionally enforce creator-scoping in the service layer (not a distinct HTTP status — a
non-creator same-tenant caller gets whatever `cancelJobForOwner`/`retryJobForOwner` throws for "not yours",
consistent with the 404-over-403 posture used elsewhere).

## Out of scope

- **The native (non-compat) SDK's batch engine** — `@arcaai/vox`'s core/plugins entries are gaining their own
  `BatchTranscriptionQueue`/`useBatchTranscription` (TASK-604: admin-configurable file-count/duration/size caps,
  gateway-enforced audio-duration probing, a `GET /limits` and `GET /fallback` read surface). That work lives on
  an unmerged `task-604` branch as of this writing (`docs/implementation/TASK-604-Vox-SDK-Live-And-Batch/README.md`)
  and explicitly does **not** touch `packages/agentic-sdk-v2/src/compat/**` — this document covers only what's
  described above. Once merged, expect a similar reference for the native engine, or an update here if the compat
  hook converges onto it.
- **`apps/ui-playground`**'s legacy `use-file-transcription.ts` — deprecated, no development plan, and known
  broken (the 1-arg `SSEClient` bug named above). Not a reference implementation.
- Admin-side tenant-wide job visibility (`admin-transcription-job.controller.ts`, `/admin/audio/transcription-jobs`) —
  a different controller with different (admin) authorization, not covered here.

## Source file index

| File | Contents |
| --- | --- |
| `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` | Single-file `uploadAudioFile`/`getTranscriptionStatus` (§A.1) |
| `packages/agentic-sdk-v2/src/compat/useArcaBatchTranscription.ts` | Multi-file queue hook (§A.2) |
| `packages/agentic-sdk-v2/src/core/FileTranscriptionService.ts` | Upload-with-progress, job fetch/cancel, stream-URL construction |
| `packages/agentic-sdk-v2/src/core/SSEClient.ts` | Ticket-flow SSE transport (`openWithTicket`) |
| `packages/agentic-sdk-v2/src/core/constants.ts` | `STT_ENDPOINTS`, `transcriptionJobScopeFor()` |
| `packages/agentic-sdk-v2/src/types/stt.ts` | `TranscriptionJobResponse`, `TranscriptionJobStatus`, `TranscriptionJobType` |
| `apps/api/src/modules/streaming/transcription-job.controller.ts` | Gateway controller (§B) |
| `apps/api/src/modules/streaming/dto/transcription-job.dto.ts` | Request/response DTOs, `MAX_FILE_SIZE`, `ALLOWED_AUDIO_MIMES` |
| `apps/api/src/modules/auth/auth.controller.ts` + `stream-ticket.service.ts` | `POST /auth/stream-ticket` (30s single-use ticket) |
| `packages/agentic-sdk-v2/src/compat/__tests__/useArcaBatchTranscription.test.ts` | Unit tests — locks the 3-arg `SSEClient` form and the per-job scope |

## Related docs

- [`Compat-API-Reference.md`](Compat-API-Reference.md) — the full compat SDK surface (§3.1 and §7 are this
  document's origin sections, now expanded here)
- [`../README.md`](../README.md) — full SDK overview
- [`docs/implementation/TASK-603-Compat-Batch-Upload/README.md`](../../../docs/implementation/TASK-603-Compat-Batch-Upload/README.md) — the ticket that wired both compat members to the real gateway API
- [`docs/implementation/TASK-604-Vox-SDK-Live-And-Batch/README.md`](../../../docs/implementation/TASK-604-Vox-SDK-Live-And-Batch/README.md) — the native (non-compat) batch engine + gateway cap-enforcement work (unmerged; see [Out of scope](#out-of-scope))
- [`apps/compat-playground`](../../../apps/compat-playground) (port 5177) — runnable reference app; the fourth tab exercises this exact flow
