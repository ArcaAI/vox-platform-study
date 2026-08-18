/**
 * @arcaai/vox - Constants
 *
 * Default values and endpoint definitions.
 */

// =============================================================================
// Route classification
// =============================================================================

/**
 * Whether `path` targets the **admin plane**.
 *
 * Covers `/admin/*` (mirrors the API gateway's own admin-route detection,
 * `AuthorizationGuard`, `/^\/(api\/v\d+\/)?admin\//`).
 *
 * TASK-759 moved the two surfaces that used to sit OUTSIDE that prefix onto
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
 * Used to decide, during impersonation, whether a request must carry the
 * admin's own JWT (admin plane) or the impersonation JWT (user plane). The
 * leading slash and any query string are irrelevant to the match.
 */
export function isAdminPlanePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  return /^\/?(?:api\/v\d+\/)?(?:admin\/|monitoring\/|health\/services(?:[/?]|$))/.test(path);
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
  /** Close consultation */
  CLOSE: (id: string) => `/consultations/${encodeURIComponent(id)}/close`,
  /** Reopen consultation */
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
} as const;

/** SSE ticket scope for the live running-SOAP stream (must match the gateway's per-resource scope). */
export const liveSummaryScopeFor = (consultationId: string): string => `consultation_live_summary:${consultationId}`;

/** SSE ticket scope for the consultation-loop event stream (must match `@StreamScope({ namespace: 'consultation_loop' })`). */
export const loopEventsScopeFor = (consultationId: string): string => `consultation_loop:${consultationId}`;

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
  GET_PREFERENCES: '/user/me/preferences',
  UPDATE_PREFERENCES: '/user/me/preferences',
} as const;

/**
 * DNA Writing Style endpoints (SDK-207 WS-2)
 *
 * Matches DnaWritingStyleController and DnaWritingStyleAdminController.
 */
export const DNA_STYLE_ENDPOINTS = {
  GENERATE: '/dna-writing-styles/generate',
  GENERATE_FOR_DOCTOR: (doctorId: string) => `/admin/dna-writing-styles/generate/${encodeURIComponent(doctorId)}`,
  JOB_STATUS: (jobId: string) => `/dna-writing-styles/jobs/${encodeURIComponent(jobId)}`,
  JOB_STREAM: (jobId: string) => `/dna-writing-styles/jobs/${encodeURIComponent(jobId)}/stream`,
  MY_STYLE: '/dna-writing-styles/my-style',
  // Owner-scoped report history (the doctor's own reports). Reuses
  // the existing list service, filtered to the caller's doctorId + tenant.
  MINE: '/dna-writing-styles/mine',
  UPDATE: (reportId: string) => `/dna-writing-styles/${encodeURIComponent(reportId)}`,
  // Promote a historical report to the doctor's active/default
  // (`isLatest`) report. Owner + tenant scoped.
  SET_DEFAULT: (reportId: string) => `/dna-writing-styles/${encodeURIComponent(reportId)}/default`,
  // Erasure — the other half of the DNA opt-out. Opting out only stops FUTURE
  // learning; the already-learned profile stays stored and keeps being injected
  // into the doctor's summary prompts until it is erased. Owner-scoped: the
  // subject is always the caller.
  RESET_MY_STYLE: '/dna-writing-styles/my-style',
  DELETE_REPORT: (reportId: string) => `/dna-writing-styles/${encodeURIComponent(reportId)}`,
  VERSIONS: (reportId: string) => `/dna-writing-styles/${encodeURIComponent(reportId)}/versions`,
  ADMIN_LIST: '/admin/dna-writing-styles',
  ADMIN_JOB_STATUS: (jobId: string) => `/admin/dna-writing-styles/jobs/${encodeURIComponent(jobId)}`,
  ADMIN_JOB_STREAM: (jobId: string) => `/admin/dna-writing-styles/jobs/${encodeURIComponent(jobId)}/stream`,
  // Aggregate dashboard. `tenantId` is super-admin-only; the
  // backend ignores it for tenant admins (CLS tenant wins).
  ADMIN_DASHBOARD: (tenantId?: string) =>
    tenantId ? `/admin/dna-writing-styles/dashboard?tenantId=${encodeURIComponent(tenantId)}` : '/admin/dna-writing-styles/dashboard',
  BY_DOCTOR: (doctorId: string) => `/dna-writing-styles/doctor/${encodeURIComponent(doctorId)}`,
  // Admin cross-user (PHI-gated) reads. These hit the `/admin`
  // controller, which requires `manage:DnaWritingStyleReport` and tenant-scopes
  // the caller (even SUPER_ADMIN cannot cross tenants). Distinct from the
  // self-only `BY_DOCTOR`/`VERSIONS` end-user routes above.
  ADMIN_BY_DOCTOR: (doctorId: string) => `/admin/dna-writing-styles/doctor/${encodeURIComponent(doctorId)}`,
  ADMIN_VERSIONS: (reportId: string) => `/admin/dna-writing-styles/${encodeURIComponent(reportId)}/versions`,
} as const;

