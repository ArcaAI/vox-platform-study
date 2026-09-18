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
  /**
   * Per-utterance ASR pipeline provenance, carried from
   * `WsTranscriptResult.pipelineId` when the streaming transport reports one.
   * Optional/back-compatible — absent for providers that don't yet forward it.
   */
  pipelineId?: string;
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
  /**
   * The ASR pipeline that produced this segment. Per-utterance
   * after a mid-session engine switch, consecutive segments legitimately carry
   * different ids, which is the point — session-level state cannot express it.
   * Absent for local transcription and for backends that do not stamp results.
   */
  pipelineId?: string;
}

/**
 * The live PARTIAL, with the backend's commit geometry attached (TASK-985
 * M-27, transport half).
 *
 * Distinct from {@link TranscriptSegment}, which is a COMMITTED row: this is
 * the one in-flight hypothesis, replaced wholesale by the next partial and
 * cleared when the final for its utterance commits.
 *
 * Both geometry fields are optional and both are TRANSPORT ONLY today. Do not
 * render a settled/tentative split on `stableChars` yet: the server-side value
 * is not monotone within an utterance (it can shrink), so a UI that trusted it
 * would make an invisible server defect visible as text that un-commits itself.
 */
export interface SttInterim {
  /** The partial hypothesis, verbatim — the same text published to `currentTranscript`. */
  text: string;
  /**
   * Length in characters of the leading prefix of `text` the backend considers
   * settled. Absent when the backend does not publish it — which is NOT the
   * same as `0`, and the two must not be collapsed.
   */
  stableChars?: number;
  /**
   * Ordinal of the utterance this partial belongs to. Its own final carries the
   * same value, so a consumer can tell "the same sentence, revised" from "the
   * next sentence" without comparing strings.
   */
  utteranceIndex?: number;
  /** Epoch ms this partial was received by the client. */
  receivedAt: number;
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
/**
 * The three `MediaTrackConstraints` switches that decide whether the browser
 * hands the SDK processed or raw microphone audio.
 *
 * Mirrors the WebRTC constraint names 1:1 so the values pass straight through
 * to `getUserMedia`; see {@link AudioStartOptions.audioProcessing}.
 */
export interface AudioProcessingConstraints {
  /** Browser acoustic echo cancellation. Browser default: ON. */
  echoCancellation?: boolean;
  /** Browser noise suppression (distinct from the SDK's RNNoise stage). Browser default: ON. */
  noiseSuppression?: boolean;
  /** Browser automatic gain control — the only thing that changes capture LEVEL. Browser default: ON. */
  autoGainControl?: boolean;
}

export interface AudioStartOptions {
  language?: string;
  /**
   * End-user STT language mode id, e.g. `'en'`, `'ml'`, `'ml-en'`
   * (Malayalam+English code-switch), `'auto'`. Forwarded to the backend STT
   * session, which resolves it against the session engine and rejects (422) a
   * mode no configured engine can serve. Takes precedence over `language` on
   * the backend path. Fetch the selectable modes with `useArcaSttLanguageModes`.
   */
  languageMode?: string;
  /**
   * Pre-start STT engine selection. Default `'primary'`. `'fallback'`
   * opens the session on the tenant-admin default provider from the start while
   * keeping the primary switchable (so a later `switchToPipeline()` returns to
   * it). Threaded exactly like {@link AudioStartOptions.languageMode}. The
   * backend fail-closes (409) when `'fallback'` is requested but no fallback is
   * configured.
   */
  startOn?: 'primary' | 'fallback';
  /**
   * Backend ASR pipeline UUID or slug.
   *
   * @deprecated TASK-865 — removed in R4 (the `AsrPipeline` resource retires
   * under TASK-861). Pass {@link AudioStartOptions.agentSlug} instead, or
   * nothing. Still forwarded for now, with a deprecation warning; when BOTH are
   * passed, `agentSlug` wins and this value is dropped (warned, never silent).
   */
  pipelineId?: string;
  /**
   * Slug of the published ASR Agent (task `SPEECH_TO_TEXT`) that should
   * transcribe this capture — a lineage key, like `workflowDefinitionSlug` at
   * `session.open()`. Omit to let the tenant → department assignment cascade
   * decide. The client never names a pipeline, an engine, a model or a VAD:
   * what transcribes is a server-side decision. Discover the selectable set
   * with `useSelectableAsrAgents()`.
   */
  agentSlug?: string;
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
   * Extra microphones beyond {@link AudioStartOptions.deviceId} and
   * {@link AudioStartOptions.secondaryDeviceId}. ALL selected mics
   * are mixed into ONE uplink stream — `AudioMixer` is N-source with per-source
   * gain and 1/sqrt(N) master normalization, so the ceiling of two was a
   * limitation of the hook, not of the mixer.
   *
   * The resolved source order is
   * `[deviceId, secondaryDeviceId, ...additionalDeviceIds]` with empties
   * dropped and duplicates removed; that order is what
   * {@link AudioStartOptions.sourceGains} indexes into. Additive/optional —
   * omit it and the pre-597 one-or-two-mic behaviour is byte-identical.
   */
  additionalDeviceIds?: string[];
  /**
   * Pre-built capture streams used **instead of** `getUserMedia`.
   *
   * When this is non-empty the hook opens NO microphone at all: the supplied
   * streams become the capture sources and flow through the identical
   * mixer → noise-filter → VAD → STT graph a mic would. This is the injection
   * seam that lets a caller drive the pipeline from an audio FILE
   * (`AudioContext.decodeAudioData` → `AudioBufferSourceNode` →
   * `MediaStreamAudioDestinationNode.stream`) — one stream simulates a single
   * mic, several simulate several mics mixed down to one uplink.
   *
   * Mutually exclusive with the deviceId fields: when set, `deviceId` /
   * `secondaryDeviceId` / `additionalDeviceIds` are ignored.
   *
   * OWNERSHIP: injected streams are CALLER-owned. `stop()`
   * (and a failed `start()`) unwires them from the graph but never stops
   * their tracks — the same stream object can be passed to the next
   * `start()` and will simply work. Only streams the SDK itself opened via
   * `getUserMedia` are stopped by SDK teardown. Corollary: releasing the
   * microphone of an injected stream is the CALLER's job; forgetting it
   * leaves the browser's recording indicator lit after `stop()`.
   *
   * Every entry must have at least one live audio track at `start()` —
   * a dead or trackless stream rejects with `SOURCE_STREAM_NOT_LIVE`
   * instead of producing a silent uplink.
   */
  sourceStreams?: MediaStream[];
  /**
   * Per-source mixer gain (linear, `1.0` = unity), index-aligned with the
   * resolved source list — i.e. with {@link AudioStartOptions.sourceStreams}
   * when streams are injected, otherwise with
   * `[deviceId, secondaryDeviceId, ...additionalDeviceIds]` after de-duplication
   * Missing/short entries default to `1.0`. Ignored when there is a
   * single source, because a single source is fed to the pipeline directly and
   * no mixer node exists.
   */
  sourceGains?: number[];
  /**
   * Browser audio-processing switches, applied to the `getUserMedia` constraints
   * of EVERY resolved source.
   *
   * The SDK's own graph does nothing to the signal on the backend-streaming path
   * — the noise filter and VAD are separate, opt-in pipeline stages, the level
   * meters are analysis-only taps, and the uplink only resamples 48→16 kHz and
   * converts to Int16. The BROWSER is the exception: `getUserMedia` defaults
   * `echoCancellation`, `noiseSuppression` and `autoGainControl` to ON in
   * Chrome, Edge and Safari, so unconstrained capture is DSP'd and auto-gained
   * before the SDK ever sees it. Set these to `false` for genuinely raw capture
   * — the right choice for clinical ASR, for multi-mic arrays, and for virtual
   * or loopback devices, whose non-standard clocking the browser APM frequently
   * mishandles (it can emit pure silence).
   *
   * Only the keys present are sent, so a caller can disable AGC alone and leave
   * the rest to the browser. An omitted (or empty) object reproduces the pre-608
   * request exactly: `{ audio: true }` for the default mic, NOT `{ audio: {} }`.
   * Ignored when {@link AudioStartOptions.sourceStreams} is used — those streams
   * were built by the caller, who already owns their constraints.
   */
  audioProcessing?: AudioProcessingConstraints;
  /**
   * Opt into RUNTIME capture-source changes for this session.
   *
   * With this set, a mixer is built even for a SINGLE source, so
   * `useArcaAudio.addSource` / `removeSource` / `setSourceGain` can change what
   * is being recorded WITHOUT tearing the session down. That matters because
   * the alternative — `stop()` then `start()` — closes the WebSocket, ends the
   * STT session and breaks transcript continuity, purely to attach a second
   * microphone.
   *
   * It is opt-in rather than always-on because the pipeline is initialized with
   * exactly ONE track: with several sources that track is necessarily the
   * mixer's output, but a lone source is fed straight through (no mixer node in
   * the graph) and that pre-597 behaviour is preserved by default. Sessions
   * started with two or more sources already have a mixer and accept runtime
   * changes without this flag.
   *
   * Note the mixer's `1/√N` master normalization is recomputed on every
   * add/remove, so joining a second mic drops the mix level ~3 dB — deliberate
   * summation headroom, not a bug.
   */
  dynamicSources?: boolean;
  /**
   * Ceiling, in ms, on the streaming-STT stop-drain performed when this capture
   * session is torn down.
   *
   * `stop()` releases the microphone synchronously and only THEN awaits the
   * drain, so this does not delay the mic going off or `isCapturing` going
   * false — it bounds how long the returned promise may wait for the server's
   * last transcript before giving up. Omit for the client default
   * (`SttWebSocketClient.DEFAULT_DRAIN_TIMEOUT_MS`, 1500 ms). The drain normally
   * ends far sooner, when the backend publishes its terminal `closed` status.
   *
   * Non-positive values are IGNORED (the default applies), matching the
   * provider-level guard on `StreamingRemoteProviderConfig.drainTimeoutMs` —
   * `0` must never read as "close instantly" or "wait forever". Backend
   * (streaming) STT only; the local in-browser path has no transport to drain.
   */
  drainTimeoutMs?: number;
  /**
   * Quiet window, in ms, that ends the streaming-STT stop-drain EARLY
   * Once the backend reports `finalizing`, the drain resolves after
   * this much silence; every transcript received restarts the window.
   *
   * **`0` disables the early resolve**, so the drain waits for the server's
   * terminal `closed`/`cancelled` status (or {@link AudioStartOptions.drainTimeoutMs}).
   * That is the setting to use when the tail final matters more than a fast
   * teardown — on a slow pipeline the tail can arrive seconds after
   * `finalizing`, long past the 250 ms default, and the socket would otherwise
   * already be closed.
   *
   * Unlike `drainTimeoutMs`, **`0` is a meaningful value and is preserved**;
   * only NEGATIVE values are ignored. Omit for the client default
   * (`SttWebSocketClient.DEFAULT_DRAIN_QUIET_WINDOW_MS`, 250 ms). Backend
   * (streaming) STT only.
   */
  quietWindowMs?: number;
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
// Streaming STT connection / provider state
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
 * Payload of a backend `provider_switched` status result
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
   * Engine now transcribing after the swap (bidirectional toggle).
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
