/**
 * @arcaai/vox - TranscriptionPipeline
 *
 * Sequential pipeline for audio processing: NoiseFilter -> VAD -> STT.
 * Wraps existing processor plugins into pipeline stages.
 */

import { EventEmitter } from 'eventemitter3';
import type { BaseProcessor } from '@arcaai/room';
import { ProcessorEvent, debugLogConfig, debugLogTranscript, type DebugTranscriptEntry } from '@arcaai/room';
import type { TranscriptionPipelineConfig, TranscriptionPipelineInput, PipelineStateInfo, TranscriptionPipelineEvents } from '../types/pipeline';
import type { TranscriptionResult, VADEvent } from '../types/audio';
import { DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG } from '../types/pipeline';
import { AgenticError } from '../types';
import { LOCAL_TRANSCRIPTION_ENABLED } from './constants';
import type { ISDKLogger } from './logger';

/**
 * Pipeline stage wrapper for existing processors.
 */
interface ProcessorStage {
  name: string;
  enabled: boolean;
  priority: number;
  processor: BaseProcessor | null;
  factory: () => Promise<BaseProcessor>;
}

type STTRuntimeProvider = 'local' | 'remote';

/**
 * TranscriptionPipeline manages the audio processing chain.
 *
 * The pipeline consists of three sequential stages:
 * 1. NoiseFilter: Removes background noise (optional)
 * 2. VAD: Detects voice activity and segments speech
 * 3. STT: Transcribes speech segments to text
 *
 * @example
 * ```typescript
 * const pipeline = new TranscriptionPipeline({
 *   noiseFilter: { enabled: true, location: 'browser', level: 'high' },
 *   vad: { enabled: true, location: 'browser' },
 *   stt: { enabled: true, location: 'auto' },
 * });
 *
 * pipeline.on('transcription', (result) => {
 *   console.log('Transcription:', result.text);
 * });
 *
 * await pipeline.start({ track, audioContext });
 * ```
 */
export class TranscriptionPipeline {
  readonly name = 'transcription-pipeline';

  private config: TranscriptionPipelineConfig;
  private stages: Map<string, ProcessorStage> = new Map();
  private emitter = new EventEmitter();
  private logger?: ISDKLogger;

  // State
  private _state: PipelineStateInfo = {
    status: 'IDLE',
    progress: 0,
    isReady: false,
  };

  // Current processing context
  private currentInput: TranscriptionPipelineInput | null = null;
  private initialized = false;

  constructor(config?: Partial<TranscriptionPipelineConfig>, logger?: ISDKLogger) {
    this.config = { ...DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG, ...config };
    this.logger = logger;

    // Set up stage factories
    this.setupStageFactories();
  }

  /**
   * Get the current pipeline state.
   */
  get state(): PipelineStateInfo {
    return { ...this._state };
  }

  /**
   * Check if the pipeline is initialized.
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if the pipeline is running.
   */
  get isRunning(): boolean {
    return this._state.status === 'RUNNING';
  }

  /**
   * Get the selected STT provider ('local', 'backend', or 'auto').
   * ASR-L-03: Exposes which provider was configured so callers can report the selection.
   */
  get selectedProvider(): 'local' | 'backend' | 'auto' {
    return this.config.stt.provider ?? 'auto';
  }

  /**
   * Get the STT processing location ('browser', 'backend', or 'auto').
   * ASR-L-03: Companion to selectedProvider — reports where STT processing happens.
   */
  get sttLocation(): 'browser' | 'backend' | 'auto' | 'skip' {
    return this.config.stt.location;
  }