/**
 * Prompt Template endpoints (SDK-207 WS-2)
 *
 * Matches PromptManagementController at @Controller('admin/prompt-templates').
 * Lives under the audited `/admin` prefix — prompt-template management is an
 * admin capability.
 */
export const PROMPT_TEMPLATE_ENDPOINTS = {
  CREATE: '/admin/prompt-templates',
  LIST: '/admin/prompt-templates',
  /**
   * End-user (clinician) read-only template list. Matches
   * `PromptTemplateController` at `@Controller('prompt-templates')`
   * `GET /available`. This is the doctor-safe path (tenant + department
   * defaults + the caller's OWN personal templates) and requires only
   * `read:PromptTemplate` — NOT the admin `manage` plane above. Use this (not
   * `LIST`) for clinician-facing selectors so an impersonated/direct doctor is
   * never bounced to `/403`.
   */
  AVAILABLE: '/prompt-templates/available',
  GET: (id: string) => `/admin/prompt-templates/${encodeURIComponent(id)}`,
  UPDATE: (id: string) => `/admin/prompt-templates/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/prompt-templates/${encodeURIComponent(id)}`,
  VERSIONS: (id: string) => `/admin/prompt-templates/${encodeURIComponent(id)}/versions`,
  VERSION: (id: string, versionNumber: number) => `/admin/prompt-templates/${encodeURIComponent(id)}/versions/${versionNumber}`,
  // Server-side field-level version diff (replaces the
  // client-side GET-both-then-diff in `compareVersions`).
  DIFF: (id: string, from: number, to: number) => `/admin/prompt-templates/${encodeURIComponent(id)}/versions/${from}/diff/${to}`,
  ASSIGN_DEPARTMENT: '/admin/prompt-templates/assign-department',
  /** Get usage statistics for a prompt template */
  USAGE: (id: string) => `/admin/prompt-templates/${encodeURIComponent(id)}/usage`,
  /** Activate (rollback to) a specific version */
  ACTIVATE_VERSION: (id: string, versionNumber: number) => `/admin/prompt-templates/${encodeURIComponent(id)}/versions/${versionNumber}/activate`,
  /** Run a quality/score test against the text-generation service */
  TEST: (id: string) => `/admin/prompt-templates/${encodeURIComponent(id)}/test`,
  /** Usage analytics grouped by department / doctor / day */
  USAGE_ANALYTICS: '/admin/prompt-templates/analytics/usage',
  /** Paginated raw prompt run rows (PromptUsageRecord), newest first */
  USAGE_RECORDS: '/admin/prompt-templates/usage-records',
} as const;

/**
 * Department endpoints (SDK-207 WS-3)
 *
 * Matches DepartmentController at @Controller('admin/departments').
 */
export const DEPARTMENT_ENDPOINTS = {
  LIST: '/admin/departments',
  GET: (id: string) => `/admin/departments/${encodeURIComponent(id)}`,
  CREATE: '/admin/departments',
  UPDATE: (id: string) => `/admin/departments/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/departments/${encodeURIComponent(id)}`,
  ROOTS: '/admin/departments/roots',
  CHILDREN: (id: string) => `/admin/departments/${encodeURIComponent(id)}/children`,
  BY_CODE: (code: string) => `/admin/departments/code/${encodeURIComponent(code)}`,
  PROMPT_CONFIG: (id: string) => `/admin/departments/${encodeURIComponent(id)}/prompt-config`,
  // Reverse dept->users listing.
  USERS: (id: string) => `/admin/departments/${encodeURIComponent(id)}/users`,
} as const;

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
 * Monitoring endpoints (SDK-207 WS-4)
 *
 * Matches `MonitoringController` at `@Controller('admin/monitoring')`.
 * TASK-759 moved this controller off the business prefix (`/monitoring`) onto
 * the admin plane — it requires `manage:all | read:TenantTelemetry`, an
 * administrative capability, so rule P2 applies. Hard move, no alias: the
 * pre-move paths 404.
 */
