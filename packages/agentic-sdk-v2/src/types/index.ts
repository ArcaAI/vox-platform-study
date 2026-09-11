/**
 * @arcaai/vox - Types
 *
 * Re-exports all type definitions.
 */

// Configuration types
export type {
  AgenticConfig,
  ApiConfig,
  AudioPluginConfig,
  AudioPluginStageName,
  ClientInferenceConfig,
  AudioSilenceLocalConfig,
  DiarizationLocalConfig,
  LocalAsrModelInfo,
  LocalNoiseSuppressionModelInfo,
  LocalVadModelInfo,
  LocalWorkflowConfig,
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
  NERLocalConfig,
  NERPluginConfig,
  NoiseCancellationLocalConfig,
  NoiseFilterPluginConfig,
  PersonalizationConfig,
  PluginConfig,
  RemoteConfigResponse,
  STTLocalConfig,
  STTPluginConfig,
  // Tenant configuration types
  TenantAudioConfig,
  TenantFeatureFlags,
  TTSPluginConfig,
  UserPreferences,
  UserPreferencesUpdate,
  VADLocalConfig,
  VADPluginConfig,
  VoiceEmbeddingLocalConfig,
  WorkflowMode,
} from './config';

export {
  DEFAULT_API_TIMEOUT,
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_CROSS_TAB_CONFIG,
  DEFAULT_LOCAL_CONFIG,
  DEFAULT_PERSONALIZATION_CONFIG,
  DEFAULT_PROCESSING_CONFIG,
  DEFAULT_SESSION_PERSISTENCE_CONFIG,
  DEFAULT_TENANT_FEATURES,
  parseTenantConfig,
  TENANT_CONFIG_KEYS,
} from './config';

// Processing configuration types
export type {
  CrossTabConfig,
  KnowledgeProcessingConfig,
  ProcessingConfig,
  ProcessingLocation,
  SessionPersistenceConfig,
  TranscriptionProcessingConfig,
  TriggerMode,
} from './config';

// Consultation types
export type {
  Consultation,
  ConsultationStatus,
  CreateConsultationInput,
  OpenSessionInput,
  SessionActions,
  SessionState,
  StartRevisitInput,
  // SES-04: Timeline types
  TimelineEntry,
  TimelineScope,
  UpdateConsultationInput,
} from './consultation';

export { CONSULTATION_STATUS_ORDER, isNewVisit, isRevisit, normalizeConsultationStatus } from './consultation';

// Audio recording types (dual-capture X8)
export type { AudioRecording, AddAudioRecordingInput } from './recording';

// Context types
export type {
  AddContextInput,
  CaseNoteInput,
  ContextActions,
  ContextFilters,
  ContextItem,
  ContextItemType,
  ContextSource,
  ContextState,
  // SES-05: Context version history
  ContextVersionEntry,
  MedicalCodes,
  MedicalEntity,
  MedicalEntityType,
  NERData,
} from './context';

// Consultation context schema discovery types
export type {
  ConsultationContextSchemaDefinition,
  ConsultationSchemaBundle,
  ContextKindDeclaration,
  ContextKindDeprecation,
  ContextOutputDeclaration,
  ContextPrimitive,
} from './consultationSchema';
export {
  CONTEXT_PRIMITIVES,
  findConsultationContextKind,
  isConsultationContextKindDeprecated,
  parseConsultationSchemaBundle,
  UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE,
} from './consultationSchema';

// consultation workflow DISCOVERY (which engine governs a consultation).
export type { ConsultationWorkflow, SelectableConsultationWorkflow } from './consultationWorkflow';
export type { AgentTask, SelectableAgent, SelectableAsrAgent } from './agent';
export type { NamedEntityRecognitionInput, NamedEntityRecognitionOutput, RecognizedEntity } from './agent';
// TASK-890 (OD-F) — invoking a published agent from the browser.
export type { AgentInvocationFrame, AgentInvocationInput, AgentInvocationResult } from './agent';

