/**
 * @arcaai/vox - Configuration Types
 *
 * Main SDK configuration types for the Agentic SDK v2.
 * Provides configuration-driven plugin architecture.
 */

// =============================================================================
// Logging Configuration (imported separately for type safety)
// =============================================================================

/**
 * Console logging configuration
 */
export interface LoggingConsoleConfig {
  /** Enable console output */
  enabled: boolean;
  /** Minimum log level for console */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Enable colorized output */
  colorize?: boolean;
  /** Pretty print JSON */
  prettyPrint?: boolean;
}

/**
 * Highlight.io configuration
 */
export interface LoggingHighlightConfig {
  /** Enable Highlight.io */
  enabled: boolean;
  /** Highlight.io project ID */
  projectId: string;
  /** Service name displayed in Highlight */
  serviceName?: string;
  /** Environment name */
  environment?: string;
  /** Enable network recording */
  networkRecording?: boolean;
}

/**
 * Microsoft Clarity configuration
 *
 * Clarity records session replays of the DOM. In a HOPE surface that DOM
 * contains PHI (transcripts, patient context), and Microsoft does not offer a
 * HIPAA BAA for Clarity — so the transport is fail-closed and refuses to
 * activate when `NODE_ENV === 'production'`. Set the Clarity project to
 * "Mask All" and mark PHI-bearing elements `data-clarity-mask="true"` before
 * enabling anywhere.
 */
export interface LoggingClarityConfig {
  /**
   * Microsoft Clarity project ID. **This is the on/off switch**: supply one and
   * Clarity is enabled, omit it (or leave it empty) and the transport is never
   * constructed — so it can be bound straight to an env var, where an unset
   * variable means "off":
   *
   * ```ts
   * clarity: { projectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID, environment: 'staging' }
   * ```
   */
  projectId?: string;
  /**
   * Optional explicit override. Leave undefined to let `projectId` decide.
   * Set to `false` to force Clarity off while keeping the ID configured.
   */
  enabled?: boolean;
  /** Minimum log level. Defaults to `error` — Clarity is not a log sink. */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Service name (sent as the `vox.service` tag) */
  serviceName?: string;
  /** Environment name (sent as the `vox.environment` tag) */
  environment?: string;
  /** Send the user id to Clarity's Identify API. Defaults to false. */
  identifyUsers?: boolean;
  /** Start with cookie consent denied until the host grants it. Defaults to false. */
  requireConsent?: boolean;
  /** Ask Clarity to prioritise recording sessions containing an error. Defaults to false. */
  upgradeOnError?: boolean;
}

/**
 * Grafana Loki configuration
 */
export interface LoggingLokiConfig {
  /** Enable Loki transport */
  enabled: boolean;
  /** Loki server URL */
  url: string;
  /** Basic auth (username:password) */
  basicAuth?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Labels to add to all logs */
  labels?: Record<string, string>;
}

/**
 * OpenTelemetry configuration
 */
export interface LoggingOTelConfig {
  /** Enable OpenTelemetry */
  enabled: boolean;
  /** OTLP endpoint URL */
  endpoint: string;
  /** Protocol type */
  protocol?: 'http/json' | 'http/protobuf' | 'grpc';
  /** Custom headers (e.g., for authentication) */
  headers?: Record<string, string>;
  /** Resource attributes */
  resourceAttributes?: Record<string, string>;
  /** Enable trace context propagation */
  propagateTraceContext?: boolean;
}

/**
 * Browser-wide capture configuration
 *
 * Mirrors `GlobalCaptureOptions` in `core/logger/globalCapture.ts`.
 */
export interface LoggingCaptureConfig {
  /** Capture `console.*` calls. Defaults to false (free-text PHI risk). */
  console?: boolean;
  /** Which console methods to capture. Defaults to `['warn', 'error']`. */
  consoleMethods?: Array<'log' | 'info' | 'debug' | 'warn' | 'error'>;
  /** Capture uncaught errors and unhandled promise rejections. Defaults to true. */
  globalErrors?: boolean;
  /** Truncate each stringified argument to this length. Defaults to 2000. */
  maxArgLength?: number;
  /** Rolling per-minute cap on captured events. Defaults to 200. */
  maxEventsPerMinute?: number;
}