  /**
   * Set up the stage factories for lazy loading processors.
   */
  private setupStageFactories(): void {
    // NoiseFilter stage
    this.stages.set('noiseFilter', {
      name: 'noiseFilter',
      enabled: this.config.noiseFilter.enabled,
      priority: 10,
      processor: null,
      factory: async () => {
        const { createNoiseFilter } = await import('@arcaai/noise-filter');
        return createNoiseFilter({
          noiseCancellation: true,
          noiseCancellationLevel: this.config.noiseFilter.level || 'high',
          debugMode: this.config.debugMode,
        });
      },
    });

    // VAD stage
    this.stages.set('vad', {
      name: 'vad',
      enabled: this.config.vad.enabled,
      priority: 20,
      processor: null,
      factory: async () => {
        const { createVAD } = await import('@arcaai/vad');
        const positiveThreshold = this.config.vad.sensitivity ?? 0.5;
        return createVAD({
          positiveSpeechThreshold: positiveThreshold,
          negativeSpeechThreshold: this.getVADNegativeThreshold(positiveThreshold),
          minSpeechMs: this.config.vad.minSpeechDuration ?? 250,
          redemptionMs: this.config.vad.minSilenceDuration ?? 500,
          debugMode: this.config.debugMode,
        });
      },
    });

    // STT stage
    this.stages.set('stt', {
      name: 'stt',
      enabled: this.config.stt.enabled,
      priority: 30,
      processor: null,
      factory: async () => {
        const { createSTT } = await import('@arcaai/stt');
        const runtimeProvider = this.resolveSTTRuntimeProvider();
        const sttSocket = this.config.stt.sttSocket;
        const streamingTransport = this.config.stt.streamingTransport as import('@arcaai/stt').STTStreamingTransport | undefined;
        const useVadGate = runtimeProvider === 'local' && this.config.vad.enabled;

        // The streaming transport carries its own WebSocket
        // URL via `StreamingSessionManager.getWebSocketUrl()`; only require
        // `sttSocket` for the legacy `RemoteSTTProvider` path.
        if (runtimeProvider === 'remote' && !sttSocket && !streamingTransport) {
          throw new Error('stt.sttSocket or stt.streamingTransport is required when STT provider resolves to backend/remote');
        }

        // Forward the voice-profile and Whisper task that
        // `PluginManager.getTranscriptionPipelineConfig()` resolved from the
        // user's preferences. These are local-only; the remote path ignores
        // them (`STTProcessor.initializeRemoteProvider` does not read either).
        const voiceProfile = this.config.stt.voiceProfile;
        const sttTask = this.config.stt.task;
        const processor = createSTT({
          ...(runtimeProvider === 'remote' && sttSocket ? { sttSocket } : {}),
          audio: {
            language: this.getSTTLanguage(),
            // End-user language mode (TASK-587) — the backend resolves it per
            // engine; the local path ignores it.
            ...(this.config.stt.languageMode ? { languageMode: this.config.stt.languageMode } : {}),
          },
          features: {
            provider: runtimeProvider,
            ...(runtimeProvider === 'local' ? { modelId: this.getSTTModelId() } : {}),
            diarization: this.config.stt.diarization ?? false,
            numSpeakers: this.config.stt.numSpeakers ?? 2,
            returnTimestamps: this.config.stt.returnTimestamps ?? 'word',
            codeSwitching: this.config.stt.codeSwitching ?? false,
            vadGate: useVadGate,
            ...(sttTask ? { task: sttTask } : {}),
          },
          ...(voiceProfile && (voiceProfile.id || typeof voiceProfile.similarityThreshold === 'number')
            ? {
                voiceProfile: {
                  ...(voiceProfile.id ? { id: voiceProfile.id } : {}),
                  ...(voiceProfile.reservedSpeakerId ? { reservedSpeakerId: voiceProfile.reservedSpeakerId } : {}),
                  ...(typeof voiceProfile.similarityThreshold === 'number' ? { similarityThreshold: voiceProfile.similarityThreshold } : {}),
                },
              }
            : {}),
          debugMode: this.config.debugMode,
        });

        if (runtimeProvider === 'remote' && streamingTransport) {
          processor.setStreamingTransport(streamingTransport);
        }

        return processor;
      },
    });
  }

