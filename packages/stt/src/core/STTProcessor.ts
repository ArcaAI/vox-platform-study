/**
 * @arcaai/stt - STTProcessor
 *
 * Main processor for speech-to-text.
 * Extends BaseProcessor from @arcaai/room for integration with the audio pipeline.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model. The local
 * (in-browser Whisper) provider was removed — this processor drives ONLY the
 * backend/remote streaming path.
 */

import {
  BaseProcessor,
  type AudioProcessorOptions,
  ProcessorEvent,
  debugLogConfig,
  debugLogTranscript,
  type DebugTranscriptEntry,
} from '@arcaai/room';

import type { STTOptions, STTStats, TranscriptionResult, STTFeatureFlags, RemoteProviderConfig, LanguageLocale } from '../types/index.js';
import {
  DEFAULT_STT_OPTIONS,
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_LANGUAGE_LOCALE,
  STTError,
  STTErrorCode,
  generateSessionId,
} from '../types/index.js';
import type { STTProvider } from '../providers/types.js';
import { RemoteSTTProvider } from '../providers/BackendSTTProvider.js';
import {
  StreamingBackendSTTProvider,
  type StreamingGapPayload,
  type StreamingSessionLike,
  type StreamingWsClientLike,
} from '../providers/StreamingBackendSTTProvider.js';
import { getSTTBrowserSupport } from '../utils/browserSupport.js';
import { WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';
import { createAudioCapture, type AudioCaptureHandle } from './audioCapture.js';

/**
 * Externally-constructed streaming transport injected into the STT
 * processor by the SDK glue layer. When set, the processor routes
 * `initializeRemoteProvider` through `StreamingBackendSTTProvider` instead
 * of the legacy `RemoteSTTProvider`.
 */
export interface STTStreamingTransport {
  sessionManager: StreamingSessionLike;
  wsClient: StreamingWsClientLike;
  /**
   * Backend ASR pipeline UUID or slug.
   * @deprecated TASK-865 — removed in R4. Name the ASR Agent with `agentSlug`,
   * or set neither and let the gateway resolve the tenant default.
   */
  pipelineId?: string;
  /** Slug of the published ASR Agent (task `SPEECH_TO_TEXT`) to transcribe with (TASK-865). */
  agentSlug?: string;
  /** Optional consultation id to associate with the streaming session. */
  consultationId?: string;
  /**
   * Optional ceiling (ms) on the stop-drain `StreamingBackendSTTProvider.destroy()`
   * performs. Threaded from the SDK's
   * `AudioStartOptions.drainTimeoutMs` through `PluginManager`'s runtime
   * options. Omitted / non-positive ⇒ the ws client's own default.
   */
  drainTimeoutMs?: number;
  /**
   * Optional quiet window (ms) that ends the stop-drain early once the backend
   * reports `finalizing`. Threaded from the SDK's
   * `AudioStartOptions.quietWindowMs`. `0` DISABLES the early resolve (the
   * drain then waits for the terminal status or `drainTimeoutMs`) and is
   * preserved verbatim; omitted / negative ⇒ the ws client's own default.
   */
  quietWindowMs?: number;
}

/**
 * STTProcessor provides speech-to-text transcription for audio tracks.
 *
 * Features:
 * - Remote (backend streaming) processing via WebSocket
 * - Event-based transcription results
 * - Integration with @arcaai/room processor pipeline
 *
 * @example
 * ```typescript
 * import { STTProcessor } from '@arcaai/stt';
 *
 * const stt = new STTProcessor({
 *   sttSocket: 'wss://api.example.com/ws/stt',
 *   audio: {
 *     language: 'en-US',
 *     sampleRate: 16000,
 *   },
 *   features: {
 *     diarization: true,
 *   },
 * });
 *
 * // Listen for transcriptions
 * stt.on('data', (payload) => {
 *   if (payload.type === 'stt-transcription') {
 *     console.log('Transcription:', payload.data.text);
 *   }
 * });
 *
 * // Attach to an AudioTrack
 * await audioTrack.setProcessor(stt);
 *
 * // Later, cleanup
 * await stt.destroy();
 * ```
 */
export class STTProcessor extends BaseProcessor {
  private options: STTOptions;
  private provider: STTProvider | null = null;
  private sessionId: string;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // Audio processing
  private captureHandle: AudioCaptureHandle | null = null;
  private debugSegmentCounter = 0;

  /**
   * Optional streaming transport injected by the SDK. When set,
   * `initializeRemoteProvider` uses `StreamingBackendSTTProvider`
   * (pipeline-aware) instead of the deprecated `RemoteSTTProvider`.
   */
  private streamingTransport: STTStreamingTransport | null = null;

  /**
   * PUSH channel for backpressure drops, re-emitted from the streaming
   * provider's `onDrop`. Consumers (the vox `TranscriptionPipeline`)
   * register this to forward drops up to the store/hook/UI. Only the streaming
   * remote provider produces drops; other providers never invoke it.
   */
  private backpressureDropCallback: ((droppedFrameCount: number) => void) | null = null;

  /**
   * PUSH channel for server `gap` frames (TASK-985 M-43), re-emitted from the
   * streaming provider's `onGap`. The downlink mirror of
   * {@link backpressureDropCallback}: that is audio lost on the way up, this is
   * text the gateway discarded on the way down.
   */
  private gapCallback: ((gap: StreamingGapPayload) => void) | null = null;

  constructor(options: STTOptions = {}) {
    super('stt-processor', options.debugMode);

    // Merge options with defaults
    this.options = {
      ...options,
      audio: {
        ...DEFAULT_AUDIO_CONFIG,
        ...options.audio,
      },
      features: {
        ...DEFAULT_FEATURE_FLAGS,
        ...options.features,
      },
      enableStats: options.enableStats ?? DEFAULT_STT_OPTIONS.enableStats,
      statsInterval: options.statsInterval ?? DEFAULT_STT_OPTIONS.statsInterval,
    };

    // Auto-generate session ID if not provided
    this.sessionId = options.sessionId ?? generateSessionId();
  }

  /**
   * Check if this processor is supported in the current browser.
   */
  isSupported(): boolean {
    const support = getSTTBrowserSupport();
    return support.backendSupported;
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Initialize the STT processor.
   */
  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    if (this.debugMode) {
      const features = (this.options.features ?? {}) as STTFeatureFlags;
      const audio = this.options.audio ?? DEFAULT_AUDIO_CONFIG;
      debugLogConfig('STT', {
        provider: features.provider ?? DEFAULT_FEATURE_FLAGS.provider,
        language: audio.language ?? DEFAULT_LANGUAGE_LOCALE,
        diarization: features.diarization ?? false,
        codeSwitching: features.codeSwitching ?? false,
        returnTimestamps: features.returnTimestamps ?? true,
        sampleRate: audio.sampleRate ?? WHISPER_SAMPLE_RATE,
      });
      this.debugSegmentCounter = 0;
    }

    // Check browser support
    const support = getSTTBrowserSupport();

    if (!support.backendSupported) {
      throw new STTError(STTErrorCode.NOT_SUPPORTED, support.unsupportedReason ?? 'STT not supported in this browser');
    }

    // Validate configuration
    this.validateConfig();

    // Create and initialize provider
    await this.initializeRemoteProvider();

    // Set up audio capture from track
    await this.setupAudioCapture(audioContext, track);

    // Ensure provider is active for this attach cycle.
    if (this.provider) {
      await this.provider.start();
    }

    // Pass through audio (STT doesn't modify audio)
    const stream = new MediaStream([track]);
    const source = audioContext.createMediaStreamSource(stream);
    const destination = audioContext.createMediaStreamDestination();
    source.connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];

    // Start stats emission if enabled
    if (this.options.enableStats) {
      this.startStatsEmission();
    }
  }

  /**
   * Destroy the processor and release resources.
   */
  protected async onDestroy(): Promise<void> {
    this.stopStatsEmission();

    if (this.provider) {
      await this.provider.stop();
      await this.provider.destroy();
      this.provider = null;
    }

    if (this.captureHandle) {
      this.captureHandle.destroy();
      this.captureHandle = null;
    }
  }

  /**
   * Enable the processor.
   */
  protected async onEnable(): Promise<void> {
    if (this.provider) {
      await this.provider.start();
    }
  }

  /**
   * Disable the processor.
   */
  protected async onDisable(): Promise<void> {
    if (this.provider) {
      await this.provider.stop();
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Get the current provider type. Always `'remote'` — the in-browser Whisper
   * provider was removed (TASK-1006).
   */
  getProviderType(): 'remote' {
    return 'remote';
  }

  /**
   * Get the underlying provider.
   */
  getProvider(): STTProvider | null {
    return this.provider;
  }

  /**
   * Get the current language locale.
   */
  getLanguage(): LanguageLocale {
    return this.options.audio?.language ?? DEFAULT_LANGUAGE_LOCALE;
  }

  /**
   * Transcribe a specific audio segment directly. The remote/streaming
   * provider does not support this (no local model to run it against) and
   * rejects with `STTError(NOT_SUPPORTED)`.
   *
   * @param audio - Audio samples (Float32Array at 16kHz)
   * @returns Transcription result
   */
  async transcribeSegment(audio: Float32Array): Promise<TranscriptionResult> {
    if (!this.provider) {
      throw new STTError(STTErrorCode.PROVIDER_INIT_FAILED, 'Provider not initialized');
    }

    return this.provider.transcribeSegment(audio);
  }

  /**
   * Get processing statistics.
   */
  getStats(): STTStats | null {
    const stats = this.provider?.getStats();
    if (stats) {
      return {
        ...stats,
        sessionId: this.sessionId,
        language: this.getLanguage(),
      };
    }
    return null;
  }

  /**
   * Get the current options.
   */
  getOptions(): STTOptions {
    return { ...this.options };
  }

  /**
   * Inject (or clear) the streaming transport used by the remote provider
   * path. Must be called BEFORE `onInit` for the new path to take effect.
   *
   * When a transport is set, the next call to `initializeRemoteProvider()`
   * constructs `StreamingBackendSTTProvider` instead of the legacy
   * `RemoteSTTProvider`. Pass `null` to revert.
   */
  setStreamingTransport(transport: STTStreamingTransport | null): void {
    this.streamingTransport = transport;
  }

  /**
   * Visible for diagnostics — the currently-injected transport, if any.
   */
  getStreamingTransport(): STTStreamingTransport | null {
    return this.streamingTransport;
  }

  /**
   * The streaming session manager for the injected transport, or `null` when
   * no transport is set. The vox hook reaches it to drive an on-the-fly
   * provider switch without threading a new callback chain.
   */
  getStreamingSessionManager(): StreamingSessionLike | null {
    return this.streamingTransport?.sessionManager ?? null;
  }

  /**
   * Register a callback fired once per outbound frame dropped at the
   * streaming client's backpressure watermark (with the running total). Only the
   * streaming remote provider produces drops. This is the PUSH complement to the
   * `droppedFrames` field in {@link getStats}; the vox `TranscriptionPipeline`
   * registers it to emit an `audioDrop` event up to the store/hook/UI. Single-
   * slot; re-registering replaces the callback. Set before `onInit` to catch
   * every drop.
   */
  onBackpressureDrop(cb: (droppedFrameCount: number) => void): void {
    this.backpressureDropCallback = cb;
  }

  /**
   * Register a callback fired when the backend reports that it DISCARDED
   * results it could not deliver (TASK-985 M-43). Only the streaming remote
   * provider produces them. Single-slot; set before `onInit` to catch every gap.
   */
  onGap(cb: (gap: StreamingGapPayload) => void): void {
    this.gapCallback = cb;
  }

  /**
   * Cumulative PCM bytes sent uplink since the streaming session started
   * (0 with no streaming transport). Polled by the vox pipeline to derive a
   * live uplink bitrate.
   */
  getUplinkBytesSent(): number {
    return this.provider instanceof StreamingBackendSTTProvider ? this.provider.getBytesSent() : 0;
  }

  /**
   * Release the current provider. Kept for API compatibility with
   * pre-TASK-1006 callers — there is no warm pool to release into any more
   * (that existed only for the removed local Whisper provider), so this is
   * equivalent to a full destroy.
   */
  async releaseWarmResources(): Promise<void> {
    if (!this.provider) return;
    await this.provider.destroy();
    this.provider = null;
  }

  /**
   * Update the configured language. The remote/streaming provider is
   * stateless w.r.t. language — it is picked up on the next session
   * establishment, so this just records the new value.
   */
  async setLanguage(language: LanguageLocale): Promise<void> {
    if (!this.options.audio) {
      this.options.audio = { ...DEFAULT_AUDIO_CONFIG };
    }
    this.options.audio.language = language;
  }

  /**
   * @deprecated TASK-1006 — was forwarded to the local diarizer, which was
   * removed alongside the in-browser Whisper provider (diarization is a
   * server-side decision of the tenant's ASR Agent). No-op.
   */
  setReservedSpeakerId(_id: string | undefined): void {
    // Intentional no-op — see deprecation note above.
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Validate the configuration.
   */
  private validateConfig(): void {
    // A streaming transport already owns the WebSocket URL via
    // StreamingSessionManager.getWebSocketUrl(), so sttSocket is required
    // only for the legacy RemoteSTTProvider path.
    if (!this.options.sttSocket && !this.streamingTransport) {
      throw new STTError(STTErrorCode.INVALID_CONFIG, 'sttSocket is required when no streaming transport is injected');
    }
  }

  /**
   * Initialize the remote WebSocket provider.
   *
   * When a streaming transport has been injected via
   * `setStreamingTransport(...)`, construct the pipeline-aware
   * `StreamingBackendSTTProvider` instead of the legacy `RemoteSTTProvider`.
   * The legacy path remains in place so existing callers that pass only an
   * `sttSocket` URL continue to work until they migrate.
   */
  private async initializeRemoteProvider(): Promise<void> {
    if (this.streamingTransport) {
      await this.initializeStreamingRemoteProvider(this.streamingTransport);
      return;
    }

    const provider = new RemoteSTTProvider();

    if (!provider.isSupported()) {
      throw new STTError(STTErrorCode.NOT_SUPPORTED, 'Remote STT not supported in this browser');
    }

    const audio = this.options.audio ?? DEFAULT_AUDIO_CONFIG;
    const features = this.options.features ?? DEFAULT_FEATURE_FLAGS;

    const config: RemoteProviderConfig = {
      sttSocket: this.options.sttSocket!,
      sessionId: this.sessionId,
      language: audio.language ?? DEFAULT_LANGUAGE_LOCALE,
      sampleRate: audio.sampleRate ?? WHISPER_SAMPLE_RATE,
      channels: audio.channels ?? 1,
      chunkLengthS: audio.chunkLengthS ?? 30,
      overlapLengthS: audio.overlapLengthS ?? 5,
      returnTimestamps: features.returnTimestamps ?? true,
      codeSwitching: features.codeSwitching ?? false,
      diarization: features.diarization ?? false,
      numSpeakers: features.numSpeakers ?? 2,
      prompt: this.options.prompt,
    };

    provider.onTranscription((result) => {
      this.handleTranscription(result);
    });

    provider.onError((error) => {
      this.handleError(error);
    });

    await provider.init(config);

    this.provider = provider;
  }

  /**
   * Initialize the pipeline-aware `StreamingBackendSTTProvider` using the
   * externally-injected transport.
   */
  private async initializeStreamingRemoteProvider(transport: STTStreamingTransport): Promise<void> {
    const provider = new StreamingBackendSTTProvider({
      sessionManager: transport.sessionManager,
      wsClient: transport.wsClient,
    });

    if (!provider.isSupported()) {
      throw new STTError(STTErrorCode.NOT_SUPPORTED, 'Remote STT not supported in this browser');
    }

    const audio = this.options.audio ?? DEFAULT_AUDIO_CONFIG;
    const features = this.options.features ?? DEFAULT_FEATURE_FLAGS;

    provider.onTranscription((result) => {
      this.handleTranscription(result);
    });
    provider.onError((error) => {
      this.handleError(error);
    });
    // Consume the provider's backpressure-drop PUSH channel and re-emit it
    // so the vox pipeline/store can surface a degraded signal. The
    // provider is the single source of truth for the count (avoids double-
    // counting the ws client's own watermark drops).
    provider.onDrop((droppedFrameCount) => {
      this.backpressureDropCallback?.(droppedFrameCount);
    });
    // TASK-985 M-43 — the downlink twin of the drop channel above. Without this
    // hop a `gap` frame dead-ends in the provider and the clinician reads a
    // transcript with a silent hole in it.
    provider.onGap((gap) => {
      this.gapCallback?.(gap);
    });

    await provider.init({
      sessionId: this.sessionId,
      // TASK-985 QW-2 / M-02 — NO default here.
      //
      // ⚠ MERGE HAZARD: this default (and the SDK's `languageMode: 'auto'`) is
      // currently MASKING a server-side prompt defect — 'auto' resolves to an
      // unprompted decode, while the agent's own configured mode resolves to a
      // pair-primed one that scores far worse. Removing the default is correct
      // and it EXPOSES that defect; it must land with the prompt-configuration
      // fix, not ahead of it. See TASK-985 §2.7.
      //
      // The backend's backfill is `if not language_mode:` — a literal is not
      // "no opinion", it beats the tenant's agent. Sending nothing is the only
      // way to say "the agent decides". Every OTHER `?? DEFAULT_LANGUAGE_LOCALE`
      // in this file stays: those configure the non-streaming remote provider,
      // which has no agent to fall back to and genuinely needs a locale. Only
      // the STREAMING session-create path, which this is, reaches the tenant's
      // ASR agent.
      language: audio.language,
      // End-user language mode — forwarded to the STT session, which
      // resolves it against the session engine and 422s an unservable mode.
      // Read from options directly (the default config carries no mode).
      languageMode: this.options.audio?.languageMode,
      // Pre-start engine selection — the backend opens the session
      // on the tenant-admin default provider when 'fallback'.
      startOn: this.options.audio?.startOn,
      sampleRate: audio.sampleRate ?? WHISPER_SAMPLE_RATE,
      channels: audio.channels ?? 1,
      chunkLengthS: audio.chunkLengthS ?? 30,
      overlapLengthS: audio.overlapLengthS ?? 5,
      returnTimestamps: features.returnTimestamps ?? true,
      codeSwitching: features.codeSwitching ?? false,
      diarization: features.diarization ?? false,
      numSpeakers: features.numSpeakers ?? 2,
      pipelineId: transport.pipelineId,
      agentSlug: transport.agentSlug,
      consultationId: transport.consultationId,
      drainTimeoutMs: transport.drainTimeoutMs,
      // Per-session stop-drain ceiling. The provider
      // applies its own `> 0` guard, so an out-of-range value degrades to the
      // client default rather than to a zero-length (or unbounded) drain.
      quietWindowMs: transport.quietWindowMs,
      // Per-session stop-drain quiet window. The provider guards on
      // `>= 0` here, NOT `> 0`: `0` is the documented "wait for the terminal
      // status instead of a quiet lull" setting and must not be discarded.
      prompt: this.options.prompt,
    });

    this.provider = provider;
  }

  /**
   * Set up audio capture from the MediaStreamTrack.
   *
   * Uses `AudioWorkletNode` when available (off-main-thread, modern API).
   * Transparently falls back to the deprecated `ScriptProcessorNode` with a
   * console warning when the runtime lacks AudioWorklet support.
   */
  private async setupAudioCapture(audioContext: AudioContext, track: MediaStreamTrack): Promise<void> {
    this.captureHandle = await createAudioCapture(audioContext, track, (frame) => {
      if (!this.provider || !this._enabled) {
        return;
      }

      this.provider.processAudio(frame, audioContext.sampleRate);
    });
  }

  /**
   * Handle transcription result from provider.
   */
  private handleTranscription(result: TranscriptionResult): void {
    const eventType = result.isFinal ? 'stt-transcription' : 'stt-partial';
    this.emitData(eventType, result);

    if (this.debugMode && result.isFinal) {
      this.debugSegmentCounter++;
      const timestamps = result.timestamps;
      const start = timestamps?.[0]?.start ?? 0;
      const lastTs = timestamps?.[timestamps.length - 1];
      const end = lastTs?.end ?? start + (result.duration ?? 0);

      const entry: DebugTranscriptEntry = {
        segment: this.debugSegmentCounter,
        speaker: result.speakerId ?? 'speaker-1',
        start,
        end,
        duration: end - start,
        inference: (result.latencyMs ?? 0) / 1000,
      };

      const features = (this.options.features ?? {}) as STTFeatureFlags;
      if (features.returnTimestamps === 'word' && timestamps && timestamps.length > 0) {
        entry.words = timestamps.map((ts) => ({
          word: ts.text,
          confidence: result.confidence ?? 0,
          start: ts.start,
          end: ts.end,
        }));
      }

      debugLogTranscript('STT', entry);
    }
  }

  /**
   * Handle error from provider.
   */
  private handleError(error: Error): void {
    this.emit(ProcessorEvent.Error, {
      error,
      recoverable: true,
    });
  }

  /**
   * Start periodic stats emission.
   */
  private startStatsEmission(): void {
    this.statsInterval = setInterval(() => {
      const stats = this.provider?.getStats();
      if (stats) {
        this.emitData('stt-stats', stats);
      }
    }, this.options.statsInterval ?? 1000);
  }

  /**
   * Stop stats emission.
   */
  private stopStatsEmission(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
}

/**
 * Factory function to create an STTProcessor.
 *
 * @param options - Processor options
 * @returns STTProcessor instance
 */
export function createSTT(options?: STTOptions): STTProcessor {
  return new STTProcessor(options);
}