/**
 * Logging configuration for the SDK
 */
export interface LoggingConfig {
  /** Global log level */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Console transport configuration */
  console?: LoggingConsoleConfig;
  /** Highlight.io transport configuration */
  highlight?: LoggingHighlightConfig;
  /** Microsoft Clarity transport configuration */
  clarity?: LoggingClarityConfig;
  /** Grafana Loki transport configuration */
  loki?: LoggingLokiConfig;
  /** OpenTelemetry transport configuration */
  otel?: LoggingOTelConfig;
  /**
   * Capture browser-wide telemetry (`console.*`, uncaught errors, unhandled
   * promise rejections) into the transport pipeline.
   *
   * Without this, only messages SDK code routed through `SDKLogger` reach a
   * transport — application console output is invisible to Clarity/Loki/OTel.
   *
   * `console` capture defaults to **off** because it forwards arbitrary
   * free-text strings that the PHI redactor cannot scrub. Enable it only where
   * the data is synthetic (development, staging). `globalErrors` defaults to on.
   */
  capture?: LoggingCaptureConfig;
  /** Fields to redact from logs */
  redactFields?: string[];
  /** Maximum message length */
  maxMessageLength?: number;
  /** Auto-generate correlation ID for each session */
  autoCorrelationId?: boolean;
}

// =============================================================================
// Main Configuration
// =============================================================================

/**
 * Main SDK Configuration
 */
export interface AgenticConfig {
  /** API connection settings */
  api: ApiConfig;
  /** Audio processing plugins configuration */
  audio?: AudioPluginConfig;
  /** Additional plugins (NER, TTS, etc.) */
  plugins?: PluginConfig;
  /** Model registry for STT, VAD, NER models */
  models?: ModelRegistryConfig;
  /** User personalization settings */
  personalization?: PersonalizationConfig;
  /** Logging configuration for observability */
  logging?: LoggingConfig;
  /** Debug mode - enables verbose logging */
  debug?: boolean;
  /**
   * Auto-wire the provider's default 401→refresh handler
   * onto the single-slot `AgenticClient.setOnUnauthorized`. Defaults to `true`
   * (refresh works out of the box). Set to `false` when
   * the host owns its own impersonation-aware 401 handling (e.g. a consumer's
   * `useAutoRefresh`) so the slot has one deterministic owner.
   */
  autoWireTokenRefresh?: boolean;
}

/**
 * API Configuration
 */
export interface ApiConfig {
  /** Base URL for the API (e.g., 'https://api.arcaai.com') */
  baseUrl: string;
  /** JWT/OAuth2 access token sent as Authorization: Bearer (for user identity) */
  accessToken?: string;
  /** API key sent as X-API-Key (for system/third-party keys) */
  apiKey?: string;
  /** Tenant ID (optional, for multi-tenant setups) */
  tenantId?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** WebSocket base URL for streaming connections (defaults to same host as baseUrl) */
  wsUrl?: string;
  /** Client-side rate limiting (sliding window). Omit to disable. */
  rateLimit?: { maxRequests: number; windowMs: number };
}

// =============================================================================
// Audio Plugin Configuration
// =============================================================================

/**
 * Audio Plugin Configuration
 * Each plugin can be enabled with a boolean or configured with options
 */
export interface AudioPluginConfig {
  /** Noise filter configuration */
  noiseFilter?: NoiseFilterPluginConfig | boolean;
  /** Voice Activity Detection configuration */
  vad?: VADPluginConfig | boolean;
  /** Speech-to-Text configuration */
  stt?: STTPluginConfig | boolean;
}

/**
 * Noise Filter Plugin Configuration
 */
export interface NoiseFilterPluginConfig {
  /** Enable noise filter */
  enabled: boolean;
  /** Noise cancellation level */
  level?: 'low' | 'medium' | 'high';
}

/**
 * VAD Plugin Configuration
 */
export interface VADPluginConfig {
  /** Enable VAD */
  enabled: boolean;
  /** Speech detection sensitivity (0-1, default: 0.5) */
  sensitivity?: number;
  /** Minimum speech duration in ms (default: 250) */
  minSpeechDuration?: number;
  /** Minimum silence duration in ms to end speech (default: 500) */
  minSilenceDuration?: number;
}

