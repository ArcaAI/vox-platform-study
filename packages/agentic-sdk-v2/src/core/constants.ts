/**
 * @arcaai/vox - Constants
 *
 * Default values and endpoint definitions.
 */

import type { AgentTask } from '../types/agent';

// =============================================================================
// Route classification
// =============================================================================

/**
 * Whether `path` targets the **admin plane**.
 *
 * Covers `/admin/*` (mirrors the API gateway's own admin-route detection,
 * `AuthorizationGuard`, `/^\/(api\/v\d+\/)?admin\//`).
 *
 * moved the two surfaces that used to sit OUTSIDE that prefix onto
 * it — `/monitoring/*` → `/admin/monitoring/*`, and
 * `/health/services[/:serviceKey]` → `/admin/health/services[...]` — so the
 * `admin/` branch now covers them. The two legacy branches are KEPT (they
 * cost nothing and still classify a hard-coded pre-move path correctly for an
 * older caller), and the remaining `/health/*` probes (`/health`,
 * `/health/live`, `/health/ready`) stay unrestricted and deliberately
 * unmatched.
 *
 * The optional `api/vN/` segment is tolerated even though SDK endpoint
 * constants omit the gateway prefix (the `baseUrl` carries it) — this keeps
 * the predicate correct if a fully-qualified path is ever passed.
 *
 * `@arcaai/vox` is business-plane only (TASK-890, OD-F/OD-K): it carries no
 * management surface, so `AgenticClient` uses this predicate to REFUSE any
 * admin-plane request outright (see `AdminPlaneRefusedError` below) instead
 * of routing it with an admin JWT during impersonation, as it once did. The
 * leading slash and any query string are irrelevant to the match.
 */
export function isAdminPlanePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  return /^\/?(?:api\/v\d+\/)?(?:admin\/|monitoring\/|health\/services(?:[/?]|$))/.test(path);
}

/**
 * Thrown by `AgenticClient` when a request targets an admin-plane endpoint
 * (`isAdminPlanePath`). `@arcaai/vox` is business-plane only (TASK-890,
 * OD-F/OD-K) — administration lives in `@arcaai/vox-node`'s `hope.admin.*`
 * or the admin console, never in the browser SDK.
 */
export class AdminPlaneRefusedError extends Error {
  /** The admin-plane endpoint the request targeted. */
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(
      `@arcaai/vox is business-plane only and refuses admin-plane requests: "${endpoint}". ` +
        `Use @arcaai/vox-node's hope.admin.* or the admin console for administration.`,
    );
    this.name = 'AdminPlaneRefusedError';
    this.endpoint = endpoint;
  }
}

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * Consultation endpoints
 *
 * Uses simplified workflow:
 * - Single `open` endpoint (get-or-create)
 * - No pause/resume/end lifecycle management
 * - Patient history endpoint for viewing all consultations
 */
export const CONSULTATION_ENDPOINTS = {
  /** Open consultation (get-or-create) */
  OPEN: '/consultations/open',
  /** Get consultation by ID with context */
  GET: (id: string) => `/consultations/${encodeURIComponent(id)}`,
  /** which engine governs this consultation (+ the governing definition's identity). */
  WORKFLOW: (id: string) => `/consultations/${encodeURIComponent(id)}/workflow`,
  /**
   * the workflows this caller may name at open. STATIC segment, and the gateway
   * declares it ABOVE `/consultations/:id` for exactly that reason; do not turn it into a
   * parameterised path.
   */
  SELECTABLE_WORKFLOWS: '/consultations/workflows',
  /** Get patient consultation history (all dates) */
  PATIENT_HISTORY: (patientId: string) => `/consultations/patient/${encodeURIComponent(patientId)}/history`,
  /** Get all consultations for patient on a specific date */
  PATIENT_DATE: (patientId: string, date: string) => `/consultations/patient/${encodeURIComponent(patientId)}/date/${encodeURIComponent(date)}`,
  /** Get consultation timeline (SES-04). Supports ?scope=single|chain query param. */
  TIMELINE: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/timeline`,
  /** Get consultation chain — parent + all revisits/referrals (SDK-207 WS-4) */
  CHAIN: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/chain`,
  LIST: '/consultations',
  /** Update consultation (PATCH) */
  UPDATE: (id: string) => `/consultations/${encodeURIComponent(id)}`,
  /**
   * Prime the consultation — the session state machine's first checkpoint
   * (also the AI_DOCUMENTATION consent checkpoint). `@RequiresIfMatch()`.
   */
  PRIME: (id: string) => `/consultations/${encodeURIComponent(id)}/prime`,
  /** Close consultation. `@RequiresIfMatch()`. */
  CLOSE: (id: string) => `/consultations/${encodeURIComponent(id)}/close`,
  /** Reopen consultation. `@RequiresIfMatch()`. */
  REOPEN: (id: string) => `/consultations/${encodeURIComponent(id)}/reopen`,
  /** Live running-SOAP SSE stream (full-state snapshots) while recording. */
  LIVE_SUMMARY_STREAM: (id: string) => `/consultations/${encodeURIComponent(id)}/live-summary/stream`,
  /**
   * Consultation-loop workflow event SSE stream. Append-only
   * feed relaying `consultation:loop:{id}` — each event is a discrete
   * `LoopEvent` (action started/finished, specialist dispatched, ...), never
   * a full-state snapshot. No server-side late-join/replay (see
   * `useConsultationEvents`'s doc comment for the `Last-Event-Id` caveat).
   */
  LOOP_STREAM: (id: string) => `/consultations/${encodeURIComponent(id)}/loop/stream`,
  /**
   * Live clinician-assist SSE stream — the `agent.grammar` node's correction
   * proposals and interpreter suggestions, relayed off
   * `consultation:live-assist:{id}`. Full-state snapshots carrying BOTH
   * branches; unlike the live-summary feed it has NO terminal event, so the
   * client decides when to close it. CARRIES PHI (a proposal quotes the
   * original span verbatim) and nothing on it has been applied to the note.
   */
  LIVE_ASSIST_STREAM: (id: string) => `/consultations/${encodeURIComponent(id)}/live-assist/stream`,
} as const;

