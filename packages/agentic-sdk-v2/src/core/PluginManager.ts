/**
 * @arcaai/vox - PluginManager
 *
 * Configuration-driven plugin management with comprehensive logging.
 * Delegates to TranscriptionPipeline and KnowledgePipeline for processing.
 */

import type { BaseProcessor } from '@arcaai/room';
import type {
  AudioPluginConfig,
  NoiseFilterPluginConfig,
  VADPluginConfig,
  STTPluginConfig,
  NERPluginConfig,
  AudioPluginStates,
  TranscriptionResult,
  VADEvent,
  TranscriptionPipelineConfig,
  KnowledgePipelineConfig,
} from '../types';
import { DEFAULT_NOISE_FILTER_CONFIG, DEFAULT_VAD_CONFIG, DEFAULT_STT_CONFIG, DEFAULT_NER_CONFIG } from './constants';
import type { ISDKLogger } from './logger';
import { TranscriptionPipeline, createTranscriptionPipeline } from './TranscriptionPipeline';
import { KnowledgePipeline, createKnowledgePipeline } from './KnowledgePipeline';
import type { AgenticClient } from './AgenticClient';

/**
 * NER extraction result for callbacks
 */
export interface NERExtractionResult {
  text: string;
  entities: Array<{
    text: string;
    type: string;
    start: number;
    end: number;
    score: number;
  }>;
  processingTime: number;
  timestamp: number;
}

/**
 * Plugin event callbacks
 */
export interface PluginEventCallbacks {
  onTranscription?: (result: TranscriptionResult) => void;
  onVADEvent?: (event: VADEvent) => void;
  onAudioLevel?: (level: number) => void;
  onNERExtraction?: (result: NERExtractionResult) => void;
  onError?: (error: Error, plugin: string) => void;
}

/**
 * NER processor interface — replaces inline `unknown` casts.
 */
export interface INERProcessor {
  init(): Promise<void>;
  extract(text: string): Promise<{
    text: string;
    entities: Array<{
      text: string;
      type: string;
      start: number;
      end: number;
      score: number;
    }>;
    processingTime: number;
    timestamp: number;
  }>;
  destroy?(): Promise<void>;
}

/**
 * Plugin manager state
 */
export interface PluginManagerState {
  initialized: boolean;
  states: AudioPluginStates;
}

/**
 * Configuration-driven plugin management.
 *
 * Delegates to TranscriptionPipeline and KnowledgePipeline for processing.
 * Handles processor lifecycle and provides unified state.
 *
 * @example
 * ```typescript
 * const manager = new PluginManager({
 *   noiseFilter: { enabled: true, level: 'high' },
 *   vad: { enabled: true, sensitivity: 0.5 },
 *   stt: { enabled: true, provider: 'auto' },
 * });
 *
 * await manager.initialize(track, audioContext);
 * ```
 */
export class PluginManager {
  private config: AudioPluginConfig;
  private processors: Map<string, BaseProcessor> = new Map();
  private callbacks: PluginEventCallbacks = {};
  private _initialized = false;
  private logger?: ISDKLogger;
  private _debugMode: boolean;

  // Pipeline instances
  private transcriptionPipeline: TranscriptionPipeline | null = null;
  private knowledgePipeline: KnowledgePipeline | null = null;
  private apiClient?: AgenticClient;

  constructor(config: AudioPluginConfig = {}, logger?: ISDKLogger, apiClient?: AgenticClient, debugMode?: boolean) {
    this.config = config;
    this.logger = logger;
    this.apiClient = apiClient;
    this._debugMode = debugMode ?? false;

    this.logger?.debug('PluginManager created', {
      operation: 'constructor',
      component: 'PluginManager',
      attributes: {
        noiseFilterEnabled: this.isEnabled('noiseFilter'),
        vadEnabled: this.isEnabled('vad'),
        sttEnabled: this.isEnabled('stt'),
      },
    });
  }

  /**
   * Get the transcription pipeline instance.
   */
  getTranscriptionPipeline(): TranscriptionPipeline | null {
    return this.transcriptionPipeline;
  }

  /**
   * Get the knowledge pipeline instance.
   */
  getKnowledgePipeline(): KnowledgePipeline | null {
    return this.knowledgePipeline;
  }

  private nerProcessor: INERProcessor | null = null;
  private nerConfig: NERPluginConfig | null = null;
  private sttIsProcessing = false;