/**
 * STT Plugin Configuration
 */
export interface STTPluginConfig {
  /** Enable STT */
  enabled: boolean;
  /** Provider selection */
  provider?: 'local' | 'backend' | 'auto';
  /** Language code (e.g., 'en', 'th') */
  language?: string;
  /**
   * End-user language mode id, e.g. `'en'`, `'ml'`, `'ml-en'`
   * `'auto'`. Default for the backend STT session; a per-capture
   * `audio.start({ languageMode })` overrides it.
   */
  languageMode?: string;
  /** Model ID from model registry */
  modelId?: string;
  /** Backend ASR pipeline ID or slug (required for provider: 'backend') */
  pipelineId?: string;
  /** WebSocket URL for backend STT streaming (overrides api.wsUrl + default path) */
  sttSocket?: string;
  // v1-compatibility
  requireTenantClaim?: boolean;
  /** Enable speaker diarization */
  diarization?: boolean;
  /** Expected number of speakers when diarization is enabled */
  numSpeakers?: number;
  /** Timestamp granularity for STT output */
  returnTimestamps?: boolean | 'word';
  /** Let model auto-detect language for multilingual/code-switching audio */
  codeSwitching?: boolean;
  /**
   * Server-resolved EFFECTIVE transcription mode (admin-owned).
   * Injected by `AgenticProvider` from the UserPreferences cascade; honored by
   * `TranscriptionPipeline.resolveSTTRuntimeProvider()` ahead of provider/location.
   */
  transcriptionMode?: 'LOCAL' | 'BACKEND';
}

// =============================================================================
// Additional Plugins Configuration
// =============================================================================

/**
 * Additional Plugins Configuration
 */
export interface PluginConfig {
  /** Named Entity Recognition */
  ner?: NERPluginConfig;
  /** Text-to-Speech (future) */
  tts?: TTSPluginConfig;
}

/**
 * NER Plugin Configuration
 */
export interface NERPluginConfig {
  /** Enable NER */
  enabled: boolean;
  /** Automatically extract entities from transcriptions */
  autoExtract?: boolean;
  /** Entity types to extract (e.g., ['DISEASE', 'MEDICATION']) */
  entityTypes?: string[];
  /** Model to use ('default', 'biomedical', 'clinical', or HuggingFace model ID) */
  model?: 'default' | 'biomedical' | 'clinical' | string;
  /** Confidence threshold (0-1, default: 0.5) */
  threshold?: number;
  /** Model quantization type for size/speed tradeoff */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
}

/**
 * TTS Plugin Configuration (future)
 */
export interface TTSPluginConfig {
  /** Enable TTS */
  enabled: boolean;
  /** Voice ID */
  voiceId?: string;
  /** Speech rate (0.5-2.0, default: 1.0) */
  rate?: number;
}

// =============================================================================
// Model Registry Configuration
// =============================================================================

/**
 * Model Registry Configuration
 */
export interface ModelRegistryConfig {
  /** Custom organization models */
  custom?: ModelDefinition[];
  /** Pre-selected models by type */
  selected?: {
    stt?: string;
    vad?: string;
    ner?: string;
  };
}

/**
 * Model Definition
 */
export interface ModelDefinition {
  /** Unique model identifier */
  id: string;
  /** Display name */
  name: string;
  /** Model type */
  type: 'stt' | 'vad' | 'ner';
  /** Model source */
  source: 'huggingface' | 'custom' | 'backend';
  /** URL for remote fetching (for custom/backend models) */
  url?: string;
  /** Model size hint */
  size?: 'tiny' | 'small' | 'medium' | 'large';
  /** Description */
  description?: string;
}

// =============================================================================
// Personalization Configuration
// =============================================================================

/**
 * Personalization Configuration
 */
export interface PersonalizationConfig {
  /** Storage mode for user preferences */
  storage: 'local' | 'backend' | 'hybrid';
  /** Sync interval in ms (for hybrid mode, default: 60000) */
  syncInterval?: number;
  /** Default user preferences */
  defaults?: UserPreferences;
}

