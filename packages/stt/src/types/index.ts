/**
 * @arcaai/stt - Type Definitions
 *
 * Core type definitions for the Speech-to-Text plugin.
 */

// ============================================================================
// Model Types
// ============================================================================

/**
 * Available Whisper model sizes.
 * Smaller models are faster but less accurate.
 */
export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large';

/**
 * Compute device for model inference.
 * - 'webgpu': Uses WebGPU for GPU acceleration (fastest, if supported)
 * - 'wasm': Uses WebAssembly (works everywhere)
 * - 'auto': Automatically selects best available option
 */
export type ComputeDevice = 'webgpu' | 'wasm' | 'auto';

/**
 * STT provider type.
 * - 'local': Process audio locally using Whisper in browser
 * - 'remote': Send audio to backend server via WebSocket
 */
export type STTProviderType = 'local' | 'remote';

/**
 * Whisper inference task.
 *
 * - `'transcribe'` (default) — return the spoken text in the source language.
 * - `'translate'` — translate from the source language **to English**. The
 *   model itself decides the source language; only the **output** is English.
 *   English-only Whisper checkpoints (model IDs ending with `.en`) cannot
 *   translate and will be rejected with `STTError(NOT_SUPPORTED)` at the
 *   engine layer.
 */
export type WhisperTask = 'transcribe' | 'translate';

// ============================================================================
// Language Types
// ============================================================================

/**
 * Language locale code following ISO 639-1 language code combined with
 * ISO 3166-1 country code (e.g., 'en-US', 'fr-FR', 'zh-CN').
 *
 * Common locale codes:
 * - 'en-US': English (United States)
 * - 'en-GB': English (United Kingdom)
 * - 'es-ES': Spanish (Spain)
 * - 'es-MX': Spanish (Mexico)
 * - 'fr-FR': French (France)
 * - 'de-DE': German (Germany)
 * - 'zh-CN': Chinese (Simplified, China)
 * - 'zh-TW': Chinese (Traditional, Taiwan)
 * - 'ja-JP': Japanese (Japan)
 * - 'ko-KR': Korean (South Korea)
 * - 'pt-BR': Portuguese (Brazil)
 * - 'it-IT': Italian (Italy)
 * - 'nl-NL': Dutch (Netherlands)
 * - 'ru-RU': Russian (Russia)
 * - 'ar-SA': Arabic (Saudi Arabia)
 * - 'hi-IN': Hindi (India)
 * - 'vi-VN': Vietnamese (Vietnam)
 */
export type LanguageLocale = string;

/**
 * Default language locale.
 */
export const DEFAULT_LANGUAGE_LOCALE: LanguageLocale = 'en-US';

// ============================================================================
// Audio Configuration
// ============================================================================

/**
 * Audio source configuration options.
 */
export interface AudioSourceConfig {
  /**
   * Language locale for the audio source.
   * Uses ISO 639-1 language code with ISO 3166-1 country code.
   * @default 'en-US'
   */
  language?: LanguageLocale;

  /**
   * Audio sample rate in Hz.
   * @default 16000 (Whisper standard)
   */
  sampleRate?: number;

  /**
   * Number of audio channels.
   * @default 1 (mono)
   */
  channels?: number;

  /**
   * Audio chunk length in seconds for processing.
   * @default 30
   */
  chunkLengthS?: number;

  /**
   * Overlap length in seconds between chunks.
   * This amount of audio is retained between chunks for context.
   * @default 5
   */
  overlapLengthS?: number;
}

/**
 * Default audio source configuration.
 */
export const DEFAULT_AUDIO_CONFIG: Required<AudioSourceConfig> = {
  language: DEFAULT_LANGUAGE_LOCALE,
  sampleRate: 16000,
  channels: 1,
  chunkLengthS: 30,
  overlapLengthS: 5,
};

// ============================================================================
// Feature Flags
// ============================================================================

/**
 * Feature flags for STT processor.
 */
