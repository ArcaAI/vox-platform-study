/**
 * @arcaai/vox - Core
 *
 * Core components for the SDK.
 */

export { AgenticClient } from './AgenticClient';
export { PluginManager, type PluginEventCallbacks, type PluginManagerState } from './PluginManager';
export { PersonalizationManager, type PreferencesChangeCallback } from './PersonalizationManager';
export { ModelRegistry, type ModelLoadProgressCallback } from './ModelRegistry';

// Three-tier config management (TASK-244)
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
  type SmrConfig,
  type FeatureFlags,
  type DeepPartial,
  type ConfigPermission,
  type ConfigFieldMeta,
} from './ConfigSchema';

// Pipeline exports
export { TranscriptionPipeline, createTranscriptionPipeline } from './TranscriptionPipeline';
export { KnowledgePipeline, createKnowledgePipeline, type TriggerMode } from './KnowledgePipeline';

// Cross-tab sync
export { SimpleCrossTabSync, createCrossTabSync, type CrossTabEvent, type CrossTabEventType } from './SimpleCrossTabSync';

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

// STT-V2 types
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
} from '../types/stt-v2';
export { TranscriptionJobStatus, TranscriptionJobType } from '../types/stt-v2';

// STT-V2 streaming clients
export { SttV2WebSocketClient, type WsConnectOptions, type WsReconnectOptions } from './SttV2WebSocketClient';
export { StreamingSessionManager, type SessionManagerStatus } from './StreamingSessionManager';
export { FileTranscriptionService, type FileTranscribeOptions } from './FileTranscriptionService';
export { SSEClient, type SSEConnectOptions } from './SSEClient';

// STT-V2 endpoint constants
export { STT_V2_ENDPOINTS } from './constants';

// Auth-based tenant endpoints
export { MY_TENANT_ENDPOINTS } from './constants';

// Logger exports
export * from './logger';