/**
 * Workflow mode for consultation recording.
 * - 'local': Doctor selects individual models for each pipeline stage (browser-side processing)
 * - 'remote': Backend handles transcription via an admin-configured pipeline
 */
export type WorkflowMode = 'local' | 'remote';

/**
 * Noise cancellation configuration for local workflow
 */
export interface NoiseCancellationLocalConfig {
  /** Selected noise cancellation model ID from the model registry */
  modelId: string;
  /** Noise cancellation intensity level */
  level: 'low' | 'medium' | 'high';
}

/**
 * STT configuration for local workflow
 */
export interface STTLocalConfig {
  /** Selected STT model ID (e.g. 'whisper-large-v3') */
  modelId: string;
}

/**
 * VAD configuration for local workflow
 */
export interface VADLocalConfig {
  /** Selected VAD model ID (e.g. 'silero-vad-v5') */
  modelId: string;
  /** Speech detection sensitivity (0-1) */
  sensitivity: number;
}

/**
 * NER configuration for local workflow
 */
export interface NERLocalConfig {
  /** Selected NER model ID */
  modelId: string;
  /** Automatically extract entities from transcriptions */
  autoExtract: boolean;
}

/**
 * Voice embedding configuration for local workflow (speaker identification)
 */
export interface VoiceEmbeddingLocalConfig {
  /** Selected voice embedding model ID; empty string or 'none' = disabled */
  modelId: string;
}

/**
 * Audio silence detection configuration for local workflow
 */
export interface AudioSilenceLocalConfig {
  /** Selected audio silence model ID; empty string or 'none' = disabled */
  modelId: string;
}

/**
 * Diarization configuration for local workflow (voice embedding based)
 */
export interface DiarizationLocalConfig {
  /** Enable speaker diarization */
  enabled: boolean;
  /** Automatically register new speakers via voice embedding */
  autoEnroll: boolean;
}

/**
 * Voice profile preferences for the local workflow.
 *
 * The activated voice profile itself lives in `UserVoiceProfile` on the backend (the canonical
 * source of truth for `isActive`). This config captures behavioural preferences AROUND voice
 * profiles -- things the doctor can toggle from the SDK without re-enrolling. The currently
 * active profile is exposed as `UserPreferences.activeVoiceProfile` (read-only).
 */
export interface VoiceProfileLocalConfig {
  /** When a new enrollment succeeds and no profile is currently active, auto-activate it. */
  autoActivateLatest?: boolean;
  /** Local diarizer cosine-similarity threshold for matching a known speaker (0-1, default 0.97). */
  similarityThreshold?: number;
  /** Whether to anchor the local diarizer to the user's active voice profile when one exists. */
  useBackendAnchor?: boolean;
}

/**
 * Local workflow configuration.
 * Doctor selects individual models for each pipeline stage.
 */
export interface LocalWorkflowConfig {
  /** Noise cancellation model and level */
  noiseCancellation: NoiseCancellationLocalConfig;
  /** Speech-to-text model selection */
  stt: STTLocalConfig;
  /** Voice Activity Detection model and sensitivity */
  vad: VADLocalConfig;
  /** Named Entity Recognition model and behavior */
  ner: NERLocalConfig;
  /** Speaker diarization via voice embedding */
  diarization: DiarizationLocalConfig;
  /** Voice embedding model for speaker identification */
  voiceEmbedding: VoiceEmbeddingLocalConfig;
  /** Audio silence detection model */
  audioSilence: AudioSilenceLocalConfig;
  /** Voice profile preferences (active profile lives in UserVoiceProfile) */
  voiceProfile: VoiceProfileLocalConfig;
}

/**
 * Active voice profile summary, resolved from `UserVoiceProfile.isActive` on the backend.
 * Read-only -- mutations go through the voice profile endpoints (enroll/activate/deactivate).
 */
export interface ActiveVoiceProfileSummary {
  /** Voice profile ID (references UserVoiceProfile) */
  id: string;
  /** Optional doctor-supplied label */
  label?: string;
  /** STT embedding model that produced the profile */
  modelId?: string;
  /** Profile creation timestamp (ISO-8601) */
  createdAt: string;
}