export const MONITORING_ENDPOINTS = {
  UPTIME: '/admin/monitoring/uptime',
  SERVICE_UPTIME: (service: string) => `/admin/monitoring/uptime/${encodeURIComponent(service)}`,
  HEARTBEATS: (service: string) => `/admin/monitoring/heartbeats/${encodeURIComponent(service)}`,
  SESSIONS: '/admin/monitoring/sessions',
} as const;

/**
 * Platform runtime metrics endpoints.
 *
 * Matches `PlatformMetricsController` at `@Controller('admin/platform')`.
 * SUPER_ADMIN-only (class-level `@CanManage('PlatformMetrics')`, satisfied by
 * the global `manage:all` grant). Responses are Redis-cached (~12s TTL) and
 * emit no audit event.
 */
export const PLATFORM_METRICS_ENDPOINTS = {
  /** E1 — requests/min, error rate, P95, open sockets, per-service/-model, request-volume series. */
  METRICS: '/admin/platform/metrics',
  /** E2 — live open-socket count (multi-instance Redis aggregate). */
  SOCKETS: '/admin/platform/sockets',
  /**
   * E3 — consumption roll-up. Omit `tenantId` for a platform-wide (cross-tenant)
   * roll-up; pass it to scope to one tenant.
   */
  CONSUMPTION: (tenantId?: string) =>
    tenantId ? `/admin/platform/consumption?tenantId=${encodeURIComponent(tenantId)}` : '/admin/platform/consumption',
} as const;

/**
 * Tenant config endpoints (SDK-207 WS-4)
 *
 * Matches TenantController config routes.
 */
export const TENANT_ENDPOINTS = {
  LIST: '/admin/tenants',
  GET: (id: string) => `/admin/tenants/${encodeURIComponent(id)}`,
  GET_BY_CODE_NAME: (codeName: string) => `/admin/tenants/code-name/${encodeURIComponent(codeName)}`,
  CREATE: '/admin/tenants',
  UPDATE: (id: string) => `/admin/tenants/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/tenants/${encodeURIComponent(id)}`,
  GET_CONFIGS: (identifier: string) => `/admin/tenants/configs/${encodeURIComponent(identifier)}`,
  UPDATE_CONFIGS: (identifier: string) => `/admin/tenants/configs/${encodeURIComponent(identifier)}`,
  // Tenant usage roll-up (users/depts/storage/clinical) for the Tenant Detail tiles.
  USAGE: (id: string) => `/admin/tenants/${encodeURIComponent(id)}/usage`,
  // Lifecycle transitions (suspend/archive/restore).
  SUSPEND: (id: string) => `/admin/tenants/${encodeURIComponent(id)}/suspend`,
  ARCHIVE: (id: string) => `/admin/tenants/${encodeURIComponent(id)}/archive`,
  RESTORE: (id: string) => `/admin/tenants/${encodeURIComponent(id)}/restore`,
  // Tenant tags read/set.
  TAGS: (id: string) => `/admin/tenants/${encodeURIComponent(id)}/tags`,
} as const;

/**
 * Auth-based tenant endpoints (no admin prefix).
 *
 * These resolve the tenant from the JWT token on the server side,
 * so no tenantId path parameter is needed.
 */