  /**
   * Initialize and start the pipeline.
   */
  async start(input: TranscriptionPipelineInput): Promise<void> {
    if (this._state.status === 'RUNNING') {
      this.logger?.warn('TranscriptionPipeline already running', {
        operation: 'start',
        component: 'TranscriptionPipeline',
      });
      return;
    }

    this.currentInput = input;
    this.updateState({ status: 'RUNNING', currentStage: 'initializing', progress: 0 });

    const timer = this.logger?.startOperation('startTranscriptionPipeline', {
      component: 'TranscriptionPipeline',
    });

    try {
      const enabledStages = this.getEnabledStages();
      let currentTrack = input.track;

      for (let i = 0; i < enabledStages.length; i++) {
        const stage = enabledStages[i]!;
        this.updateState({
          currentStage: stage.name,
          progress: Math.round((i / enabledStages.length) * 100),
        });

        // Create processor if not exists
        if (!stage.processor) {
          this.logger?.debug(`Creating processor for stage: ${stage.name}`, {
            operation: 'createProcessor',
            component: 'TranscriptionPipeline',
          });
          stage.processor = await stage.factory();
        }

        // Set up event handlers
        this.setupProcessorEventHandlers(stage);

        // Initialize processor
        await stage.processor.init({
          track: currentTrack,
          audioContext: input.audioContext,
          kind: 'audio',
        });

        // Use processed track for next stage
        if (stage.processor.processedTrack) {
          currentTrack = stage.processor.processedTrack;
        }

        this.logger?.debug(`Stage initialized: ${stage.name}`, {
          operation: 'initStage',
          component: 'TranscriptionPipeline',
        });
      }

      this.initialized = true;
      this.updateState({
        status: 'RUNNING',
        currentStage: undefined,
        progress: 100,
        isReady: true,
      });

      if (this.config.debugMode) {
        debugLogConfig('TranscriptionPipeline', {
          noiseFilter: {
            enabled: this.config.noiseFilter.enabled,
            level: this.config.noiseFilter.level ?? 'high',
          },
          vad: {
            enabled: this.config.vad.enabled,
            sensitivity: this.config.vad.sensitivity ?? 0.5,
            minSpeechMs: this.config.vad.minSpeechDuration ?? 250,
          },
          stt: {
            enabled: this.config.stt.enabled,
            provider: this.config.stt.provider ?? 'auto',
            model: this.config.stt.modelId ?? 'default',
            language: this.config.stt.language ?? 'en-US',
            diarization: this.config.stt.diarization ?? false,
            codeSwitching: this.config.stt.codeSwitching ?? false,
            returnTimestamps: this.config.stt.returnTimestamps ?? 'word',
          },
          microphone: {
            sampleRate: input.audioContext.sampleRate,
          },
        });
      }

      timer?.end(true, {
        attributes: { stageCount: enabledStages.length },
      });

      this.logger?.info('TranscriptionPipeline started', {
        operation: 'start',
        component: 'TranscriptionPipeline',
        success: true,
        attributes: {
          stages: enabledStages.map((s) => s.name),
        },
      });
    } catch (error) {
      timer?.error(error as Error);
      this.updateState({
        status: 'ERROR',
        error: error as Error,
        isReady: false,
      });
      this.emit('error', { error: error as Error, stage: this._state.currentStage || 'unknown' });
      throw error;
    }
  }

