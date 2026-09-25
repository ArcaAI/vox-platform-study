/**
 * @arcaai/vox - TranscriptionPipeline
 *
 * Hosts the backend/remote STT stage over the streaming transport.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model. The
 * `noiseFilter` and `vad` client stages, the `clientInference` gate, and the
 * local STT provider were removed. The pipeline now has a single stage:
 * capture -> backend STT over the streaming transport.
 */

import { EventEmitter } from 'eventemitter3';
import type { BaseProcessor } from '@arcaai/room';
import { ProcessorEvent, debugLogConfig } from '@arcaai/room';
import type { TranscriptionPipelineConfig, TranscriptionPipelineInput, PipelineStateInfo, TranscriptionPipelineEvents } from '../types/pipeline';
import type { TranscriptionResult } from '../types/audio';
import { DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG } from '../types/pipeline';
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

/**
 * TranscriptionPipeline manages the audio processing chain.
 *
 * The browser never runs a model (TASK-865/TASK-1006): the pipeline hosts
 * exactly one stage — backend STT over the streaming transport.
 *
 * @example
 * ```typescript
 * const pipeline = new TranscriptionPipeline({
 *   stt: { enabled: true, location: 'backend', provider: 'backend', streamingTransport },
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
   * Get the selected STT provider (`'backend'` or `'auto'` — local was removed).
   * ASR-L-03: Exposes which provider was configured so callers can report the selection.
   */
  get selectedProvider(): 'backend' | 'auto' {
    return this.config.stt.provider ?? 'auto';
  }

  /**
   * Get the STT processing location (`'backend'`, `'auto'`, or `'skip'`).
   * ASR-L-03: Companion to selectedProvider — reports where STT processing happens.
   */
  get sttLocation(): 'backend' | 'auto' | 'skip' {
    return this.config.stt.location;
  }

  /**
   * Set up the stage factories for lazy loading processors.
   */
  private setupStageFactories(): void {
    // STT stage — the only stage the pipeline hosts.
    this.stages.set('stt', {
      name: 'stt',
      enabled: this.config.stt.enabled,
      priority: 30,
      processor: null,
      factory: async () => {
        const { createSTT } = await import('@arcaai/stt');
        const sttSocket = this.config.stt.sttSocket;
        const streamingTransport = this.config.stt.streamingTransport as import('@arcaai/stt').STTStreamingTransport | undefined;

        // The streaming transport carries its own WebSocket
        // URL via `StreamingSessionManager.getWebSocketUrl()`; only require
        // `sttSocket` for the legacy `RemoteSTTProvider` path.
        if (!sttSocket && !streamingTransport) {
          throw new Error('stt.sttSocket or stt.streamingTransport is required to transcribe');
        }

        const processor = createSTT({
          ...(sttSocket ? { sttSocket } : {}),
          audio: {
            language: this.getSTTLanguage(),
            // End-user language mode — the backend resolves it per engine.
            ...(this.config.stt.languageMode ? { languageMode: this.config.stt.languageMode } : {}),
            // Pre-start engine selection — the backend opens the
            // session on the fallback engine when 'fallback'.
            ...(this.config.stt.startOn ? { startOn: this.config.stt.startOn } : {}),
          },
          features: {
            provider: 'remote',
            diarization: this.config.stt.diarization ?? false,
            numSpeakers: this.config.stt.numSpeakers ?? 2,
            returnTimestamps: this.config.stt.returnTimestamps ?? 'word',
            codeSwitching: this.config.stt.codeSwitching ?? false,
          },
          debugMode: this.config.debugMode,
        });

        if (streamingTransport) {
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
          stt: {
            enabled: this.config.stt.enabled,
            provider: this.config.stt.provider ?? 'auto',
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
      stt: { ...this.config.stt, ...config.stt },
    };

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
   * Toggle the STT stage.
   */
  async toggleStage(stageName: 'stt', enabled: boolean): Promise<void> {
    const stage = this.stages.get(stageName);
    if (!stage) return;

    stage.enabled = enabled;
    this.config.stt.enabled = enabled;

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
   * session started. Polled by `useArcaAudio` to derive a live uplink bitrate
   * from the delta. Guarded so a processor/mock without the getter is a no-op.
   */
  getUplinkBytesSent(): number {
    const sttProcessor = this.stages.get('stt')?.processor as unknown as { getUplinkBytesSent?: () => number } | undefined;
    return sttProcessor?.getUplinkBytesSent?.() ?? 0;
  }

  /**
   * The streaming session manager backing the STT stage, or `null` when no
   * streaming transport is set. `useArcaAudio` reaches it to read the live
   * session id and drive an on-the-fly provider switch. Duck-typed
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

  private getSTTLanguage(): string {
    if (this.config.stt.codeSwitching) {
      return 'auto';
    }
    return this.config.stt.language ?? 'en-US';
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

      if (stage.name === 'stt') {
        this.handleSTTEvent(payload);
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
