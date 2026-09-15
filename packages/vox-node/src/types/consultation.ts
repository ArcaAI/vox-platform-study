/**
 * Request/response types for the v2 native, consultation-bound summarization
 * surface. Wire shapes are camelCase and served by
 * `apps/api/src/modules/consultation/consultation.controller.ts` (summary
 * routes) and `consultation-job.controller.ts` (async job routes) under
 * `POST/GET/PATCH /api/v1/consultations/:id/summary*` and
 * `/api/v1/consultations/jobs/:jobId*`.
 */

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * Body of `POST /api/v1/consultations/:id/summary` and
 * `POST /api/v1/consultations/:id/summary/async`.
 * Mirrors `GenerateSummaryRequest` (`packages/applications/.../generate-summary.request.ts`).
 */
export interface GenerateSummaryRequest {
  /** Transcription text; if omitted, uses existing transcriptions on the consultation. */
  transcription?: string;
  /** DNA Style ID for summarization. */
  dnaStyleId?: string;
  /** Template to use for summarization. */
  template?: string;
  /** Include Named Entity Recognition. */
  includeNER?: boolean;
  /** Specific context item IDs to use for summarization. */
  contextItemIds?: string[];
  /** Additional options for summarization. */
  options?: Record<string, unknown>;
  /**
   * Idempotency key (UUID) for safe POST retries / double-clicks.
   *
   * This is a BODY field on this endpoint, not an `Idempotency-Key` HTTP
   * header — the gateway Redis-dedupes by `(tenantId, userId, key)` and
   * returns the prior `jobId` on collision (HTTP 200).
   */
  idempotencyKey?: string;
}

/**
 * Body of `POST /api/v1/consultations/:id/summary/pre-summary` and
 * `POST /api/v1/consultations/:id/summary/pre-summary/async`.
 * Mirrors `GeneratePreSummaryRequest` (`packages/applications/.../generate-presummary.request.ts`).
 */
export interface GeneratePreSummaryRequest {
  /** DNA Style ID for pre-summarization. */
  dnaStyleId?: string;
  /** Specific case note IDs to use; if omitted, uses all case notes. */
  caseNoteIds?: string[];
  /** Additional options for pre-summarization. */
  options?: Record<string, unknown>;
  /**
   * Idempotency key (UUID) for safe POST retries / double-clicks.
   *
   * This is a BODY field on this endpoint, not an `Idempotency-Key` HTTP
   * header — same dedupe semantics as {@link GenerateSummaryRequest.idempotencyKey}.
   */
  idempotencyKey?: string;
}

/**
 * Body of `PATCH /api/v1/consultations/:id/summary/:summaryId` (OCC —
 * requires `If-Match`, handled at the transport layer, not in this body).
 * Mirrors `UpdateSummaryRequest` (`packages/applications/.../update-summary.request.ts`).
 */
export interface UpdateSummaryRequest {
  /** Updated summary content. */
  content?: string;
  /** Reason for the change. */
  changeReason?: string;
  /** Summary of what changed. */
  changeSummary?: string;
  /** Source of the change. */
  changeSource?: 'doctor_edit' | 'ai_regeneration' | 'system';
}

/**
 * Body of `POST /api/v1/consultations/:id/summary/:contextItemId/approve` (OCC
 * — requires `If-Match`; see {@link ApproveSummaryOptions.ifMatch} on
 * `ConsultationSummariesResource.approve`). Mirrors `SummaryApprovalRequest`
 * (`packages/applications/.../summary-approval.request.ts`), plus the
 * TASK-972 `clinicianUserId` field the server-side lane of this same ticket
 * adds to that DTO.
 */
export interface ApproveSummaryRequest {
  /**
   * One-click clinician acknowledgement to sign past a safety FLAG. Recorded
   * as a `SAFETY_OVERRIDE` WORM audit event; no free-text justification
   * required.
   */
  overrideSafetyFlag?: boolean;
  /**
   * The clinician the approval is attested for — same rule as
   * {@link OpenConsultationRequest.clinicianUserId}: REQUIRED when this
   * client authenticates as a SERVICE ACCOUNT (400 `CLINICIAN_REQUIRED`
   * otherwise), and refused for a human caller who is not `SUPER_ADMIN` /
   * `TENANT_ADMIN` (400 otherwise; omit it to sign as yourself). A clinician
   * outside the tenant is a 404, not a 403 (`assertUserBelongsToTenant`).
   * The named clinician lands on `approvedBy`/the `SIGNED_NOTE` version; the
   * calling credential is recorded beside them as ACTOR in the WORM `ATTEST`
   * row (TASK-972 Lane 1).
   */
  clinicianUserId?: string;
}