export interface STTFeatureFlags {
  /**
   * Provider selection.
   * - 'local': Process audio locally using Whisper in browser
   * - 'remote': Send audio to backend server via WebSocket
   * @default 'remote'
   */
  provider?: STTProviderType;

  /**
   * Model ID for local provider.
   * Required when provider is 'local'.
   * Can be a Whisper model size ('tiny', 'base', 'small', 'medium', 'large')
   * or a custom Hugging Face model ID.
   */
  modelId?: WhisperModelSize | string;

  /**
   * Enable speaker diarization.
   * @default false
   */
  diarization?: boolean;

  /**
   * Number of speakers for diarization.
   * Only used when diarization is enabled.
   * @default 2
   */
  numSpeakers?: number;

  /**
   * Whether to return timestamps with transcription.
   * - true: Return chunk-level timestamps
   * - 'word': Return word-level timestamps
   * - false: No timestamps
   * @default true
   */
  returnTimestamps?: boolean | 'word';

  /**
   * If true, do not force Whisper language and let model auto-detect language.
   * Useful for multilingual/code-switching conversations.
   * @default false
   */
  codeSwitching?: boolean;

  /**
   * If true, disable continuous frame feeding and expect external segment calls
   * via `transcribeSegment()` (e.g. VAD-gated speech-only processing).
   * @default false
   */
  vadGate?: boolean;

  /**
   * Compute device for local model inference.
   * @default 'auto'
   */
  device?: ComputeDevice;

  /**
   * Use quantized models for smaller size and faster loading.
   * Only applies to local provider.
   * @default true
   */
  quantized?: boolean;

  /**
   * Whisper inference task.
   *
   * - `'transcribe'` (default) — return the spoken text in the source language.
   * - `'translate'` — translate from the source language to English. Requires
   *   a multilingual Whisper model. English-only checkpoints (model IDs
   *   ending with `.en`) reject this with `STTError(NOT_SUPPORTED)`.
   *
   * @default 'transcribe'
   */
  task?: WhisperTask;
}

/**
 * Default feature flags.
 */
export const DEFAULT_FEATURE_FLAGS: Required<Omit<STTFeatureFlags, 'modelId'>> = {
  provider: 'remote',
  diarization: false,
  numSpeakers: 2,
  returnTimestamps: true,
  codeSwitching: false,
  vadGate: false,
  device: 'auto',
  quantized: true,
  task: 'transcribe',
};

// ============================================================================
// STT Options
// ============================================================================

/**
 * Configuration options for the STTProcessor.
 */
export interface STTOptions {
  /**
   * WebSocket URL for backend STT service.
   * Required when using 'remote' provider.
   */
  sttSocket?: string;

  /**
   * Session ID for STT service.
   * If not provided, will be auto-generated.
   */
  sessionId?: string;

  /**
   * Audio source configuration.
   */
  audio?: AudioSourceConfig;

  /**
   * Feature flags for STT processing.
   */
  features?: STTFeatureFlags;

  /**
   * Initial prompt to guide transcription.
   */
  prompt?: string;

  /**
   * Optional voice-profile context for the local diarizer.
   *
   * `id` is the server-side `UserVoiceProfile.id` (carried for telemetry /
   * logging). `reservedSpeakerId` pins the first allocated speaker slot in
   * `LocalSpeakerDiarizer` to a stable doctor label. `similarityThreshold`
   * tunes the MFCC centroid matching threshold (range `[0, 1]`, lower =
   * more permissive).
   *
   * Set by the SDK from `UserPreferences.activeVoiceProfile` +
   * `UserPreferences.localConfig.voiceProfile`. All fields are optional so the
   * SDK can express partial state (e.g. threshold tweak before enrollment).
   */
  voiceProfile?: {
    id?: string;
    reservedSpeakerId?: string;
    similarityThreshold?: number;
  };

  /**
   * Enable debug mode for verbose console logging of configuration and transcripts.
   * @default false
   */
  debugMode?: boolean;

