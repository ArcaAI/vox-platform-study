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
  useArca,
  // Surface the focused domain hooks (siblings of
  // useArcaSession/useArcaSummary) so consumers can use them without the useArca() aggregate.
  useArcaLiveSummary,
  // the live clinician-assist feed (grammar corrections +
  // interpreter suggestions). SSE only, no audio/ML, so it belongs in core.
  useArcaLiveAssist,
  useArcaAudio,
  useArcaConfig,
  useArcaDevices,
  useArcaContext,
  useArcaSession,
  // Surface the dedicated summary hook from the core entry.
  useArcaSummary,
  useAudioRecordings,
  useAuth,
  useConsultationChain,
  useConsultationJob,
  // TASK-974: submit a clinician's writing samples to the hidden DNA analyst agent.
  useDnaWritingStyle,
  // Schema discovery + the consultation-loop event stream
  useConsultationSchema,
  useConsultationWorkflow,
  useSelectableConsultationWorkflows,
  // TASK-865: the ASR Agent picker's data source (no audio/ML — a plain read).
  useSelectableAsrAgents,
  // workflow invocation (run / watch / cancel). No audio or ML, so
  // it belongs in /core: an admin or dashboard surface runs workflows too.
  useWorkflowRun,
  // TASK-890: the workflow human-review surface, and invoking a published agent. Both are
  // plain reads/writes with no audio or ML, so they belong in /core alongside useWorkflowRun.
  useWorkflowReview,
  useAgentInvocation,
  useConsultationEvents,
  useArcaSttLanguageModes,
  // Native 2-way STT provider toggle (pipeline ↔ default)
  useSttProviderToggle,
  // Native batch (pre-recorded file) transcription queue
  useBatchTranscription,
  usePipelines,
  usePolicies,
  useStorage,
  useUserSettings,
  useVoiceEmbedding,
} from './hooks';

