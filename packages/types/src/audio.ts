/**
 * Audio-related types
 */

/**
 * Audio format specifications
 */
export interface AudioFormat {
  sampleRate: number; // Hz (e.g., 16000, 44100, 48000)
  channels: number; // 1 for mono, 2 for stereo
  bitDepth: number; // bits per sample (e.g., 16, 24, 32)
  encoding: AudioEncoding;
}

/**
 * Supported audio encodings
 */
export type AudioEncoding = 'pcm' | 'float32' | 'mp3' | 'wav' | 'webm';

/**
 * Audio buffer data
 */
export interface AudioBuffer {
  data: ArrayBuffer | Float32Array | Int16Array;
  format: AudioFormat;
  duration: number; // in seconds
}

/**
 * Audio capture device info
 */
export interface AudioDevice {
  id: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  groupId?: string;
}

/**
 * Audio capture configuration
 */
export interface AudioCaptureConfig {
  deviceId?: string;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

/**
 * Audio capture source types
 */
export enum AudioCaptureSource {
  SYSTEM_AUDIO = 'system_audio', // via getDisplayMedia
  MICROPHONE = 'microphone', // via getUserMedia
  MIXED = 'mixed', // system audio + microphone mixed
  AUDIO_OUTPUT = 'audio_output', // future: loopback
  AUDIO_INPUT = 'audio_input', // specific input device
}

/**
 * Audio capture state
 */
export enum AudioCaptureState {
  IDLE = 'idle',
  REQUESTING_PERMISSION = 'requesting_permission',
  RECORDING = 'recording',
  PAUSED = 'paused',
  STOPPED = 'stopped',
  ERROR = 'error',
}

/**
 * Audio capture error codes
 */
export enum AudioCaptureErrorCode {
  PERMISSION_DENIED = 'permission_denied',
  DEVICE_NOT_FOUND = 'device_not_found',
  NOT_SUPPORTED = 'not_supported',
  DEVICE_IN_USE = 'device_in_use',
  STREAM_ERROR = 'stream_error',
  RECORDING_ERROR = 'recording_error',
}

/**
 * Audio capture error
 */
export interface AudioCaptureError {
  code: AudioCaptureErrorCode;
  message: string;
  originalError?: Error;
}

/**
 * Audio capture options
 */
export interface AudioCaptureOptions {
  preferredSource?: AudioCaptureSource;
  config?: Partial<AudioCaptureConfig>;
  onStateChange?: (state: AudioCaptureState) => void;
  onAudioLevel?: (level: number) => void;
  onError?: (error: AudioCaptureError) => void;

  // VAD integration
  enableVAD?: boolean;
  vadConfig?: any; // Will be typed as Partial<VADConfig> when imported
  onVADProbability?: (probability: number, timestamp: number) => void;
  onSpeechSegment?: (segment: any) => void; // Will be typed as SpeechSegment when imported
}

/**
 * Audio recording metadata
 */
export interface AudioRecordingMetadata {
  id: string;
  startTime: number;
  endTime?: number;
  duration?: number; // in seconds
  source: AudioCaptureSource;
  sampleRate: number;
  channelCount: number;
  format: string; // 'webm', 'mp4', etc.
  size: number; // in bytes
  deviceLabel?: string;

  // VAD results (if VAD was enabled)
  speechSegments?: any[]; // Will be typed as SpeechSegment[] when imported
  vadResult?: any; // Will be typed as VADResult when imported
}

/**
 * Audio recording with blob
 */
export interface AudioRecording {
  metadata: AudioRecordingMetadata;
  blob: Blob;
  url?: string; // Object URL for playback
}

/**
 * Audio capture event
 */
export interface AudioCaptureEvent {
  type: 'start' | 'data' | 'pause' | 'resume' | 'stop' | 'error';
  timestamp: number;
  data?: AudioBuffer;
  error?: Error;
}

