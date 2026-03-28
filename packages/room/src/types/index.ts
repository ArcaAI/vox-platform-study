/**
 * @arcaai/room - Type Definitions
 *
 * Core type definitions for the audio processing package.
 */

// ============================================================================
// Audio Feature Types
// ============================================================================

/**
 * Audio features that can be toggled on/off via WebRTC constraints.
 * These map directly to MediaTrackConstraints properties.
 */
export enum AudioFeature {
  /** Automatic gain control - normalizes audio levels */
  AUTO_GAIN_CONTROL = 'autoGainControl',
  /** Echo cancellation - removes echo from audio */
  ECHO_CANCELLATION = 'echoCancellation',
  /** Noise suppression - reduces background noise */
  NOISE_SUPPRESSION = 'noiseSuppression',
  /** Voice isolation - experimental, stronger noise suppression */
  VOICE_ISOLATION = 'voiceIsolation',
}

/**
 * Options for capturing audio from a device.
 */
export interface AudioCaptureOptions {
  /** Specific device ID to capture from */
  deviceId?: string;
  /** Enable echo cancellation (default: true) */
  echoCancellation?: boolean;
  /** Enable noise suppression (default: true) */
  noiseSuppression?: boolean;
  /** Enable automatic gain control (default: true) */
  autoGainControl?: boolean;
  /** Enable voice isolation - experimental (default: false) */
  voiceIsolation?: boolean;
  /** Sample rate in Hz (default: device default, typically 48000) */
  sampleRate?: number;
  /** Number of audio channels (default: 1 for mono) */
  channelCount?: number;
  /** Audio latency hint */
  latency?: number;
}

/**
 * Default audio capture options following best practices.
 */
export const DEFAULT_AUDIO_OPTIONS: Required<Omit<AudioCaptureOptions, 'deviceId' | 'sampleRate' | 'latency'>> = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: false,
  channelCount: 1,
};

// ============================================================================
// Track Types
// ============================================================================

/**
 * Track state indicating the current status of an audio track.
 */
export enum TrackState {
  /** Track is not yet initialized */
  IDLE = 'idle',
  /** Track is being initialized */
  INITIALIZING = 'initializing',
  /** Track is active and capturing/playing */
  ACTIVE = 'active',
  /** Track is muted */
  MUTED = 'muted',
  /** Track has ended or been stopped */
  ENDED = 'ended',
  /** Track encountered an error */
  ERROR = 'error',
}

/**
 * Track kind - currently only audio is supported.
 */
export type TrackKind = 'audio';

/**
 * Track source indicating where the audio comes from.
 */
export enum TrackSource {
  /** Microphone input */
  MICROPHONE = 'microphone',
  /** Screen share audio */
  SCREEN_SHARE = 'screen_share',
  /** Custom audio source */
  CUSTOM = 'custom',
}

// ============================================================================
// Device Types
// ============================================================================

/**
 * Simplified audio device information.
 */
export interface AudioDevice {
  /** Unique device identifier */
  deviceId: string;
  /** Human-readable device label */
  label: string;
  /** Device kind */
  kind: 'audioinput' | 'audiooutput';
  /** Group ID for devices that belong together */
  groupId: string;
  /** Whether this is the default device */
  isDefault: boolean;
}

// ============================================================================
// Audio Level Types
// ============================================================================

/**
 * Audio level information for visualization and VAD.
 */
export interface AudioLevelInfo {
  /** Current audio level (0-1) */
  level: number;
  /** Whether voice activity is detected */
  isSpeaking: boolean;
  /** Peak level since last reset */
  peak: number;
  /** Average level over recent samples */
  average: number;
}

// ============================================================================
// Room Configuration Types
// ============================================================================

/**
 * Room provider configuration options.
 */
export interface RoomOptions {
  /** Enable Web Audio API mixing */
  webAudioMix?: boolean;
  /** Custom AudioContext to use */
  audioContext?: AudioContext;
  /** Audio latency hint for AudioContext */
  latencyHint?: AudioContextLatencyCategory;
  /** Sample rate for AudioContext */
  sampleRate?: number;
}

/**
 * Default room options.
 */
export const DEFAULT_ROOM_OPTIONS: RoomOptions = {
  webAudioMix: true,
  latencyHint: 'interactive',
};

// ============================================================================
// Browser Support Types
// ============================================================================

/**
 * Browser feature support information.
 */
export interface BrowserSupport {
  /** Whether getUserMedia is supported */
  getUserMedia: boolean;
  /** Whether AudioContext is supported */
  audioContext: boolean;
  /** Whether AudioWorklet is supported */
  audioWorklet: boolean;
  /** Whether MediaStreamTrack is supported */
  mediaStreamTrack: boolean;
  /** Whether the browser is Safari */
  isSafari: boolean;
  /** Safari version if applicable, null when not Safari */
  safariVersion: string | null;
  /** Whether all required features are supported */
  isFullySupported: boolean;
  /** Detailed browser capabilities (from browserCompatibility) */
  capabilities?: BrowserCapabilities;
}

// ============================================================================
// Browser Capabilities Types
// ============================================================================

/**
 * Detected browser name.
 */
export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari' | 'ios-safari' | 'unknown';

/**
 * Detailed browser capabilities for audio processing.
 */
export interface BrowserCapabilities {
  browserName: BrowserName;
  browserVersion: string;
  isSupported: boolean;
  supportsMultipleMics: boolean;
  supportsAudioWorklet: boolean;
  audioWorkletReliable: boolean;
  supportsPersistentPermissions: boolean;
  supportsBackgroundAudio: boolean;
  supportsSharedArrayBuffer: boolean;
  supportsWasmSimd: boolean;
  requiresUserGesture: boolean;
  recommendedSampleRate: number;
}

/**
 * A limitation of the current browser for audio processing.
 */
export interface BrowserLimitation {
  feature: string;
  severity: 'blocker' | 'degraded' | 'info';
  description: string;
  workaround?: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for room-related errors.
 */
export enum RoomErrorCode {
  /** User denied microphone permission */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** Requested device not found */
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
  /** Device is in use by another application */
  DEVICE_IN_USE = 'DEVICE_IN_USE',
  /** Browser does not support required features */
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  /** AudioContext is in suspended state */
  AUDIO_CONTEXT_SUSPENDED = 'AUDIO_CONTEXT_SUSPENDED',
  /** Processor initialization failed */
  PROCESSOR_INIT_FAILED = 'PROCESSOR_INIT_FAILED',
  /** Track not found or invalid */
  TRACK_NOT_FOUND = 'TRACK_NOT_FOUND',
  /** Unknown error */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Custom error class for room-related errors.
 */
export class RoomError extends Error {
  constructor(
    public readonly code: RoomErrorCode,
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message, { cause });
    this.name = 'RoomError';
  }
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Callback function type for event handlers.
 */
export type EventCallback<T = void> = T extends void ? () => void : (data: T) => void;

/**
 * Async initialization result.
 */
export interface InitResult<T> {
  success: boolean;
  data?: T;
  error?: RoomError;
}

/**
 * Disposable interface for cleanup.
 */
export interface Disposable {
  dispose(): void | Promise<void>;
}