  /**
   * Enable statistics emission for monitoring.
   * @default false
   */
  enableStats?: boolean;

  /**
   * Interval for stats emission in milliseconds.
   * @default 1000
   */
  statsInterval?: number;

  /**
   * Callback for model loading progress (local only).
   */
  onModelProgress?: (progress: ModelLoadProgress) => void;
}

/**
 * Default options for STTProcessor.
 */
export const DEFAULT_STT_OPTIONS = {
  audio: DEFAULT_AUDIO_CONFIG,
  features: DEFAULT_FEATURE_FLAGS,
  debugMode: false,
  enableStats: false,
  statsInterval: 1000,
} as const;

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `stt-${timestamp}-${randomPart}`;
}

// ============================================================================
// Model Loading Types
// ============================================================================

/**
 * Progress information during model loading.
 */
export interface ModelLoadProgress {
  /**
   * Current loading status.
   */
  status: 'downloading' | 'loading' | 'ready' | 'error';

  /**
   * Download progress (0-1).
   */
  progress: number;

  /**
   * File being downloaded.
   */
  file?: string;

  /**
   * Loaded bytes.
   */
  loaded?: number;

  /**
   * Total bytes.
   */
  total?: number;

  /**
   * Error message if status is 'error'.
   */
  error?: string;
}

// ============================================================================
// Transcription Types
// ============================================================================

/**
 * Timestamp for a transcription segment or word.
 */
export interface TranscriptionTimestamp {
  /**
   * Start time in seconds.
   */
  start: number;

  /**
   * End time in seconds.
   */
  end: number;

  /**
   * Text content.
   */
  text: string;
}

/**
 * Word-level timestamp emitted by the streaming backend (stt
 * `SegmentResult.word_timestamps`). Carried through {@link TranscriptionResult.words}
 * so the SDK store can expose word timings to consumers.
 *
 * Distinct from {@link TranscriptionTimestamp} (segment-level `{ start, end, text }`):
 * this is per-word and includes an optional confidence score.
 */
export interface WordTimestamp {
  /**
   * The word text.
   */
  word: string;

  /**
   * Start time in seconds.
   */
  start: number;

  /**
   * End time in seconds.
   */
  end: number;

  /**
   * Confidence score (0-1), if the engine provides one. Whisper does not score
   * individual words, so this is optional.
   */
  confidence?: number;
}

/**
 * Result of a transcription operation.
 */
export interface TranscriptionResult {
  /**
   * Transcribed text.
   */
  text: string;

  /**
   * Whether this is a final transcription.
   */
  isFinal: boolean;

  /**
   * Language of the transcription.
   */
  language: string;

  /**
   * Confidence score (0-1), if available.
   */
  confidence?: number;

  /**
   * Timestamps for segments/words, if requested.
   */
  timestamps?: TranscriptionTimestamp[];

  /**
   * Word-level timestamps carried from the streaming backend transcript.
   * Distinct from the segment-level `timestamps` above; preserved so the
   * SDK store can surface per-word timings.
   */
  words?: WordTimestamp[];

  /**
   * Speaker ID from diarization, if available.
   */
  speakerId?: string;

  /**
   * Speaker confidence score from diarization (0-1), if available.
   */
  speakerConfidence?: number;

  /**
   * Optional voice features captured for this speaker segment.
   * Stored locally by consumers when needed for browser-side speaker profiling.
   */
  speakerFeatures?: SpeakerVoiceFeatures;

  /**
   * Duration of the audio segment in seconds.
   */
  duration?: number;

  /**
   * Processing latency in milliseconds.
   */
  latencyMs?: number;
}

/**
 * Browser-safe speaker voice feature payload.
 * Keeps vectors JSON-serializable for local storage use-cases.
 */
