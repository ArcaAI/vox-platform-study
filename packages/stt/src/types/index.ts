/**
 * @arcaai/stt - Type Definitions
 *
 * Core type definitions for the Speech-to-Text plugin.
 */

// ============================================================================
// Model Types
// ============================================================================

/**
 * STT provider type.
 *
 * @deprecated TASK-1006 — the browser never runs a model (TASK-865): the
 * in-browser Whisper provider was removed and `'remote'` (backend streaming
 * ASR, selected via the tenant's ASR Agent) is the only value. Kept as a
 * single-member union so `STTFeatureFlags.provider` stays source-compatible
 * for callers that still pass `{ provider: 'remote' }` explicitly.
 */
export type STTProviderType = 'remote';

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
   * End-user language mode id, e.g. `'en'`, `'ml'`, `'ml-en'`
   * (Malayalam+English code-switch), `'auto'`. When set on the streaming
   * (backend) path it is forwarded to the STT session, which resolves it
   * against the session engine and rejects a mode no configured engine can
   * serve. Takes precedence over `language` on the backend. Ignored by the
   * local (browser) STT path.
   */
  languageMode?: string;

  /**
   * Pre-start STT engine selection, `'primary'` (default) or
   * `'fallback'`. Forwarded to the STT session on the streaming/backend path so
   * it opens on the tenant-admin default provider when `'fallback'`. Ignored by
   * the local (browser) STT path.
   */
  startOn?: 'primary' | 'fallback';

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
// `languageMode` and `startOn` are genuinely optional
// absent means "use the pipeline default / start on primary" — so they are
// excluded from the required set rather than given a meaningless placeholder.
export const DEFAULT_AUDIO_CONFIG: Required<Omit<AudioSourceConfig, 'languageMode' | 'startOn'>> = {
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
   *
   * @deprecated TASK-1006 — `'remote'` (backend streaming ASR) is the only
   * value; the in-browser Whisper provider was removed (TASK-865: the
   * browser never runs a model).
   * @default 'remote'
   */
  provider?: STTProviderType;

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
}

/**
 * Default feature flags.
 */
export const DEFAULT_FEATURE_FLAGS: Required<STTFeatureFlags> = {
  provider: 'remote',
  diarization: false,
  numSpeakers: 2,
  returnTimestamps: true,
  codeSwitching: false,
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
   * The ASR pipeline that produced this result. Per-utterance, so a
   * mid-session engine switch is visible transcript-by-transcript. Absent for
   * local providers and for backends that do not stamp results.
   */
  pipelineId?: string;

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
   * Start time in seconds relative to the audio-stream start, for the
   * backend-streaming path (mirrors the sdk-side `TranscriptionResult`
   * field the SDK hook reads to stamp `segment.startTime`). Distinct from
   * the epoch-based clocks — this is a small stream-relative offset.
   */
  vadStreamStartSec?: number;

  /**
   * End time in seconds relative to the audio-stream start (see
   * {@link TranscriptionResult.vadStreamStartSec}).
   */
  vadStreamEndSec?: number;

  /**
   * Processing latency in milliseconds.
   */
  latencyMs?: number;

  /**
   * Length, in characters, of the leading prefix of {@link TranscriptionResult.text}
   * the backend considers SETTLED on a partial — the rest may still be revised
   * (TASK-985 M-27, transport half).
   *
   * TRANSPORT ONLY. Nothing renders differently on it yet, and nothing should:
   * today's server-side value is not monotone within an utterance (it can
   * shrink), so splitting the caption on it would turn an invisible server
   * defect into a visible one. It is carried so the live harness and the
   * playground can OBSERVE a settled prefix at all. Absent on finals and on any
   * backend that does not publish it.
   */
  stableChars?: number;

  /**
   * Ordinal of the utterance this result belongs to, from the backend. Partials
   * and the final of one utterance share it, so a consumer can tell "the same
   * sentence, revised" from "the next sentence" without string comparison
   * (TASK-985 M-27). Absent on backends that do not stamp it.
   */
  utteranceIndex?: number;
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
   * @deprecated TASK-1006 — the in-browser Whisper provider was removed; never set.
   */
  device?: string;

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
/**
 * @deprecated TASK-1006 — the in-browser Whisper provider was removed; no
 * emitter remains (the remote/streaming path never loads a local model).
 */
export interface STTModelLoadedPayload {
  type: 'stt-model-loaded';
  model: string;
  device: string;
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
   * Whether backend (streaming) STT is supported.
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
  // TASK-985 (QW-2 / M-02) — OPTIONAL, because absent is a meaningful value on the
  // streaming path and no other value can express it. The backend's backfill is
  // `if not language_mode:`, so a literal here is not "no opinion" — it beats the
  // tenant's configured ASR agent. Sending nothing is the only way to say "the agent
  // decides", and that is the correct default for a clinical session.
  //
  // The engines that genuinely need a locale — the in-browser Whisper pipeline and the
  // non-streaming remote provider — keep their own `?? DEFAULT_LANGUAGE_LOCALE` at the
  // point of use, because they have no agent to defer to.
  language?: LanguageLocale;

  /**
   * End-user language mode id. Forwarded to the STT session on the
   * streaming/backend path; takes precedence over `language` there. Ignored by
   * local providers.
   */
  languageMode?: string;

  /**
   * Pre-start STT engine selection. Forwarded to the STT session on
   * the streaming/backend path so it opens on the tenant-admin default provider
   * when `'fallback'`. Ignored by local providers.
   */
  startOn?: 'primary' | 'fallback';

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