/** SSE ticket scope for the live running-SOAP stream (must match the gateway's per-resource scope). */
export const liveSummaryScopeFor = (consultationId: string): string => `consultation_live_summary:${consultationId}`;

/** SSE ticket scope for the consultation-loop event stream (must match `@StreamScope({ namespace: 'consultation_loop' })`). */
export const loopEventsScopeFor = (consultationId: string): string => `consultation_loop:${consultationId}`;

/** SSE ticket scope for the live clinician-assist stream (must match `@StreamScope({ namespace: 'consultation_live_assist' })`). */
export const liveAssistScopeFor = (consultationId: string): string => `consultation_live_assist:${consultationId}`;

/**
 * Audio recording endpoints (dual-capture X8).
 * Persist/list raw + processed captures attached to a consultation.
 */
export const AUDIO_RECORDING_ENDPOINTS = {
  /** Attach an audio recording (mediaId + optional rawMediaId/processedMediaId) */
  ADD: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/recordings`,
  /** List audio recordings for a consultation */
  LIST: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/recordings`,
} as const;

/**
 * Context endpoints
 */
export const SPEECH_ENDPOINTS = {
  /** OpenAI-compatible synthesis; streams audio (or SSE) */
  SYNTHESIZE: () => '/speech/synthesize',
  /** List available voices */
  VOICES: () => '/speech/voices',
} as const;