  /**
   * Stop the pipeline.
   */
  async stop(): Promise<void> {
    if (this._state.status === 'IDLE') {
      return;
    }

    this.logger?.debug('Stopping TranscriptionPipeline', {
      operation: 'stop',
      component: 'TranscriptionPipeline',
    });

    const timer = this.logger?.startOperation('stopTranscriptionPipeline', {
      component: 'TranscriptionPipeline',
    });

    try {
      // Destroy all processors
      for (const stage of this.stages.values()) {
        if (stage.processor) {
          await stage.processor.destroy();
          stage.processor = null;
        }
      }

      if (this.currentInput) {
        try {
          this.currentInput.track?.stop?.();
        } catch {
          /* best-effort */
        }
        const ownership = this.config.contextOwnership ?? 'borrowed';
        if (ownership === 'owned') {
          try {
            if (this.currentInput.audioContext?.state !== 'closed') {
              await this.currentInput.audioContext?.close?.();
            }
          } catch {
            /* best-effort */
          }
        }
      }

      this.currentInput = null;
      this.initialized = false;
      this.updateState({
        status: 'IDLE',
        progress: 0,
        isReady: false,
        currentStage: undefined,
        error: undefined,
      });

      timer?.end(true);

      this.logger?.info('TranscriptionPipeline stopped', {
        operation: 'stop',
        component: 'TranscriptionPipeline',
        success: true,
      });
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }

  /**
   * Pause the pipeline. Awaits async processor disable operations.
   */
  async pause(): Promise<void> {
    if (this._state.status !== 'RUNNING') {
      return;
    }

    for (const stage of this.stages.values()) {
      if (stage.processor && stage.enabled) {
        await stage.processor.disable?.();
      }
    }

    this.updateState({ status: 'PAUSED' });

    this.logger?.debug('TranscriptionPipeline paused', {
      operation: 'pause',
      component: 'TranscriptionPipeline',
    });
  }

  /**
   * Resume the pipeline. Awaits async processor enable operations.
   */
  async resume(): Promise<void> {
    if (this._state.status !== 'PAUSED') {
      return;
    }

    for (const stage of this.stages.values()) {
      if (stage.processor && stage.enabled) {
        await stage.processor.enable?.();
      }
    }

    this.updateState({ status: 'RUNNING' });

    this.logger?.debug('TranscriptionPipeline resumed', {
      operation: 'resume',
      component: 'TranscriptionPipeline',
    });
  }

  /**
   * Update pipeline configuration.
   */
  updateConfig(config: Partial<TranscriptionPipelineConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      noiseFilter: { ...this.config.noiseFilter, ...config.noiseFilter },
      vad: { ...this.config.vad, ...config.vad },
      stt: { ...this.config.stt, ...config.stt },
    };

    // Update stage enabled states
    const noiseFilterStage = this.stages.get('noiseFilter');
    if (noiseFilterStage) {
      noiseFilterStage.enabled = this.config.noiseFilter.enabled;
    }

    const vadStage = this.stages.get('vad');
    if (vadStage) {
      vadStage.enabled = this.config.vad.enabled;
    }

    const sttStage = this.stages.get('stt');
    if (sttStage) {
      sttStage.enabled = this.config.stt.enabled;
    }

    this.logger?.debug('TranscriptionPipeline config updated', {
      operation: 'updateConfig',
      component: 'TranscriptionPipeline',
    });
  }

  /**
   * Toggle a specific stage.
   */
  async toggleStage(stageName: 'noiseFilter' | 'vad' | 'stt', enabled: boolean): Promise<void> {
    const stage = this.stages.get(stageName);
    if (!stage) return;

    stage.enabled = enabled;

    // Update config
    switch (stageName) {
      case 'noiseFilter':
        this.config.noiseFilter.enabled = enabled;
        break;
      case 'vad':
        this.config.vad.enabled = enabled;
        break;
      case 'stt':
        this.config.stt.enabled = enabled;
        break;
    }

    // If running, enable/disable the processor
    if (stage.processor) {
      if (enabled) {
        await stage.processor.enable?.();
      } else {
        await stage.processor.disable?.();
      }
    }

    this.logger?.debug(`Stage ${stageName} toggled: ${enabled}`, {
      operation: 'toggleStage',
      component: 'TranscriptionPipeline',
      attributes: { stage: stageName, enabled },
    });
  }

  /**
   * Get the RAW input track (the unprocessed source track), independent of any
   * enabled processing stages. Used by dual-capture to record the
   * original microphone alongside the processed output from `getProcessedTrack()`.
   */
  getRawInputTrack(): MediaStreamTrack | null {
    return this.currentInput?.track ?? null;
  }

  /**
   * Get the processed audio track (output of the last enabled stage).
   */
  getProcessedTrack(): MediaStreamTrack | null {
    const enabledStages = this.getEnabledStages();
    for (let i = enabledStages.length - 1; i >= 0; i--) {
      const stage = enabledStages[i]!;
      if (stage.processor?.processedTrack) {
        return stage.processor.processedTrack;
      }
    }
    return this.currentInput?.track ?? null;
  }

  /**
   * Get a specific processor by stage name.
   */
  getProcessor(stageName: string): BaseProcessor | null {
    return this.stages.get(stageName)?.processor ?? null;
  }