export interface SpeakerVoiceFeatures {
  /** Source of the feature extraction pipeline. */
  source: 'local-diarizer' | 'remote';
  /** Feature vector for this segment (if available). */
  vector?: number[];
  /** Number of samples aggregated in the source speaker profile. */
  profileSamples?: number;
  /** Similarity score used to match an existing profile. */
  similarity?: number;
  /** Capture sample rate for this segment. */
  sampleRate?: number;
}

// ============================================================================
// Statistics Types
// ============================================================================

/**
 * Statistics about STT processing.
 */
export interface STTStats {
  /**
   * Whether the STT processor is currently active.
   */
  isActive: boolean;

  /**
   * Whether currently processing audio.
   */
  isProcessing: boolean;

  /**
   * Total audio processed in seconds.
   */
  totalAudioProcessed: number;

  /**
   * Total transcriptions completed.
   */
  transcriptionCount: number;

  /**
   * Average processing latency in milliseconds.
   */
  averageLatencyMs: number;

  /**
   * Current buffer size in seconds.
   */
  bufferSizeS: number;

  /**
   * Provider type in use.
   */
  providerType: STTProviderType;

  /**
   * Model in use (local only).
   */
  model?: string;

  /**
   * Compute device in use (local only).
   */
  device?: ComputeDevice;

  /**
   * WebSocket connection status (remote only).
   */
  connectionStatus?: 'connected' | 'disconnected' | 'connecting' | 'error';

  /**
   * Outbound audio frames dropped at the streaming client's bufferedAmount
   * watermark since the session started (remote streaming only).
   * Non-zero means PCM was lost from the durable transcript; consumers surface
   * it as a degraded-connection signal. Undefined for providers that cannot drop.
   */
  droppedFrames?: number;

  /**
   * Session ID.
   */
  sessionId?: string;

  /**
   * Language locale in use.
   */
  language?: LanguageLocale;

  /**
   * Timestamp when stats were collected.
   */
  timestamp: number;
}

// ============================================================================
// Event Payload Types
// ============================================================================

/**
 * Payload for transcription events.
 */
export interface STTTranscriptionPayload {
  type: 'stt-transcription' | 'stt-partial';
  data: TranscriptionResult;
  timestamp: number;
}

/**
 * Payload for speech start event.
 */
export interface STTSpeechStartPayload {
  type: 'stt-speech-start';
  timestamp: number;
}

/**
 * Payload for speech end event.
 */
export interface STTSpeechEndPayload {
  type: 'stt-speech-end';
  duration: number;
  timestamp: number;
}

/**
 * Payload for model loaded event.
 */
export interface STTModelLoadedPayload {
  type: 'stt-model-loaded';
  model: string;
  device: ComputeDevice;
  loadTimeMs: number;
  timestamp: number;
}

/**
 * Payload for stats event.
 */
export interface STTStatsPayload {
  type: 'stt-stats';
  data: STTStats;
  timestamp: number;
}

/**
 * All possible STT data event types.
 */
export type STTDataEventType = 'stt-transcription' | 'stt-partial' | 'stt-speech-start' | 'stt-speech-end' | 'stt-model-loaded' | 'stt-stats';

/**
 * Union of all STT data payloads.
 */
export type STTDataPayload = STTTranscriptionPayload | STTSpeechStartPayload | STTSpeechEndPayload | STTModelLoadedPayload | STTStatsPayload;

// ============================================================================
// WebSocket Message Types
// ============================================================================

/**
 * Audio metadata sent with audio chunks to backend.
 */
export interface AudioMetadata {
  /**
   * Device ID of the audio source.
   */
  deviceId?: string;

  /**
   * Role of the audio (e.g., 'user', 'agent').
   */
  role?: string;

  /**
   * Sample rate of the audio.
   */
  sampleRate?: number;

  /**
   * Number of channels.
   */
  channels?: number;
}

/**
 * Messages sent to the backend WebSocket.
 */
export type WSOutboundMessage = { type: 'audio'; data: number[]; metadata?: AudioMetadata } | { type: 'stop' } | { type: 'ping' };