/**
 * Remote workflow configuration (read-only, resolved from admin config).
 * Included in the response so doctors can see their assigned pipeline.
 */
export interface RemoteConfigResponse {
  /** Assigned ASR pipeline ID */
  pipelineId: string;
  /** Human-readable pipeline name (resolved from AsrPipeline) */
  pipelineName?: string;
  /** How the pipeline was assigned */
  assignedBy: 'admin' | 'tenant-default';
  /** Whether code-switching is enabled in the pipeline YAML */
  codeSwitchingEnabled?: boolean;
}

/**
 * User Preferences (persisted per user/doctor).
 *
 * Workflow-oriented structure:
 * - Shared settings (language, dnaStyleId) apply to both modes
 * - localConfig: doctor-controlled model selections for local processing
 * - remoteConfig: read-only, resolved from admin-assigned pipeline at read time
 */
export interface UserPreferences {
  /** Workflow mode: local (doctor selects models) or remote (admin-configured pipeline) */
  workflowMode?: WorkflowMode;
  /** Preferred language code (e.g. 'en', 'th') */
  language?: string;
  /** DNA writing style ID for summarization */
  dnaStyleId?: string;
  /** Local workflow model configuration (used when workflowMode === 'local') */
  localConfig?: Partial<LocalWorkflowConfig>;
  /** Read-only remote pipeline info (resolved from admin config, not settable by doctors) */
  remoteConfig?: RemoteConfigResponse;
  /**
   * Read-only summary of the currently active voice profile, resolved from
   * `UserVoiceProfile.isActive` at read time. Mutations go through the voice profile
   * endpoints (`enroll`, `activate`, `deactivate`) -- this field is informational only.
   */
  activeVoiceProfile?: ActiveVoiceProfileSummary;
  /**
   * Read-only EFFECTIVE transcription mode resolved server-side
   * (locked ⇒ tenant default wins; unlocked ⇒ `workflowMode` overrides). NOT
   * settable by doctors (see `UserPreferencesUpdate`); the SDK re-projects it
   * into `resolvedConfig.stt.transcriptionMode` (admin-owned).
   */
  transcriptionMode?: 'LOCAL' | 'BACKEND';
  /** Read-only: whether the tenant locked the transcription mode. */
  transcriptionModeLocked?: boolean;
  /** Custom preferences (extensible) */
  custom?: Record<string, unknown>;
}

/**
 * User preferences update payload (what doctors can change).
 * remoteConfig and codeSwitching are NOT included -- they are admin-controlled.
 */
export interface UserPreferencesUpdate {
  workflowMode?: WorkflowMode;
  language?: string;
  dnaStyleId?: string;
  localConfig?: Partial<LocalWorkflowConfig>;
  custom?: Record<string, unknown>;
}

// =============================================================================
// Default Configurations
// =============================================================================

/**
 * Default local workflow configuration
 */
export const DEFAULT_LOCAL_CONFIG: LocalWorkflowConfig = {
  noiseCancellation: { modelId: 'rnnoise', level: 'medium' },
  // Browser-loadable Whisper default. `whisper-large-v3` is NOT browser-loadable
  // (the onnx-community repo is gated / 401s); local STT runs tiny/base/small.
  stt: { modelId: 'whisper-base' },
  vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
  // Optional feature — the model id is retained for opt-in, but auto-extraction
  // stays OFF by default. Medical NER pulls the ~300MB `@arcaai/med-ner`
  // peer; it runs only when a consumer explicitly enables `autoExtract`.
  ner: { modelId: 'biomedical', autoExtract: false },
  diarization: { enabled: false, autoEnroll: false },
  voiceEmbedding: { modelId: '' },
  audioSilence: { modelId: '' },
  voiceProfile: {
    autoActivateLatest: true,
    similarityThreshold: 0.97,
    useBackendAnchor: true,
  },
};

/**
 * Default audio plugin configuration
 */