/**
 * Response of `POST /api/v1/consultations/:id/summary/:contextItemId/approve`.
 * Mirrors the controller's inline `SummaryApprovalResponseDto`
 * (`apps/api/src/modules/consultation/consultation.controller.ts`).
 */
export interface SummaryApprovalResponse {
  /** Context item id of the approved summary. */
  contextItemId: string;
  approvalStatus: string;
  /** The clinician who approved — see {@link ApproveSummaryRequest.clinicianUserId}. */
  approvedBy: string;
  approvedAt: string;
}

// -----------------------------------------------------------------------------
// Consultation (minimal read — id validation for the P0.5 flow, NOT CRUD)
// -----------------------------------------------------------------------------

/**
 * Response body of `GET /api/v1/consultations/:id` — the ONLY consultation
 * read this SDK exposes (`hope.consultations.get(id)`), scoped to what the
 * P0.5 summarization flow needs to validate an id, not full consultation
 * CRUD (out of day-1 scope).
 *
 * The real backend DTO is `ConsultationResponse`
 * (`packages/applications/src/services/consultation/consultation/dto/consultation.response.ts`)
 * and additionally carries `doctor` (`DoctorInfo`), `department`
 * (`DepartmentInfo`), `parentConsultationId`, `metadata`, and `contextItems`
 * (`ContextItemResponse[]`, populated only when fetching a single
 * consultation). Deliberately NOT typed here — this SDK has no other reason
 * to model context items, and doing so would pull in the entire
 * transcript/summary content-item shape for a "does this id exist" check.
 * This type is a genuine PARTIAL VIEW of that DTO — reach for the fields
 * below only; anything else on the wire is simply not represented.
 */