export const MY_TENANT_ENDPOINTS = {
  INFO: '/tenant/me',
  CONFIG: '/tenant/me/config',
  /**
   * Discovery bundle for the caller tenant's PINNED `ConsultationContextSchema`
   * A deliberate sibling of `CONFIG` above, not an
   * addition to it — see `ConsultationSchemaClient.ts`.
   */
  CONTEXT_SCHEMA: '/tenant/me/context-schema',
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
 * platform-wide for now — backend-based transcription only. VAD and noise
 * suppression are UNAFFECTED and keep running in the browser as preprocessing
 * stages for the backend stream (they drive the level meter / speech-end
 * events); this flag gates only the STT stage's local/offline path.
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
 * Consolidated service health endpoint.
 *
 * The API gateway provides a single endpoint that fans out health checks to
 * all downstream Python microservices (TTS, SMR, NLP, STT) and returns
 * aggregated results with per-service status.
 *
 * TASK-759 moved it to `AdminHealthServicesController`
 * (`@Controller('admin/health/services')`): it is CASL-gated ops telemetry
 * (`manage:all | read:TenantTelemetry`), so it belongs on the admin plane, not
 * on the PUBLIC k8s-probe prefix. The unauthenticated probes in
 * `HEALTH_ENDPOINTS` above are unaffected. Hard move, no alias.
 */
export const SERVICE_HEALTH_ENDPOINTS = {
  SERVICES: '/admin/health/services',
} as const;

/**
 * Global settings endpoints
 */
export const GLOBAL_SETTINGS_ENDPOINTS = {
  LIST: '/admin/settings',
  GET: (id: string) => `/admin/settings/${encodeURIComponent(id)}`,
  CREATE: '/admin/settings',
  UPDATE: (id: string) => `/admin/settings/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/settings/${encodeURIComponent(id)}`,
  BY_TENANT: (tenantId: string) => `/admin/settings/tenant/${encodeURIComponent(tenantId)}`,
  TENANT_CONFIG: (tenantId: string) => `/admin/settings/tenant/${encodeURIComponent(tenantId)}/config`,
  // Super-admin-only, step-up-authenticated, audited secret reveal.
  REVEAL: (id: string) => `/admin/settings/${encodeURIComponent(id)}/reveal`,
} as const;

/**
 * Plan-entitlements endpoints.
 *
 * `ADMIN` paths are super-admin-only (`/admin/entitlements/*`, admin-plane per
 * `isAdminPlanePath`, so the admin JWT is used during impersonation); `ME` is
 * the tenant self-view on the user plane. `PLAN`/`TENANT_*` builders
 * `encodeURIComponent` their segments to match the other endpoint groups.
 */
export const ENTITLEMENTS_ENDPOINTS = {
  // Super-admin surface
  ENABLED: '/admin/entitlements/enabled',
  PLANS: '/admin/entitlements/plans',
  PLAN: (plan: string) => `/admin/entitlements/plans/${encodeURIComponent(plan)}`,
  TENANT_SNAPSHOT: (tenantId: string) => `/admin/entitlements/tenants/${encodeURIComponent(tenantId)}`,
  TENANT_OVERRIDE: (tenantId: string) => `/admin/entitlements/tenants/${encodeURIComponent(tenantId)}/override`,
  TENANT_DOWNGRADE: (tenantId: string) => `/admin/entitlements/tenants/${encodeURIComponent(tenantId)}/downgrade`,
  TRIAL_EXPIRY_RUN: '/admin/entitlements/trial-expiry/run',
  // Tenant self-view (user plane)
  ME: '/entitlements/me',
} as const;

/**
 * User settings endpoints.
 *
 * The API only exposes two real routes — `GET /user/me/settings` and
 * `PATCH /user/me/settings/:namespace/:key`. The previous shape (CRUD by id,
 * MY_SETTINGS by userId) targeted routes that do not exist.
 */
export const USER_SETTINGS_ENDPOINTS = {
  list: '/user/me/settings',
  updateByKey: (namespace: string, key: string) => `/user/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
} as const;

/**
 * Admin settings endpoints for ANOTHER user. Targets
 * `apps/api/.../user.controller.ts` (@Controller('admin/users')) at
 * `GET /admin/users/:id/settings` and `PATCH /admin/users/:id/settings/:namespace/:key`
 * (`assertUserInScope`). Distinct from the self-only
 * `USER_SETTINGS_ENDPOINTS` above — these let an admin view/edit a target
 * user's preferences (the typed "preferences" object is an FE aggregation over
 * the `arcaai-sdk` settings namespace).
 */
export const ADMIN_USER_SETTINGS_ENDPOINTS = {
  list: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/settings`,
  updateByKey: (userId: string, namespace: string, key: string) =>
    `/admin/users/${encodeURIComponent(userId)}/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
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
 * User management endpoints
 * API controller: @Controller('admin/users')
 */
export const USER_ENDPOINTS = {
  LIST: '/admin/users',
  SEARCH: '/admin/users',
  GET: (id: string) => `/admin/users/${encodeURIComponent(id)}`,
  GET_BY_EXTERNAL: (externalId: string) => `/admin/users/external/${encodeURIComponent(externalId)}`,
  CREATE: '/admin/users',
  UPDATE: (id: string) => `/admin/users/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/users/${encodeURIComponent(id)}`,
  BY_TENANT: (tenantId: string) => `/admin/users/tenant/${encodeURIComponent(tenantId)}`,
  ME: '/auth/me',
  // Admin reset-password (temporary password OR emailed link).
  RESET_PASSWORD: (id: string) => `/admin/users/${encodeURIComponent(id)}/reset-password`,
  // Public completion of a reset link (no auth; token-carried).
  PASSWORD_RESET_COMPLETE: '/users/password-reset/complete',
  // Public self-service forgot-password (no auth; always 202).
  FORGOT_PASSWORD: '/auth/forgot-password',
  // Super-admin-only time-boxed impersonation mint ("act as").
  IMPERSONATE: (id: string) => `/admin/users/${encodeURIComponent(id)}/impersonate`,
  // Server-side bulk user actions (enable/disable/delete/assign-departments).
  BULK_ACTIONS: '/admin/users/bulk-actions',
  // Server-side export (csv | xlsx | pdf).
  EXPORT: '/admin/users/export',
} as const;

/**
 * API Key management endpoints
 */
export const API_KEY_ENDPOINTS = {
  LIST: '/admin/api-keys',
  GET: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}`,
  CREATE: '/admin/api-keys',
  UPDATE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}`,
  REVOKE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}/revoke`,
  // Rotate: mint a new secret (returned once); old key
  // stays valid for a 24h grace window.
  ROTATE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}/rotate`,
  USAGE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}/usage`,
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