export const CONTEXT_ENDPOINTS = {
  /** Add context to consultation */
  ADD: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context`,
  /** Get context items for consultation */
  GET: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context`,
  /** Get shared context (all doctors on same date) */
  SHARED: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context/shared`,
  /** Update a context item (SES-03) */
  UPDATE: (consultationId: string, contextId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/context/${encodeURIComponent(contextId)}`,
  /** Get version history for a context item (SES-05) */
  VERSIONS: (consultationId: string, contextId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/context/${encodeURIComponent(contextId)}/versions`,
  /** Get a specific version of a context item (SES-05) */
  VERSION: (consultationId: string, contextId: string, versionNumber: number) =>
    `/consultations/${encodeURIComponent(consultationId)}/context/${encodeURIComponent(contextId)}/versions/${versionNumber}`,
  /** Get transcription context items only (SES-07) */
  TRANSCRIPTIONS: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context/transcriptions`,
  /** Get case note context items only (SES-07) */
  CASE_NOTES: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context/case-notes`,
  /** Get worknote context items only */
  WORKNOTES: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context/worknotes`,
  /** Get attachment context items only */
  ATTACHMENTS: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/context/attachments`,
} as const;

/**
 * Summary endpoints
 */
export const SUMMARY_ENDPOINTS = {
  GENERATE: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary`,
  PRE_SUMMARY: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/pre-summary`,
  LATEST: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/latest`,
  /** Get latest pre-summary (SUM-03) */
  LATEST_PRE_SUMMARY: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/pre-summary/latest`,
  /** List all summaries for a consultation (SUM-04) */
  LIST: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary`,
  UPDATE: (consultationId: string, summaryId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(summaryId)}`,
  EXTRACT_ENTITIES: (consultationId: string, contextItemId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(contextItemId)}/extract-entities`,
  /** Generate comprehensive summary across linked consultations (SUM-02) */
  COMPREHENSIVE: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/comprehensive`,
  /** Async summary generation — returns job ID, HTTP 202 (SUM-01) */
  GENERATE_ASYNC: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/async`,
  /** Async pre-summary generation (SUM-01) */
  PRE_SUMMARY_ASYNC: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/pre-summary/async`,
  /** Async comprehensive summary generation (SUM-01) */
  COMPREHENSIVE_ASYNC: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/summary/comprehensive/async`,
  /** Get version history for a summary context item (WS-3) */
  VERSIONS: (consultationId: string, contextItemId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(contextItemId)}/versions`,
  /** Approve and lock a summary (Story 148) */
  APPROVE: (consultationId: string, contextItemId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(contextItemId)}/approve`,
  /** Diff two versions of a summary — append `?from=&to=` */
  DIFF: (consultationId: string, contextItemId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(contextItemId)}/diff`,
  /** List / create tags on a summary */
  TAGS: (consultationId: string, contextItemId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(contextItemId)}/tags`,
  /** Delete a single tag from a summary */
  TAG: (consultationId: string, contextItemId: string, tagId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/summary/${encodeURIComponent(contextItemId)}/tags/${encodeURIComponent(tagId)}`,
} as const;

/**
 * NER/Entities endpoints
 *
 * Fixed NER-R-05: paths corrected from `.../entities` to `.../named-entities`
 * to match backend ConsultationController.getAggregateNamedEntities route.
 */
export const ENTITY_ENDPOINTS = {
  /** Get aggregate named entities for consultation */
  GET_ALL: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/named-entities`,
  /** Get named entities for a specific context item */
  GET_FOR_ITEM: (consultationId: string, contextItemId: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/context/${encodeURIComponent(contextItemId)}/named-entities`,
} as const;

/**
 * Personalization endpoints
 */
export const PERSONALIZATION_ENDPOINTS = {
  GET_PREFERENCES: '/users/me/preferences',
  UPDATE_PREFERENCES: '/users/me/preferences',
} as const;

/**
 * Department endpoints — NONE. The group is gone (TASK-890 OD-F/OD-K, wave-3
 * close).
 *
 * L9 removed the admin CRUD surface (`LIST`/`GET`/`CREATE`/`UPDATE`/`DELETE`/
 * `ROOTS`/`CHILDREN`/`BY_CODE`/`USERS`) with its sole consumer, the admin
 * `useDepartments` hook, and kept `PROMPT_CONFIG` as a documented exception
 * for `AgenticProvider`'s config cascade (tier 2, DEF-C5). The wave-3 close
 * measured that exception against the gateway and it does not exist: the
 * gateway serves `PATCH admin/departments/:id/prompt-config` and NO GET (see
 * `apps/api/openapi.json`), so both provider reads have always resolved a 404
 * that the surrounding `try/catch` logged at warn — the department tier has
 * never applied. Removing the constant and both call sites changes no
 * behaviour and stops the code claiming a tier it cannot resolve; a
 * self-scoped READ route (`GET users/me/department/prompt-config`) plus the
 * tier-2 read is the follow-up (§8).
 */

/**
 * Health check endpoints (SDK-207 WS-4)
 *
 * Matches HealthController.
 */
export const HEALTH_ENDPOINTS = {
  HEALTH: '/health',
  LIVE: '/health/live',
  READY: '/health/ready',
} as const;

/**
 * Auth-based tenant endpoints (no admin prefix).
 *
 * These resolve the tenant from the JWT token on the server side,
 * so no tenantId path parameter is needed.
 */
export const MY_TENANT_ENDPOINTS = {
  INFO: '/tenants/me',
  CONFIG: '/tenants/me/config',
  /**
   * Discovery bundle for the caller tenant's PINNED `ConsultationContextSchema`
   * A deliberate sibling of `CONFIG` above, not an
   * addition to it — see `ConsultationSchemaClient.ts`.
   */
  CONTEXT_SCHEMA: '/tenants/me/context-schema',
} as const;

// =============================================================================
// STT Endpoints (ASR-R-01)
// =============================================================================

/**
 * STT endpoints
 *
 * Complete endpoint set for the stt module:
 * - Streaming session management (create session + WebSocket)
 * - Transcription job lifecycle (create, list, status, cancel, retry)
 * - File upload transcription with SSE
 *
 * REST endpoints are relative to the API base URL.
 * WebSocket path (WS_STREAM) is absolute from host root.
 */
export const STT_ENDPOINTS = {
  /** Create a streaming session — returns sessionId + wsUrl */
  CREATE_SESSION: '/audio/transcription-jobs/stream/session',
  /** List selectable STT language modes + per-mode supported engines*/
  LANGUAGE_MODES: '/audio/transcription-jobs/language-modes',
  /** Close/delete a streaming session */
  CLOSE_SESSION: (sessionId: string) => `/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}`,
  /**
   * Refresh the one-shot stream ticket for a live session.
   * SDK calls this from `SttWebSocketClient.attemptReconnect` because the
   * previous ticket is consumed by the gateway on the first WS open.
   */
  REFRESH_TICKET: (sessionId: string) => `/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}/refresh-ticket`,
  /**
   * Switch a live streaming session to the tenant fallback pipeline.
   * The backend swaps the ASR engine in place; the client learns via the
   * `provider_switched` status frame. 409 when no fallback is configured or the
   * session is already on the fallback; 404 on a backend without the route.
   */
  SWITCH_TO_FALLBACK: (sessionId: string) => `/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}/switch-to-fallback`,
  /**
   * Switch a live streaming session BACK to its primary pipeline.
   * The primary-direction counterpart of `SWITCH_TO_FALLBACK` — gives native SDK
   * consumers a 2-way pipeline↔default toggle. 409 when already on the primary or
   * the primary engine was never loaded; 404 on a backend without the route.
   */
  SWITCH_TO_PRIMARY: (sessionId: string) => `/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}/switch-to-primary`,
  /** WebSocket path for real-time audio streaming (absolute, not API-prefixed) */
  WS_STREAM: '/ws/stt/stream',
  /** Create a generic transcription job */
  CREATE_JOB: '/audio/transcription-jobs',
  /** Create a batch transcription job (pre-recorded audio) */
  CREATE_BATCH_JOB: '/audio/transcription-jobs/batch',
  /** Create a streaming transcription job */
  CREATE_STREAMING_JOB: '/audio/transcription-jobs/streaming',
  /** Upload audio file + SSE stream results */
  TRANSCRIBE: '/audio/transcription-jobs/transcribe',
  /** Reconnect to an existing job's SSE stream */
  JOB_STREAM: (jobId: string) => `/audio/transcription-jobs/${encodeURIComponent(jobId)}/stream`,
  /** Get transcription job by ID */
  GET_JOB: (jobId: string) => `/audio/transcription-jobs/${encodeURIComponent(jobId)}`,
  /** List transcription jobs (paginated) */
  LIST_JOBS: '/audio/transcription-jobs',
  /** Get job status counts/stats */
  JOB_STATS: '/audio/transcription-jobs/stats',
  /** Get transcription jobs by consultation ID */
  JOBS_BY_CONSULTATION: (consultationId: string) => `/audio/transcription-jobs/consultation/${encodeURIComponent(consultationId)}`,
  /** Get transcription jobs by status */
  JOBS_BY_STATUS: (status: string) => `/audio/transcription-jobs/status/${encodeURIComponent(status)}`,
  /** Cancel a transcription job */
  CANCEL_JOB: (jobId: string) => `/audio/transcription-jobs/${encodeURIComponent(jobId)}/cancel`,
  /** Retry a failed transcription job */
  RETRY_JOB: (jobId: string) => `/audio/transcription-jobs/${encodeURIComponent(jobId)}/retry`,
  /**
   * Batch upload ceilings — recordings per batch, minutes per recording, size,
   * in-flight jobs. The SDK enforces the SAME numbers the gateway
   * does; fetching them is what keeps "5" and "60" from being hardcoded twice.
   */
  BATCH_LIMITS: '/audio/transcription-jobs/limits',
  /**
   * The tenant's configured STT fallback pipeline — lets the live
   * provider toggle NAME the default and disable itself when none is set,
   * instead of discovering the 409 mid-consultation.
   */
  FALLBACK_PROVIDER: '/audio/transcription-jobs/fallback',
} as const;

/**
 * SSE ticket scope for a transcription job's result stream.
 *
 * MUST match the gateway's per-resource scope exactly: the route declares
 * `@StreamScope({ namespace: 'transcription_job', param: 'id' })` and the auth
 * guard compares the ticket's stored scope against `transcription_job:<id>`.
 * A generic scope string ("jobs", "transcription-jobs", …) is rejected 401.
 */
export const transcriptionJobScopeFor = (jobId: string): string => `transcription_job:${jobId}`;

// =============================================================================
// Pipeline Endpoints (ASR-R-01)
// =============================================================================

/**
 * ASR Pipeline endpoints
 *
 * Read operations use `/audio/pipelines` (any authenticated user).
 * Write operations use `/admin/audio/pipelines` (admin only).
 *
 * @deprecated TASK-865 — removed in R4 (`AsrPipeline` retires under TASK-861). See {@link AGENT_ENDPOINTS}.
 */
export const PIPELINE_ENDPOINTS = {
  /** List ASR pipelines (paginated) */
  LIST: '/audio/pipelines',
  /** Get pipeline by ID */
  GET: (pipelineId: string) => `/audio/pipelines/${encodeURIComponent(pipelineId)}`,
  /** Get pipeline by slug */
  GET_BY_SLUG: (slug: string) => `/audio/pipelines/slug/${encodeURIComponent(slug)}`,
  /** Create a new ASR pipeline */
  CREATE: '/admin/audio/pipelines',
  /** Update an ASR pipeline */
  UPDATE: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}`,
  /** Delete an ASR pipeline (soft-delete) */
  DELETE: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}`,
  /** Validate pipeline YAML configuration */
  VALIDATE: '/admin/audio/pipelines/validate',
  /** Assign a pipeline to a tenant */
  ASSIGN_TENANT: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/assign-tenant`,
  /** Assign a pipeline to a user */
  ASSIGN_USER: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/assign-user`,
  /** Mark a pipeline as the tenant default (POST) */
  SET_DEFAULT: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/set-default`,
  /** Enable/disable a pipeline (PATCH, OCC via If-Match) */
  TOGGLE: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/toggle`,
  /** List config-version snapshots (newest first) */
  VERSIONS: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/versions`,
  /** Get one config-version snapshot by version number */
  VERSION: (pipelineId: string, versionNumber: number) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/versions/${versionNumber}`,
} as const;

// =============================================================================
// NLP Endpoints (NER-R-04)
// =============================================================================

/**
 * NLP proxy endpoints
 *
 * Matches backend NlpController at `/nlp` (proxied to Python NLP service).
 * These are proxied to the Python NLP service.
 */
export const NLP_ENDPOINTS = {
  /** Classify tokens (medical NER) — primary NER endpoint */
  CLASSIFY_TOKENS: '/nlp/classify/tokens',
  /** Classify text (text-level classification) */
  CLASSIFY_TEXT: '/nlp/classify/text',
  /** Correct text (spell check / grammar) */
  CORRECT: '/nlp/correct',
  /** Suggest findings based on text */
  SUGGEST: '/nlp/suggest',
} as const;

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default request timeout in milliseconds
 */
export const DEFAULT_TIMEOUT = 30000;

/**
 * Default personalization sync interval in milliseconds
 */
export const DEFAULT_SYNC_INTERVAL = 60000;

/**
 * Local storage keys.
 *
 * `SELECTED_MODELS` is the BASE key — `ModelRegistry` namespaces it per
 * `${tenantId}::${userId}` as `arcaai-selected-models/${ns}`, so selections
 * isolate per tenant/user instead of sharing one global key.
 */
export const STORAGE_KEYS = {
  SELECTED_MODELS: 'arcaai-selected-models',
} as const;

// =============================================================================
// Feature Flags
// =============================================================================

/**
 * Local (in-browser) transcription kill switch.
 *
 * The owner decided to disable on-device Whisper transcription
 * platform-wide for now — backend-based transcription only. This flag gates
 * only the STT stage's local/offline path.
 *
 * VAD and noise suppression are gated SEPARATELY and are also off: since
 * TASK-865 the browser never runs a model, so `TranscriptionPipeline` drops
 * both client stages from the graph unless the host sets
 * `audio.clientInference: { allow: true }`. (Earlier text here said they
 * "keep running in the browser as preprocessing stages" — that predates
 * TASK-865 and is no longer true; corrected under TASK-977 D-6.)
 *
 * `TranscriptionPipeline.resolveSTTRuntimeProvider()` reads this flag: when
 * `false`, it never resolves the STT provider to `'local'` regardless of
 * config (`transcriptionMode`, `provider`, `location`) — a backend transport
 * (`stt.sttSocket` / `stt.streamingTransport`) resolves to `'remote'`; with no
 * transport it throws `AgenticError('LOCAL_TRANSCRIPTION_DISABLED', ...)`
 * instead of silently falling back to on-device transcription. The local
 * Whisper processor is therefore never constructed while this flag is off (no
 * model-download side effects).
 *
 * TO RE-ENABLE: flip this back to `true`. This is the single, findable
 * switch — no other code path needs to change.
 *
 * @deprecated TASK-865 — removed in R4 together with the local Whisper stage: the constant
 * stays `false` until then and is never flipped. The browser never runs a model.
 */
export const LOCAL_TRANSCRIPTION_ENABLED = false;

// =============================================================================
// Additional Endpoint Constants
// =============================================================================

/**
 * Auth endpoints
 *
 * `STREAM_TICKET` is the single source of truth for the SSE ticket-mint
 * endpoint consumed by `core/SSEClient.ts`. The path is owned by the API at
 * `POST /auth/stream-ticket`.
 */
export const AUTH_ENDPOINTS = {
  LOGIN: '/auth/login',
  LOGOUT: '/auth/logout',
  ME: '/auth/me',
  REFRESH: '/auth/refresh',
  IMPERSONATE: '/auth/impersonate',
  REVOKE_IMPERSONATION: '/auth/revoke-impersonation',
  STREAM_TICKET: '/auth/stream-ticket',
} as const;

/**
 * User settings endpoints.
 *
 * The API only exposes two real routes — `GET /users/me/settings` and
 * `PATCH /users/me/settings/:namespace/:key`. The previous shape (CRUD by id,
 * MY_SETTINGS by userId) targeted routes that do not exist.
 */
export const USER_SETTINGS_ENDPOINTS = {
  list: '/users/me/settings',
  updateByKey: (namespace: string, key: string) => `/users/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
} as const;