  /**
   * Set NER plugin configuration
   */
  setNERConfig(config: NERPluginConfig | undefined): void {
    this.nerConfig = config && config.enabled ? config : null;
    this.logger?.debug('NER config updated', {
      operation: 'setNERConfig',
      component: 'PluginManager',
      attributes: {
        enabled: this.nerConfig?.enabled ?? false,
        autoExtract: this.nerConfig?.autoExtract ?? false,
        model: this.nerConfig?.model,
      },
    });
  }

  /**
   * Initialize NER processor (separate from audio plugins)
   */
  async initializeNER(): Promise<void> {
    if (!this.nerConfig?.enabled) {
      return;
    }

    const pluginTimer = this.logger?.startOperation('initNER', {
      component: 'PluginManager',
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { createMedNER } = (await import('@arcaai/med-ner')) as any;

      const processor = createMedNER({
        model: this.nerConfig.model ?? DEFAULT_NER_CONFIG.model,
        threshold: this.nerConfig.threshold ?? DEFAULT_NER_CONFIG.threshold,
        entityTypes: this.nerConfig.entityTypes as unknown[],
        dtype: this.nerConfig.dtype ?? DEFAULT_NER_CONFIG.dtype,
        onEntitiesExtracted: (result: {
          entities: Array<{ text: string; type: string; start: number; end: number; score: number }>;
          text: string;
          processingTime: number;
          timestamp: number;
        }) => {
          this.logger?.debug('NER extraction complete', {
            operation: 'nerExtraction',
            component: 'PluginManager',
            attributes: {
              entityCount: result.entities.length,
              processingTime: result.processingTime,
            },
          });
          this.callbacks.onNERExtraction?.({
            text: result.text,
            entities: result.entities.map((e: { text: string; type: string; start: number; end: number; score: number }) => ({
              text: e.text,
              type: e.type,
              start: e.start,
              end: e.end,
              score: e.score,
            })),
            processingTime: result.processingTime,
            timestamp: result.timestamp,
          });
        },
        onError: (error: Error) => {
          this.logger?.error('NER processing error', {
            operation: 'nerExtraction',
            component: 'PluginManager',
            error: error as Error,
          });
          this.callbacks.onError?.(error as Error, 'ner');
        },
      });

      await processor.init();
      this.nerProcessor = processor as INERProcessor;

      pluginTimer?.end(true, {
        attributes: {
          model: this.nerConfig.model ?? 'default',
          threshold: this.nerConfig.threshold ?? DEFAULT_NER_CONFIG.threshold,
        },
      });

      this.logger?.info('NER processor initialized', {
        operation: 'initNER',
        component: 'PluginManager',
        success: true,
      });
    } catch (error) {
      pluginTimer?.error(error as Error);
      this.logger?.error('Failed to initialize NER plugin', {
        operation: 'initNER',
        component: 'PluginManager',
        error: error as Error,
      });
      this.callbacks.onError?.(error as Error, 'ner');
    }
  }

  /**
   * Extract entities from text using NER processor
   */
  async extractEntities(text: string): Promise<NERExtractionResult | null> {
    if (!this.nerProcessor) {
      this.logger?.warn('NER processor not initialized', {
        operation: 'extractEntities',
        component: 'PluginManager',
      });
      return null;
    }

    try {
      const result = await this.nerProcessor.extract(text);
      return {
        text: result.text,
        entities: result.entities.map((e) => ({
          text: e.text,
          type: e.type,
          start: e.start,
          end: e.end,
          score: e.score,
        })),
        processingTime: result.processingTime,
        timestamp: result.timestamp,
      };
    } catch (error) {
      this.logger?.error('Entity extraction failed', {
        operation: 'extractEntities',
        component: 'PluginManager',
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Check if NER is available
   */
  isNERAvailable(): boolean {
    return this.nerProcessor !== null;
  }

  /**
   * Set event callbacks
   */
  setCallbacks(callbacks: PluginEventCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Check if manager is initialized
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize all configured plugins using the transcription pipeline.
   */
  async initialize(track: MediaStreamTrack, audioContext: AudioContext): Promise<void> {
    if (this._initialized) {
      this.logger?.debug('PluginManager already initialized, skipping', {
        operation: 'initialize',
        component: 'PluginManager',
      });
      return;
    }

    const initTimer = this.logger?.startOperation('initializePlugins', {
      component: 'PluginManager',
    });

    try {
      // Build transcription pipeline config from audio plugin config
      const transcriptionConfig = this.getTranscriptionPipelineConfig();

      // Create and initialize the transcription pipeline
      this.transcriptionPipeline = createTranscriptionPipeline(transcriptionConfig, this.logger);

      // Set up pipeline event handlers
      this.setupPipelineEventHandlers();

      // Start the pipeline
      await this.transcriptionPipeline.start({ track, audioContext });

      // Store processor references for backward compatibility
      const noiseFilterProcessor = this.transcriptionPipeline.getProcessor('noiseFilter');
      if (noiseFilterProcessor) {
        this.processors.set('noiseFilter', noiseFilterProcessor);
      }

      const vadProcessor = this.transcriptionPipeline.getProcessor('vad');
      if (vadProcessor) {
        this.processors.set('vad', vadProcessor);
      }

      const sttProcessor = this.transcriptionPipeline.getProcessor('stt');
      if (sttProcessor) {
        this.processors.set('stt', sttProcessor);
      }

      this._initialized = true;

      initTimer?.end(true, {
        attributes: {
          initializedPlugins: Array.from(this.processors.keys()),
          totalPlugins: this.processors.size,
          usePipeline: true,
        },
      });

      this.logger?.info('PluginManager initialization complete (using pipeline)', {
        operation: 'initialize',
        component: 'PluginManager',
        success: true,
        attributes: {
          plugins: Array.from(this.processors.keys()),
        },
      });
    } catch (error) {
      initTimer?.error(error as Error);
      this.logger?.error('Failed to initialize PluginManager', {
        operation: 'initialize',
        component: 'PluginManager',
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Initialize the knowledge pipeline.
   */
  async initializeKnowledgePipeline(config?: Partial<KnowledgePipelineConfig>): Promise<void> {
    if (this.knowledgePipeline) {
      this.logger?.debug('KnowledgePipeline already initialized', {
        operation: 'initializeKnowledgePipeline',
        component: 'PluginManager',
      });
      return;
    }

    const knowledgeConfig = this.buildKnowledgePipelineConfig(config);
    this.knowledgePipeline = createKnowledgePipeline(knowledgeConfig, this.apiClient, this.logger);

    // Set up knowledge pipeline event handlers
    this.knowledgePipeline.on('nerComplete', ({ entities, processingTime }) => {
      this.logger?.debug('NER extraction complete', {
        operation: 'nerComplete',
        component: 'PluginManager',
        attributes: { entityCount: entities.length, processingTime },
      });
      this.callbacks.onNERExtraction?.({
        text: '',
        entities: entities.map((e) => ({
          text: e.text,
          type: e.entityType,
          start: e.startOffset ?? 0,
          end: e.endOffset ?? 0,
          score: e.confidence ?? 0,
        })),
        processingTime,
        timestamp: Date.now(),
      });
    });

    this.knowledgePipeline.on('error', ({ error, stage }) => {
      this.callbacks.onError?.(error, stage);
    });

    await this.knowledgePipeline.init();

    this.logger?.info('KnowledgePipeline initialized', {
      operation: 'initializeKnowledgePipeline',
      component: 'PluginManager',
      success: true,
    });
  }

  /**
   * Build transcription pipeline config from audio plugin config.
   * Public to allow inspection (e.g., for testing or advanced configuration).
   */
  getTranscriptionPipelineConfig(): TranscriptionPipelineConfig {
    const noiseFilterConfig = this.getConfig<NoiseFilterPluginConfig>('noiseFilter');
    const vadConfig = this.getConfig<VADPluginConfig>('vad');
    const sttConfig = this.getConfig<STTPluginConfig>('stt');

    return {
      debugMode: this._debugMode,
      noiseFilter: {
        enabled: noiseFilterConfig.enabled ?? false,
        location: noiseFilterConfig.enabled ? 'browser' : 'skip',
        level: noiseFilterConfig.level ?? DEFAULT_NOISE_FILTER_CONFIG.level,
      },
      vad: {
        enabled: vadConfig.enabled ?? false,
        location: 'browser',
        sensitivity: vadConfig.sensitivity ?? DEFAULT_VAD_CONFIG.sensitivity,
        minSpeechDuration: vadConfig.minSpeechDuration ?? DEFAULT_VAD_CONFIG.minSpeechDuration,
        minSilenceDuration: vadConfig.minSilenceDuration ?? DEFAULT_VAD_CONFIG.minSilenceDuration,
      },
      stt: {
        enabled: sttConfig.enabled ?? false,
        location: sttConfig.provider === 'local' ? 'browser' : sttConfig.provider === 'backend' ? 'backend' : 'auto',
        provider: sttConfig.provider ?? DEFAULT_STT_CONFIG.provider,
        language: sttConfig.language ?? DEFAULT_STT_CONFIG.language,
        modelId: sttConfig.modelId,
        sttSocket: sttConfig.sttSocket,
        pipelineId: sttConfig.pipelineId,
        diarization: sttConfig.diarization ?? false,
        numSpeakers: sttConfig.numSpeakers ?? 2,
        returnTimestamps: sttConfig.returnTimestamps ?? 'word',
        codeSwitching: sttConfig.codeSwitching ?? false,
      },
    };
  }

  /**
   * Build knowledge pipeline config.
   */
  private buildKnowledgePipelineConfig(config?: Partial<KnowledgePipelineConfig>): KnowledgePipelineConfig {
    const nerConfig = this.nerConfig;

    return {
      ner: {
        enabled: nerConfig?.enabled ?? config?.ner?.enabled ?? false,
        location: config?.ner?.location ?? 'browser',
        triggerMode: nerConfig?.autoExtract ? 'auto' : (config?.ner?.triggerMode ?? 'auto'),
        model: nerConfig?.model ?? config?.ner?.model ?? DEFAULT_NER_CONFIG.model,
        threshold: nerConfig?.threshold ?? config?.ner?.threshold ?? DEFAULT_NER_CONFIG.threshold,
        entityTypes: nerConfig?.entityTypes ?? (config?.ner?.entityTypes as string[] | undefined),
      },
      spellCheck: config?.spellCheck ?? {
        enabled: false,
        location: 'disabled',
        triggerMode: 'manual',
      },
      summarization: config?.summarization ?? {
        enabled: true,
        location: 'backend',
        triggerMode: 'manual',
      },
    };
  }

  /**
   * Set up event handlers for the transcription pipeline.
   */
  private setupPipelineEventHandlers(): void {
    if (!this.transcriptionPipeline) return;

    this.transcriptionPipeline.on('transcription', (result) => {
      this.callbacks.onTranscription?.(result);
    });

    this.transcriptionPipeline.on('partialTranscription', (result) => {
      // Also forward partial transcriptions
      this.callbacks.onTranscription?.(result);
    });

    this.transcriptionPipeline.on('vadEvent', (event) => {
      this.callbacks.onVADEvent?.(event);
    });

    this.transcriptionPipeline.on('error', ({ error, stage }) => {
      this.callbacks.onError?.(error, stage);
    });
  }

  /**
   * Check if a plugin is enabled in configuration
   */
  isEnabled(name: keyof AudioPluginConfig): boolean {
    const config = this.config[name];
    if (typeof config === 'boolean') return config;
    return config?.enabled ?? false;
  }

  /**
   * Get plugin configuration
   */
  private getConfig<T extends object>(name: keyof AudioPluginConfig): T {
    const config = this.config[name];
    if (typeof config === 'boolean') {
      return { enabled: config } as T;
    }
    return (config || { enabled: false }) as T;
  }

  /**
   * Get processor by name
   */
  getProcessor(name: string): BaseProcessor | undefined {
    return this.processors.get(name);
  }

  /**
   * Get all processors
   */
  getAllProcessors(): BaseProcessor[] {
    return Array.from(this.processors.values());
  }

  /**
   * Get current plugin states
   */
  getStates(): AudioPluginStates {
    const noiseFilter = this.processors.get('noiseFilter');
    const vad = this.processors.get('vad');
    const stt = this.processors.get('stt');

    return {
      noiseFilter: {
        isActive: noiseFilter?.isEnabled() ?? false,
        isSupported: this.isEnabled('noiseFilter'),
      },
      vad: {
        isActive: vad?.isEnabled() ?? false,
        isSupported: this.isEnabled('vad'),
      },
      stt: {
        isActive: stt?.isEnabled() ?? false,
        isSupported: this.isEnabled('stt'),
        isProcessing: this.sttIsProcessing,
      },
    };
  }

  /**
   * Update the STT processing state flag.
   * Call with `true` when the STT processor begins processing audio,
   * and `false` when it finishes.
   */
  setSttProcessing(isProcessing: boolean): void {
    this.sttIsProcessing = isProcessing;
  }

  /**
   * Enable/disable a processor
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    this.logger?.debug(`${enabled ? 'Enabling' : 'Disabling'} processor: ${name}`, {
      operation: 'setEnabled',
      component: 'PluginManager',
      attributes: { processorName: name, enabled },
    });

    if (this.transcriptionPipeline && this.isPipelineStageName(name)) {
      await this.transcriptionPipeline.toggleStage(name, enabled);
      const stageProcessor = this.transcriptionPipeline.getProcessor(name);
      if (stageProcessor) {
        this.processors.set(name, stageProcessor);
      } else {
        this.processors.delete(name);
      }
      return;
    }

    const processor = this.processors.get(name);
    if (!processor) {
      this.logger?.warn('Cannot set enabled state - processor not found', {
        operation: 'setEnabled',
        component: 'PluginManager',
        attributes: { processorName: name, enabled },
      });
      return;
    }

    if (enabled) {
      await processor.enable();
    } else {
      await processor.disable();
    }
  }

  /**
   * Toggle a processor
   */
  async toggle(name: string): Promise<boolean> {
    if (this.transcriptionPipeline && this.isPipelineStageName(name)) {
      const currentStates = this.getStates();
      const newState = !currentStates[name].isActive;
      this.logger?.debug(`Toggling processor: ${name} -> ${newState}`, {
        operation: 'toggle',
        component: 'PluginManager',
        attributes: { processorName: name, newState },
      });
      await this.setEnabled(name, newState);
      return newState;
    }

    const processor = this.processors.get(name);
    if (!processor) {
      this.logger?.warn('Cannot toggle - processor not found', {
        operation: 'toggle',
        component: 'PluginManager',
        attributes: { processorName: name },
      });
      return false;
    }

    const newState = !processor.isEnabled();
    this.logger?.debug(`Toggling processor: ${name} -> ${newState}`, {
      operation: 'toggle',
      component: 'PluginManager',
      attributes: { processorName: name, newState },
    });

    await this.setEnabled(name, newState);
    return newState;
  }

  private isPipelineStageName(name: string): name is 'noiseFilter' | 'vad' | 'stt' {
    return name === 'noiseFilter' || name === 'vad' || name === 'stt';
  }

  /**
   * Restart all processors with new track
   */
  async restart(track: MediaStreamTrack, audioContext: AudioContext): Promise<void> {
    const timer = this.logger?.startOperation('restartPlugins', {
      component: 'PluginManager',
    });

    try {
      for (const [name, processor] of this.processors.entries()) {
        this.logger?.debug(`Restarting processor: ${name}`, {
          operation: 'restart',
          component: 'PluginManager',
          attributes: { processorName: name },
        });
        await processor.restart({ track, audioContext });
      }
      timer?.end(true, { attributes: { processorCount: this.processors.size } });
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }

  /**
   * Destroy all processors and release resources
   */
  async destroy(): Promise<void> {
    const timer = this.logger?.startOperation('destroyPlugins', {
      component: 'PluginManager',
    });

    try {
      // Destroy transcription pipeline
      if (this.transcriptionPipeline) {
        await this.transcriptionPipeline.destroy();
        this.transcriptionPipeline = null;
      }

      // Destroy knowledge pipeline
      if (this.knowledgePipeline) {
        await this.knowledgePipeline.destroy();
        this.knowledgePipeline = null;
      }

      // Clear processor references
      const processorNames = Array.from(this.processors.keys());
      this.processors.clear();
      this._initialized = false;

      if (this.nerProcessor) {
        await this.nerProcessor.destroy?.();
        this.nerProcessor = null;
      }

      this.callbacks = {};

      timer?.end(true, { attributes: { destroyedPlugins: processorNames } });
      this.logger?.info('PluginManager destroyed', {
        operation: 'destroy',
        component: 'PluginManager',
        success: true,
      });
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }

  /**
   * Update configuration (requires reinitialize for changes to take effect)
   */
  updateConfig(config: Partial<AudioPluginConfig>): void {
    this.logger?.debug('Updating PluginManager configuration', {
      operation: 'updateConfig',
      component: 'PluginManager',
      attributes: {
        noiseFilterChanged: 'noiseFilter' in config,
        vadChanged: 'vad' in config,
        sttChanged: 'stt' in config,
      },
    });
    this.config = { ...this.config, ...config };
  }
}