/**
 * Role management endpoints
 *
 * Note: the `USER_ROLES` / `USER_ROLE` builders below
 * target the canonical end-user self-service path (`/users/:id/roles`),
 * which the backend currently does NOT expose — the only end-user route
 * for "my roles" today is `GET /auth/me`. The forward-looking placeholder
 * is kept for SDK consumers that already integrate against this surface.
 *
 * For admin user-role assignment operations, use `ADMIN_USER_ROLES_ENDPOINTS`
 * (defined below), which targets the real `apps/api/.../user.controller.ts`
 * routes at `/admin/users/:id/roles[/:assignmentId]`.
 */
export const ROLE_ENDPOINTS = {
  LIST: '/admin/rbac/roles',
  GET: (id: string) => `/admin/rbac/roles/${encodeURIComponent(id)}`,
  CREATE: '/admin/rbac/roles',
  UPDATE: (id: string) => `/admin/rbac/roles/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/rbac/roles/${encodeURIComponent(id)}`,
  ASSIGN_POLICY: (roleId: string, policyId: string) => `/admin/rbac/roles/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`,
  REMOVE_POLICY: (roleId: string, policyId: string) => `/admin/rbac/roles/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`,
  /** End-user self-service roles surface. */
  USER_ROLES: (userId: string) => `/users/${encodeURIComponent(userId)}/roles`,
  /**
   * End-user self-service role assignment row. The second argument is
   * `assignmentId` (a join-table row id), NOT a roleId — the backend
   * deletes by assignment, not by role.
   */
  USER_ROLE: (userId: string, assignmentId: string) => `/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(assignmentId)}`,
  CHILDREN: (id: string) => `/admin/rbac/roles/${encodeURIComponent(id)}/children`,
  HIERARCHY: (id: string) => `/admin/rbac/roles/${encodeURIComponent(id)}/hierarchy`,
} as const;

/**
 * Admin user-role assignment endpoints.
 *
 * Distinct from `ROLE_ENDPOINTS.USER_ROLES`, which targets the end-user
 * self-service surface (`/users/:id/roles`, currently served only by
 * `/auth/me.roles`). These admin paths target `apps/api/.../user.controller.ts`
 * (`@Controller('admin/users')`).
 *
 * Backend reality (verified 2026-05-23):
 *   - POST   /admin/users/:id/roles                 → assign     (CreateUserRoleAssignmentRequest)
 *   - DELETE /admin/users/:id/roles/:assignmentId   → remove     (by assignmentId, NOT roleId)
 *   - There is currently no GET listing endpoint.
 */
export const ADMIN_USER_ROLES_ENDPOINTS = {
  LIST: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/roles`,
  ASSIGN: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/roles`,
  REMOVE: (userId: string, assignmentId: string) => `/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(assignmentId)}`,
} as const;

/**
 * Admin user ↔ department assignment endpoints.
 *
 * Targets `apps/api/.../controllers/user-departments.controller.ts` at
 * `/admin/users/:id/departments[/:assignmentId]`. Tenant-scoped via the active
 * tenant context (super admins pass `X-Tenant-Id`).
 */
export const ADMIN_USER_DEPARTMENTS_ENDPOINTS = {
  LIST: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/departments`,
  ASSIGN: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/departments`,
  UPDATE: (userId: string, assignmentId: string) => `/admin/users/${encodeURIComponent(userId)}/departments/${encodeURIComponent(assignmentId)}`,
  REMOVE: (userId: string, assignmentId: string) => `/admin/users/${encodeURIComponent(userId)}/departments/${encodeURIComponent(assignmentId)}`,
} as const;

