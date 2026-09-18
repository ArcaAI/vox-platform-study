/**
 * @arcaai/stt - LocalSTTProvider
 *
 * Local STT provider using Whisper via Transformers.js.
 * Processes audio entirely in the browser without server dependency.
 *
 * By default, uses WhisperWorkerEngine which runs ML inference in a Web Worker
 * to keep the UI responsive. Falls back to main thread if Workers unavailable.
 */

import { DEFAULT_LANGUAGE_LOCALE } from '../types/index.js';
import type { TranscriptionResult, STTStats, LocalProviderConfig, ComputeDevice } from '../types/index.js';
import type { TranscribeOptions } from '../engines/types.js';
import { resolveLocalWhisperModel } from '../types/index.js';
import { BaseSTTProvider } from './BaseSTTProvider.js';
import { WhisperWorkerEngine } from '../engines/WhisperWorkerEngine.js';
import type { BaseEngine } from '../engines/BaseEngine.js';
import { AudioBufferManager } from '../core/AudioBufferManager.js';
import { isTransformersJsSupported } from '../utils/browserSupport.js';
import { WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';
import { LocalSpeakerDiarizer } from './LocalSpeakerDiarizer.js';

/**
 * Local STT provider using Whisper in the browser.
 *
 * Features:
 * - Fully client-side transcription (no server required)
 * - WebGPU acceleration with WASM fallback
 * - Multiple Whisper model sizes
 * - Chunk-based processing for streaming
 *
 * @example
 * ```typescript
 * const provider = new LocalSTTProvider();
 *
 * await provider.init({
 *   sessionId: 'session-123',
 *   modelId: 'tiny',
 *   language: 'en-US',
 *   device: 'auto',
 *   quantized: true,
 *   sampleRate: 16000,
 *   channels: 1,
 *   chunkLengthS: 30,
 *   overlapLengthS: 5,
 *   returnTimestamps: true,
 *   diarization: false,
 *   numSpeakers: 2,
 * });
 *
 * provider.onTranscription((result) => {
 *   console.log('Transcription:', result.text);
 * });
 *
 * await provider.start();
 *
 * // Process audio chunks
 * provider.processAudio(audioSamples, sampleRate);
 *
 * await provider.stop();
 * await provider.destroy();
 * ```
 */
export class LocalSTTProvider extends BaseSTTProvider {
  readonly name = 'local-whisper';
  readonly type = 'local' as const;

  private engine: BaseEngine | null = null;
  private bufferManager: AudioBufferManager | null = null;
  private processingInterval: ReturnType<typeof setInterval> | null = null;
  private isTranscribing = false;
  private usesWorker = false;
  private diarizer: LocalSpeakerDiarizer | null = null;

  isSupported(): boolean {
    return isTransformersJsSupported();
  }

  async init(config: LocalProviderConfig): Promise<void> {
    if (this.initialized) {
      await this.destroy();
    }

    this.config = config;

    // Resolve modelId into a browser-loadable Whisper source:
    // 'whisper-tiny' → 'tiny'; a namespaced HF repo passes through as modelPath;
    // a non-browser-loadable id (e.g. 'whisper-large-v3') falls back to a safe
    // browser-viable size instead of requesting a bare/gated HF repo (which 401s).
    const { model, modelPath } = resolveLocalWhisperModel(config.modelId);

    // Use WhisperWorkerEngine by default for non-blocking transcription
    // It will automatically fall back to main thread if Workers unavailable
    const workerEngine = new WhisperWorkerEngine();
    this.engine = workerEngine;
    this.usesWorker = workerEngine.usesWorker();

    await this.engine.init({
      model: model,
      // TASK-985 (QW-2) — `ProviderConfig.language` is optional, because on the
      // STREAMING path absent is the only way to say "the tenant's agent decides".
      // This engine is the in-browser Whisper pipeline: there is no agent behind it
      // to defer to, so it genuinely needs a locale and supplies its own default.
      language: config.language ?? DEFAULT_LANGUAGE_LOCALE,
      device: config.device,
      quantized: config.quantized,
      modelPath: modelPath,
      chunkLengthS: config.chunkLengthS,
      overlapLengthS: config.overlapLengthS,
      returnTimestamps: config.returnTimestamps,
      codeSwitching: config.codeSwitching,
      onProgress: config.onProgress,
      // Forward the default Whisper task into the engine.
      ...(config.task ? { task: config.task } : {}),
    });

    // Initialize buffer manager
    this.bufferManager = new AudioBufferManager({
      sampleRate: WHISPER_SAMPLE_RATE,
      chunkLengthS: config.chunkLengthS,
      overlapLengthS: config.overlapLengthS,
    });

    this.diarizer = new LocalSpeakerDiarizer({
      enabled: config.diarization,
      maxSpeakers: config.numSpeakers,
      // Forward the user-tuned similarity threshold.
      ...(typeof config.voiceProfile?.similarityThreshold === 'number' ? { similarityThreshold: config.voiceProfile.similarityThreshold } : {}),
      ...(config.voiceProfile?.reservedSpeakerId ? { reservedSpeakerId: config.voiceProfile.reservedSpeakerId } : {}),
    });

    this.initialized = true;
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Provider not initialized. Call init() first.');
    }

    this.processing = true;

    // Start processing loop to check for buffered audio
    this.processingInterval = setInterval(() => {
      this.processBufferedAudio();
    }, 500); // Check every 500ms
  }

  async stop(): Promise<void> {
    this.processing = false;

    // Stop processing loop
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Process any remaining audio
    await this.flushBuffer();
  }

  async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
    if (!this.bufferManager || !this.processing) {
      return;
    }

    // Add to buffer (will be resampled if needed)
    this.bufferManager.append(audio, sampleRate);

    // Check if we have a full chunk to process
    if (this.bufferManager.hasChunk() && !this.isTranscribing) {
      await this.processBufferedAudio();
    }
  }

  async transcribeSegment(audio: Float32Array): Promise<TranscriptionResult> {
    if (!this.engine) {
      throw new Error('Provider not initialized. Call init() first.');
    }

    const startTime = performance.now();
    const transcribeOptions: TranscribeOptions | undefined =
      this.config && (this.config as LocalProviderConfig).prompt ? { prompt: (this.config as LocalProviderConfig).prompt } : undefined;
    const baseResult = await this.engine.transcribe(audio, transcribeOptions);
    const result = this.applyLocalDiarization(baseResult, audio);
    const latencyMs = performance.now() - startTime;

    this.recordTranscription(latencyMs, audio.length / WHISPER_SAMPLE_RATE);

    return {
      ...result,
      latencyMs,
      duration: audio.length / WHISPER_SAMPLE_RATE,
    };
  }

  async destroy(): Promise<void> {
    await this.stop();

    if (this.engine) {
      await this.engine.destroy();
      this.engine = null;
    }

    if (this.bufferManager) {
      this.bufferManager.clear();
      this.bufferManager = null;
    }

    this.diarizer?.reset();
    this.diarizer = null;

    this.config = null;
    this.initialized = false;
    this.processing = false;
  }

  getStats(): STTStats & { usesWorker: boolean } {
    const baseStats = super.getStats();
    const engineStats = this.engine?.getStats();

    return {
      ...baseStats,
      bufferSizeS: this.bufferManager?.getDuration() ?? 0,
      model: engineStats?.model,
      device: engineStats?.device as ComputeDevice | undefined,
      usesWorker: this.usesWorker,
    };
  }

  /**
   * Process any buffered audio chunks.
   */
  private async processBufferedAudio(): Promise<void> {
    if (!this.bufferManager || !this.engine || this.isTranscribing) {
      return;
    }

    // Process all available chunks
    while (this.bufferManager.hasChunk()) {
      this.isTranscribing = true;

      try {
        const chunk = this.bufferManager.getChunk();
        if (chunk) {
          const result = await this.transcribeSegment(chunk);
          this.emitTranscription(result);
        }
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.isTranscribing = false;
      }
    }
  }

  /**
   * Flush and process any remaining audio in the buffer.
   */
  private async flushBuffer(): Promise<void> {
    if (!this.bufferManager || !this.engine) {
      return;
    }

    const remaining = this.bufferManager.flush();
    if (remaining && remaining.length > 0) {
      this.isTranscribing = true;

      try {
        const result = await this.transcribeSegment(remaining);
        this.emitTranscription(result);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.isTranscribing = false;
      }
    }
  }

  /**
   * Get the Whisper engine for direct access.
   */
  getEngine(): BaseEngine | null {
    return this.engine;
  }

  /**
   * Check if the provider is using a Web Worker for transcription.
   */
  isUsingWorker(): boolean {
    return this.usesWorker;
  }

  /**
   * Get the buffer manager for direct access.
   */
  getBufferManager(): AudioBufferManager | null {
    return this.bufferManager;
  }

  /**
   * Forward a late-arriving reserved-speaker id to the internal
   * `LocalSpeakerDiarizer`. Used by `STTProcessor.setReservedSpeakerId`,
   * which is in turn invoked by `PluginManager.propagateUserPreferenceDelta`
   * when `UserPreferences.activeVoiceProfile` changes after the pipeline is
   * already running.
   *
   * No-op if init() has not yet constructed a diarizer. The diarizer itself
   * only honours the new id while no profiles have been allocated (first speech
   * segment locks the slot) — callers are responsible for invoking this before
   * the user starts speaking when correctness matters.
   */
  setReservedSpeakerId(id: string | undefined): void {
    this.diarizer?.setReservedSpeakerId(id);
  }

  private applyLocalDiarization(result: TranscriptionResult, audio: Float32Array): TranscriptionResult {
    if (!this.config?.diarization || !this.diarizer) {
      return result;
    }

    const assignment = this.diarizer.assignSpeakerWithFeatures(audio);
    if (!assignment) {
      return result;
    }

    return {
      ...result,
      speakerId: assignment.speakerId,
      speakerConfidence: assignment.similarity,
      speakerFeatures: {
        source: 'local-diarizer',
        vector: assignment.featureVector,
        profileSamples: assignment.profileSamples,
        similarity: assignment.similarity,
        sampleRate: this.config?.sampleRate ?? WHISPER_SAMPLE_RATE,
      },
    };
  }
}