export type {
  BreakGlassCredentials,
  Bucket,
  CreatePolicyInput,
  Pipeline,
  PipelineVersion,
  Policy,
  UpdatePolicyInput,
  UseArcaAudio,
  UseArcaConfigReturn,
  UseArcaContext,
  UseArcaReturn,
  UseArcaSession,
  UseArcaSessionReturn,
  UseArcaSummary,
  UseAudioRecordingsReturn,
  UseAuthReturn,
  UseConsultationChainReturn,
  UseConsultationJobReturn,
  UseConsultationSchemaReturn,
  UseDnaWritingStyleReturn,
  PollIngestJobOptions,
  UseConsultationWorkflowReturn,
  UseSelectableConsultationWorkflowsReturn,
  // workflow invocation.
  StartWorkflowRunOptions,
  UseWorkflowRunOptions,
  UseWorkflowRunReturn,
  UseConsultationEventsReturn,
  ConsultationEventsStreamStatus,
  UseArcaSttLanguageModesReturn,
  UseSttProviderToggleReturn,
  UsePipelinesReturn,
  UsePoliciesReturn,
  UseStorageReturn,
  UseUserSettingsReturn,
  UseVoiceEmbeddingReturn,
  VoiceProfile,
  EnrollFiles,
  EnrollOptions,
  VoiceEnrollmentTarget,
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
  LoggingClarityConfig,
  LoggingCaptureConfig,
  LoggingLokiConfig,
  LoggingOTelConfig,
  ModelDefinition,
  ModelRegistryConfig,
  NERPluginConfig,
  NoiseFilterPluginConfig,
  // TASK-865: the client-inference gate + the stage-name union.
  AudioPluginStageName,
  ClientInferenceConfig,
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

// TASK-865: published-Agent selection types (business plane).
export type { AgentTask, SelectableAgent, SelectableAsrAgent } from './types';
export type { NamedEntityRecognitionInput, NamedEntityRecognitionOutput, RecognizedEntity } from './types';
export type { UseSelectableAsrAgentsReturn } from './hooks';
// TASK-890 (OD-F) — invoking a published agent from the browser.
export type { AgentInvocationFrame, AgentInvocationInput, AgentInvocationResult } from './types';
export type { UseAgentInvocationReturn, UseWorkflowReviewReturn } from './hooks';

export type { LiveSummarySnapshot, LiveSummarySection, LiveSummaryEntity, LiveSummaryStats, LiveSummaryVitals } from './types';
export type { LiveAssistEvent, LiveAssistSuggestion, LiveAssistProposal, LiveAssistCorrections } from './types';
export type { UseArcaLiveAssistReturn, LiveAssistStreamStatus } from './hooks';

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
// Types - Consultation Context Schema
// =============================================================================

export type {
  ConsultationContextSchemaDefinition,
  ConsultationSchemaBundle,
  // the discovery answer returned by `useConsultationWorkflow`, and the selectable
  // set returned by `useSelectableConsultationWorkflows`.
  ConsultationWorkflow,
  SelectableConsultationWorkflow,
  ContextKindDeclaration,
  ContextKindDeprecation,
  ContextOutputDeclaration,
  ContextPrimitive,
  LoopEvent,
} from './types';

export { CONTEXT_PRIMITIVES, findConsultationContextKind, isConsultationContextKindDeprecated } from './types';

// =============================================================================
// Types + guards — workflow invocation
// =============================================================================

export type {
  TerminalRunStatus,
  WorkflowRunEvent,
  WorkflowRunEventPayload,
  WorkflowRunEventType,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSchemaDescription,
  WorkflowSummary,
  // TASK-890 — the human-review surface of a run.
  WorkflowReview,
  WorkflowReviewDecision,
  WorkflowReviewDecisionResult,
} from './types';

export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from './types';

/**
 * The reserved run-identity keys and their detector — exported so a caller can
 * validate an `input` object BEFORE handing it to `start()` (e.g. while
 * building it from form fields), rather than catching the throw.
 */
export { RESERVED_RUN_IDENTITY_KEYS, ReservedRunIdentityError, reservedRunIdentityKeysIn } from './hooks';

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
  // argument/return shapes of already-public audio surfaces
  // (`audio.start(options)`, dual capture, the store's pipeline/connection
  // state). Types only: erased at build, so `/core` stays audio-code-free.
  ActivePipelineInfo,
  AudioProcessingConstraints,
  AudioStartOptions,
  DualCaptureResult,
  SttConnectionState,
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
  DocumentSectionGroup,
  DocumentSectionKey,
  DocumentSectionSpec,
  HighlightSegment,
  LegacySoapSectionCode,
  SensorScores,
  // Deprecated aliases of DocumentSectionKey / DocumentSectionGroup.
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

// DNA writing-sample ingest types (TASK-974, business plane)
export type { DnaWritingSampleKind, DnaWritingSample, DnaWritingSamplesIngestInput, DnaIngestJobResponse, DnaIngestJobStatus } from './types';

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
  WsMetadataMessage,
  WsMetadataSpan,
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
  AUDIO_RECORDING_ENDPOINTS,
  AUTH_ENDPOINTS,
  CONSULTATION_ENDPOINTS,
  CONSULTATION_JOB_ENDPOINTS,
  CONTEXT_ENDPOINTS,
  // TASK-974: DNA writing-style sample ingest (business plane).
  DNA_WRITING_STYLE_ENDPOINTS,
  ENTITLEMENTS_ENDPOINTS,
  ENTITY_ENDPOINTS,
  HEALTH_ENDPOINTS,
  MY_TENANT_ENDPOINTS,
  NLP_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  PIPELINE_ENDPOINTS,
  POLICY_ENDPOINTS,
  STORAGE_ENDPOINTS,
  STT_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  TEXT_ENDPOINTS,
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
  // TEXT error → AgenticErrorCode classification helpers.
  classifyHttpError,
  classifyTextError,
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
  labelForSection,
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
export type { AppConfig, DeepPartial, TextConfig } from './core/ConfigSchema';
export { ModelRegistry, type ModelLoadProgressCallback } from './core/ModelRegistry';
export { PersonalizationManager, type PreferencesChangeCallback } from './core/PersonalizationManager';

// =============================================================================
// LOCAL Voice Embedding
// =============================================================================
//
// In-browser speaker-embedding provider (Transformers.js WavLM `*-sv`) that
// sits ALONGSIDE the backend `useVoiceEmbedding`. Persists via the existing
// `/voice-profiles/enroll` path; caches the local embedding tenant/user-scoped;
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
export {
  BatchTranscriptionQueue,
  DEFAULT_BATCH_LIMITS,
  type BatchQueueItem,
  type BatchItemStatus,
  type BatchRejectionReason,
  type BatchTranscriptSegment,
  type BatchTranscriptionLimits,
  type BatchTranscriptionOptions,
  type BatchTranscriptionQueueConfig,
} from './core/BatchTranscriptionQueue';
export { probeAudioDurationSeconds, type ProbeAudioDurationOptions } from './core/audioDuration';
export type { UseBatchTranscriptionProps, UseBatchTranscriptionReturn, BatchTranscriptionLimitsResponse } from './hooks/useBatchTranscription';
export type { SttFallbackProvider } from './hooks/useSttProviderToggle';
export { SSEClient, type SSEConnectOptions } from './core/SSEClient';

/**
 * The WebSocket lane of a workflow run stream (TASK-931), exported alongside `SSEClient` for
 * the same reason: a surface that wants to watch a run outside `useWorkflowRun` — a worker, a
 * non-React shell — needs the client, not just the hook. `SocketUnavailableError` is exported
 * so that refusal is catchable by name rather than by message.
 */
export {
  SocketUnavailableError,
  WorkflowRunSocketClient,
  resolveWorkflowSocketUrl,
  workflowRunStreamTicketPath,
  type WorkflowRunStreamTicket,
} from './core/WorkflowRunSocketClient';

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
// store accessors. Consuming apps MUST read
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