/**
 * Admin user profile endpoints.
 *
 * Targets `apps/api/.../user.controller.ts` at `/admin/users/:id/profile`.
 * Exposes `preferredPromptTemplateId` through the GET/PATCH profile path.
 */
export const ADMIN_USER_PROFILE_ENDPOINTS = {
  GET: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/profile`,
  UPDATE: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/profile`,
} as const;

/**
 * Audit log endpoints (QA-003)
 */
export const AUDIT_LOG_ENDPOINTS = {
  LIST: '/admin/audit-logs',
  // Cursor (keyset) list; like EXPORT it is a STATIC segment declared
  // on the API BEFORE the `/:id` param route so `cursor` is not parsed as an id.
  CURSOR: '/admin/audit-logs/cursor',
  // Server-side CSV export; declared on the API BEFORE `/:id`.
  EXPORT: '/admin/audit-logs/export',
  GET: (id: string) => `/admin/audit-logs/${encodeURIComponent(id)}`,
  BY_RESOURCE: (resourceType: string, resourceId: string) =>
    `/admin/audit-logs/resource/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`,
  BY_USER: (userId: string) => `/admin/audit-logs/user/${encodeURIComponent(userId)}`,
} as const;

// =============================================================================
// Admin / storage / text endpoint bindings
//
// Paths omit the `/api/v1` prefix (the AgenticClient baseUrl carries it).
// Every path below is source-verified against its API controller (cited per
// group).
// =============================================================================

/**
 * Admin consultation endpoints.
 *
 * Tenant-wide consultation supervision — class-level `@CanManage('Consultation')`
 * (TENANT_ADMIN / SUPER_ADMIN). A plain DOCTOR is denied (403).
 * Controller: `apps/api/src/modules/consultation/admin-consultation.controller.ts`
 * (`@Controller('admin/consultations')`).
 */
export const ADMIN_CONSULTATION_ENDPOINTS = {
  /**
   * List ALL consultations in scope (paginated; page/limit + patientId/doctorId/departmentId filters).
   *
   * A SUPER_ADMIN with NO working tenant now gets a
   * cross-tenant list (previously HTTP 400). A tenant-admin is pinned to their tenant.
   */
  LIST: '/admin/consultations',
  /** Get a single consultation by ID (tenant-scoped) */
  GET: (id: string) => `/admin/consultations/${encodeURIComponent(id)}`,
  /**
   * Zero-filled new/revisit aggregation over a date range.
   * Requires `?from=&to=`; optional `&granularity=day|month`. Scope mirrors LIST
   * (super-admin cross-tenant when unscoped; tenant-admin pinned to their tenant).
   */
  AGGREGATE: (params: { from: string; to: string; granularity?: 'day' | 'month' }) => {
    const qs = new URLSearchParams({ from: params.from, to: params.to });
    if (params.granularity) qs.set('granularity', params.granularity);
    return `/admin/consultations/aggregate?${qs.toString()}`;
  },
} as const;

/**
 * Admin transcription-job endpoints.
 *
 * Tenant-wide transcription-job supervision — class-level `@CanManage('Tenant')`.
 * Distinct from the owner-scoped end-user `STT_ENDPOINTS.*` reads.
 * Controller: `apps/api/src/modules/streaming/admin-transcription-job.controller.ts`
 * (`@Controller('admin/audio/transcription-jobs')`).
 */
export const ADMIN_TRANSCRIPTION_JOB_ENDPOINTS = {
  /** List ALL transcription jobs in the tenant (paginated) */
  LIST: '/admin/audio/transcription-jobs',
  /** Tenant-wide job status counts */
  STATS: '/admin/audio/transcription-jobs/stats',
  /** Tenant-wide jobs filtered by status */
  BY_STATUS: (status: string) => `/admin/audio/transcription-jobs/status/${encodeURIComponent(status)}`,
} as const;

/**
 * Tenant storage bucket endpoints.
 *
 * Controller: `apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts`
 * (`@Controller('admin/tenants/storage/buckets')`, class-level `@CanManage('Tenant')`).
 * `DEFAULTS` is shared by GET (read defaults) and PUT (set defaults).
 */