  /**
   * Cumulative outbound audio bytes sent by the streaming STT stage since the
   * session started (0 for local STT — no wire). Polled by `useArcaAudio` to
   * derive a live uplink bitrate from the delta. Guarded so a processor/mock
   * without the getter is a no-op.
   */
  getUplinkBytesSent(): number {
    const sttProcessor = this.stages.get('stt')?.processor as unknown as { getUplinkBytesSent?: () => number } | undefined;
    return sttProcessor?.getUplinkBytesSent?.() ?? 0;
  }

  /**
   * The streaming session manager backing the STT stage, or `null` for local
   * STT / no streaming transport. `useArcaAudio` reaches it to read the live
   * session id and drive an on-the-fly provider switch (TASK-567 R4). Duck-typed
   * (the concrete `StreamingSessionManager` lives in vox; the stage processor is
   * `@arcaai/stt`) and guarded so a processor/mock without the getter is a no-op.
   */
  getStreamingSessionManager(): {
    getSessionId(): string | null;
    switchToFallback?(): Promise<void>;
  } | null {
    const sttProcessor = this.stages.get('stt')?.processor as unknown as
      | {
          getStreamingSessionManager?: () => { getSessionId(): string | null; switchToFallback?(): Promise<void> } | null;
        }
      | undefined;
    return sttProcessor?.getStreamingSessionManager?.() ?? null;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): TranscriptionPipelineConfig {
    return { ...this.config };
  }

  /**
   * Subscribe to pipeline events.
   */
  on<K extends keyof TranscriptionPipelineEvents>(event: K, listener: (payload: TranscriptionPipelineEvents[K]) => void): void {
    this.emitter.on(event, listener);
  }