/**
 * Plan-entitlements self-view, business plane.
 *
 * TASK-890 (OD-F/OD-K): the super-admin surface this group used to expose
 * (`ENABLED`/`PLANS`/`PLAN`/`TENANT_SNAPSHOT`/`TENANT_OVERRIDE`/
 * `TENANT_DOWNGRADE`/`TRIAL_EXPIRY_RUN`, all `/admin/entitlements/*`) was
 * removed along with its sole consumer, the admin `useEntitlements` hook —
 * `@arcaai/vox` carries no management surface. `ME` survives as a documented
 * wire contract (TASK-760): the tenant self-view, `read:Tenant`,
 * CLS-tenant-scoped, deliberately under `tenants/me/**`, not `users/me/**`.
 */
export const ENTITLEMENTS_ENDPOINTS = {
  ME: '/tenants/me/entitlements',
} as const;

/**
 * Consultation job endpoints
 */
export const CONSULTATION_JOB_ENDPOINTS = {
  GET: (jobId: string) => `/consultations/jobs/${encodeURIComponent(jobId)}`,
  CANCEL: (jobId: string) => `/consultations/jobs/${encodeURIComponent(jobId)}/cancel`,
  SSE: (jobId: string) => `/consultations/jobs/${encodeURIComponent(jobId)}/stream`,
} as const;

