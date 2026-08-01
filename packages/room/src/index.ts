/**
 * @arcaai/room
 *
 * React-based audio processing package with configurable features and plugin architecture.
 *
 * @example
 * ```tsx
 * import {
 *   RoomProvider,
 *   useAudioTrack,
 *   useAudioLevel,
 *   AudioFeature,
 * } from '@arcaai/room';
 *
 * function App() {
 *   return (
 *     <RoomProvider>
 *       <AudioRecorder />
 *     </RoomProvider>
 *   );
 * }
 *
 * function AudioRecorder() {
 *   const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
 *     noiseSuppression: true,
 *     echoCancellation: true,
 *   });
 *
 *   const { level, isSpeaking } = useAudioLevel(track);
 *
 *   return (
 *     <div>
 *       <button onClick={isCapturing ? stopCapture : startCapture}>
 *         {isCapturing ? 'Stop' : 'Start'}
 *       </button>
 *       <div>Level: {(level * 100).toFixed(0)}%</div>
 *       <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
 *     </div>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export {
  // Audio Features
  AudioFeature,
  type AudioCaptureOptions,
  DEFAULT_AUDIO_OPTIONS,

  // Track Types
  TrackState,
  type TrackKind,
  TrackSource,

  // Device Types
  type AudioDevice,

  // Audio Level Types
  type AudioLevelInfo,

  // Room Types
  type RoomOptions,
  DEFAULT_ROOM_OPTIONS,

  // Browser Support
  type BrowserSupport,
  type BrowserCapabilities,
  type BrowserLimitation,
  type BrowserName,

  // Errors
  RoomErrorCode,
  RoomError,

  // Utility Types
  type EventCallback,
  type InitResult,
  type Disposable,
} from './types/index.js';

// ============================================================================
// Core
// ============================================================================

export {
  // AudioContext Management
  AudioContextManager,
  getNewAudioContext,
  type AudioContextAcquireOptions,

  // AudioTrack
  AudioTrack,
  type AudioTrackOptions,

  // ProcessorPipeline
  ProcessorPipeline,

  // Room
  Room,
  RoomEvent,
  RoomState,
  createLocalTracks,
  type RoomEventMap,

  // AudioMixer
  AudioMixer,
  type AudioMixerSource,
  type AudioMixerEventMap,
  type AudioMixerSourceLevel,
  type AudioMixerLevelMonitorOptions,

  // Typed Room errors
  RoomPermissionError,
  RoomDeviceError,
  RoomSecurityError,
  RoomConstraintError,
  RoomResumeTimeoutError,
  RoomSampleRateMismatchError,
  RoomUnknownError,
  RoomMediaErrorCode,
  type RoomMediaErrorCodeValue,
  mapGetUserMediaError,
} from './core/index.js';

// ============================================================================
// Events
// ============================================================================

export {
  // Track Events
  TrackEvent,
  type TrackEventMap,
  type TrackEventPayload,
  type ProcessorUpdatePayload,
  type FeatureUpdatePayload,
  type TrackErrorPayload,

  // Processor Events
  ProcessorEvent,
  type ProcessorEventMap,
  type ProcessorEventPayload,
  type ProcessorErrorPayload,
  type ProcessorDataPayload,
  type VADDataPayload,
  type TranscriptionDataPayload,
  type SpeakerRecognitionDataPayload,

  // Event Emitter
  TypedEventEmitter,
  type EventMap,
  type EventHandler,
} from './events/index.js';

// ============================================================================
// Processors
// ============================================================================

export {
  // Types
  type TrackProcessor,
  type EventEmittingProcessor,
  type ProcessorOptions,
  type AudioProcessorOptions,
  type ProcessorFactory,
  type ProcessorConfig,
  ProcessorStatus,
  type ProcessorInfo,

  // Base Processor
  BaseProcessor,

  // Native Processor
  NativeProcessor,
  createNativeProcessor,
  type NativeProcessorOptions,
} from './processors/index.js';

// ============================================================================
// React Components
// ============================================================================

export {
  // Room Provider
  RoomProvider,
  type RoomProviderProps,
  type RoomContextValue,

  // Audio Track Renderer
  AudioTrackRenderer,
  type AudioTrackRendererProps,
} from './components/index.js';

// ============================================================================
// React Hooks
// ============================================================================

export {
  // Room Hook
  useRoom,
  useRoomSafe,

  // Audio Track Hook
  useAudioTrack,
  type UseAudioTrackOptions,
  type UseAudioTrackReturn,

  // Processors Hook
  useProcessors,
  type UseProcessorsOptions,
  type UseProcessorsReturn,

  // Audio Level Hook
  useAudioLevel,
  useMediaStreamAudioLevel,
  type UseAudioLevelOptions,
  type UseAudioLevelReturn,

  // Devices Hook
  useDevices,
  type UseDevicesOptions,
  type UseDevicesReturn,
  type DeviceKind,

  // Browser Capabilities Hook
  useBrowserCapabilities,
  type UseBrowserCapabilitiesReturn,

  // Audio Mixer Hook
  useAudioMixer,
  type UseAudioMixerReturn,
} from './hooks/index.js';

// ============================================================================
// Utilities
// ============================================================================

export {
  // Debug Logger
  debugLog,
  debugLogConfig,
  debugLogTranscript,
  type DebugTranscriptEntry,
  type DebugTranscriptWord,

  // Browser Support
  isBrowser,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isGetUserMediaSupported,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
  getBrowserSupport,
  isBasicAudioSupported,
  isWebAudioSupported,
  isAdvancedAudioSupported,
  getAudioContextConstructor,

  // Browser Compatibility
  detectBrowserName,
  detectBrowserVersion,
  meetsMinimumVersion,
  detectWasmSimd,
  getBrowserCapabilities,
  getBrowserLimitations,

  // Constraints
  buildAudioConstraints,
  getTrackFeatures,
  applyFeatureConstraint,
  isFeatureSupported,
  getSupportedFeatures,

  // Worklet Loader
  createWorkletLoader,
  type WorkletLoader,
  type WorkletLoaderOptions,

  // Audio Utilities
  calculateRMSLevel,
  calculatePeakLevel,
  linearToDecibels,
  decibelsToLinear,
  detectVoiceActivity,
  createSmoothingCalculator,
  createSilenceDetector,
  resampleAudio,
  audioBufferToFloat32,
  audioBufferToTrack,
  sleep,
} from './utils/index.js';