  /**
   * Unsubscribe from pipeline events.
   */
  off<K extends keyof TranscriptionPipelineEvents>(event: K, listener: (payload: TranscriptionPipelineEvents[K]) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * Destroy the pipeline and release resources.
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.stages.clear();
    this.emitter.removeAllListeners();
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private resolveSTTRuntimeProvider(): STTRuntimeProvider {
    // TASK-545: local (in-browser) transcription is disabled
    // platform-wide by default. When the flag is off, the resolution below
    // (transcriptionMode / provider / location cascade) never runs — a
    // backend transport resolves to 'remote'; with none, we fail loud instead
    // of silently transcribing on-device.
    if (!LOCAL_TRANSCRIPTION_ENABLED) {
      return this.resolveSTTRuntimeProviderLocalDisabled();
    }

    // The server-resolved EFFECTIVE transcription mode is
    // authoritative (admin-owned, with the tenant lock + workflowMode cascade
    // already applied upstream). It wins over provider/location/sttSocket.
    const transcriptionMode = this.config.stt.transcriptionMode;
    if (transcriptionMode === 'LOCAL') {
      return 'local';
    }
    if (transcriptionMode === 'BACKEND') {
      return 'remote';
    }

    const configuredProvider = this.config.stt.provider ?? 'auto';
    if (configuredProvider === 'local') {
      return 'local';
    }
    if (configuredProvider === 'backend') {
      return 'remote';
    }

    if (this.config.stt.location === 'backend') {
      return 'remote';
    }
    if (this.config.stt.location === 'browser') {
      return 'local';
    }

    // Default to backend/remote whenever a backend transport exists.
    // The backend workflow injects a pipeline-aware `streamingTransport` (its own
    // WebSocket URL) but no legacy `sttSocket`; treating only `sttSocket` as the
    // backend signal wrongly resolved those consumers to LOCAL when the server
    // left `transcriptionMode` unset, dragging them into the local Whisper path.
    // A bare config with neither transport stays local (offline-capable default;
    // local must then be opted into via provider/location/transcriptionMode).
    return this.config.stt.sttSocket || this.config.stt.streamingTransport ? 'remote' : 'local';
  }

  /**
   * TASK-545 resolution path used while `LOCAL_TRANSCRIPTION_ENABLED` is
   * `false`. Never returns `'local'`: a configured backend transport
   * (`sttSocket`/`streamingTransport`) resolves to `'remote'` regardless of
   * what `transcriptionMode`/`provider`/`location` say; with no transport it
   * throws instead of silently transcribing on-device. Any signal that
   * explicitly asked for local (server `transcriptionMode: LOCAL`, `provider:
   * 'local'`, or `location: 'browser'`) is logged as a warning first so the
   * mismatch is visible, then treated the same as no preference at all.
   */
  private resolveSTTRuntimeProviderLocalDisabled(): STTRuntimeProvider {
    const transcriptionMode = this.config.stt.transcriptionMode;
    const configuredProvider = this.config.stt.provider ?? 'auto';
    const location = this.config.stt.location;

    // Explicit backend/remote requests still resolve directly — they were
    // never asking for local, so there is nothing to warn about here (a
    // missing transport is reported by the STT stage factory's own
    // sttSocket/streamingTransport check).
    if (transcriptionMode === 'BACKEND' || configuredProvider === 'backend' || location === 'backend') {
      return 'remote';
    }

    const requestedLocal = transcriptionMode === 'LOCAL' || configuredProvider === 'local' || location === 'browser';
    if (requestedLocal) {
      this.logger?.warn('Local transcription was requested but is disabled platform-wide; resolving to backend-only', {
        operation: 'resolveSTTRuntimeProvider',
        component: 'TranscriptionPipeline',
        attributes: { transcriptionMode, configuredProvider, location },
      });
    }

    if (this.config.stt.sttSocket || this.config.stt.streamingTransport) {
      return 'remote';
    }

    throw new AgenticError(
      'LOCAL_TRANSCRIPTION_DISABLED',
      'Local (in-browser) transcription is disabled platform-wide. Configure a backend ASR pipeline (stt.sttSocket or stt.streamingTransport) to use speech-to-text.',
    );
  }

  private getSTTLanguage(): string {
    if (this.config.stt.codeSwitching) {
      return 'auto';
    }
    return this.config.stt.language ?? 'en-US';
  }

  private getSTTModelId(): string {
    return this.config.stt.modelId ?? 'tiny';
  }

  private getVADNegativeThreshold(positiveThreshold: number): number {
    return Math.max(0.1, Math.min(0.95, positiveThreshold - 0.15));
  }

  /**
   * Get enabled stages sorted by priority.
   */
  private getEnabledStages(): ProcessorStage[] {
    return Array.from(this.stages.values())
      .filter((stage) => stage.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Set up event handlers for a processor.
   */
  private setupProcessorEventHandlers(stage: ProcessorStage): void {
    if (!stage.processor) return;

    stage.processor.on(ProcessorEvent.Data, (rawPayload) => {
      const payload = rawPayload as { type: string; data: unknown; timestamp: number };

      switch (stage.name) {
        case 'vad':
          this.handleVADEvent(payload);
          break;
        case 'stt':
          this.handleSTTEvent(payload);
          break;
      }
    });

    stage.processor.on(ProcessorEvent.Error, (errorPayload) => {
      this.emit('error', { error: errorPayload.error, stage: stage.name });
    });

    // The STT processor exposes a PUSH channel for backpressure drops
    // (its `getStats().droppedFrames` getter is unpolled on the SDK path). Wire it
    // through to an `audioDrop` event so the loss reaches the store/hook/UI. The
    // method is single-slot (re-registration is idempotent), and guarded so
    // processors/mocks without it are a no-op.
    if (stage.name === 'stt') {
      const sttProcessor = stage.processor as unknown as {
        onBackpressureDrop?: (cb: (droppedFrameCount: number) => void) => void;
      };
      sttProcessor.onBackpressureDrop?.((droppedFrameCount) => {
        this.emit('audioDrop', droppedFrameCount);
      });
    }
  }

  /**
   * Handle VAD events.
   */
  private handleVADEvent(payload: { type: string; data: unknown; timestamp: number }): void {
    if (payload.type === 'vad-speech-start') {
      const vadEvent: VADEvent = {
        type: 'speech-start',
        timestamp: payload.timestamp,
      };
      this.emit('vadEvent', vadEvent);
    } else if (payload.type === 'vad-speech-end') {
      const data = payload.data as {
        audio?: Float32Array;
        segmentNumber?: number;
        streamStartSec?: number;
        streamEndSec?: number;
        durationSec?: number;
      };
      const vadEvent: VADEvent = {
        type: 'speech-end',
        timestamp: payload.timestamp,
        audioData: data.audio,
        segmentNumber: data.segmentNumber,
        streamStartSec: data.streamStartSec,
        streamEndSec: data.streamEndSec,
        durationSec: data.durationSec,
      };
      this.emit('vadEvent', vadEvent);

      const sttStage = this.stages.get('stt');
      const sttProcessor = sttStage?.processor as {
        getProviderType?: () => 'local' | 'remote';
        transcribeSegment?: (audio: Float32Array) => Promise<TranscriptionResult>;
      } | null;
      const supportsSegmentTranscription = sttProcessor?.getProviderType?.() === 'local' && typeof sttProcessor?.transcribeSegment === 'function';

      if (supportsSegmentTranscription && data.audio && data.audio.length > 0 && sttProcessor?.transcribeSegment) {
        sttProcessor
          .transcribeSegment(data.audio)
          .then((result) => {
            const enriched: TranscriptionResult = {
              ...result,
              vadSegmentNumber: data.segmentNumber,
              vadStreamStartSec: data.streamStartSec,
              vadStreamEndSec: data.streamEndSec,
              vadDurationSec: data.durationSec,
            };

            if (this.config.debugMode && enriched.isFinal) {
              this.logDebugTranscript(enriched);
            }

            this.emit('transcription', enriched);
          })
          .catch((error) => {
            this.emit('error', { error: error as Error, stage: 'stt' });
          });
      }
    } else if (payload.type === 'vad-misfire') {
      const vadEvent: VADEvent = {
        type: 'misfire',
        timestamp: payload.timestamp,
      };
      this.emit('vadEvent', vadEvent);
    }
  }

  /**
   * Handle STT events.
   */
  private handleSTTEvent(payload: { type: string; data: unknown; timestamp: number }): void {
    if (payload.type === 'stt-transcription' || payload.type === 'stt-partial') {
      const result = payload.data as TranscriptionResult;
      if (payload.type === 'stt-transcription' && result.isFinal) {
        this.emit('transcription', result);
      } else {
        this.emit('partialTranscription', result);
      }
    }
  }

  /**
   * Log a structured debug transcript entry using VAD + STT metadata.
   * Uses stream-relative start/end from VAD and word timestamps from Whisper.
   */
  private logDebugTranscript(result: TranscriptionResult): void {
    const start = result.vadStreamStartSec ?? 0;
    const end = result.vadStreamEndSec ?? start + (result.duration ?? 0);

    const entry: DebugTranscriptEntry = {
      segment: result.vadSegmentNumber ?? 0,
      speaker: result.speakerId ?? 'speaker-1',
      start,
      end,
      duration: result.vadDurationSec ?? end - start,
      inference: (result.latencyMs ?? 0) / 1000,
    };

    const timestamps = result.timestamps ?? result.segments;
    if (timestamps && timestamps.length > 0) {
      entry.words = timestamps.map((ts) => ({
        word: ts.text,
        confidence: result.confidence ?? 0,
        start: ts.start,
        end: ts.end,
      }));
    }

    debugLogTranscript('Pipeline', entry);
  }

  /**
   * Emit a pipeline event.
   */
  private emit<K extends keyof TranscriptionPipelineEvents>(event: K, payload: TranscriptionPipelineEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /**
   * Update pipeline state.
   */
  private updateState(updates: Partial<PipelineStateInfo>): void {
    this._state = { ...this._state, ...updates };
    this.emit('stateChange', this._state);
  }
}

/**
 * Factory function to create a TranscriptionPipeline.
 */
export function createTranscriptionPipeline(config?: Partial<TranscriptionPipelineConfig>, logger?: ISDKLogger): TranscriptionPipeline {
  return new TranscriptionPipeline(config, logger);
}
