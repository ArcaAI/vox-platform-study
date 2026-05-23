/**
 * @arcaai/stt - STTProcessor
 *
 * Main processor for speech-to-text.
 * Extends BaseProcessor from @arcaai/room for integration with the audio pipeline.
 */

import {
  BaseProcessor,
  type AudioProcessorOptions,
  ProcessorEvent,
  debugLogConfig,
  debugLogTranscript,
  type DebugTranscriptEntry,
} from '@arcaai/room';

import type {
  STTOptions,
  STTStats,
  TranscriptionResult,
  STTProviderType,
  STTFeatureFlags,
  LocalProviderConfig,
  RemoteProviderConfig,
  ComputeDevice,
  LanguageLocale,
} from '../types/index.js';
import {
  DEFAULT_STT_OPTIONS,
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_LANGUAGE_LOCALE,
  STTError,
  STTErrorCode,
  generateSessionId,
  isWhisperModelSize,
  normalizeModelId,
  getLanguageCode,
} from '../types/index.js';
import type { STTProvider } from '../providers/types.js';
import { LocalSTTProvider } from '../providers/LocalSTTProvider.js';
import { RemoteSTTProvider } from '../providers/BackendSTTProvider.js';
import { getSTTBrowserSupport } from '../utils/browserSupport.js';
import { WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';
import { createAudioCapture, type AudioCaptureHandle } from './audioCapture.js';

/**
 * STTProcessor provides speech-to-text transcription for audio tracks.
 *
 * Features:
 * - Local Whisper processing via Transformers.js
 * - Remote processing via WebSocket
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
 *     provider: 'remote',
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
  private static localProviderPool = new Map<string, LocalSTTProvider>();

  private options: STTOptions;
  private provider: STTProvider | null = null;
  private resolvedProviderType: STTProviderType = 'remote';
  private sessionId: string;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // Audio processing
  private captureHandle: AudioCaptureHandle | null = null;
  private localProviderCacheKey: string | null = null;
  private debugSegmentCounter = 0;

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
    return support.localSupported || support.backendSupported;
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
        modelId: features.modelId ?? 'default',
        diarization: features.diarization ?? false,
        codeSwitching: features.codeSwitching ?? false,
        returnTimestamps: features.returnTimestamps ?? true,
        vadGate: features.vadGate ?? false,
        sampleRate: audio.sampleRate ?? WHISPER_SAMPLE_RATE,
      });
      this.debugSegmentCounter = 0;
    }

    // Check browser support
    const support = getSTTBrowserSupport();

    if (!support.localSupported && !support.backendSupported) {
      throw new STTError(STTErrorCode.NOT_SUPPORTED, support.unsupportedReason ?? 'STT not supported in this browser');
    }

    // Resolve provider type
    this.resolvedProviderType = this.resolveProviderType();

    // Validate configuration
    this.validateConfig();

    // Create and initialize provider
    await this.initializeProvider();

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

    // Stop provider. Keep local provider warm between attach/detach cycles so
    // model weights remain in-memory and we avoid repeated model downloads.
    if (this.provider) {
      await this.provider.stop();
      const keepLocalProviderWarm = this.resolvedProviderType === 'local' && this.provider instanceof LocalSTTProvider;
      if (!keepLocalProviderWarm) {
        await this.provider.destroy();
        this.provider = null;
        this.localProviderCacheKey = null;
      }
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
   * Get the current provider type.
   */
  getProviderType(): STTProviderType {
    return this.resolvedProviderType;
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
   * Transcribe a specific audio segment directly.
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
   * Fully release warm local-provider resources.
   * This should be called when the owning hook/component unmounts.
   */
  async releaseWarmResources(): Promise<void> {
    if (!this.provider) {
      this.localProviderCacheKey = null;
      return;
    }
    if (this.provider instanceof LocalSTTProvider && this.localProviderCacheKey) {
      STTProcessor.localProviderPool.set(this.localProviderCacheKey, this.provider);
      await STTProcessor.evictLocalProvidersExcept(this.localProviderCacheKey);
      this.provider = null;
      return;
    }

    await this.provider.destroy();
    this.provider = null;
    this.localProviderCacheKey = null;
  }

  /**
   * Update language dynamically.
   * Note: This requires reinitializing the provider for local mode.
   */
  async setLanguage(language: LanguageLocale): Promise<void> {
    if (!this.options.audio) {
      this.options.audio = { ...DEFAULT_AUDIO_CONFIG };
    }
    this.options.audio.language = language;

    // For local provider, would need to reinitialize
    // For remote, the next session can use the new language
    if (this.provider && this.resolvedProviderType === 'local') {
      console.warn('[STTProcessor] Language change requires reinitialization for local provider');
    }
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Validate the configuration.
   */
  private validateConfig(): void {
    const features = this.options.features as STTFeatureFlags | undefined;
    const provider = features?.provider ?? DEFAULT_FEATURE_FLAGS.provider;

    // For local provider, modelId is required
    if (provider === 'local' && !features?.modelId) {
      throw new STTError(STTErrorCode.INVALID_CONFIG, 'modelId is required when provider is "local"');
    }

    // For remote provider, sttSocket is required
    if (provider === 'remote' && !this.options.sttSocket) {
      throw new STTError(STTErrorCode.INVALID_CONFIG, 'sttSocket is required when provider is "remote"');
    }
  }

  /**
   * Resolve which provider type to use.
   */
  private resolveProviderType(): STTProviderType {
    const provider = this.options.features?.provider;

    if (provider === 'local') {
      return 'local';
    }

    // Default to remote
    return 'remote';
  }

  /**
   * Initialize the appropriate provider.
   */
  private async initializeProvider(): Promise<void> {
    if (this.resolvedProviderType === 'local') {
      const nextCacheKey = this.getLocalProviderCacheKey();
      const canReuseLocalProvider = this.provider instanceof LocalSTTProvider && this.localProviderCacheKey === nextCacheKey;
      const pooledProvider = STTProcessor.localProviderPool.get(nextCacheKey);
      const canReusePooledProvider = pooledProvider && pooledProvider.isReady() && !pooledProvider.isProcessing();

      if (!canReuseLocalProvider) {
        if (canReusePooledProvider) {
          const reusedProvider = pooledProvider as LocalSTTProvider;
          this.bindLocalProviderCallbacks(reusedProvider);
          this.provider = reusedProvider;
          this.localProviderCacheKey = nextCacheKey;
          return;
        }

        if (this.provider) {
          if (this.provider instanceof LocalSTTProvider && this.localProviderCacheKey) {
            STTProcessor.localProviderPool.delete(this.localProviderCacheKey);
          }
          await this.provider.stop();
          await this.provider.destroy();
          this.provider = null;
        }
        await this.initializeLocalProvider();
        this.localProviderCacheKey = nextCacheKey;
        if (this.provider) {
          const initializedProvider = this.provider as LocalSTTProvider;
          STTProcessor.localProviderPool.set(nextCacheKey, initializedProvider);
          await STTProcessor.evictLocalProvidersExcept(nextCacheKey);
        }
      }
    } else {
      const previousLocalProviderKey = this.localProviderCacheKey;
      this.localProviderCacheKey = null;
      if (this.provider) {
        if (this.provider instanceof LocalSTTProvider && previousLocalProviderKey) {
          STTProcessor.localProviderPool.delete(previousLocalProviderKey);
        }
        await this.provider.stop();
        await this.provider.destroy();
        this.provider = null;
      }
      await this.initializeRemoteProvider();
    }
  }

  private getLocalProviderCacheKey(): string {
    const audio = this.options.audio ?? DEFAULT_AUDIO_CONFIG;
    const features = this.options.features as STTFeatureFlags;
    const normalizedModelId = normalizeModelId(features.modelId ?? '');
    const normalizedLanguage = getLanguageCode(audio.language ?? DEFAULT_LANGUAGE_LOCALE);

    return JSON.stringify({
      modelId: normalizedModelId,
      language: normalizedLanguage,
      device: features.device ?? 'auto',
      quantized: features.quantized ?? true,
      sampleRate: audio.sampleRate ?? WHISPER_SAMPLE_RATE,
      channels: audio.channels ?? 1,
      chunkLengthS: audio.chunkLengthS ?? 30,
      overlapLengthS: audio.overlapLengthS ?? 5,
      returnTimestamps: features.returnTimestamps ?? true,
      codeSwitching: features.codeSwitching ?? false,
      vadGate: features.vadGate ?? false,
      diarization: features.diarization ?? false,
      numSpeakers: features.numSpeakers ?? 2,
    });
  }

  /**
   * Initialize the local Whisper provider.
   */
  private async initializeLocalProvider(): Promise<void> {
    const provider = new LocalSTTProvider();

    if (!provider.isSupported()) {
      throw new STTError(STTErrorCode.NOT_SUPPORTED, 'Local STT not supported in this browser');
    }

    const audio = this.options.audio ?? DEFAULT_AUDIO_CONFIG;
    const features = this.options.features as STTFeatureFlags;
    const modelId = features.modelId!;

    const config: LocalProviderConfig = {
      sessionId: this.sessionId,
      modelId: modelId,
      language: audio.language ?? DEFAULT_LANGUAGE_LOCALE,
      device: (features.device ?? 'auto') as ComputeDevice,
      quantized: features.quantized ?? true,
      sampleRate: audio.sampleRate ?? WHISPER_SAMPLE_RATE,
      channels: audio.channels ?? 1,
      chunkLengthS: audio.chunkLengthS ?? 30,
      overlapLengthS: audio.overlapLengthS ?? 5,
      returnTimestamps: features.returnTimestamps ?? true,
      codeSwitching: features.codeSwitching ?? false,
      diarization: features.diarization ?? false,
      numSpeakers: features.numSpeakers ?? 2,
      prompt: this.options.prompt,
      onProgress: this.options.onModelProgress,
    };

    this.bindLocalProviderCallbacks(provider);

    await provider.init(config);

    this.provider = provider;

    // Emit model loaded event
    const localProvider = provider as LocalSTTProvider;
    const engineStats = localProvider.getEngine()?.getStats();
    if (engineStats?.modelLoadTimeMs) {
      const whisperModel = isWhisperModelSize(modelId) ? modelId : 'custom';
      this.emitData('stt-model-loaded', {
        model: whisperModel,
        device: engineStats.device,
        loadTimeMs: engineStats.modelLoadTimeMs,
      });
    }
  }

  private bindLocalProviderCallbacks(provider: LocalSTTProvider): void {
    provider.onTranscription((result) => {
      this.handleTranscription(result);
    });

    provider.onError((error) => {
      this.handleError(error);
    });
  }

  private static async evictLocalProvidersExcept(keepKey: string): Promise<void> {
    for (const [cacheKey, provider] of STTProcessor.localProviderPool.entries()) {
      if (cacheKey === keepKey) {
        continue;
      }
      await provider.destroy();
      STTProcessor.localProviderPool.delete(cacheKey);
    }
  }

  /**
   * Initialize the remote WebSocket provider.
   */
  private async initializeRemoteProvider(): Promise<void> {
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

      const features = this.options.features as STTFeatureFlags | undefined;
      if (features?.vadGate) {
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
