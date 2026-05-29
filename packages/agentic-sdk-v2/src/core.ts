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
  useApiKeys,
  useArca,
  useArcaConfig,
  useArcaSession,
  // TASK-299 D-13 — surface the dedicated summary hook from the core entry.
  useArcaSummary,
  useAuditLog,
  useAuth,
  useConsultationJob,
  useDepartments,
  useDnaStyle,
  useGlobalSettings,
  useHealthCheck,
  useMonitoring,
  usePipelines,
  usePolicies,
  usePrompts,
  useRoles,
  useStorage,
  useTenants,
  useUsers,
  useUserSettings,
  useVoiceEmbedding,
} from './hooks';

export type {
  ApiKey,
  ApiKeyUsage,
  ApiKeyWithRawKey,
  AuditLogEntry,
  Bucket,
  CreateApiKeyInput,
  CreatePolicyInput,
  CreateTenantInput,
  CreateUserInput,
  Policy,
  Role,
  StorageFile,
  StorageFileWithUrl,
  Tenant,
  UpdateApiKeyInput,
  UpdatePolicyInput,
  UpdateTenantInput,
  UpdateUserInput,
  UseApiKeysReturn,
  UseArcaAudio,
  UseArcaConfigReturn,
  UseArcaContext,
  UseArcaReturn,
  UseArcaSession,
  UseArcaSessionReturn,
  UseArcaSummary,
  UseAuditLogReturn,
  UseAuthReturn,
  UseConsultationJobReturn,
  UseDepartmentsReturn,
  UseDnaStyleReturn,
  UseGlobalSettingsReturn,
  UseHealthCheckReturn,
  UseMonitoringReturn,
  UsePipelinesReturn,
  UsePoliciesReturn,
  UsePromptsReturn,
  User,
  UseRolesReturn,
  UserRoleAssignment,
  UseStorageReturn,
  UseTenantsReturn,
  UseUserSettingsReturn,
  UseUsersReturn,
  UseVoiceEmbeddingReturn,
  VoiceProfile,
  EnrollFiles,
  UserRole,
} from './hooks';

// TASK-265 W0-10 — typed built-in role identifiers
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
  VADEvent,
  VADEventType,
} from './types';

// =============================================================================
// Types - Summary
// =============================================================================

export type {
  AsyncJobResponse,
  // TASK-299 D-17 — widened comprehensive summary options.
  ComprehensiveSummaryGenerationOptions,
  ComprehensiveSummaryOptions,
  ComprehensiveSummaryResponse,
  DNAStyle,
  DNAStyleData,
  NEREntity,
  PreSummaryOptions,
  SummaryActions,
  SummaryApprovalResponse,
  // Story 148: Summary approval
  SummaryApprovalStatus,
  // TASK-299 D-4 — canonical summary-generation options.
  SummaryGenerationOptions,
  SummaryJobStatus,
  SummaryMeta,
  SummaryOptions,
  SummaryResponse,
  SummaryState,
  SummaryVersionEntry,
  // WS-3: Summary versioning
  UpdateSummaryOptions,
} from './types';

// =============================================================================
// Types - DNA Writing Style (SDK-207 WS-4)
// =============================================================================

export type { DnaGenerateInput, DnaJobResult, DnaJobStatus, DnaReport, DnaReportData, DnaReportWithFallback, DnaStyleVersion, DnaUpdateInput } from './types';

// =============================================================================
// Types - Prompt Template (SDK-207 WS-4)
// =============================================================================

export type {
  AssignDepartmentPromptInput,
  CreatePromptInput,
  PromptListFilters,
  PromptTemplate,
  PromptTemplateCategory,
  PromptVariable,
  PromptVersion,
  UpdatePromptInput,
} from './types';

// =============================================================================
// Types - Diff (SDK-207 WS-4)
// =============================================================================

export type { DiffChange, DiffMode, DiffResult, DiffStats } from './types';

// =============================================================================
// Types - STT-V2 Streaming
// =============================================================================

export type {
  AiModelResponse,
  AsrPipelineResponse,
  CreateStreamingSessionRequest,
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

export type { AuthUser, ImpersonateResponse, LoginResponse } from './types/auth';

// Settings + OCC error (TASK-302 Stream D Phase D.4) — exported here so
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

// =============================================================================
// Constants - Endpoint Definitions
// =============================================================================

export {
  ADMIN_USER_ROLES_ENDPOINTS,
  API_KEY_ENDPOINTS,
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
  POLICY_ENDPOINTS,
  PROMPT_TEMPLATE_ENDPOINTS,
  ROLE_ENDPOINTS,
  SERVICE_HEALTH_ENDPOINTS,
  STORAGE_ENDPOINTS,
  STT_V2_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  TENANT_ENDPOINTS,
  USER_ENDPOINTS,
  USER_SETTINGS_ENDPOINTS,
  VOICE_EMBEDDING_ENDPOINTS,
} from './core/constants';

// =============================================================================
// Types - Models
// =============================================================================

export type {
  ModelLoadingStates,
  ModelLoadOptions,
  ModelLoadProgress,
  ModelLoadStatus,
  ModelRegistryActions,
  ModelRegistryState,
  SelectedModels,
} from './types';

export { DEFAULT_MODELS, DEFAULT_STT_MODELS, DEFAULT_VAD_MODELS } from './types';

// =============================================================================
// Utilities
// =============================================================================

export {
  // TASK-299 D-18 — SMR error → AgenticErrorCode classification helpers.
  classifyHttpError,
  classifySmrError,
  // SDK-207 WS-4: Diff utilities
  computeDiff,
  computePromptDiff,
  computeSummaryDiff,
  createUnifiedPatch,
  extractPromptVariables,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  // TASK-299 D-9 — Idempotency-Key helpers.
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
} from './utils';

// =============================================================================
// Core Classes (Advanced Usage)
// =============================================================================

export { AgenticClient } from './core/AgenticClient';
export { ConfigManager, type ConfigManagerOptions } from './core/ConfigManager';
export type { AppConfig, DeepPartial } from './core/ConfigSchema';
export { ModelRegistry, type ModelLoadProgressCallback } from './core/ModelRegistry';
export { PersonalizationManager, type PreferencesChangeCallback } from './core/PersonalizationManager';

// =============================================================================
// STT-V2 Streaming Clients
// =============================================================================

export { FileTranscriptionService, type FileTranscribeOptions } from './core/FileTranscriptionService';
export { SSEClient, type SSEConnectOptions } from './core/SSEClient';
export { StreamingSessionManager, type SessionManagerStatus } from './core/StreamingSessionManager';
export { SttV2WebSocketClient, type WsConnectOptions, type WsReconnectOptions } from './core/SttV2WebSocketClient';

// =============================================================================
// Store (Advanced Usage)
// =============================================================================

// TASK-317 W4.3 (AC-12) — the PUBLIC `useAgenticStore` stays the @deprecated
// module singleton so external importers (`import { useAgenticStore } from
// '@arcaai/vox'`) keep working without an <AgenticProvider>. Internal SDK code
// uses the context-backed `useAgenticStore` from `./store` instead (per-tenant
// isolation, audit C-1).
export { agenticStoreSingleton as useAgenticStore } from './store/agenticStore';
export type { AgenticActions, AgenticState } from './store/agenticStore';

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
