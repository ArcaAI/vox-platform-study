/**
 * @arcaai/stt
 *
 * Capture + backend-streaming speech-to-text transport for @arcaai/room.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model. The
 * in-browser Whisper provider, its engines, worker and React hook were
 * removed. What remains is audio CAPTURE (`createAudioCapture`,
 * `float32ToInt16`) and the STREAMING TRANSPORT to the backend — the tenant's
 * ASR Agent decides VAD/denoise/ASR server-side.
 *
 * Features:
 * - Remote (backend streaming) processing via WebSocket
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

  // Transcription
  type TranscriptionTimestamp,
  type WordTimestamp, // word-level timestamps carried through TranscriptionResult.words
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

  // Provider Config
  type ProviderConfig,
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
  type STTStreamingTransport,

  // Audio Buffer Manager
  AudioBufferManager,
  type AudioBufferManagerOptions,
  type AudioBufferStats,
  DEFAULT_BUFFER_OPTIONS,

  // Audio Capture (worklet path with coalesced frames)
  createAudioCapture,
  isAudioWorkletUsable,
  type AudioCaptureHandle,
  type AudioCaptureOptions,
  type AudioFrameCallback,
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
  RemoteSTTProvider,
  BackendSTTProvider, // Deprecated alias

  // Pipeline-aware streaming provider.
  StreamingBackendSTTProvider,
  type StreamingRemoteProviderConfig,
  type StreamingSessionLike,
  type StreamingWsClientLike,
  type StreamingTranscriptPayload,
  // TASK-985 M-43 — the gateway's `gap` frame (text it discarded on the way down).
  type StreamingGapPayload,
} from './providers/index.js';

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
// Utilities
// ============================================================================

export {
  // Browser Detection
  isBrowser,
  isAudioWorkletSupported,
  isWebSocketSupported,
  isSharedArrayBufferSupported,
  isAudioContextSupported,
  isMediaStreamTrackSupported,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
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
  // TASK-985 M-53 — stateful, rate-exact streaming converter (keeps kernel history across frames).
  createStreamingResampler,
  type StreamingResampler,
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
