/**
 * @arcaai/vox - Audio Types
 *
 * Types for audio capture, processing, and transcription.
 */

// =============================================================================
// Audio State
// =============================================================================

/**
 * Audio state exposed by useArca hook
 */
export interface AudioState {
  /** Whether audio capture is active */
  isCapturing: boolean;
  /** Whether microphone is muted */
  isMuted: boolean;
  /** Current audio level (0-100) */
  level: number;
  /** Whether speech is detected (VAD) */
  isSpeaking: boolean;
  /** Current transcription text (interim, not finalized) */
  currentTranscript: string;
  /** Plugin states */
  plugins: AudioPluginStates;
  /** Error if any */
  error: Error | null;
}

/**
 * Audio plugin states
 */
export interface AudioPluginStates {
  /** Noise filter state */
  noiseFilter: PluginState;
  /** VAD state */
  vad: PluginState;
  /** STT state */
  stt: STTPluginState;
}

/**
 * Generic plugin state
 */
export interface PluginState {
  /** Whether the plugin is currently active */
  isActive: boolean;
  /** Whether the plugin is supported in current browser */
  isSupported: boolean;
}

/**
 * STT-specific plugin state
 */
export interface STTPluginState extends PluginState {
  /** Whether STT is currently processing audio */
  isProcessing: boolean;
  /** Current model being used */
  currentModel?: string;
  /** Model loading progress (0-100) */
  modelLoadProgress?: number;
}

// =============================================================================
// Audio Actions
// =============================================================================

/**
 * Audio actions interface
 */
export interface AudioActions {
  /** Start audio capture */
  start: () => Promise<void>;
  /** Stop audio capture */
  stop: () => Promise<void>;
  /** Mute microphone */
  mute: () => void;
  /** Unmute microphone */
  unmute: () => void;
  /** Toggle noise filter on/off */
  toggleNoiseFilter: (enabled?: boolean) => void;
  /** Toggle VAD on/off */
  toggleVAD: (enabled?: boolean) => void;
  /** Toggle STT on/off */
  toggleSTT: (enabled?: boolean) => void;
}

// =============================================================================
// Transcription Types
// =============================================================================

/**
 * Transcription result from STT
 */
export interface TranscriptionResult {
  /** Transcribed text */
  text: string;
  /** Whether this is a final result */
  isFinal: boolean;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Detected language */
  language?: string;
  /** Speaker identifier from diarization, if available */
  speakerId?: string;
  /** Speaker confidence score from diarization (0-1) */
  speakerConfidence?: number;
  /** Optional speaker voice features for local persistence */
  speakerFeatures?: {
    source?: string;
    vector?: number[];
    profileSamples?: number;
    similarity?: number;
    sampleRate?: number;
  };
  /** Segments with timing */
  segments?: TranscriptionSegment[];
  /** Alias used by @arcaai/stt local provider for timestamp output */
  timestamps?: TranscriptionSegment[];
  /** VAD segment number (1-based), propagated from VAD pipeline */
  vadSegmentNumber?: number;
  /** Start time in seconds relative to audio stream start, from VAD */
  vadStreamStartSec?: number;
  /** End time in seconds relative to audio stream start, from VAD */
  vadStreamEndSec?: number;
  /** Duration in seconds, from VAD */
  vadDurationSec?: number;
  /** Processing latency in milliseconds */
  latencyMs?: number;
  /** Duration of the audio segment in seconds */
  duration?: number;
}

/**
 * Transcription segment with timing
 */
export interface TranscriptionSegment {
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Segment text */
  text: string;
  /** Speaker identifier (if diarization enabled) */
  speaker?: string;
}

// =============================================================================
// VAD Types
// =============================================================================

/**
 * VAD event types
 */
export type VADEventType = 'speech-start' | 'speech-end' | 'misfire';

/**
 * VAD event payload
 */
export interface VADEvent {
  /** Event type */
  type: VADEventType;
  /** Event timestamp */
  timestamp: number;
  /** Audio data (for speech-end events) */
  audioData?: Float32Array;
  /** Sequential segment number assigned by VAD (1-based, speech-end only) */
  segmentNumber?: number;
  /** Start time in seconds relative to the audio stream start (speech-end only) */
  streamStartSec?: number;
  /** End time in seconds relative to the audio stream start (speech-end only) */
  streamEndSec?: number;
  /** Duration of the segment in seconds (speech-end only) */
  durationSec?: number;
}

// =============================================================================
// Audio Options
// =============================================================================

/**
 * Audio hook options
 */
export interface AudioOptions {
  /** Enable noise filter (overrides config) */
  enableNoiseFilter?: boolean;
  /** Enable VAD (overrides config) */
  enableVAD?: boolean;
  /** STT provider selection (overrides config) */
  sttProvider?: 'local' | 'backend' | 'auto';
  /** Callback for transcription results */
  onTranscription?: (result: TranscriptionResult) => void;
  /** Callback for VAD events */
  onVAD?: (event: VADEvent) => void;
  /** Callback for audio level updates */
  onAudioLevel?: (level: number) => void;
}

// =============================================================================
// Structured Transcript Segment (WS-B)
// =============================================================================

/**
 * A single segment of structured transcript data with timing and diarization.
 */
export interface TranscriptSegment {
  text: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  speakerLabel?: string;
  confidence?: number;
  language?: string;
}

/**
 * Options accepted by audio.start() to configure the capture session.
 */
export interface AudioStartOptions {
  language?: string;
  pipelineId?: string;
}

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default audio plugin states
 */
export const DEFAULT_AUDIO_PLUGIN_STATES: AudioPluginStates = {
  noiseFilter: { isActive: false, isSupported: false },
  vad: { isActive: false, isSupported: false },
  stt: { isActive: false, isSupported: false, isProcessing: false },
};

/**
 * Default audio state
 */
export const DEFAULT_AUDIO_STATE: AudioState = {
  isCapturing: false,
  isMuted: false,
  level: 0,
  isSpeaking: false,
  currentTranscript: '',
  plugins: DEFAULT_AUDIO_PLUGIN_STATES,
  error: null,
};