// workflow INVOCATION (running one), as distinct from the discovery
// types above (which one governs a consultation).
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
} from './workflowRun';
export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from './workflowRun';

// Consultation-loop workflow event types
export type { LoopEvent } from './loopEvent';

// Audio types
export type {
  // The ASR pipeline the live streaming session is transcribing on.
  ActivePipelineInfo,
  AudioActions,
  AudioOptions,
  AudioPluginStates,
  AudioProcessingConstraints,
  AudioStartOptions,
  AudioState,
  // Raw + noise-filtered blobs from a dual capture.
  DualCaptureResult,
  PluginState,
  STTPluginState,
  // Streaming-STT connection lifecycle as the store reports it.
  SttConnectionState,
  TranscriptionResult,
  TranscriptionSegment,
  // WS-B: Structured transcript and start options
  TranscriptSegment,
  // Word-level timestamps carried through the store
  TranscriptWord,
  VADEvent,
  VADEventType,
} from './audio';

export { DEFAULT_AUDIO_PLUGIN_STATES, DEFAULT_AUDIO_STATE } from './audio';

// Summary types
export type {
  // SUM-01: Async summary job types
  AsyncJobResponse,
  // Widened comprehensive summary options
  ComprehensiveSummaryGenerationOptions,
  ComprehensiveSummaryOptions,
  // SUM-02: Comprehensive summary types
  ComprehensiveSummaryResponse,
  // Summary tagging input
  CreateSummaryTagInput,
  DNAStyle,
  DNAStyleData,
  NEREntity,
  PreSummaryOptions,
  SummaryActions,
  // WS-B: Extended summary generation options
  SummaryGenerationOptions,
  SummaryJobStatus,
  SummaryMeta,
  SummaryOptions,
  SummaryResponse,
  SummaryState,
  // Summary tag
  SummaryTag,
  SummaryVersionEntry,
  // WS-3: Summary versioning types
  UpdateSummaryOptions,
  // Version diff result
  VersionDiff,
} from './summary';

export type { SummaryApprovalResponse, SummaryApprovalStatus } from './summary';

export { DEFAULT_SUMMARY_STATE } from './summary';

// Provenance / citations types
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
} from './citations';

// DNA Writing Style types (SDK-207 WS-4)
export type {
  DnaErasureResult,
  DnaGenerateInput,
  DnaJobResult,
  DnaJobStatus,
  DnaReport,
  DnaReportData,
  DnaReportWithFallback,
  DnaStyleVersion,
  DnaUpdateInput,
} from './dna';

// DNA aggregate dashboard types
export type { DnaDashboard, DnaDashboardDailyCount, DnaDashboardRecentActivity, DnaDashboardUsageEntry } from './dna';

// Prompt Template types
export type {
  AssignDepartmentPromptInput,
  CreatePromptInput,
  DepartmentPromptField,
  PromptListFilters,
  PromptTemplate,
  PromptTemplateCategory,
  PromptTemplateStatus,
  PromptVariable,
  PromptVersion,
  UpdatePromptInput,
  // Quality/score testing + usage analytics
  TestPromptInput,
  PromptTestResult,
  // Raw per-dimension breakdown behind PromptTestResult
  PromptTestMetrics,
  PromptUsageByDepartment,
  PromptUsageByDoctor,
  PromptUsageByDay,
  PromptUsageAnalytics,
} from './prompt';

// Diff types (prompt version diff superset)
export type { DiffChange, DiffMode, DiffResult, DiffStats, PromptVersionDiff, PromptVersionDiffField } from './diff';

// Common types
export type {
  AgenticErrorCode,
  AgenticEventHandler,
  AgenticEventType,
  AllowedPageSize,
  AsyncStatus,
  DeepPartial,
  FunctionParams,
  HookStatus,
  PaginatedResponse,
  PaginationParams,
} from './common';

export { AgenticError, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from './common';

// Model registry types
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
} from './models';

