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

// Audio recording types (TASK-329 P2 — dual-capture X8)
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

// Audio types
export type {
  AudioActions,
  AudioOptions,
  AudioPluginStates,
  AudioStartOptions,
  AudioState,
  PluginState,
  STTPluginState,
  TranscriptionResult,
  TranscriptionSegment,
  // WS-B: Structured transcript and start options
  TranscriptSegment,
  // TASK-372 D9 — word-level timestamps carried through the store
  TranscriptWord,
  VADEvent,
  VADEventType,
} from './audio';

export { DEFAULT_AUDIO_PLUGIN_STATES, DEFAULT_AUDIO_STATE } from './audio';

// Summary types
export type {
  // SUM-01: Async summary job types
  AsyncJobResponse,
  // TASK-299 D-17: widened comprehensive summary options
  ComprehensiveSummaryGenerationOptions,
  ComprehensiveSummaryOptions,
  // SUM-02: Comprehensive summary types
  ComprehensiveSummaryResponse,
  // TASK-329 P6: summary tagging input
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
  // TASK-329 P6: summary tag
  SummaryTag,
  SummaryVersionEntry,
  // WS-3: Summary versioning types
  UpdateSummaryOptions,
  // TASK-329 P6: version diff result
  VersionDiff,
} from './summary';

export type { SummaryApprovalResponse, SummaryApprovalStatus } from './summary';

export { DEFAULT_SUMMARY_STATE } from './summary';

// Provenance / citations types (TASK-330 Phase 1, Lane J)
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
} from './citations';

// DNA Writing Style types (SDK-207 WS-4)
export type { DnaGenerateInput, DnaJobResult, DnaJobStatus, DnaReport, DnaReportData, DnaReportWithFallback, DnaStyleVersion, DnaUpdateInput } from './dna';

// DNA aggregate dashboard types (TASK-328 A5)
export type { DnaDashboard, DnaDashboardDailyCount, DnaDashboardRecentActivity, DnaDashboardUsageEntry } from './dna';

// Prompt Template types (SDK-207 WS-4; TASK-328 A4)
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
  // TASK-328 A4 — quality/score testing + usage analytics
  TestPromptInput,
  PromptTestResult,
  // TASK-389 #15 (AG12/A5) — raw per-dimension breakdown behind PromptTestResult
  PromptTestMetrics,
  PromptUsageByDepartment,
  PromptUsageByDoctor,
  PromptUsageByDay,
  PromptUsageAnalytics,
} from './prompt';

// Diff types (SDK-207 WS-4)
export type { DiffChange, DiffMode, DiffResult, DiffStats } from './diff';

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

// STT-V2 types (Layer 0 Foundation — SDK-206)
export type {
  // AI models
  AiModelResponse,
  // ASR pipelines
  AsrPipelineResponse,
  // Streaming session
  CreateStreamingSessionRequest,
  StreamingSessionResponse,
  StreamingSessionStatus,
  // Transcription jobs
  TranscriptionJobResponse,
  TranscriptionJobStatusCounts,
  // WebSocket protocol (client → server)
  WsAudioFrame,
  WsClientMessage,
  WsCloseMessage,
  WsErrorMessage,
  WsServerMessage,
  WsStatusMessage,
  WsStopMessage,
  // WebSocket protocol (server → client)
  WsTranscriptResult,
  WsWordTimestamp,
} from './stt-v2';

export { AiModelDownloadStatus, ResourceStatus, TranscriptionJobStatus, TranscriptionJobType } from './stt-v2';

// Consultation job types (TASK-032 WS-A)
export type { ConsultationJob, JobStatus, JobStreamCallbacks, PollOptions } from './consultation-job';

export { isTerminalStatus } from './consultation-job';

// User management types (TASK-032 WS-G)
export type { AssignDepartmentsInput, CreateUserInput, UpdateUserInput, User } from '../hooks/useUsers';

// API Key types (TASK-032 WS-G)
export type { ApiKey, ApiKeyUsage, ApiKeyWithRawKey, CreateApiKeyInput, UpdateApiKeyInput } from '../hooks/useApiKeys';

// Role types (TASK-032 WS-G)
export type { Role, UserRoleAssignment } from '../hooks/useRoles';

// Health check types (TASK-034 WS-H)
export type { ComponentCheck, ComponentStatus, HealthStatus, ServiceHealthStatus } from './health';

// Monitoring types (TASK-032 WS-A; SessionCounts realigned to backend SessionsResponse in TASK-386)
export type { HeartbeatRecord, ServiceSessionCount, ServiceUptime, SessionCounts } from './monitoring';

// Platform runtime metrics types (TASK-386 #16 — E1/E2/E3)
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

// Voice embedding types (TASK-265 W0-7 — voice-profile rewrite)
export type { VoiceProfile, EnrollFiles } from '../hooks/useVoiceEmbedding';

// Settings types + OCC error (TASK-302 Stream D Phase D.4)
export type {
  CreateGlobalSettingInput,
  CreateUserSettingInput,
  GlobalSetting,
  UpdateGlobalSettingInput,
  UpdateUserSettingInput,
  UserSetting,
} from './settings';
export { ConfigConflictError } from './settings';

// Frontend pipeline config types (TASK-328 A6)
export type {
  FrontendPipelineConfigJson,
  TenantFrontendConfig,
  UpsertTenantFrontendConfigInput,
  // TASK-356 Phase 4 — audio-console enums (string unions).
  CaptureMode,
  TranscriptionMode,
} from './frontend-pipeline-config';