/**
 * Optional audio features default OFF.
 *
 * VAD and noise cancellation are opt-in: each pulls a runtime model on the first
 * `audio.start()` (VAD → Silero ONNX + ORT WASM from the jsDelivr CDN; noise →
 * RNNoise WASM). A consumer that never states an audio preference falls through
 * to this default via `AgenticProvider`'s `cfg.audio ?? DEFAULT_AUDIO_CONFIG`, so
 * enabling them here forced an unsolicited CDN fetch on every such app. STT is the
 * core capability, not an optional add-on, so it stays enabled. Opt in per stage
 * with `audio.vad.enabled` / `audio.noiseFilter.enabled` (core) or
 * `audioSettings.voiceActivityDetection` / `noiseSuppression` (compat).
 */
export const DEFAULT_AUDIO_CONFIG: AudioPluginConfig = {
  noiseFilter: { enabled: false, level: 'medium' },
  vad: { enabled: false, sensitivity: 0.5 },
  stt: {
    enabled: true,
    provider: 'auto',
    language: 'en',
    returnTimestamps: 'word',
    codeSwitching: false,
  },
};

/**
 * Default personalization configuration
 */
export const DEFAULT_PERSONALIZATION_CONFIG: PersonalizationConfig = {
  storage: 'local',
  defaults: {
    // Backend transcription is the sane platform default; local is opt-in.
    workflowMode: 'remote',
    language: 'en',
    localConfig: { ...DEFAULT_LOCAL_CONFIG },
  },
};

/**
 * Default API configuration (timeout only)
 */
export const DEFAULT_API_TIMEOUT = 30000;

// =============================================================================
// Processing Location Configuration
// =============================================================================

/**
 * Processing location options for different tasks.
 */
export type ProcessingLocation = 'browser' | 'backend' | 'auto' | 'disabled' | 'skip';

/**
 * Trigger mode for pipeline stages.
 */
export type TriggerMode = 'auto' | 'manual';

/**
 * Processing configuration for pipelines.
 * Allows fine-grained control over where processing happens.
 */
export interface ProcessingConfig {
  /** Transcription pipeline processing locations */
  transcription: TranscriptionProcessingConfig;
  /** Knowledge pipeline processing locations */
  knowledge: KnowledgeProcessingConfig;
}

/**
 * Transcription pipeline processing configuration.
 */
export interface TranscriptionProcessingConfig {
  /** Noise filter processing */
  noiseFilter: {
    /** Processing location (browser or skip) */
    location: 'browser' | 'skip';
    /** Noise cancellation level */
    level?: 'low' | 'medium' | 'high';
  };
  /** VAD processing (always browser) */
  vad: {
    /** Processing location (always browser) */
    location: 'browser';
    /** Speech detection sensitivity */
    sensitivity?: number;
  };
  /** STT processing */
  stt: {
    /** Processing location */
    location: 'browser' | 'backend' | 'auto';
    /** Provider type */
    provider?: 'local' | 'backend' | 'auto';
    /** Language code */
    language?: string;
    /** Model ID for local processing */
    modelId?: string;
    /** WebSocket URL for backend STT streaming */
    sttSocket?: string;
    /** Backend ASR pipeline ID or slug */
    pipelineId?: string;
  };
}

/**
 * Knowledge pipeline processing configuration.
 */
export interface KnowledgeProcessingConfig {
  /** NER processing */
  ner: {
    /** Processing location */
    location: 'browser' | 'backend' | 'auto' | 'disabled';
    /** Trigger mode */
    triggerMode: TriggerMode;
    /** Model ID */
    model?: string;
    /** Confidence threshold */
    threshold?: number;
  };
  /** Spell check processing */
  spellCheck: {
    /** Processing location */
    location: 'browser' | 'backend' | 'disabled';
    /** Trigger mode */
    triggerMode: TriggerMode;
  };
  /** Summarization processing */
  summarization: {
    /** Processing location (always backend or disabled) */
    location: 'backend' | 'disabled';
    /** Trigger mode (always manual) */
    triggerMode: 'manual';
    /** DNA style ID for personalization */
    dnaStyleId?: string;
  };
}

/**
 * Default processing configuration.
 */