/**
 * Messages received from the backend WebSocket.
 */
export type WSInboundMessage =
  | { type: 'connected'; session_id: string; audio_config: Record<string, unknown>; timestamp: string }
  | { type: 'transcription'; text: string; is_final: boolean; speaker_id: string; session_id: string; language: string }
  | { type: 'keepalive'; session_id: string; timestamp: string }
  | { type: 'pong'; session_id: string; timestamp: string }
  | { type: 'stopped'; session_id: string; timestamp: string }
  | { type: 'error'; message: string; session_id: string };

// ============================================================================
// Browser Support Types
// ============================================================================

/**
 * Browser support information for STT features.
 */
export interface STTBrowserSupport {
  /**
   * Whether WebAssembly is supported.
   */
  webAssembly: boolean;

  /**
   * Whether WebGPU is supported.
   */
  webGPU: boolean;

  /**
   * Whether AudioWorklet is supported.
   */
  audioWorklet: boolean;

  /**
   * Whether WebSocket is supported.
   */
  webSocket: boolean;

  /**
   * Whether SharedArrayBuffer is supported.
   */
  sharedArrayBuffer: boolean;

  /**
   * Whether Transformers.js can run in this browser.
   */
  transformersJsSupported: boolean;

  /**
   * Recommended compute device based on capabilities.
   */
  recommendedDevice: ComputeDevice;

  /**
   * Recommended provider based on capabilities.
   */
  recommendedProvider: Exclude<STTProviderType, 'auto'>;

  /**
   * Whether local STT is fully supported.
   */
  localSupported: boolean;

  /**
   * Whether backend STT is supported.
   */
  backendSupported: boolean;

  /**
   * Reason if STT is not supported.
   */
  unsupportedReason?: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes specific to the STT processor.
 */
export enum STTErrorCode {
  /** Model failed to load */
  MODEL_LOAD_FAILED = 'MODEL_LOAD_FAILED',
  /** WebSocket connection failed */
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  /** Session not found or expired */
  SESSION_ERROR = 'SESSION_ERROR',
  /** Audio processing error */
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  /** Browser does not support required features */
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  /** Invalid configuration provided */
  INVALID_CONFIG = 'INVALID_CONFIG',
  /** Transcription failed */
  TRANSCRIPTION_FAILED = 'TRANSCRIPTION_FAILED',
  /** Provider initialization failed */
  PROVIDER_INIT_FAILED = 'PROVIDER_INIT_FAILED',
}

/**
 * Custom error class for STT processor errors.
 */
export class STTError extends Error {
  constructor(
    public readonly code: STTErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'STTError';
  }
}

// ============================================================================
// Provider Configuration Types
// ============================================================================

/**
 * Base configuration for STT providers.
 */
export interface ProviderConfig {
  /**
   * Session ID for the STT session.
   */
  sessionId: string;

  /**
   * Language locale for transcription.
   */
  language: LanguageLocale;

  /**
   * Sample rate of input audio.
   */
  sampleRate: number;

  /**
   * Number of audio channels.
   */
  channels: number;

  /**
   * Chunk length in seconds.
   */
  chunkLengthS: number;

  /**
   * Overlap length in seconds between chunks.
   */
  overlapLengthS: number;

  /**
   * Whether to return timestamps.
   */
  returnTimestamps: boolean | 'word';

  /**
   * If true, let Whisper auto-detect language for multilingual/code-switching audio.
   */
  codeSwitching?: boolean;

  /**
   * Enable speaker diarization.
   */
  diarization: boolean;

  /**
   * Number of speakers for diarization.
   */
  numSpeakers: number;
}

/**
 * Configuration specific to local provider.
 */
export interface LocalProviderConfig extends ProviderConfig {
  /**
   * Model ID - can be a Whisper model size or custom model path.
   */
  modelId: WhisperModelSize | string;

  /**
   * Compute device to use.
   */
  device: ComputeDevice;