/**
 * DNA writing-style sample ingest endpoints (TASK-974).
 *
 * Business plane — `DnaWritingStyleIngestController`
 * (`@Controller('dna-writing-styles/ingest')`). Reachable by JWT, API key
 * (scope `dna-writing-style:ingest`) and service account
 * (`svc:dna-writing-style:ingest`); NOT `/admin/*`, and deliberately a NEW
 * name — `DNA_STYLE_ENDPOINTS` stays absent per the TASK-890 gate tests. No
 * SSE on this surface (job status is polled via `INGEST_JOB`).
 */
export const DNA_WRITING_STYLE_ENDPOINTS = {
  INGEST: '/dna-writing-styles/ingest',
  INGEST_JOB: (jobId: string) => `/dna-writing-styles/ingest/jobs/${encodeURIComponent(jobId)}`,
} as const;

/**
 * Storage management endpoints
 */
export const STORAGE_ENDPOINTS = {
  LIST_BUCKETS: '/storage/buckets',
  GET_BUCKET: (name: string) => `/storage/buckets/${encodeURIComponent(name)}`,
  /** Create a new bucket */
  CREATE_BUCKET: '/storage/buckets',
  /** Delete a bucket */
  DELETE_BUCKET: (name: string) => `/storage/buckets/${encodeURIComponent(name)}`,
  LIST_FILES: (bucketName: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files`,
  UPLOAD_FILE: (bucketName: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files`,
  GET_FILE: (bucketName: string, key: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files/${encodeURIComponent(key)}`,
  DELETE_FILE: (bucketName: string, key: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files/${encodeURIComponent(key)}`,
  HEALTH: '/storage/health',
} as const;

/**
 * Policy management endpoints
 */
export const POLICY_ENDPOINTS = {
  LIST: '/admin/rbac/policies',
  GET: (id: string) => `/admin/rbac/policies/${encodeURIComponent(id)}`,
  CREATE: '/admin/rbac/policies',
  UPDATE: (id: string) => `/admin/rbac/policies/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/rbac/policies/${encodeURIComponent(id)}`,
  VALIDATE: '/admin/rbac/policies/validate',
} as const;

// =============================================================================
// Admin / storage / text endpoint bindings
//
// Paths omit the `/api/v1` prefix (the AgenticClient baseUrl carries it).
// Every path below is source-verified against its API controller (cited per
// group).
// =============================================================================

/**
 * Text-generation proxy endpoints.
 *
 * Controller: `apps/api/src/modules/streaming/text-proxy.controller.ts`
 * (`@Controller('text-generations')`). `GENERATE_ASSEMBLED` runs server-side prompt
 * assembly (DNA-styled + attachment-aware); `GENERATE` is the raw passthrough.
 */
export const TEXT_ENDPOINTS = {
  /** Generate text (raw passthrough; sync or streaming) */
  GENERATE: '/text-generations/generate',
  /** Generate text with server-side prompt assembly */
  GENERATE_ASSEMBLED: '/text-generations/generate/assembled',
  /** List configured LLM providers */
  PROVIDERS: '/text-generations/providers',
  /** Get a text-generation task's status */
  TASK: (id: string) => `/text-generations/tasks/${encodeURIComponent(id)}`,
  /** Cancel a running text-generation task */
  TASK_CANCEL: (id: string) => `/text-generations/tasks/${encodeURIComponent(id)}/cancel`,
  /** Stream a text-generation task's chunks via SSE */
  TASK_STREAM: (id: string) => `/text-generations/tasks/${encodeURIComponent(id)}/stream`,
} as const;

// =============================================================================
// Plugin Defaults
// =============================================================================

/**
 * Default noise filter configuration
 */
export const DEFAULT_NOISE_FILTER_CONFIG = {
  enabled: true,
  level: 'medium' as const,
};

/**
 * Default VAD configuration
 */
export const DEFAULT_VAD_CONFIG = {
  enabled: true,
  sensitivity: 0.5,
  minSpeechDuration: 250,
  minSilenceDuration: 500,
};

/**
 * Default STT configuration
 */
export const DEFAULT_STT_CONFIG = {
  enabled: true,
  provider: 'auto' as const,
  language: 'en',
};

/**
 * Default NER configuration
 *
 * Phase 0 (0.8) / SOTA gap review D7 — default to the medical
 * ('clinical') preset, matching `DEFAULT_MED_NER_OPTIONS` in `@arcaai/med-ner`.
 * 'default' remains a selectable preset for callers that explicitly want the
 * generic Xenova/bert-base-NER model; it is just no longer the implicit
 * fallback, since D7 would otherwise be defeated for SDK consumers relying on
 * this constant (see PluginManager.initializeNER / buildKnowledgePipelineConfig).
 */
export const DEFAULT_NER_CONFIG = {
  enabled: false,
  autoExtract: false,
  model: 'clinical' as const,
  threshold: 0.5,
  dtype: 'q8' as const,
};

/**
 * Voice profile endpoints.
 *
 * Matches `VoiceProfileController` at `@Controller('voice-profiles')`. Replaces
 * the previous `/users/:userId/voice-embedding` shape, which never had a
 * matching API controller. Enrollment uses multipart/form-data via
 * `apiClient.postFormData()`. Deletion is keyed by **profile id**, not user id.
 */
export const VOICE_EMBEDDING_ENDPOINTS = {
  enroll: '/voice-profiles/enroll',
  list: '/voice-profiles',
  /**
   * TASK-887 — which speaker-embedding model a new enrollment would use. Diarization is a
   * declared ASR-agent option, so a profile is only ever matched by an agent bound to the model
   * that embedded it; a client compares this against its profiles' `modelId` to know which are
   * still live and which need re-enrolling.
   */
  enrollmentTarget: (agentSlug?: string) =>
    agentSlug ? `/voice-profiles/enrollment-target?agentSlug=${encodeURIComponent(agentSlug)}` : '/voice-profiles/enrollment-target',
  delete: (profileId: string) => `/voice-profiles/${encodeURIComponent(profileId)}`,
  activate: (profileId: string) => `/voice-profiles/${encodeURIComponent(profileId)}/activate`,
  deactivate: (profileId: string) => `/voice-profiles/${encodeURIComponent(profileId)}/deactivate`,
} as const;

/**
 * Built-in user role identifiers.
 *
 * Canonical typed tuple of the SDK's recognised system role names. Consumers
 * use these for guards and switch statements on the user's effective roles.
 * Frozen at runtime so accidental mutation is rejected.
 */
export const USER_ROLES = Object.freeze(['role_admin', 'role_doctor', 'role_patient'] as const);

export type UserRole = (typeof USER_ROLES)[number];

/**
 * `metadata.subType` stamped on each per-utterance TRANSCRIPT context item the
 * audio hook writes during a live session.
 *
 * It marks the row as ONE UTTERANCE rather than the consultation's aggregate
 * transcript (which the STT service writes at finalize, marked
 * `STT_AGGREGATE`). The gateway's finalize idempotency guard keys on that
 * distinction: without it, the first per-segment row looks like the aggregate,
 * the aggregate write is skipped, `TranscriptionCreated` never fires, and
 * clinical note generation silently never starts.
 */
export const TRANSCRIPT_SEGMENT_SUBTYPE = 'TRANSCRIPT_SEGMENT';

/**
 * Workflow INVOCATION endpoints — running a tenant's published
 * workflows, and running one against a consultation.
 *
 * Two route FAMILIES, deliberately not one with a flag. `RUNS` is the unbound
 * plane (`create:WorkflowRun` + scope `workflow:run:write`); `CONSULTATION_RUNS`
 * is the clinical plane (`execute:ConsultationWorkflow` + scope
 * `workflows:execute`, outside the `workflow:` prefix so a key holding bare
 * `workflow` cannot inherit it). A run may write into a consultation only when
 * the consultation is named by the URL — never by the request body.
 *
 * Runs started on EITHER plane are read back through `RUN` / `RUN_STREAM` /
 * `RUN_CANCEL`: the gateway ships no consultation-scoped status route, and the
 * 202's `statusUrl`/`streamUrl` point here for that reason.
 */
export const WORKFLOW_ENDPOINTS = {
  /** The tenant's published, invokable workflows. */
  LIST: '/workflows',
  /** Start a run. `?mode=async|blocking|stream`; `Idempotency-Key` header joins an in-flight run. */
  RUNS: (slug: string) => `/workflows/${encodeURIComponent(slug)}/runs`,
  /** Live run status, stages and delivered result. */
  RUN: (slug: string, runId: string) => `/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`,
  /** Snapshot-then-delta SSE. Resume with `Last-Event-ID` (or `?lastEventId=` from a browser). */
  RUN_STREAM: (slug: string, runId: string) => `/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/stream`,
  /** Send the interpreter's allow-listed cancel signal. */
  RUN_CANCEL: (slug: string, runId: string) => `/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/cancel`,
  /** What may be run AGAINST this consultation — wider than `LIST` (adds the `consultation` palette). */
  CONSULTATION_LIST: (consultationId: string) => `/consultations/${encodeURIComponent(consultationId)}/workflows`,
  /** Run a published workflow against THIS consultation. The id is in the URL, never the body. */
  CONSULTATION_RUNS: (consultationId: string, slug: string) =>
    `/consultations/${encodeURIComponent(consultationId)}/workflows/${encodeURIComponent(slug)}/runs`,
  /**
   * TASK-890 — the published definition's generated contract: input/output schemas, trigger
   * kinds, output protocols, admitted delivery lanes, and an AsyncAPI fragment for its run
   * events. Scope `workflow:definition:read`, NOT a run scope: reading what a graph declares
   * is not implied by permission to start it.
   */
  SCHEMA: (slug: string) => `/workflows/${encodeURIComponent(slug)}/schema`,
  /**
   * TASK-890 — the live state of ONE `core.humanReview` node of a run. A graph may carry
   * several, so a review is addressed by `(runId, nodeId)` rather than by the run.
   */
  RUN_REVIEW: (slug: string, runId: string, nodeId: string) =>
    `/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/reviews/${encodeURIComponent(nodeId)}`,
  /** TASK-890 — release a Human-review node with a decision. `reviewerId` is never sent; the gateway stamps it. */
  RUN_REVIEW_DECIDE: (slug: string, runId: string, nodeId: string) =>
    `/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/reviews/${encodeURIComponent(nodeId)}/decide`,
} as const;

/**
 * The SSE ticket scope for a workflow run stream. Mirrors the gateway's
 * `@StreamScope({ namespace: 'workflow_run', param: 'runId' })` — a ticket is
 * minted for ONE run, so the scope carries the run id.
 */
export const workflowRunStreamScope = (runId: string): string => `workflow_run:${runId}`;

// =============================================================================
// Agent endpoints (TASK-865 — business plane, TASK-863 routes)
// =============================================================================

/**
 * Published-Agent discovery and invocation, business plane (API key or JWT).
 * Administration (`/admin/agents/**`) is NOT here — it is the admin plane.
 */
export const AGENT_ENDPOINTS = {
  /**
   * List published, active agents visible to the tenant, optionally filtered by task.
   *
   * Typed with the shared {@link AgentTask} union (a TYPE-only import, so this module stays
   * runtime-dependency-free) rather than a second copy of it — the copy is what went stale
   * when `NAMED_ENTITY_RECOGNITION` was added in TASK-931.
   */
  LIST: (task?: AgentTask) => (task ? `/agents?task=${encodeURIComponent(task)}` : '/agents'),
  /** One published agent: summary + input/output schema. */
  GET: (slug: string) => `/agents/${encodeURIComponent(slug)}`,
  /**
   * TASK-890 (OD-F) — invoke a `TEXT_GENERATION` agent. `?mode=blocking` answers JSON;
   * `?mode=stream` answers `text/event-stream` with the TEXT service's frames relayed verbatim.
   *
   * Scope `agent:invocation:write`, which is mintable on its own — so a browser integration
   * holding nothing but an API key can call this and nothing else.
   */
  INVOKE: (slug: string, mode: 'blocking' | 'stream' = 'blocking') => `/agents/${encodeURIComponent(slug)}/invocations?mode=${mode}`,
  /** TASK-890 — synthesize speech with a `TEXT_TO_SPEECH` agent; streamed audio, the existing speech-proxy contract. */
  SPEECH: (slug: string) => `/agents/${encodeURIComponent(slug)}/speech`,
  /** TASK-890 — submit a BATCH transcription to a `SPEECH_TO_TEXT` agent. Realtime capture stays `audio.start({ agentSlug })`. */
  TRANSCRIBE: (slug: string) => `/agents/${encodeURIComponent(slug)}/transcriptions`,
} as const;
