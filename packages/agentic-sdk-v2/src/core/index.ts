/**
 * @arcaai/vox - Core
 *
 * Core components for the SDK.
 */

export { AgenticClient } from './AgenticClient';
export { PluginManager, type PluginEventCallbacks, type PluginManagerState } from './PluginManager';
export { PersonalizationManager, type PreferencesChangeCallback } from './PersonalizationManager';
export { ModelRegistry, type ModelLoadProgressCallback } from './ModelRegistry';

// Three-tier config management
export { ConfigManager, type ConfigManagerOptions } from './ConfigManager';
export {
  AppConfigSchema,
  SYSTEM_DEFAULTS,
  CONFIG_PERMISSIONS,
  canUserEditField,
  getFieldPermission,
  getUserEditableFields,
  type AppConfig,
  type AudioConfig,
  type SttConfig,
  type UiConfig,
  type TextConfig,
  type FeatureFlags,
  type DeepPartial,
  type ConfigPermission,
  type ConfigFieldMeta,
} from './ConfigSchema';

// Pipeline exports
export { TranscriptionPipeline, createTranscriptionPipeline } from './TranscriptionPipeline';
export { KnowledgePipeline, createKnowledgePipeline, type TriggerMode } from './KnowledgePipeline';

// Cross-tab sync
export { SimpleCrossTabSync, createCrossTabSync, type CrossTabEventType } from './SimpleCrossTabSync';

// SharedWorker-backed HMAC key for cross-tab BroadcastChannel envelopes.
export { CrossTabHmacKeyManager, type CrossTabHmacKeyManagerOptions } from './CrossTabHmacKeyManager';
export type {
  CrossTabHmacReq,
  CrossTabHmacRes,
  CrossTabHmacSignReq,
  CrossTabHmacVerifyReq,
  CrossTabHmacResetReq,
  CrossTabHmacResOk,
  CrossTabHmacResErr,
} from './CrossTabHmacSharedWorker';

// Shared connection management (multi-tab)
export { SharedConnectionManager } from './SharedConnectionManager';
export type { WorkerMessage, WorkerMessageType, SSESubscription, WSSubscription } from './SharedConnectionWorker';

export {
  // API Endpoints
  CONSULTATION_ENDPOINTS,
  CONTEXT_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  ENTITY_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  // Default values
  DEFAULT_TIMEOUT,
  DEFAULT_SYNC_INTERVAL,
  STORAGE_KEYS,
  // Plugin defaults
  DEFAULT_NOISE_FILTER_CONFIG,
  DEFAULT_VAD_CONFIG,
  DEFAULT_STT_CONFIG,
} from './constants';

// STT types
export type {
  WsTranscriptResult,
  WsStatusMessage,
  WsErrorMessage,
  WsServerMessage,
  WsAudioFrame,
  WsClientMessage,
  CreateStreamingSessionRequest,
  StreamingSessionResponse,
  StreamingSessionStatus,
  TranscriptionJobResponse,
  TranscriptionJobStatusCounts,
} from '../types/stt';
export { TranscriptionJobStatus, TranscriptionJobType } from '../types/stt';

// STT streaming clients
export { SttWebSocketClient, type WsConnectOptions, type WsReconnectOptions, type WsDrainOptions } from './SttWebSocketClient';
export { StreamingSessionManager, type SessionManagerStatus } from './StreamingSessionManager';
export { FileTranscriptionService, type FileTranscribeOptions } from './FileTranscriptionService';
// Batch transcription engine + the browser duration probe it validates with.
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
} from './BatchTranscriptionQueue';
export { probeAudioDurationSeconds, type ProbeAudioDurationOptions } from './audioDuration';
export { SSEClient, type SSEConnectOptions } from './SSEClient';

// STT endpoint constants
export { STT_ENDPOINTS } from './constants';

// Auth-based tenant endpoints
export { MY_TENANT_ENDPOINTS } from './constants';

// Logger exports
export * from './logger';