  /**
   * Whether to use quantized models.
   */
  quantized: boolean;

  /**
   * Initial prompt to guide transcription. Forwarded to Whisper as
   * `initial_prompt` on every transcribe call — useful for biasing the
   * model toward domain-specific vocabulary (e.g. medical terminology).
   */
  prompt?: string;

  /**
   * Progress callback.
   */
  onProgress?: (progress: ModelLoadProgress) => void;

  /**
   * Default Whisper task baked into the engine for this provider instance.
   * Forwarded into `EngineConfig.task` at `LocalSTTProvider.init()` time.
   * Per-call `TranscribeOptions.task` still wins; this field exists so the
   * provider pool key can distinguish a transcribe-warm provider from a
   * translate-warm provider.
   *
   * @default 'transcribe'
   */
  task?: WhisperTask;

  /**
   * Optional reserved-speaker slot for the enrolled doctor.
   *
   * When `reservedSpeakerId` is set, `LocalSpeakerDiarizer` pins the FIRST
   * allocated speaker slot to that id instead of the default `speaker-1`.
   * `similarityThreshold` lets the user tune the cosine-similarity threshold
   * used by the MFCC centroid matcher; lower means more permissive matching
   * to the doctor's profile (default `0.97`).
   *
   * The 40-d MFCC (local) vs 256-d backend embedding mismatch means the
   * acoustic anchor itself cannot yet be shared — long-term unification
   * onto a single ONNX speaker-embedding model is a tracked roadmap item.
   */
  voiceProfile?: {
    /** Server-side voice profile id (UUID). Optional so the SDK can carry a
     * threshold-only preference even before the doctor enrolls. */
    id?: string;
    /** Display name / stable id to pin to the first speaker slot. Optional;
     * when absent the diarizer keeps its default `speaker-1` slot label. */
    reservedSpeakerId?: string;
    /**
     * Cosine-similarity threshold used by the local MFCC diarizer when
     * matching an incoming utterance to an existing speaker centroid.
     * Range `[0, 1]`. Lower values are more permissive.
     * @default 0.97 (see `LocalSpeakerDiarizer.DEFAULT_SIMILARITY_THRESHOLD`)
     */
    similarityThreshold?: number;
  };
}

/**
 * Configuration specific to remote provider.
 */
export interface RemoteProviderConfig extends ProviderConfig {
  /**
   * WebSocket URL for STT service.
   */
  sttSocket: string;

