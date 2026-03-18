/**
 * @arcaai/stt
 *
 * Speech-to-text plugin for @arcaai/room with local Whisper and remote processing support.
 *
 * Features:
 * - Local Whisper processing via Transformers.js with WebGPU acceleration
 * - Remote processing via WebSocket for server-side processing
 * - Event-based transcription results
 * - Integration with @arcaai/room processor pipeline
 *
 * @example
 * ```tsx
 * import {
 *   STTProcessor,
 *   createSTT,
 * } from '@arcaai/stt';
 * import { useAudioTrack, useProcessors } from '@arcaai/room';
 *
 * function TranscriptionDemo() {
 *   const { track, startCapture } = useAudioTrack();
 *   const { addProcessor } = useProcessors({ track });
 *
 *   useEffect(() => {
 *     if (track) {
 *       const stt = createSTT({
 *         sttSocket: 'wss://api.example.com/ws/stt',
 *         audio: {
 *           language: 'en-US',
 *         },
 *         features: {
 *           provider: 'remote',
 *           diarization: true,
 *         },
 *       });
 *
 *       stt.on('data', (payload) => {
 *         if (payload.type === 'stt-transcription') {
 *           console.log('Transcription:', payload.data.text);
 *         }
 *       });
 *
 *       addProcessor(stt);
 *     }
 *   }, [track]);
 *
 *   return <button onClick={startCapture}>Start Recording</button>;
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export {
  // Model Types
  type WhisperModelSize,
  type ComputeDevice,
  type STTProviderType,

  // Language Types
  type LanguageLocale,
  DEFAULT_LANGUAGE_LOCALE,
  getLanguageCode,
  getCountryCode,

  // Audio Configuration
  type AudioSourceConfig,
  DEFAULT_AUDIO_CONFIG,

  // Feature Flags
  type STTFeatureFlags,
  DEFAULT_FEATURE_FLAGS,

  // Options
  type STTOptions,
  DEFAULT_STT_OPTIONS,
  generateSessionId,

  // Model Loading
  type ModelLoadProgress,

  // Transcription
  type TranscriptionTimestamp,
  type TranscriptionResult,

  // Statistics
  type STTStats,

  // Event Payloads
  type STTTranscriptionPayload,
  type STTSpeechStartPayload,
  type STTSpeechEndPayload,
  type STTModelLoadedPayload,
  type STTStatsPayload,
  type STTDataEventType,
  type STTDataPayload,

  // WebSocket Messages
  type AudioMetadata,
  type WSOutboundMessage,
  type WSInboundMessage,

  // Browser Support
  type STTBrowserSupport,

  // Errors
  STTErrorCode,
  STTError,

  // Utility functions
  isWhisperModelSize,
  normalizeModelId,
  parseModelId,

  // Provider Config
  type ProviderConfig,
  type LocalProviderConfig,
  type RemoteProviderConfig,
  type BackendProviderConfig, // Deprecated alias
} from './types/index.js';

// ============================================================================
// Core
// ============================================================================

export {
  // Main Processor
  STTProcessor,
  createSTT,

  // Audio Buffer Manager
  AudioBufferManager,
  type AudioBufferManagerOptions,
  type AudioBufferStats,
  DEFAULT_BUFFER_OPTIONS,
} from './core/index.js';

// ============================================================================
// Providers
// ============================================================================

export {
  // Provider Types
  type STTProvider,
  type TranscriptionCallback,
  type ErrorCallback,

  // Provider Implementations
  BaseSTTProvider,
  LocalSTTProvider,
  RemoteSTTProvider,
  BackendSTTProvider, // Deprecated alias
} from './providers/index.js';

// ============================================================================
// Engines
// ============================================================================

export {
  // Engine Types
  type STTEngine,
  type EngineConfig,
  type TranscribeOptions,
  type EngineStats,

  // Engine Implementations
  BaseEngine,
  WhisperEngine,
} from './engines/index.js';

// ============================================================================
// WebSocket
// ============================================================================

export {
  WebSocketClient,
  type WebSocketClientOptions,
  type WebSocketCallbacks,
  type ConnectionState,
  DEFAULT_WS_OPTIONS,

  MessageHandler,
  type MessageHandlerCallbacks,
} from './websocket/index.js';

// ============================================================================
// React Hooks
// ============================================================================

export { useSTT, type UseSTTOptions, type UseSTTReturn } from './hooks/index.js';

// ============================================================================
// Utilities
// ============================================================================

export {
  // Browser Detection
  isBrowser,
  isWebAssemblySupported,
  isWebGPUSupported,
  isWebGPUAvailable,
  isAudioWorkletSupported,
  isWebSocketSupported,
  isSharedArrayBufferSupported,
  isAudioContextSupported,
  isMediaStreamTrackSupported,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isTransformersJsSupported,
  getRecommendedDevice,
  getRecommendedProvider,
  getSTTBrowserSupport,
  isSTTSupported,
  logBrowserSupport,

  // Audio Processing
  WHISPER_SAMPLE_RATE,
  resampleLinear,
  stereoToMono,
  multiChannelToMono,
  prepareAudioForWhisper,
  prepareFloat32ForWhisper,
  int16ToFloat32,
  float32ToInt16,
  bytesToFloat32,
  float32ToBytes,
  samplesToDuration,
  durationToSamples,
  normalizeAudio,
  concatenateFloat32Arrays,
  type NormalizeOptions,
} from './utils/index.js';