export const DEFAULT_PROCESSING_CONFIG: ProcessingConfig = {
  transcription: {
    noiseFilter: {
      location: 'browser',
      level: 'high',
    },
    vad: {
      location: 'browser',
      sensitivity: 0.5,
    },
    stt: {
      location: 'auto',
      provider: 'auto',
      language: 'en-US',
    },
  },
  knowledge: {
    ner: {
      location: 'browser',
      triggerMode: 'auto',
      threshold: 0.6,
    },
    spellCheck: {
      location: 'disabled',
      triggerMode: 'manual',
    },
    summarization: {
      location: 'backend',
      triggerMode: 'manual',
    },
  },
};

// =============================================================================
// Session Configuration
// =============================================================================

/**
 * Session persistence configuration.
 */
export interface SessionPersistenceConfig {
  /** Enable session state persistence */
  enabled: boolean;
  /** Storage type for persistence */
  storage: 'sessionStorage' | 'localStorage';
  /** Whether to restore audio capture on refresh */
  restoreAudioCapture: boolean;
  /** Whether to restore pipeline states on refresh */
  restorePipelineStates: boolean;
}

/**
 * Default session persistence configuration.
 */
export const DEFAULT_SESSION_PERSISTENCE_CONFIG: SessionPersistenceConfig = {
  enabled: true,
  storage: 'sessionStorage',
  restoreAudioCapture: false, // Audio requires user gesture, so default to false
  restorePipelineStates: true,
};

/**
 * Cross-tab session configuration.
 */
export interface CrossTabConfig {
  /** Enable cross-tab session sharing */
  enabled: boolean;
  /** Audio lock timeout in milliseconds */
  audioLockTimeoutMs: number;
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
}

/**
 * Default cross-tab configuration.
 */
export const DEFAULT_CROSS_TAB_CONFIG: CrossTabConfig = {
  enabled: true,
  audioLockTimeoutMs: 5000,
  heartbeatIntervalMs: 2000,
};

// =============================================================================
// Tenant Audio Configuration
// =============================================================================

/**
 * Feature flags derived from tenant GlobalSetting records (namespace: feature-flags).
 */
export interface TenantFeatureFlags {
  realTimeTranscription: boolean;
  nerExtraction: boolean;
  codeSwitching: boolean;
  dnaStyle: boolean;
  crossChainSummary: boolean;
}

/**
 * Tenant-scoped audio/AI configuration parsed from GlobalSetting records.
 *
 * The SDK fetches `GET /tenant/me/config` at initialization (the server resolves
 * the tenant from the JWT token) and transforms the flat key-value list into
 * this structured interface.
 *
 * Namespace mapping:
 *   - `stt` -> `defaultSttModel`, `vadSensitivity`
 *   - `smr` -> `defaultSmrProvider`, `defaultSmrModel`
 *   - `general` -> `defaultLanguage`
 *   - `feature-flags` -> `features.*`
 *   - `ux-constants` -> `localAsrModels`, `localVadModels`, `localNoiseSuppressionModels`
 */
export interface TenantAudioConfig {
  defaultSttModel?: string;
  vadSensitivity?: number;
  defaultSmrProvider?: string;
  defaultSmrModel?: string;
  defaultLanguage?: string;
  features: TenantFeatureFlags;
  /**
   * Server-computed effective local raw-capture flag
   * (platform capability AND tenant toggle). Read-only from the client's
   * perspective; the provider maps it into `audio.captureRawAudio`.
   */
  captureRawAudio?: boolean;
  localAsrModels?: LocalAsrModelInfo[];
  localVadModels?: LocalVadModelInfo[];
  localNoiseSuppressionModels?: LocalNoiseSuppressionModelInfo[];
}

export interface LocalAsrModelInfo {
  id: string;
  name: string;
}

export interface LocalVadModelInfo {
  id: string;
  name: string;
}

export interface LocalNoiseSuppressionModelInfo {
  id: string;
  name: string;
}

/**
 * Default feature flags when no tenant config is loaded.
 */
export const DEFAULT_TENANT_FEATURES: TenantFeatureFlags = {
  realTimeTranscription: true,
  nerExtraction: true,
  codeSwitching: false,
  dnaStyle: true,
  crossChainSummary: false,
};

/**
 * Tenant config setting key constants matching the GlobalSetting `key` column
 * in `packages/database/src/prisma/db_main/seed/11-global-setting.ts`.
 */
