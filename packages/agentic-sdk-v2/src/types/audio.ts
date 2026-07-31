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
  /** Start audio capture with optional per-capture options. */
  start: (options?: AudioStartOptions) => Promise<void>;
  /**
   * Start capture using the user's persisted
   * preferences (device(s), language, workflow mode → local/backend STT,
   * dual-capture). Derives {@link AudioStartOptions} and delegates to `start`.
   */
  startFromPreferences: () => Promise<void>;
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
  /**
   * Word-level timestamps. Carried from the streaming
   * backend's `WsTranscriptResult.wordTimestamps` through
   * `StreamingBackendSTTProvider.normalizeTranscript` so the store's
   * {@link TranscriptSegment.words} can expose word timings to consumers.
   * Optional/back-compatible — absent for engines that don't emit word timings.
   */
  words?: TranscriptWord[];
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
 * A single word-level timestamp within a transcript segment.
 *
 * Originates from stt `SegmentResult.word_timestamps` →
 * `WsTranscriptResult.wordTimestamps` and is carried through the SDK store so
 * consumers can render word timings / click-to-seek directly from
 * `audio.transcriptSegments` (rather than only from the raw socket).
 */
export interface TranscriptWord {
  /** The word text */
  word: string;
  /** Start time in seconds from session start */
  start: number;
  /** End time in seconds from session start */
  end: number;
  /** Confidence score (0-1). Absent for engines (e.g. Whisper) that don't score words. */
  confidence?: number;
}

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
  /**
   * Word-level timestamps, when the backend provides
   * them. Optional/back-compatible — existing consumers are unaffected.
   */
  words?: TranscriptWord[];
}

/**
 * Result of a dual-capture session: the unprocessed microphone blob (`raw`)
 * and the noise-filtered/VAD-gated pipeline output blob (`processed`).
 * Structurally identical to `DualStreamRecorderResult` in
 * `core/DualStreamRecorder` (kept here so the public types don't import core).
 */
export interface DualCaptureResult {
  raw: Blob;
  processed: Blob;
}

/**
 * Options accepted by audio.start() to configure the capture session.
 */
export interface AudioStartOptions {
  language?: string;
  /**
   * End-user STT language mode id (TASK-587), e.g. `'en'`, `'ml'`, `'ml-en'`
   * (Malayalam+English code-switch), `'auto'`. Forwarded to the backend STT
   * session, which resolves it against the session engine and rejects (422) a
   * mode no configured engine can serve. Takes precedence over `language` on
   * the backend path. Fetch the selectable modes with `useArcaSttLanguageModes`.
   */
  languageMode?: string;
  pipelineId?: string;
  /**
   * Primary microphone deviceId. Forwarded as
   * `getUserMedia({ audio: { deviceId: { exact } } })`. Omit for the default mic.
   */
  deviceId?: string;
  /**
   * Optional second microphone. When set, its stream is
   * mixed with the primary mic (via `@arcaai/room`'s `AudioMixer`) into a single
   * processed graph before the noise-filter/VAD/STT pipeline.
   */
  secondaryDeviceId?: string;
  /**
   * When true (and the workflow is LOCAL), records the
   * pre-noise-filter (raw) and post-filter (processed) tracks in parallel via
   * `DualStreamRecorder`. The resulting blobs are delivered on `stop()` through
   * {@link AudioStartOptions.onDualCapture}.
   */
  dualCaptureEnabled?: boolean;
  /**
   * Callback fired on `stop()` with the dual-capture blobs.
   * A consumer uploads each blob, then attaches both via
   * `useAudioRecordings.add(consultationId, { mediaId, rawMediaId, processedMediaId })`.
   * The SDK does not perform the upload itself (that's the UI bucket).
   */
  onDualCapture?: (result: DualCaptureResult) => void;
}

// =============================================================================
// Streaming STT connection / provider state (TASK-567 Phase F)
// =============================================================================

/**
 * Live connection health of the streaming STT session.
 *   - `connected`         — transport open, transcribing on the active pipeline.
 *   - `reconnecting`      — the WebSocket dropped and the client is re-attempting
 *                           (or a degraded on-the-fly provider switch is rebuilding).
 *   - `switched_fallback` — the backend swapped the session's ASR engine to the
 *                           tenant fallback (auto on outage OR user-triggered).
 *                           The durable "we are on the fallback" signal lives on
 *                           {@link ActivePipelineInfo.isFallback}; this value is
 *                           the momentary switch acknowledgement.
 *   - `error`             — reconnection budget exhausted; the session is gone.
 */
export type SttConnectionState = 'connected' | 'reconnecting' | 'switched_fallback' | 'error';

/** The ASR pipeline the live streaming session is currently transcribing on. */
export interface ActivePipelineInfo {
  /** Pipeline UUID or slug. */
  id: string;
  /** Human-readable name (best-effort; falls back to the id when unresolved). */
  name: string;
  /** True once the session has switched to the tenant fallback pipeline. */
  isFallback: boolean;
}

/**
 * Payload of a backend `provider_switched` status result (TASK-567 §3.4),
 * surfaced from the streaming STT `status` frame to the hook/store.
 */
export interface ProviderSwitchInfo {
  /** Pipeline the session switched away from. */
  fromPipeline: string;
  /** Pipeline the session is now transcribing on (the fallback). */
  toPipeline: string;
  /** Trigger: `auto` (outage/exception) or `user` (clinician-initiated). */
  reason: string;
  /** Utterance ordinal at which the swap happened, when the backend reports it. */
  utteranceIndex?: number;
  /**
   * Engine now transcribing after the swap (TASK-586: bidirectional toggle).
   * `fallback` after a primary→fallback switch, `primary` after a switch back.
   * Absent on a pre-586 backend that only reports the one-way switch.
   */
  active?: 'primary' | 'fallback';
  /** True when now on the fallback engine; false after a switch back to primary. Absent ⇒ pre-586 backend. */
  isFallback?: boolean;
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
