/**
 * @arcaai/vox - Constants
 *
 * Default values and endpoint definitions.
 */

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
} as const;

/**
 * Context endpoints
 */
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
 * DNA_ENDPOINTS removed in TASK-210 Phase 6.
 * Was deprecated since SUM-06, replaced by DNA_STYLE_ENDPOINTS.
 */

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
  UPDATE: (reportId: string) => `/dna-writing-styles/${encodeURIComponent(reportId)}`,
  VERSIONS: (reportId: string) => `/dna-writing-styles/${encodeURIComponent(reportId)}/versions`,
  ADMIN_LIST: '/admin/dna-writing-styles',
  ADMIN_JOB_STATUS: (jobId: string) => `/admin/dna-writing-styles/jobs/${encodeURIComponent(jobId)}`,
  ADMIN_JOB_STREAM: (jobId: string) => `/admin/dna-writing-styles/jobs/${encodeURIComponent(jobId)}/stream`,
  BY_DOCTOR: (doctorId: string) => `/dna-writing-styles/doctor/${encodeURIComponent(doctorId)}`,
} as const;

/**
 * Prompt Template endpoints (SDK-207 WS-2)
 *
 * Matches PromptManagementController.
 */
export const PROMPT_TEMPLATE_ENDPOINTS = {
  CREATE: '/prompt-templates',
  LIST: '/prompt-templates',
  GET: (id: string) => `/prompt-templates/${encodeURIComponent(id)}`,
  UPDATE: (id: string) => `/prompt-templates/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/prompt-templates/${encodeURIComponent(id)}`,
  VERSIONS: (id: string) => `/prompt-templates/${encodeURIComponent(id)}/versions`,
  VERSION: (id: string, versionNumber: number) => `/prompt-templates/${encodeURIComponent(id)}/versions/${versionNumber}`,
  ASSIGN_DEPARTMENT: '/prompt-templates/assign-department',
  /** Get usage statistics for a prompt template (TASK-218) */
  USAGE: (id: string) => `/prompt-templates/${encodeURIComponent(id)}/usage`,
  /** Activate (rollback to) a specific version */
  ACTIVATE_VERSION: (id: string, versionNumber: number) => `/prompt-templates/${encodeURIComponent(id)}/versions/${versionNumber}/activate`,
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
 * Matches MonitoringController.
 */
export const MONITORING_ENDPOINTS = {
  UPTIME: '/monitoring/uptime',
  SERVICE_UPTIME: (service: string) => `/monitoring/uptime/${encodeURIComponent(service)}`,
  HEARTBEATS: (service: string) => `/monitoring/heartbeats/${encodeURIComponent(service)}`,
  SESSIONS: '/monitoring/sessions',
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
} as const;

// =============================================================================
// STT-V2 Endpoints (ASR-R-01)
// =============================================================================

/**
 * STT-V2 endpoints
 *
 * Complete endpoint set for the stt-v2 module:
 * - Streaming session management (create session + WebSocket)
 * - Transcription job lifecycle (create, list, status, cancel, retry)
 * - File upload transcription with SSE
 *
 * REST endpoints are relative to the API base URL.
 * WebSocket path (WS_STREAM) is absolute from host root.
 */
export const STT_V2_ENDPOINTS = {
  /** Create a streaming session — returns sessionId + wsUrl */
  CREATE_SESSION: '/audio/transcription-jobs/stream/session',
  /** Close/delete a streaming session */
  CLOSE_SESSION: (sessionId: string) => `/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}`,
  /** WebSocket path for real-time audio streaming (absolute, not API-prefixed) */
  WS_STREAM: '/ws/stt-v2/stream',
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
} as const;

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
  /** Create a new ASR pipeline (TASK-218) */
  CREATE: '/admin/audio/pipelines',
  /** Update an ASR pipeline (TASK-218) */
  UPDATE: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}`,
  /** Delete an ASR pipeline (soft-delete) (TASK-218) */
  DELETE: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}`,
  /** Validate pipeline YAML configuration */
  VALIDATE: '/admin/audio/pipelines/validate',
  /** Assign a pipeline to a tenant */
  ASSIGN_TENANT: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/assign-tenant`,
  /** Assign a pipeline to a user */
  ASSIGN_USER: (pipelineId: string) => `/admin/audio/pipelines/${encodeURIComponent(pipelineId)}/assign-user`,
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
 * Local storage keys
 */
export const STORAGE_KEYS = {
  PREFERENCES: 'arcaai-preferences',
  SELECTED_MODELS: 'arcaai-selected-models',
  SESSION_STATE: 'arcaai-session-state',
} as const;

// =============================================================================
// TASK-032 WS-A: Additional Endpoint Constants
// =============================================================================

/**
 * Auth endpoints (TASK-032 WS-A)
 *
 * TASK-274 fu-sse-constants: `STREAM_TICKET` is the single source of truth
 * for the SSE ticket-mint endpoint consumed by `core/SSEClient.ts`. The path
 * is owned by the API at `POST /auth/stream-ticket` (TASK-263 D1).
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
 * The API gateway provides a single /health/services endpoint that fans out
 * health checks to all downstream Python microservices (TTS, SMR, NLP, STT)
 * and returns aggregated results with per-service status.
 */
export const SERVICE_HEALTH_ENDPOINTS = {
  SERVICES: '/health/services',
} as const;

/**
 * Global settings endpoints (TASK-032 WS-A)
 */
export const GLOBAL_SETTINGS_ENDPOINTS = {
  LIST: '/admin/settings',
  GET: (id: string) => `/admin/settings/${encodeURIComponent(id)}`,
  CREATE: '/admin/settings',
  UPDATE: (id: string) => `/admin/settings/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/settings/${encodeURIComponent(id)}`,
  BY_TENANT: (tenantId: string) => `/admin/settings/tenant/${encodeURIComponent(tenantId)}`,
  TENANT_CONFIG: (tenantId: string) => `/admin/settings/tenant/${encodeURIComponent(tenantId)}/config`,
} as const;

/**
 * User settings endpoints (TASK-265 W0-8 reduction)
 *
 * The API only exposes two real routes — `GET /user/me/settings` and
 * `PATCH /user/me/settings/:namespace/:key`. The previous shape (CRUD by id,
 * MY_SETTINGS by userId) targeted routes that do not exist; see
 * docs/implementation/TASK-265-SDK-Endpoint-Drift/README.md.
 */
export const USER_SETTINGS_ENDPOINTS = {
  list: '/user/me/settings',
  updateByKey: (namespace: string, key: string) => `/user/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
} as const;

