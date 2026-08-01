/**
 * @arcaai/vox/core
 *
 * Core SDK exports WITHOUT plugin dependencies.
 * This entry point provides a lightweight bundle (~200KB) for consumers
 * who don't need audio processing features (STT, VAD, noise filter).
 *
 * Use this when:
 * - Building admin/dashboard apps that only need API access
 * - Server-side rendering where audio plugins aren't needed
 * - Reducing initial bundle size with lazy-loaded plugins
 *
 * @example
 * ```tsx
 * // Import only core functionality
 * import { AgenticProvider, useArca } from '@arcaai/vox/core';
 *
 * // For full SDK with plugins:
 * import { AgenticProvider, useArca, useVAD } from '@arcaai/vox';
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Provider
// =============================================================================

export { AgenticProvider, useAgenticContext, useSDKLogger } from './providers';
export type { AgenticProviderProps } from './providers';

// =============================================================================
// Hooks
// =============================================================================

export {
  useAdminConsultations,
  useAdminTranscriptionJobs,
  useApiKeys,
  useArca,
  // Surface the focused domain hooks (siblings of
  // useArcaSession/useArcaSummary) so consumers can use them without the useArca() aggregate.
  useArcaLiveSummary,
  useArcaAudio,
  useArcaConfig,
  useArcaContext,
  useArcaSession,
  // Surface the dedicated summary hook from the core entry.
  useArcaSummary,
  useAudioRecordings,
  useAuditLog,
  useAuth,
  useConsultationChain,
  useConsultationJob,
  useDepartments,
  useDnaDashboard,
  useDnaStyle,
  useEntitlements,
  useGlobalSettings,
  // Read-only Clinical Documentation Harness admin surface
  useHarnessAdmin,
  useHealthCheck,
  useArcaSttLanguageModes,
  // Native 2-way STT provider toggle (pipeline ↔ default)
  useSttProviderToggle,
  useMonitoring,
  usePipelines,
  usePlatformMetrics,
  usePolicies,
  // Global-admin ops-surface hooks
  usePrismaStudio,
  usePrompts,
  useQueueAdmin,
  useRateLimits,
  useRoles,
  useStorage,
  useStorageKeys,
  useTenantBuckets,
  useTenantFrontendConfig,
  useTenants,
  useTenantStorageConfig,
  useUserDepartments,
  useUsers,
  useUserSettings,
  useVoiceEmbedding,
} from './hooks';

export type {
  AdminConsultation,
  AdminConsultationListParams,
  AdminTranscriptionJob,
  AdminTranscriptionJobStats,
  ApiKey,
  ApiKeyUsage,
  ApiKeyWithRawKey,
  AuditLogCursorParams,
  AuditLogEntry,
  AuditLogFilterParams,
  AuditLogResponsibleUser,
  BreakGlassCredentials,
  Bucket,
  CreateApiKeyInput,
  CreatePolicyInput,
  CreateStorageKeyInput,
  CreateTenantBucketInput,
  CreateTenantInput,
  CreateUserInput,
  DeleteTenantBucketObjectResult,
  ListTenantStorageConfigParams,
  Pipeline,
  PipelineVersion,
  Policy,
  Role,
  SetTenantBucketDefaultsInput,
  StorageFile,
  StorageFileWithUrl,
  StorageKey,
  StorageKeyWithSecret,
  Tenant,
  TenantBucket,
  TenantBucketDefaults,
  TenantBucketObject,
  TenantBucketTree,
  TenantStorageConfig,
  TenantUsageStats,
  UpdateApiKeyInput,
  UpdatePolicyInput,
  UpdateTenantInput,
  UpdateUserInput,
  UpsertTenantStorageConfigInput,
  UseAdminConsultationsReturn,
  UseAdminTranscriptionJobsReturn,
  UseApiKeysReturn,
  UseArcaAudio,
  UseArcaConfigReturn,
  UseArcaContext,
  UseArcaReturn,
  UseArcaSession,
  UseArcaSessionReturn,
  UseArcaSummary,
  UseAudioRecordingsReturn,
  UseAuditLogReturn,
  UseAuthReturn,
  UseConsultationChainReturn,
  UseConsultationJobReturn,
  UseDepartmentsReturn,
  UseDnaDashboardReturn,
  UseDnaStyleReturn,
  // Plan-entitlements hook + response/request types
  UseEntitlementsReturn,
  EntitlementPlan,
  TrialInfo,
  CapabilityUsageRow,
  ResolvedFeatures,
  EntitlementCapabilities,
  PlanEntitlement,
  UpdatePlanEntitlementInput,
  TenantEntitlementOverride,
  UpsertTenantOverrideInput,
  DowngradeDisabledGroup,
  DowngradeReport,
  TrialExpiryReport,
  UseGlobalSettingsReturn,
  // Harness admin hook + read-model types
  UseHarnessAdminReturn,
  HarnessPolicy,
  HarnessPolicySource,
  HarnessAuditEvent,
  HarnessAuditList,
  HarnessEvalRun,
  HarnessEvalRunList,
  HarnessEvalRunDetail,
  HarnessGateQueue,
  HarnessGateQueueItem,
  HarnessWorkflow,
  HarnessWorkflowList,
  UseHealthCheckReturn,
  UseArcaSttLanguageModesReturn,
  UseSttProviderToggleReturn,
  UseMonitoringReturn,
  UsePipelinesReturn,
  UsePlatformMetricsReturn,
  UsePoliciesReturn,
  // Global-admin ops-surface hook returns
  UsePrismaStudioReturn,
  UsePromptsReturn,
  // Raw prompt run rows (Agent Jobs surface)
  PromptUsageRecord,
  PaginatedPromptUsageRecords,
  UseQueueAdminReturn,
  UseRateLimitsReturn,
  User,
  UseRolesReturn,
  UserRoleAssignment,
  UseStorageKeysReturn,
  UseStorageReturn,
  UseTenantBucketsReturn,
  UseTenantFrontendConfigReturn,
  UseTenantsReturn,
  UseTenantStorageConfigReturn,
  UseUserDepartmentsReturn,
  UserDepartmentAssignment,
  // Full list query forwarded by useUsers().listPaginated.
  UserListQuery,
  AssignUserDepartmentInput,
  UseUserSettingsReturn,
  UseUsersReturn,
  UseVoiceEmbeddingReturn,
  VoiceProfile,
  EnrollFiles,
  UserRole,
} from './hooks';

// Typed built-in role identifiers
export { USER_ROLES } from './hooks';

// =============================================================================
// Types - Configuration
// =============================================================================

export type {
  AgenticConfig,
  ApiConfig,
  AudioPluginConfig,
  // Logging configuration types
  LoggingConfig,
  LoggingConsoleConfig,
  LoggingHighlightConfig,
  LoggingLokiConfig,
  LoggingOTelConfig,
  ModelDefinition,
  ModelRegistryConfig,
  NERPluginConfig,
  NoiseFilterPluginConfig,
  PersonalizationConfig,
  PluginConfig,
  STTPluginConfig,
  // Tenant configuration types
  TenantAudioConfig,
  TenantFeatureFlags,
  TTSPluginConfig,
  UserPreferences,
  VADPluginConfig,
} from './types';

// =============================================================================
// Types - Consultation
// =============================================================================

export type {
  Consultation,
  ConsultationStatus,
  CreateConsultationInput,
  OpenSessionInput,
  SessionActions,
  SessionState,
  StartRevisitInput,
  TimelineEntry,
  TimelineScope,
  UpdateConsultationInput,
} from './types';

export { CONSULTATION_STATUS_ORDER, isNewVisit, isRevisit, normalizeConsultationStatus } from './types';

export type { LiveSummarySnapshot, LiveSummarySection, LiveSummaryEntity, LiveSummaryStats, LiveSummaryVitals } from './types';

// =============================================================================
// Types - Context
// =============================================================================

export type {
  AddContextInput,
  CaseNoteInput,
  ContextActions,
  ContextFilters,
  ContextItem,
  ContextItemType,
  ContextSource,
  ContextState,
  ContextVersionEntry,
  MedicalCodes,
  MedicalEntity,
  MedicalEntityType,
  NERData,
} from './types';

// Audio recording types (dual-capture X8)
export type { AudioRecording, AddAudioRecordingInput } from './types';

// =============================================================================
// Types - Audio
// =============================================================================

export type {
  AudioActions,
  AudioOptions,
  AudioPluginStates,
  AudioState,
  PluginState,
  STTPluginState,
  TranscriptionResult,
  TranscriptionSegment,
  // WS-B store segment + word-level timestamps it now carries
  TranscriptSegment,
  TranscriptWord,
  VADEvent,
  VADEventType,
} from './types';

// =============================================================================
// Types - Summary
// =============================================================================

export type {
  AsyncJobResponse,
  // Widened comprehensive summary options.
  ComprehensiveSummaryGenerationOptions,
  ComprehensiveSummaryOptions,
  ComprehensiveSummaryResponse,
  // Summary tagging input.
  CreateSummaryTagInput,
  DNAStyle,
  DNAStyleData,
  NEREntity,
  PreSummaryOptions,
  SummaryActions,
  SummaryApprovalResponse,
  // Story 148: Summary approval
  SummaryApprovalStatus,
  // Canonical summary-generation options.
  SummaryGenerationOptions,
  SummaryJobStatus,
  SummaryMeta,
  SummaryOptions,
  SummaryResponse,
  SummaryState,
  // Summary tag.
  SummaryTag,
  SummaryVersionEntry,
  // WS-3: Summary versioning
  UpdateSummaryOptions,
  // Version diff result.
  VersionDiff,
} from './types';

// =============================================================================
// Types - Provenance / Citations
// =============================================================================

export type {
  CitationClaim,
  CitationsMap,
  ClaimEvidence,
  ClaimStatus,
  ClinicalReviewData,
  HighlightSegment,
  SensorScores,
  SoapSection,
  SoapSectionGroup,
  TranscriptSource,
} from './types';

// =============================================================================
// Types - DNA Writing Style (SDK-207 WS-4)
// =============================================================================

export type {
  DnaGenerateInput,
  DnaJobResult,
  DnaJobStatus,
  DnaReport,
  DnaReportData,
  DnaReportWithFallback,
  DnaStyleVersion,
  DnaUpdateInput,
} from './types';

// DNA aggregate dashboard types
export type { DnaDashboard, DnaDashboardDailyCount, DnaDashboardRecentActivity, DnaDashboardUsageEntry } from './types';

// =============================================================================
// Types - Prompt Template (SDK-207 WS-4)
// =============================================================================

export type {
  AssignDepartmentPromptInput,
  CreatePromptInput,
  DepartmentPromptField,
  PromptListFilters,
  PromptTemplate,
  PromptTemplateCategory,
  PromptTemplateStatus,
  PromptTestMetrics,
  PromptTestResult,
  PromptVariable,
  PromptVersion,
  UpdatePromptInput,
} from './types';

// =============================================================================
// Types - Diff (SDK-207 WS-4)
// =============================================================================

export type { DiffChange, DiffMode, DiffResult, DiffStats, PromptVersionDiff, PromptVersionDiffField } from './types';

// =============================================================================
// Types - STT Streaming
// =============================================================================

export type {
  AiModelResponse,
  AsrPipelineResponse,
  CreateStreamingSessionRequest,
  LanguageMode,
  LanguageModeCatalog,
  StreamingSessionResponse,
  StreamingSessionStatus,
  TranscriptionJobResponse,
  TranscriptionJobStatusCounts,
  WsAudioFrame,
  WsClientMessage,
  WsCloseMessage,
  WsErrorMessage,
  WsServerMessage,
  WsStatusMessage,
  WsStopMessage,
  WsTranscriptResult,
  WsWordTimestamp,
} from './types';

export { AiModelDownloadStatus, ResourceStatus, TranscriptionJobStatus, TranscriptionJobType } from './types';

// =============================================================================
// Types - Common
// =============================================================================

export type {
  AgenticErrorCode,
  AgenticEventHandler,
  AgenticEventType,
  AllowedPageSize,
  AsyncStatus,
  HookStatus,
  PaginatedResponse,
  PaginationParams,
} from './types';

export { AgenticError, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from './types';

export type { AuthUser, ImpersonateResponse, AdminImpersonateOptions, LoginResponse } from './types/auth';

// Monitoring + platform runtime metrics types
export type { HeartbeatRecord, ServiceSessionCount, ServiceUptime, SessionCounts } from './types';
export type {
  ConsumptionConsultations,
  ConsumptionRollup,
  OpenSockets,
  PlatformMetrics,
  PlatformModelMetric,
  PlatformModelsSummary,
  PlatformServiceMetric,
  RequestVolumePoint,
} from './types';

// Settings + OCC error — exported here so
// admin-UI consumers can `instanceof ConfigConflictError` without
// pulling in audio/STT plugin code.
export type {
  CreateGlobalSettingInput,
  CreateUserSettingInput,
  GlobalSetting,
  UpdateGlobalSettingInput,
  UpdateUserSettingInput,
  UserSetting,
} from './types';
export { ConfigConflictError } from './types';

// Frontend pipeline config types (incl. CaptureMode/TranscriptionMode)
export type { CaptureMode, FrontendPipelineConfigJson, TenantFrontendConfig, TranscriptionMode, UpsertTenantFrontendConfigInput } from './types';

// =============================================================================
// Types - Global-admin ops surfaces
// =============================================================================

export type {
  BulkJobActionResult,
  JobDetail,
  JobOptions,
  JobStatusFilter,
  JobSummary,
  ListJobsParams,
  PaginatedJobs,
  PrismaStudioStatus,
  QueueJobCounts,
  QueueStats,
  RateLimitPolicy,
  RateLimitRoutePolicy,
  RateLimitTierName,
  RateLimitTierPolicy,
  RateLimitValueSource,
  RedisHealth,
  SetRateLimitRouteInput,
  SetRateLimitTierInput,
} from './types';

// =============================================================================
// Constants - Endpoint Definitions
// =============================================================================

export {
  ADMIN_CONSULTATION_ENDPOINTS,
  ADMIN_TRANSCRIPTION_JOB_ENDPOINTS,
  ADMIN_USER_DEPARTMENTS_ENDPOINTS,
  ADMIN_USER_PROFILE_ENDPOINTS,
  ADMIN_USER_ROLES_ENDPOINTS,
  API_KEY_ENDPOINTS,
  AUDIO_RECORDING_ENDPOINTS,
  AUDIT_LOG_ENDPOINTS,
  AUTH_ENDPOINTS,
  CONSULTATION_ENDPOINTS,
  CONSULTATION_JOB_ENDPOINTS,
  CONTEXT_ENDPOINTS,
  DEPARTMENT_ENDPOINTS,
  DNA_STYLE_ENDPOINTS,
  ENTITY_ENDPOINTS,
  GLOBAL_SETTINGS_ENDPOINTS,
  HEALTH_ENDPOINTS,
  MONITORING_ENDPOINTS,
  MY_TENANT_ENDPOINTS,
  NLP_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  PIPELINE_ENDPOINTS,
  PLATFORM_METRICS_ENDPOINTS,
  POLICY_ENDPOINTS,
  PROMPT_TEMPLATE_ENDPOINTS,
  // Global-admin ops-surface endpoints
  PSTUDIO_ENDPOINTS,
  QUEUE_ADMIN_ENDPOINTS,
  RATE_LIMIT_ADMIN_ENDPOINTS,
  ROLE_ENDPOINTS,
  SERVICE_HEALTH_ENDPOINTS,
  SMR_ENDPOINTS,
  STORAGE_ENDPOINTS,
  STORAGE_KEY_ENDPOINTS,
  STT_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  TENANT_BUCKET_ENDPOINTS,
  TENANT_ENDPOINTS,
  TENANT_FRONTEND_CONFIG_ENDPOINTS,
  TENANT_STORAGE_CONFIG_ENDPOINTS,
  USER_ENDPOINTS,
  USER_SETTINGS_ENDPOINTS,
  VOICE_EMBEDDING_ENDPOINTS,
} from './core/constants';

// =============================================================================
// Types - Models
// =============================================================================

export type {
  AvailableSttModel,
  ModelLoadingStates,
  ModelLoadOptions,
  ModelLoadProgress,
  ModelLoadStatus,
  ModelRegistryActions,
  ModelRegistryState,
  SelectedModels,
  SttTask,
} from './types';

export { DEFAULT_AVAILABLE_STT_MODELS, DEFAULT_MODELS, DEFAULT_STT_MODELS, DEFAULT_VAD_MODELS } from './types';

// =============================================================================
// Utilities
// =============================================================================

export {
  // SMR error → AgenticErrorCode classification helpers.
  classifyHttpError,
  classifySmrError,
  // SDK-207 WS-4: Diff utilities
  computeDiff,
  computePromptDiff,
  computeSummaryDiff,
  createUnifiedPatch,
  // Cursor (keyset) response normalizer (offset sibling: extractPaginated).
  extractCursorPaginated,
  extractPromptVariables,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  // Idempotency-Key helpers.
  generateIdempotencyKey,
  getErrorCode,
  getErrorMessage,
  getToday,
  isAgenticError,
  isAuthError,
  isNetworkError,
  isRetriableError,
  isSameDay,
  parseDate,
  // Stories 117-118: Prompt variable substitution
  substitutePromptVariables,
  validatePromptVariables,
  withIdempotencyKey,
  wrapError,
  // Provenance/citations helpers for the review UI.
  SOAP_SECTIONS,
  SOAP_SECTION_LABELS,
  isNeedsAttention,
  sortClaimsByAttention,
  selectClaimsNeedingAttention,
  groupClaimsBySection,
  buildTranscriptHighlights,
  confidencePercent,
} from './utils';

// Cursor page result type (PageResult<T>-shaped),
// returned by `extractCursorPaginated`.
export type { CursorPageResult } from './utils';

// =============================================================================
// Core Classes (Advanced Usage)
// =============================================================================

export { AgenticClient } from './core/AgenticClient';
export { ConfigManager, type ConfigManagerOptions } from './core/ConfigManager';
export type { AppConfig, DeepPartial } from './core/ConfigSchema';
export { ModelRegistry, type ModelLoadProgressCallback } from './core/ModelRegistry';
export { PersonalizationManager, type PreferencesChangeCallback } from './core/PersonalizationManager';

// =============================================================================
// LOCAL Voice Embedding
// =============================================================================
//
// In-browser speaker-embedding provider (Transformers.js WavLM `*-sv`) that
// sits ALONGSIDE the backend `useVoiceEmbedding`. Persists via the existing
// `/voice-profile/enroll` path; caches the local embedding tenant/user-scoped;
// "quick test" = cosine similarity vs the enrolled embedding(s).

export { useLocalVoiceEmbedding } from './hooks';
export type { UseLocalVoiceEmbeddingReturn, UseLocalVoiceEmbeddingOptions, LocalVoiceEmbeddingRecord, LocalVoiceStatus } from './hooks';

export {
  createLocalVoiceEmbedder,
  isLocalVoiceEmbeddingSupported,
  DEFAULT_LOCAL_VOICE_MODEL_ID,
  LOCAL_VOICE_EMBEDDING_DIM,
  LOCAL_VOICE_SAMPLE_RATE,
} from './core/LocalVoiceEmbedder';
export type {
  LocalVoiceEmbedder,
  CreateLocalVoiceEmbedderOptions,
  LocalVoiceEmbedderProgress,
  LocalVoiceProgressCallback,
} from './core/LocalVoiceEmbedder';

export {
  cosineSimilarity,
  l2Normalize,
  averageEmbeddings,
  bestMatch,
  isVoiceEnrollmentProvider,
  resolveVoiceEnrollmentProvider,
  DEFAULT_VOICE_MATCH_THRESHOLD,
  VOICE_ENROLLMENT_PROVIDERS,
  DEFAULT_VOICE_ENROLLMENT_PROVIDER,
} from './utils/voiceEmbedding';
export type { VoiceEnrollmentProvider, EnrolledEmbeddingRef, VoiceMatchResult } from './utils/voiceEmbedding';

// =============================================================================
// STT Streaming Clients
// =============================================================================

export { FileTranscriptionService, type FileTranscribeOptions } from './core/FileTranscriptionService';
export { SSEClient, type SSEConnectOptions } from './core/SSEClient';

// Dual-stream recorder (dual-capture X8): records raw + processed
// tracks in parallel via two MediaRecorders.
export { DualStreamRecorder } from './core/DualStreamRecorder';
export type { DualStreamRecorderOptions, DualStreamRecorderResult } from './core/DualStreamRecorder';
export { StreamingSessionManager, type SessionManagerStatus } from './core/StreamingSessionManager';
export { SttWebSocketClient, type WsConnectOptions, type WsReconnectOptions, type WsDrainOptions } from './core/SttWebSocketClient';

// =============================================================================
// Store (Advanced Usage)
// =============================================================================

// The PUBLIC `useAgenticStore` stays the @deprecated
// module singleton so external importers (`import { useAgenticStore } from
// '@arcaai/vox'`) keep working without an <AgenticProvider>. Internal SDK code
// uses the context-backed `useAgenticStore` from `./store` instead (per-tenant
// isolation, audit C-1).
export { agenticStoreSingleton as useAgenticStore } from './store/agenticStore';
export type { AgenticActions, AgenticState } from './store/agenticStore';

// Publicly expose the per-provider, context-backed
// store accessors. Consuming apps (e.g. apps/ui-playground) MUST read
// provider-initialized state through these, NOT the inert @deprecated
// `useAgenticStore` singleton above (no provider initializes it, so its
// `apiClient`/`configManager`/`logger` stay `null` forever).
// - `useArcaStore` is the SAME context-backed hook the SDK uses internally
//   (`useStore(useStoreApi(), selector)`), just under the public name.
// - `useStoreApi` returns the nearest provider's `StoreApi` for imperative
//   `.getState()` reads inside callbacks/loops.
// Both fail loud (throw) outside an <AgenticProvider>, never the singleton.
export { useAgenticStore as useArcaStore, useStoreApi } from './store/agenticStore';
export type { AgenticStoreApi } from './store/agenticStore';

// EXPORTED audio-drop selectors. The external vox consultation UI
// reads the drop signal via `useArcaStore(selectAudioDropped)` /
// `useArcaStore(selectAudioDegraded)` (never a direct store import; select
// atomically). `selectAudioDropped` → per-session dropped-frame count;
// `selectAudioDegraded` → session-sticky "audio was lost" latch.
export { selectAudioDropped, selectAudioDegraded } from './store/agenticStore';

// Constants — defaults and plugin configs (endpoints exported above)
export {
  DEFAULT_NER_CONFIG,
  DEFAULT_NOISE_FILTER_CONFIG,
  DEFAULT_STT_CONFIG,
  DEFAULT_SYNC_INTERVAL,
  DEFAULT_TIMEOUT,
  DEFAULT_VAD_CONFIG,
  STORAGE_KEYS,
} from './core/constants';

// =============================================================================
// Logging (Advanced Usage)
// =============================================================================

export {
  // Transports
  ConsoleTransport,
  // Logger factory
  createSDKLogger,
  createTraceparent,
  extractTraceContext,
  // Utilities
  generateId,
  generateSpanId,
  generateTraceId,
  getGlobalLogger,
  HighlightTransport,
  LOG_LEVEL_VALUES,
  LokiTransport,
  OTelTransport,
  safeStringify,
  SDKLogger,
  serializeError,
  setGlobalLogger,
} from './core/logger';

export type {
  ConsoleTransportConfig,
  CorrelationContext,
  ErrorContext,
  HighlightTransportConfig,
  HttpMeta,
  // Transport types
  ILogTransport,
  // Logger types
  ISDKLogger,
  LogEntry,
  LoggerConfig,
  LogLevel,
  LogMeta,
  LokiTransportConfig,
  OperationContext,
  OperationTimer,
  OTelTransportConfig,
  ResourceInfo,
  SDKMeta,
  // Context types
  TraceContext,
  UserContext,
} from './core/logger';