export const TENANT_BUCKET_ENDPOINTS = {
  /** List all buckets for the current tenant */
  LIST: '/admin/tenants/storage/buckets',
  /** Default bucket per purpose — GET reads, PUT sets (same path) */
  DEFAULTS: '/admin/tenants/storage/buckets/defaults',
  /** Get a bucket by ID */
  GET: (id: string) => `/admin/tenants/storage/buckets/${encodeURIComponent(id)}`,
  /** Folder/file tree for a bucket (optional `?prefix=`) */
  TREE: (id: string) => `/admin/tenants/storage/buckets/${encodeURIComponent(id)}/tree`,
  /** Presigned download URL for a file in a bucket (required `?key=`) */
  PRESIGNED_URL: (id: string) => `/admin/tenants/storage/buckets/${encodeURIComponent(id)}/presigned-url`,
  /** Create a custom bucket */
  CREATE: '/admin/tenants/storage/buckets',
  /** Delete a custom bucket */
  DELETE: (id: string) => `/admin/tenants/storage/buckets/${encodeURIComponent(id)}`,
  /** List objects in a bucket (storage-provider op; optional `?prefix=`) */
  LIST_OBJECTS: (id: string) => `/admin/tenants/storage/buckets/${encodeURIComponent(id)}/objects`,
  /** Delete a single object in a bucket (storage-provider op; required `?key=`) */
  DELETE_OBJECT: (id: string) => `/admin/tenants/storage/buckets/${encodeURIComponent(id)}/objects`,
  /** Provision system buckets for a tenant */
  PROVISION: (tenantId: string) => `/admin/tenants/storage/buckets/provision/${encodeURIComponent(tenantId)}`,
} as const;

/**
 * Tenant storage access-key endpoints.
 *
 * Controller: `apps/api/src/modules/storage-access-key/storage-access-key.controller.ts`
 * (`@Controller('admin/tenants/storage/keys')`, class-level `@CanManage('Tenant')`).
 * The CREATE response includes the secret exactly once.
 */
export const STORAGE_KEY_ENDPOINTS = {
  /** List access keys (secrets NOT included) */
  LIST: '/admin/tenants/storage/keys',
  /** Generate a new access key (secret shown once; same path as LIST) */
  CREATE: '/admin/tenants/storage/keys',
  /** Revoke an access key */
  DELETE: (id: string) => `/admin/tenants/storage/keys/${encodeURIComponent(id)}`,
} as const;

/**
 * Tenant storage config endpoints.
 *
 * Controller: `apps/api/src/modules/tenant-storage-config/tenant-storage-config-admin.controller.ts`
 * (`@Controller('admin/tenants/storage/config')`, class-level `@CanManage('Tenant')`).
 * `UPSERT` is a PUT to the same path as `LIST`.
 */
export const TENANT_STORAGE_CONFIG_ENDPOINTS = {
  /** List storage configs (optional `?includeDisabled=true`) */
  LIST: '/admin/tenants/storage/config',
  /** Resolve the effective config for a bucket (optional `?bucketId=`) */
  EFFECTIVE: '/admin/tenants/storage/config/effective',
  /** Create or update a storage config (PUT, same path as LIST) */
  UPSERT: '/admin/tenants/storage/config',
  /** Delete a storage config */
  DELETE: (id: string) => `/admin/tenants/storage/config/${encodeURIComponent(id)}`,
} as const;

/**
 * Clinical Documentation Harness admin endpoints (read-only subset).
 *
 * Controller: `apps/api/src/modules/harness-admin/harness-admin.controller.ts`
 * (`@Controller('admin/harness')`). Policy/audit/eval/gate-queue are DB-backed
 * and always available; `WORKFLOWS` proxies the harness Temporal client and
 * returns 503 when the harness service (`:8866`) is down — callers must
 * degrade honestly.
 */
export const HARNESS_ADMIN_ENDPOINTS = {
  /** Effective harness policy for the caller tenant (tenant row → global default → code default) */
  POLICY: '/admin/harness/policy',
  /** WORM audit trail (newest-first) + chain-integrity verdict */
  AUDIT: '/admin/harness/audit',
  /** Eval runs (newest-first, paginated) */
  EVAL_RUNS: '/admin/harness/eval-runs',
  /** One eval run with per-case scores */
  EVAL_RUN: (id: string) => `/admin/harness/eval-runs/${encodeURIComponent(id)}`,
  /** Consultations awaiting clinician review + SLA/escalation state */
  GATE_QUEUE: '/admin/harness/gate-queue',
  /** Temporal document workflows (503 when the harness service is unavailable) */
  WORKFLOWS: '/admin/harness/workflows',
} as const;

/**
 * Tenant FRONTEND pipeline-config endpoints.
 *
 * Controller: `apps/api/src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts`
 * (`@Controller('admin/tenant-frontend-config')`, class-level `@CanManage('Tenant')`).
 * One row per tenant: `GET` reads (null when unset), `UPSERT` is a PUT to the
 * same path. A super admin may target a tenant via `?tenantId=`.
 */