export interface ConsultationGetResponse {
  id: string;
  patientId: string;
  doctorId: string;
  departmentId?: string;
  /** `YYYY-MM-DD`. */
  appointmentDate: string;
  /**
   * Clinical lifecycle status — the single-sourced `ConsultationStatus`
   * column ( session state machine; the legacy `metadata.status`
   * tracker this field used to derive from is deleted). Defaults to
   * `'OPEN'` server-side for a freshly-created consultation.
   */
  status?:
    | 'OPEN'
    | 'PRIMED'
    | 'RECORDING'
    | 'DRAINING'
    | 'DRAFT_PENDING_SENSORS'
    | 'PENDING_REVIEW'
    | 'SIGNED'
    | 'TIMED_OUT'
    | 'CLOSED'
    | 'REOPENED'
    | 'CLOSED_COMPLETE'
    | 'CLOSED_INCOMPLETE';
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * `structuredData` on {@link ConsultationSummaryResponse} — summary metadata
 * including LLM info. Named separately from the anonymous inline type on the
 * source DTO (`packages/applications/.../summary.response.ts`) purely for
 * export ergonomics; the field set is unchanged.
 */
export interface ConsultationSummaryStructuredData {
  llmProvider?: string;
  modelName?: string;
  processingTimeMs?: number;
  dnaStyleId?: string;
  inputTokens?: number;
  outputTokens?: number;
  entities?: Record<string, unknown>[];
  cacheHit?: boolean;
  qualityScore?: number;
  promptResolvedFrom?: 'preferred' | 'department' | 'default';
  resolvedPromptId?: string;
}

/**
 * Response body for the v2 consultation summary read/write routes (`GET`
 * `/summary`, `/summary/latest`, `/summary/pre-summary/latest`; `PATCH`
 * `/summary/:summaryId`; the resolved value of an async job). Named
 * `ConsultationSummaryResponse` (not `SummaryResponse`) to avoid colliding
 * with the v1-compat `SummaryResponse` in `./summarization` — the source
 * DTO's class name is `SummaryResponse`
 * (`packages/applications/.../summary.response.ts`).
 */
export interface ConsultationSummaryResponse {
  id: string;
  consultationId: string;
  type: 'summary' | 'pre_summary';
  content: string;
  /** Summary metadata including LLM info. */
  structuredData?: ConsultationSummaryStructuredData;
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// Async jobs (consultation-job.controller.ts)
// -----------------------------------------------------------------------------

/** Lifecycle status of an async consultation job, as returned by `JobStatusResponse.status`. */
export type JobStatusType = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Kind of async consultation job, as returned by `JobStatusResponse.type`. */
export type JobType = 'PRE_SUMMARY' | 'SUMMARY' | 'COMPREHENSIVE_SUMMARY' | 'NER';

/**
 * Response body of `POST /api/v1/consultations/:id/summary/async` and
 * `.../summary/pre-summary/async` (HTTP 200). Mirrors `AsyncJobResponseDto`
 * (`apps/api/src/modules/consultation/consultation.controller.ts`). Note
 * this DTO's `status` union (`pending|processing|completed|failed`) is
 * distinct from — and does not line up 1:1 with — the `JobStatusType` used
 * by `JobStatusResponse` below (`PENDING|RUNNING|COMPLETED|FAILED|CANCELLED`);
 * that mismatch exists in the gateway source, not introduced here.
 */
export interface AsyncJobResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  consultationId: string;
  createdAt: string;
  /** Job progress percentage (0-100). */
  progress?: number;
  /** Job result (partial summary), present once available. */
  result?: Partial<ConsultationSummaryResponse>;
  /** Error message if the job failed. */
  errorMessage?: string;
}

/**
 * Response body of `GET /api/v1/consultations/jobs/:jobId` (HTTP 200) and
 * the parsed `data` payload of each `GET .../jobs/:jobId/stream` SSE frame
 * (see {@link JobStreamEvent}). Mirrors `JobStatusResponse`
 * (`packages/applications/src/services/consultation/jobs/dto/job.dto.ts`).
 *
 * The source DTO types `createdAt`/`startedAt`/`completedAt` as `Date` on
 * the server, but every transport here is JSON (`JSON.stringify`), which
 * serializes `Date` to an ISO-8601 string — so this SDK type declares them
 * as `string`, matching what actually arrives over the wire.
 */
export interface JobStatusResponse {
  jobId: string;
  type: JobType;
  status: JobStatusType;
  /** Associated consultation ID. */
  consultationId?: string;
  /** Associated context item ID. */
  contextItemId?: string;
  /** Progress percentage 0-100. */
  progress: number;
  /** Current processing step. */
  currentStep?: string;
  /**
   * Result when completed. Shape varies by {@link JobType} (pre-summary /
   * summary / comprehensive-summary / NER each have their own internal
   * result interface server-side) — left as `unknown` rather than guessed at.
   */
  result?: unknown;
  /** Error message if failed. */
  error?: string;
  /** ISO-8601 job creation timestamp. */
  createdAt: string;
  /** ISO-8601 job start timestamp. */
  startedAt?: string;
  /** ISO-8601 job completion timestamp. */
  completedAt?: string;
  /** Owning tenant id (ownership check carry-through). */
  tenantId: string;
  /** Owning user id (ownership check carry-through). */
  userId: string;
}

/**
 * One parsed frame of `GET /api/v1/consultations/jobs/:jobId/stream` (SSE).
 * Derived from `ConsultationJobService.subscribeToJobUpdates`
 * (`packages/applications/src/services/consultation/jobs/consultation-job.service.ts`):
 * each Redis-published update — and the initial/terminal status — is emitted
 * as `data: JSON.stringify(currentStatus)`; an unknown `jobId` instead emits
 * `data: JSON.stringify({ error: 'Job not found', jobId })`. There is no
 * `event:` discriminator on the wire, so the client must distinguish the two
 * shapes by the presence of `error`.
 */
export type JobStreamEvent = JobStatusResponse | { error: string; jobId: string };

// -----------------------------------------------------------------------------
// Context items (consultation.controller.ts `:id/context` routes)
// -----------------------------------------------------------------------------

/**
 * `ContextItem.type` — the PLATFORM item type, mirroring the `ContextItemType`
 * enum (`packages/domains/src/enums/generated/ContextItemType.ts`).
 *
 * Distinct from, and NOT replaced by, {@link AddContextRequest.kindKey}: the
 * type says which substrate the item is stored on, the kind key says which
 * TENANT-DECLARED vocabulary entry it is an instance of. A schema-aware write
 * carries both.
 */
export type ContextItemType =
  | 'AUDIO_RECORDING'
  | 'WORKNOTE'
  | 'RAW_SUMMARY'
  | 'MODIFIED_SUMMARY'
  | 'PRE_SUMMARY'
  | 'NAMED_ENTITY'
  | 'TRANSCRIPT'
  | 'CASE_NOTE'
  | 'ATTACHMENT'
  | 'SIGNED_NOTE'
  | 'STRUCTURED';

/** `ContextItem.source` — who produced the item. Mirrors the `ContextItemSource` enum. */
export type ContextItemSource = 'USER' | 'AI' | 'SYSTEM' | 'TRANSCRIPTION';

/** Hard server-side cap on {@link AddContextRequest.content} (`CONTEXT_CONTENT_MAX_LENGTH`). */
export const CONTEXT_CONTENT_MAX_LENGTH = 200_000;

/**
 * Body of `POST /api/v1/consultations/:id/context`. Mirrors `AddContextRequest`
 * (`packages/applications/src/services/consultation/context/dto/add-context.request.ts`).
 *
 * The gateway validates this body with `whitelist + forbidNonWhitelisted`, so
 * an undeclared field rejects the whole request — this interface is closed on
 * purpose, and adding a field here without adding it to the server DTO first
 * produces a 400, not a silently ignored key.
 */
export interface AddContextRequest {
  /** Required. See {@link ContextItemType}. */
  type: ContextItemType;
  /** Content text. Required by the server for non-media types; capped at {@link CONTEXT_CONTENT_MAX_LENGTH}. */
  content?: string;
  /** Media id of an already-uploaded file (for `ATTACHMENT`). */
  mediaId?: string;
  /** DNA Writing Style id (summaries only). */
  dnaWritingStyleId?: string;
  /** Defaults to `'USER'` server-side. */
  source?: ContextItemSource;
  /** Free-form metadata. Convention: lab/exam attachments carry `{ subType: 'LAB_RESULT' }`. */
  metadata?: Record<string, unknown>;
  /**
   * The tenant-declared context kind this item instantiates — `kinds[].key` of
   * the tenant's pinned `ConsultationContextSchema` version, discoverable at
   * `GET /api/v1/tenants/me/context-schema`.
   *
   * Omitting it is the legacy path: no schema is consulted and the write
   * proceeds exactly as it did before the context-schema plane existed.
   */
  kindKey?: string;
  /**
   * Structured payload for a `STRUCTURED` kind, validated server-side against
   * that kind's `fields` sub-schema in the PINNED version.
   *
   * **Requires {@link kindKey}** — a payload with nothing to validate it
   * against is a 400, and `ConsultationsResource.addContext` refuses it
   * locally rather than letting you discover that in production.
   */
  payload?: Record<string, unknown>;
  /**
   * The context item this one was DERIVED from, used only to compute the loop
   * cascade depth. Never schema-validated; a bad or cross-tenant reference
   * degrades to depth 0 rather than failing the write.
   */
  derivedFromContextItemId?: string;
}

/**
 * Response body of `POST /api/v1/consultations/:id/context` (and the other
 * `:id/context*` reads). Mirrors `ContextItemResponse`
 * (`packages/applications/src/services/consultation/context/dto/context-item.response.ts`).
 *
 * A genuine PARTIAL VIEW, in the same spirit as {@link ConsultationGetResponse}:
 * the server DTO additionally carries the media/derivative fields (`url`,
 * `mimeType`, `thumbnailUrl`), the `is*` classification booleans, and the
 * `audioRecordings` / `summaryMeta` / `namedEntities` / `versions` expansions.
 * Those model the transcript-and-summary surface this SDK does not otherwise
 * touch; reach for the fields below only.
 *
 * Note what is deliberately ABSENT: the response carries **no `kindKey` and no
 * `contextSchemaVersionId`** — the DTO mapper does not project them. A caller
 * that needs to know which kind or schema version an item was written under
 * must remember what it sent, not read it back.
 */
export interface ContextItemResponse {
  id: string;
  consultationId: string;
  type: ContextItemType;
  source: ContextItemSource;
  content?: string;
  mediaId?: string;
  dnaWritingStyleId?: string;
  metadata?: Record<string, unknown>;
  /** Content-revision pointer. DISTINCT from {@link ContextItemResponse.version}. */
  currentVersionNumber: number;
  /** Row `_version`, the OCC counter. Echo back as `If-Match: "<version>"` on a PATCH. */
  version: number;
  createdAt: string;
  updatedAt: string;
}