export const TENANT_CONFIG_KEYS = {
  DEFAULT_STT_MODEL: 'default-stt-model',
  VAD_SENSITIVITY: 'vad-sensitivity',
  DEFAULT_SMR_PROVIDER: 'default-smr-provider',
  DEFAULT_SMR_MODEL: 'default-smr-model',
  DEFAULT_LANGUAGE: 'default-language',
  ENABLE_REAL_TIME_TRANSCRIPTION: 'enable-real-time-transcription',
  ENABLE_NER_EXTRACTION: 'enable-ner-extraction',
  ENABLE_CODE_SWITCHING: 'enable-code-switching',
  ENABLE_DNA_STYLE: 'enable-dna-style',
  ENABLE_CROSS_CHAIN_SUMMARY: 'enable-cross-chain-summary',
  // Server-computed effective flag (platform capability AND tenant
  // toggle) for local raw-stream audio capture. Surfaced via GET
  // /tenant/me/config and mapped into audio.captureRawAudio (admin-owned;
  // user preferences cannot override it).
  ENABLE_LOCAL_RAW_CAPTURE: 'enable-local-raw-capture',
  LOCAL_ASR_MODELS: 'local-asr-models',
  LOCAL_VAD_MODELS: 'local-vad-models',
  LOCAL_NOISE_SUPPRESSION_MODELS: 'local-noise-suppression-models',
} as const;

interface TenantSettingRecord {
  key: string;
  value: unknown;
  namespace?: string;
  [k: string]: unknown;
}

function settingValue(settings: TenantSettingRecord[], key: string): string | undefined {
  const entry = settings.find((s) => s.key === key);
  if (entry === undefined) return undefined;
  return String(entry.value);
}

function settingBool(settings: TenantSettingRecord[], key: string, fallback: boolean): boolean {
  const v = settingValue(settings, key);
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function settingFloat(settings: TenantSettingRecord[], key: string): number | undefined {
  const v = settingValue(settings, key);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isNaN(n) ? undefined : n;
}

function settingJsonArray<T>(settings: TenantSettingRecord[], key: string): T[] | undefined {
  const entry = settings.find((s) => s.key === key);
  if (entry === undefined) return undefined;

  const raw = entry.value;
  if (Array.isArray(raw)) return raw as T[];

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Parse a flat list of GlobalSetting records into a structured TenantAudioConfig.
 */
export function parseTenantConfig(settings: TenantSettingRecord[]): TenantAudioConfig {
  const K = TENANT_CONFIG_KEYS;
  const D = DEFAULT_TENANT_FEATURES;

  return {
    defaultSttModel: settingValue(settings, K.DEFAULT_STT_MODEL),
    vadSensitivity: settingFloat(settings, K.VAD_SENSITIVITY),
    defaultSmrProvider: settingValue(settings, K.DEFAULT_SMR_PROVIDER),
    defaultSmrModel: settingValue(settings, K.DEFAULT_SMR_MODEL),
    defaultLanguage: settingValue(settings, K.DEFAULT_LANGUAGE),
    features: {
      realTimeTranscription: settingBool(settings, K.ENABLE_REAL_TIME_TRANSCRIPTION, D.realTimeTranscription),
      nerExtraction: settingBool(settings, K.ENABLE_NER_EXTRACTION, D.nerExtraction),
      codeSwitching: settingBool(settings, K.ENABLE_CODE_SWITCHING, D.codeSwitching),
      dnaStyle: settingBool(settings, K.ENABLE_DNA_STYLE, D.dnaStyle),
      crossChainSummary: settingBool(settings, K.ENABLE_CROSS_CHAIN_SUMMARY, D.crossChainSummary),
    },
    captureRawAudio: settingBool(settings, K.ENABLE_LOCAL_RAW_CAPTURE, false),
    localAsrModels: settingJsonArray<LocalAsrModelInfo>(settings, K.LOCAL_ASR_MODELS),
    localVadModels: settingJsonArray<LocalVadModelInfo>(settings, K.LOCAL_VAD_MODELS),
    localNoiseSuppressionModels: settingJsonArray<LocalNoiseSuppressionModelInfo>(settings, K.LOCAL_NOISE_SUPPRESSION_MODELS),
  };
}