export const TENANT_FRONTEND_CONFIG_ENDPOINTS = {
  /** Read the tenant frontend pipeline config (null when not yet configured) */
  GET: '/admin/tenant-frontend-config',
  /** Create or update the tenant frontend pipeline config (PUT, same path as GET) */
  UPSERT: '/admin/tenant-frontend-config',
} as const;

/**
 * Text-generation proxy endpoints.
 *
 * Controller: `apps/api/src/modules/streaming/text-proxy.controller.ts`
 * (`@Controller('text')`). `GENERATE_ASSEMBLED` runs server-side prompt
 * assembly (DNA-styled + attachment-aware); `GENERATE` is the raw passthrough.
 */
export const TEXT_ENDPOINTS = {
  /** Generate text (raw passthrough; sync or streaming) */
  GENERATE: '/text/generate',
  /** Generate text with server-side prompt assembly */
  GENERATE_ASSEMBLED: '/text/generate/assembled',
  /** List configured LLM providers */
  PROVIDERS: '/text/providers',
  /** Get a text-generation task's status */
  TASK: (id: string) => `/text/tasks/${encodeURIComponent(id)}`,
  /** Cancel a running text-generation task */
  TASK_CANCEL: (id: string) => `/text/tasks/${encodeURIComponent(id)}/cancel`,
  /** Stream a text-generation task's chunks via SSE */
  TASK_STREAM: (id: string) => `/text/tasks/${encodeURIComponent(id)}/stream`,
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
 * Matches `VoiceProfileController` at `@Controller('voice-profile')`. Replaces
 * the previous `/users/:userId/voice-embedding` shape, which never had a
 * matching API controller. Enrollment uses multipart/form-data via
 * `apiClient.postFormData()`. Deletion is keyed by **profile id**, not user id.
 */
export const VOICE_EMBEDDING_ENDPOINTS = {
  enroll: '/voice-profile/enroll',
  list: '/voice-profile',
  delete: (profileId: string) => `/voice-profile/${encodeURIComponent(profileId)}`,
  activate: (profileId: string) => `/voice-profile/${encodeURIComponent(profileId)}/activate`,
  deactivate: (profileId: string) => `/voice-profile/${encodeURIComponent(profileId)}/deactivate`,
} as const;

/**
 * Rate-limit admin endpoints.
 *
 * Matches `RateLimitAdminController` at `@Controller('admin/rate-limit')` —
 * super-admin only (`manage all`). Every mutation returns the fresh full
 * `RateLimitPolicy`.
 */
export const RATE_LIMIT_ADMIN_ENDPOINTS = {
  POLICY: '/admin/rate-limit',
  SET_ENABLED: '/admin/rate-limit/enabled',
  SET_TIER: (tier: string) => `/admin/rate-limit/tiers/${encodeURIComponent(tier)}`,
  SET_ROUTE: (routeId: string) => `/admin/rate-limit/routes/${encodeURIComponent(routeId)}`,
} as const;

/**
 * Queue admin endpoints.
 *
 * Matches `QueueAdminController` at `@Controller('admin/queues')` — super-admin
 * only (`manage all`). Deliberately NON-destructive: the SDK exposes no
 * clean/remove/pause builders, so the admin console cannot invoke them.
 */
export const QUEUE_ADMIN_ENDPOINTS = {
  LIST: '/admin/queues',
  REDIS_HEALTH: '/admin/queues/health/redis',
  GET: (queueName: string) => `/admin/queues/${encodeURIComponent(queueName)}`,
  JOBS: (queueName: string) => `/admin/queues/${encodeURIComponent(queueName)}/jobs`,
  JOB: (queueName: string, jobId: string) => `/admin/queues/${encodeURIComponent(queueName)}/jobs/${encodeURIComponent(jobId)}`,
  RETRY_JOB: (queueName: string, jobId: string) => `/admin/queues/${encodeURIComponent(queueName)}/jobs/${encodeURIComponent(jobId)}/retry`,
  BULK_JOBS: (queueName: string) => `/admin/queues/${encodeURIComponent(queueName)}/jobs/bulk`,
} as const;

/**
 * Prisma Studio endpoints.
 *
 * `STATUS` is always registered (`PrismaStudioStatusController`); `SHELL` is
 * the dev-only served HTML (`PrismaStudioController`) used for
 * the link-out — it 404s when Studio is disabled.
 */
export const PSTUDIO_ENDPOINTS = {
  STATUS: '/admin/pstudio/status',
  SHELL: '/admin/pstudio',
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