export { DEFAULT_AVAILABLE_STT_MODELS, DEFAULT_MODELS, DEFAULT_STT_MODELS, DEFAULT_VAD_MODELS } from './models';

// Pipeline types
export type {
  KnowledgePipelineActions,
  KnowledgePipelineConfig,
  KnowledgePipelineEvents,
  KnowledgePipelineInput,
  KnowledgePipelineOutput,
  PipelineStateInfo,
  PipelineStatus,
  TranscriptionPipelineActions,
  TranscriptionPipelineConfig,
  TranscriptionPipelineEvents,
  TranscriptionPipelineInput,
  TranscriptionPipelineOutput,
} from './pipeline';

export { DEFAULT_KNOWLEDGE_PIPELINE_CONFIG, DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG } from './pipeline';

// STT types (Layer 0 Foundation — SDK-206)
export type {
  // AI models
  AiModelResponse,
  // ASR pipelines
  AsrPipelineResponse,
  // Streaming session
  CreateStreamingSessionRequest,
  StreamingSessionResponse,
  StreamingSessionStatus,
  // Language modes
  LanguageMode,
  LanguageModeCatalog,
  // Transcription jobs
  TranscriptionJobResponse,
  TranscriptionJobStatusCounts,
  // WebSocket protocol (client → server)
  WsAudioFrame,
  WsClientMessage,
  WsCloseMessage,
  WsErrorMessage,
  WsMetadataMessage,
  WsMetadataSpan,
  WsServerMessage,
  WsStatusMessage,
  WsStopMessage,
  // WebSocket protocol (server → client)
  WsTranscriptResult,
  WsWordTimestamp,
} from './stt';

export { AiModelDownloadStatus, ResourceStatus, TranscriptionJobStatus, TranscriptionJobType } from './stt';

// Consultation job types
export type { ConsultationJob, JobStatus, JobStreamCallbacks, PollOptions } from './consultation-job';

export { isTerminalStatus } from './consultation-job';

// User management, API-key and role types were removed under TASK-890
// (OD-F/OD-K) along with their sole consumers, the admin `useUsers` /
// `useApiKeys` / `useRoles` hooks — `@arcaai/vox` carries no management
// surface.

// Health check types
export type { ComponentCheck, ComponentStatus, HealthStatus, ServiceHealthStatus } from './health';

// Monitoring types (SessionCounts aligned to backend SessionsResponse)
export type { HeartbeatRecord, ServiceSessionCount, ServiceUptime, SessionCounts } from './monitoring';

// Platform runtime metrics types (E1/E2/E3)
export type {
  ConsumptionConsultations,
  ConsumptionRollup,
  OpenSockets,
  PlatformMetrics,
  PlatformModelMetric,
  PlatformModelsSummary,
  PlatformServiceMetric,
  RequestVolumePoint,
} from './platform-metrics';

// Voice embedding types
export type { VoiceProfile, EnrollFiles } from '../hooks/useVoiceEmbedding';

// Settings types + OCC error
export type {
  CreateGlobalSettingInput,
  CreateUserSettingInput,
  GlobalSetting,
  UpdateGlobalSettingInput,
  UpdateUserSettingInput,
  UserSetting,
  // Secret reveal (step-up re-auth).
  RevealSecretInput,
  RevealSecretResult,
} from './settings';
export { ConfigConflictError } from './settings';

// Frontend pipeline config types
export type {
  FrontendPipelineConfigJson,
  TenantFrontendConfig,
  UpsertTenantFrontendConfigInput,
  // Audio-console enums (string unions).
  CaptureMode,
  TranscriptionMode,
} from './frontend-pipeline-config';

// Global-admin ops-surface types (Rate Limits / Queues & Jobs / Prisma Studio)
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
} from './ops-admin';

export type { LiveSummarySnapshot, LiveSummarySection, LiveSummaryEntity, LiveSummaryStats, LiveSummaryVitals } from './liveSummary';
export type { LiveAssistEvent, LiveAssistSuggestion, LiveAssistProposal, LiveAssistCorrections } from './liveAssist';