  /**
   * Initial prompt to guide transcription.
   */
  prompt?: string;
}

/**
 * @deprecated Use RemoteProviderConfig instead.
 */
export type BackendProviderConfig = RemoteProviderConfig;

// ============================================================================
// Utility Functions
// ============================================================================

const WHISPER_MODEL_SIZES: readonly string[] = ['tiny', 'base', 'small', 'medium', 'large'];

/**
 * Check if a string is a valid Whisper model size.
 * Accepts both bare names ('tiny') and prefixed names ('whisper-tiny').
 */
export function isWhisperModelSize(value: string): value is WhisperModelSize {
  const normalized = value.replace(/^whisper-/, '');
  return WHISPER_MODEL_SIZES.includes(normalized);
}

/**
 * Normalize a model ID to a bare Whisper model size if applicable.
 * Strips 'whisper-' prefix if present (e.g. 'whisper-tiny' → 'tiny').
 * Returns the original value if it's not a recognized model size.
 */
export function normalizeModelId(modelId: string): string {
  const stripped = modelId.replace(/^whisper-/, '');
  return WHISPER_MODEL_SIZES.includes(stripped) ? stripped : modelId;
}

/**
 * Parse a model ID and return the Whisper model size if applicable.
 * Returns undefined if the model ID is a custom path.
 */
export function parseModelId(modelId: string): WhisperModelSize | undefined {
  const normalized = normalizeModelId(modelId);
  return isWhisperModelSize(normalized) ? normalized : undefined;
}

/**
 * Whisper sizes that are published as browser-loadable `onnx-community` repos
 * and small enough for in-browser inference. The `large`/`medium` checkpoints
 * are NOT loadable in the browser — e.g. `onnx-community/whisper-large-v3` is
 * gated and returns HTTP 401 — so they must never be selected for local STT.
 */
const BROWSER_LOADABLE_WHISPER_SIZES: readonly WhisperModelSize[] = ['tiny', 'base', 'small'];

/**
 * Default browser-loadable Whisper size, used when a configured local model id
 * is not browser-loadable. `base` (~150 MB) balances size and accuracy.
 */
export const DEFAULT_LOCAL_WHISPER_SIZE: WhisperModelSize = 'base';

/**
 * Resolve a configured STT model id into a browser-loadable Whisper source for
 * the local pipeline, returning `{ model, modelPath }` for the engine:
 * - `modelPath` set   → load this explicit HuggingFace repo verbatim.
 * - `modelPath` unset → the engine derives `onnx-community/whisper-<model>`.
 *
 * Resolution order:
 * 1. A recognized, browser-loadable Whisper size ("tiny"/"base"/"small", with
 *    or without the "whisper-" prefix) → use that size.
 * 2. A namespaced HuggingFace repo id ("org/name") → trust it as `modelPath`.
 * 3. Anything else — a bare non-namespaced id ("whisper-large-v3"), or a
 *    too-large size ("medium"/"large") with no browser-loadable onnx repo — is
 *    NOT loadable in the browser. Returning it as a bare path makes the worker
 *    request `huggingface.co/<id>` and fail (401/404), so fall back to
 *    {@link DEFAULT_LOCAL_WHISPER_SIZE} and warn instead.
 */
export function resolveLocalWhisperModel(modelId: string): {
  model: WhisperModelSize;
  modelPath?: string;
} {
  const normalized = normalizeModelId(modelId);

  if (isWhisperModelSize(normalized)) {
    const size = normalized as WhisperModelSize;
    if (BROWSER_LOADABLE_WHISPER_SIZES.includes(size)) {
      return { model: size };
    }
    console.warn(
      `[stt] Local Whisper size "${size}" is not browser-loadable; falling back to "${DEFAULT_LOCAL_WHISPER_SIZE}". Browser-viable sizes: ${BROWSER_LOADABLE_WHISPER_SIZES.join('/')}.`,
    );
    return { model: DEFAULT_LOCAL_WHISPER_SIZE };
  }

  // A namespaced HuggingFace repo id is an explicit, intentional choice — trust it.
  if (normalized.includes('/')) {
    return { model: DEFAULT_LOCAL_WHISPER_SIZE, modelPath: normalized };
  }

  // Unrecognized bare id (e.g. "whisper-large-v3"): not a loadable browser repo.
  console.warn(
    `[stt] Local STT model "${modelId}" is not browser-loadable; falling back to "${DEFAULT_LOCAL_WHISPER_SIZE}". Use a Whisper size (${BROWSER_LOADABLE_WHISPER_SIZES.join('/')}) or a full HF repo id (e.g. "onnx-community/whisper-base").`,
  );
  return { model: DEFAULT_LOCAL_WHISPER_SIZE };
}

/**
 * Get the language code (ISO 639-1) from a locale code.
 * @example getLanguageCode('en-US') // returns 'en'
 */
export function getLanguageCode(locale: LanguageLocale): string {
  const [language] = locale.split('-');
  return language ?? locale;
}

/**
 * Get the country code (ISO 3166-1) from a locale code.
 * @example getCountryCode('en-US') // returns 'US'
 */
export function getCountryCode(locale: LanguageLocale): string | undefined {
  const parts = locale.split('-');
  return parts.length > 1 ? parts[1] : undefined;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { AudioProcessorOptions, ProcessorOptions, TrackProcessor, EventEmittingProcessor } from '@arcaai/room';