/**
 * Consultation job endpoints (TASK-032 WS-A)
 */
export const CONSULTATION_JOB_ENDPOINTS = {
  GET: (jobId: string) => `/consultations/jobs/${encodeURIComponent(jobId)}`,
  CANCEL: (jobId: string) => `/consultations/jobs/${encodeURIComponent(jobId)}/cancel`,
  SSE: (jobId: string) => `/consultations/jobs/${encodeURIComponent(jobId)}/stream`,
} as const;

/**
 * User management endpoints (TASK-032 WS-G)
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
} as const;

/**
 * API Key management endpoints (TASK-032 WS-G)
 */
export const API_KEY_ENDPOINTS = {
  LIST: '/admin/api-keys',
  GET: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}`,
  CREATE: '/admin/api-keys',
  UPDATE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}`,
  DELETE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}`,
  REVOKE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}/revoke`,
  USAGE: (id: string) => `/admin/api-keys/${encodeURIComponent(id)}/usage`,
} as const;

/**
 * Storage management endpoints (TASK-032 WS-G)
 */
export const STORAGE_ENDPOINTS = {
  LIST_BUCKETS: '/storage/buckets',
  GET_BUCKET: (name: string) => `/storage/buckets/${encodeURIComponent(name)}`,
  /** Create a new bucket (TASK-218) */
  CREATE_BUCKET: '/storage/buckets',
  /** Delete a bucket (TASK-218) */
  DELETE_BUCKET: (name: string) => `/storage/buckets/${encodeURIComponent(name)}`,
  LIST_FILES: (bucketName: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files`,
  UPLOAD_FILE: (bucketName: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files`,
  GET_FILE: (bucketName: string, key: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files/${encodeURIComponent(key)}`,
  DELETE_FILE: (bucketName: string, key: string) => `/storage/buckets/${encodeURIComponent(bucketName)}/files/${encodeURIComponent(key)}`,
  HEALTH: '/storage/health',
} as const;

/**
 * Policy management endpoints (TASK-218)
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
 * Role management endpoints (TASK-032 WS-G)
 *
 * Note (TASK-279 / R-05): the `USER_ROLES` / `USER_ROLE` builders below
 * target the canonical end-user self-service path (`/users/:id/roles`),
 * which the backend currently does NOT expose — the only end-user route
 * for "my roles" today is `GET /auth/me`. The forward-looking placeholder
 * is kept for SDK consumers that already integrate against this surface;
 * see TASK-282 follow-up for the missing backend route.
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
  /** End-user self-service roles surface — see TASK-279 / TASK-282. */
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
 * Admin user-role assignment endpoints (TASK-279 / R-05).
 *
 * Distinct from `ROLE_ENDPOINTS.USER_ROLES`, which targets the end-user
 * self-service surface (`/users/:id/roles`, currently served only by
 * `/auth/me.roles`). These admin paths target `apps/api/.../user.controller.ts`
 * (`@Controller('admin/users')`).
 *
 * Backend reality (verified 2026-05-23):
 *   - POST   /admin/users/:id/roles                 → assign     (CreateUserRoleAssignmentRequest)
 *   - DELETE /admin/users/:id/roles/:assignmentId   → remove     (by assignmentId, NOT roleId)
 *   - There is currently no GET listing endpoint   → see TASK-282 follow-up.
 */
export const ADMIN_USER_ROLES_ENDPOINTS = {
  LIST: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/roles`,
  ASSIGN: (userId: string) => `/admin/users/${encodeURIComponent(userId)}/roles`,
  REMOVE: (userId: string, assignmentId: string) => `/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(assignmentId)}`,
} as const;

/**
 * Audit log endpoints (QA-003)
 */
export const AUDIT_LOG_ENDPOINTS = {
  LIST: '/admin/audit-logs',
  GET: (id: string) => `/admin/audit-logs/${encodeURIComponent(id)}`,
  BY_RESOURCE: (resourceType: string, resourceId: string) =>
    `/admin/audit-logs/resource/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`,
  BY_USER: (userId: string) => `/admin/audit-logs/user/${encodeURIComponent(userId)}`,
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
 */
export const DEFAULT_NER_CONFIG = {
  enabled: false,
  autoExtract: false,
  model: 'default' as const,
  threshold: 0.5,
  dtype: 'q8' as const,
};

/**
 * Voice profile endpoints (TASK-265 W0-7 / GAP-02 — D2 Option B)
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
} as const;

/**
 * Built-in user role identifiers (TASK-265 W0-10).
 *
 * Canonical typed tuple of the SDK's recognised system role names. Consumers
 * use these for guards and switch statements on the user's effective roles.
 * Frozen at runtime so accidental mutation is rejected.
 */
export const USER_ROLES = Object.freeze(['role_admin', 'role_doctor', 'role_patient'] as const);

export type UserRole = (typeof USER_ROLES)[number];
