/**
 * @arcaai/vox - KnowledgePipeline
 *
 * Parallel pipeline for knowledge processing: NER, SpellCheck, Summarization.
 * Supports both automatic and manual triggering of stages.
 */

import { EventEmitter } from 'eventemitter3';
import type {
  KnowledgePipelineConfig,
  KnowledgePipelineInput,
  KnowledgePipelineOutput,
  PipelineStateInfo,
  KnowledgePipelineEvents,
} from '../types/pipeline';
import type { MedicalEntity } from '../types/context';
import { DEFAULT_KNOWLEDGE_PIPELINE_CONFIG } from '../types/pipeline';
import type { ISDKLogger } from './logger';
import type { AgenticClient } from './AgenticClient';
import { SUMMARY_ENDPOINTS } from './constants';

/**
 * TASK-461 C5-05 — derive a STABLE, deterministic entity id from the entity's
 * content + span. Browser auto-NER re-extracts over overlapping/rolling text,
 * so a random id per run never dedups and identical clinical entities pile up
 * as duplicate rows. Hashing `entityType|text|startOffset|endOffset` keeps the
 * same entity's identity across re-extractions (so the store's id-keyed dedup
 * collapses it) while genuinely distinct entities keep distinct ids. FNV-1a
 * 32-bit is used over the raw composite so the id carries no PHI (entity text
 * can surface in logs/telemetry) — only an opaque, reproducible digest.
 */
function stableEntityId(entityType: string, text: string, startOffset: number, endOffset: number): string {
  const key = `${entityType}|${text}|${startOffset}|${endOffset}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ner-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Trigger mode for pipeline stages.
 */
export type TriggerMode = 'auto' | 'manual';

/**
 * Stage configuration for the knowledge pipeline.
 */
interface KnowledgeStage {
  name: string;
  enabled: boolean;
  triggerMode: TriggerMode;
  location: 'browser' | 'backend' | 'auto' | 'disabled';
  processor?: unknown;
  processing: boolean;
}

/**
 * Raw NER entity from @arcaai/med-ner processor.
 */
interface RawNEREntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
}

/**
 * NER extraction result from @arcaai/med-ner processor.
 */
interface NERResult {
  text: string;
  entities: RawNEREntity[];
  processingTime: number;
  timestamp: number;
}

/**
 * KnowledgePipeline manages text processing for knowledge extraction.
 *
 * The pipeline consists of three parallel stages:
 * 1. NER: Extracts medical entities from text
 * 2. SpellCheck: Corrects spelling errors
 * 3. Summarization: Generates conversation summaries
 *
 * Stages can be triggered automatically or manually based on configuration.
 *
 * @example
 * ```typescript
 * const pipeline = new KnowledgePipeline({
 *   ner: { enabled: true, location: 'browser', triggerMode: 'auto' },
 *   spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' },
 *   summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
 * }, apiClient);
 *
 * pipeline.on('nerComplete', ({ entities }) => {
 *   console.log('Entities:', entities);
 * });
 *
 * // Process text (auto stages run immediately)
 * const result = await pipeline.process({ text: 'Patient has diabetes...' });
 *
 * // Manually trigger summarization
 * const summary = await pipeline.triggerSummarization('consultation-123');
 * ```
 */
export class KnowledgePipeline {
  readonly name = 'knowledge-pipeline';

  private config: KnowledgePipelineConfig;
  private stages: Map<string, KnowledgeStage> = new Map();
  private emitter = new EventEmitter();
  private logger?: ISDKLogger;
  private apiClient?: AgenticClient;

  // NER processor (lazy loaded)
  private nerProcessor: {
    extract: (text: string) => Promise<NERResult>;
    init: () => Promise<void>;
    isInitialized: () => boolean;
  } | null = null;

  // State
  private _state: PipelineStateInfo = {
    status: 'IDLE',
    progress: 0,
    isReady: false,
  };

  // Results cache for manual triggering
  private lastInput: KnowledgePipelineInput | null = null;
  private results: Map<string, unknown> = new Map();

  constructor(config?: Partial<KnowledgePipelineConfig>, apiClient?: AgenticClient, logger?: ISDKLogger) {
    this.config = { ...DEFAULT_KNOWLEDGE_PIPELINE_CONFIG, ...config };
    this.apiClient = apiClient;
    this.logger = logger;

    this.setupStages();
  }

  /**
   * Get the current pipeline state.
   */
  get state(): PipelineStateInfo {
    return { ...this._state };
  }

  /**
   * Set up the stage configurations.
   */
  private setupStages(): void {
    this.stages.set('ner', {
      name: 'ner',
      enabled: this.config.ner.enabled,
      triggerMode: this.config.ner.triggerMode,
      location: this.config.ner.location,
      processing: false,
    });

    this.stages.set('spellCheck', {
      name: 'spellCheck',
      enabled: this.config.spellCheck.enabled,
      triggerMode: this.config.spellCheck.triggerMode,
      location: this.config.spellCheck.location,
      processing: false,
    });

    this.stages.set('summarization', {
      name: 'summarization',
      enabled: this.config.summarization.enabled,
      triggerMode: this.config.summarization.triggerMode,
      location: this.config.summarization.location,
      processing: false,
    });
  }

  /**
   * Initialize the pipeline (lazy load NER if browser-based).
   */
  async init(): Promise<void> {
    if (this.config.ner.enabled && this.config.ner.location === 'browser') {
      await this.initNERProcessor();
    }

    this.updateState({ isReady: true });

    this.logger?.info('KnowledgePipeline initialized', {
      operation: 'init',
      component: 'KnowledgePipeline',
      success: true,
    });
  }

  /**
   * Initialize the browser-based NER processor.
   */
  private async initNERProcessor(): Promise<void> {
    if (this.nerProcessor?.isInitialized()) {
      return;
    }

    const timer = this.logger?.startOperation('initNERProcessor', {
      component: 'KnowledgePipeline',
    });

    try {
      const { createMedNER } = await import('@arcaai/med-ner');

      const processor = createMedNER({
        model: this.config.ner.model ?? 'biomedical',
        threshold: this.config.ner.threshold ?? 0.6,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Med-NER entity type list from config.
        entityTypes: this.config.ner.entityTypes as any,
      });

      await processor.init();

      this.nerProcessor = {
        extract: async (text: string) => processor.extract(text),
        init: async () => processor.init(),
        isInitialized: () => processor.isInitialized(),
      };

      timer?.end(true, {
        attributes: {
          model: this.config.ner.model ?? 'biomedical',
        },
      });

      this.logger?.info('NER processor initialized', {
        operation: 'initNERProcessor',
        component: 'KnowledgePipeline',
        success: true,
      });
    } catch (error) {
      timer?.error(error as Error);
      this.logger?.error('Failed to initialize NER processor', {
        operation: 'initNERProcessor',
        component: 'KnowledgePipeline',
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Process text through the pipeline.
   * Auto-triggered stages run immediately; manual stages must be triggered separately.
   */
  async process(input: KnowledgePipelineInput): Promise<KnowledgePipelineOutput> {
    this.lastInput = input;
    this.results.clear();

    this.updateState({ status: 'RUNNING', progress: 0 });

    const timer = this.logger?.startOperation('processKnowledge', {
      component: 'KnowledgePipeline',
    });

    const output: KnowledgePipelineOutput = {
      timestamp: Date.now(),
    };

    try {
      const autoStages = this.getAutoStages();
      const promises: Promise<void>[] = [];

      // Execute auto stages in parallel
      for (const stage of autoStages) {
        switch (stage.name) {
          case 'ner':
            promises.push(
              this.executeNER(input.text).then((entities) => {
                output.entities = entities;
                this.results.set('ner', entities);
              }),
            );
            break;
          case 'spellCheck':
            promises.push(
              this.executeSpellCheck(input.text).then((corrected) => {
                output.correctedText = corrected;
                this.results.set('spellCheck', corrected);
              }),
            );
            break;
          // Summarization is always manual
        }
      }

      await Promise.all(promises);

      this.updateState({ status: 'COMPLETED', progress: 100 });

      timer?.end(true, {
        attributes: {
          autoStagesExecuted: autoStages.map((s) => s.name),
          entityCount: output.entities?.length ?? 0,
        },
      });

      return output;
    } catch (error) {
      timer?.error(error as Error);
      this.updateState({ status: 'ERROR', error: error as Error });
      this.emit('error', { error: error as Error, stage: 'unknown' });
      throw error;
    }
  }

  /**
   * Manually trigger NER extraction.
   */
  async triggerNER(text?: string): Promise<MedicalEntity[]> {
    const inputText = text ?? this.lastInput?.text;
    if (!inputText) {
      throw new Error('No text provided for NER extraction');
    }

    const entities = await this.executeNER(inputText);
    this.results.set('ner', entities);
    return entities;
  }

  /**
   * Manually trigger spell check.
   */
  async triggerSpellCheck(text?: string): Promise<string> {
    const inputText = text ?? this.lastInput?.text;
    if (!inputText) {
      throw new Error('No text provided for spell check');
    }

    const corrected = await this.executeSpellCheck(inputText);
    this.results.set('spellCheck', corrected);
    return corrected;
  }

  /**
   * Manually trigger summarization.
   */
  async triggerSummarization(contextId: string): Promise<string> {
    const summary = await this.executeSummarization(contextId);
    this.results.set('summarization', summary);
    return summary;
  }

  /**
   * Get the result of a specific stage.
   */
  getStageResult<T>(stageName: string): T | undefined {
    return this.results.get(stageName) as T | undefined;
  }

  /**
   * Update pipeline configuration.
   */
  updateConfig(config: Partial<KnowledgePipelineConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      ner: { ...this.config.ner, ...config.ner },
      spellCheck: { ...this.config.spellCheck, ...config.spellCheck },
      summarization: { ...this.config.summarization, ...config.summarization },
    };

    // Update stage configurations
    const nerStage = this.stages.get('ner');
    if (nerStage && config.ner) {
      nerStage.enabled = this.config.ner.enabled;
      nerStage.triggerMode = this.config.ner.triggerMode;
      nerStage.location = this.config.ner.location;
    }

    const spellCheckStage = this.stages.get('spellCheck');
    if (spellCheckStage && config.spellCheck) {
      spellCheckStage.enabled = this.config.spellCheck.enabled;
      spellCheckStage.triggerMode = this.config.spellCheck.triggerMode;
      spellCheckStage.location = this.config.spellCheck.location;
    }

    const summarizationStage = this.stages.get('summarization');
    if (summarizationStage && config.summarization) {
      summarizationStage.enabled = this.config.summarization.enabled;
      summarizationStage.triggerMode = this.config.summarization.triggerMode;
      summarizationStage.location = this.config.summarization.location;
    }

    this.logger?.debug('KnowledgePipeline config updated', {
      operation: 'updateConfig',
      component: 'KnowledgePipeline',
    });
  }

  /**
   * Get the current configuration.
   */
  getConfig(): KnowledgePipelineConfig {
    return { ...this.config };
  }

  /**
   * Subscribe to pipeline events.
   */
  on<K extends keyof KnowledgePipelineEvents>(event: K, listener: (payload: KnowledgePipelineEvents[K]) => void): void {
    this.emitter.on(event, listener);
  }

  /**
   * Unsubscribe from pipeline events.
   */
  off<K extends keyof KnowledgePipelineEvents>(event: K, listener: (payload: KnowledgePipelineEvents[K]) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * Destroy the pipeline and release resources.
   */
  async destroy(): Promise<void> {
    this.nerProcessor = null;
    this.results.clear();
    this.lastInput = null;
    this.stages.clear();
    this.updateState({ status: 'IDLE', isReady: false });
    this.emitter.removeAllListeners();

    this.logger?.info('KnowledgePipeline destroyed', {
      operation: 'destroy',
      component: 'KnowledgePipeline',
    });
  }

  // =========================================================================
  // Private Execution Methods
  // =========================================================================

  /**
   * Execute NER extraction.
   */
  private async executeNER(text: string): Promise<MedicalEntity[]> {
    const stage = this.stages.get('ner')!;
    if (!stage.enabled || stage.location === 'disabled') {
      return [];
    }

    // TASK-508 Phase 0 (0.8) — the API gateway DOES expose NER now
    // (`POST /api/v1/ai/nlp/entities`, AiInferenceController, TASK-446/506);
    // this KnowledgePipeline just hasn't been wired to call it yet. Fail fast
    // with that accurate limitation rather than the previous (now false)
    // claim that no such gateway endpoint exists.
    if (stage.location === 'backend') {
      throw new Error(
        'Backend NER is not yet wired in this SDK (the API gateway does expose ' +
          'POST /api/v1/ai/nlp/entities). Set KnowledgePipeline ner.location to ' +
          '"browser" (recommended) or disable NER.',
      );
    }

    stage.processing = true;
    const startTime = performance.now();

    try {
      let entities: MedicalEntity[];

      // Prefer browser execution for both explicit browser mode and "auto" mode.
      if (stage.location === 'browser' || stage.location === 'auto') {
        // Browser-based NER
        if (!this.nerProcessor) {
          await this.initNERProcessor();
        }

        const result = await this.nerProcessor!.extract(text);
        entities = result.entities.map((e) => ({
          // TASK-461 C5-05 — stable, content/offset-derived id so re-extractions
          // of the same entity dedup instead of accumulating (was randomUUID()).
          id: stableEntityId(e.type, e.text, e.start, e.end),
          text: e.text,
          entityType: e.type as MedicalEntity['entityType'],
          confidence: e.score,
          startOffset: e.start,
          endOffset: e.end,
        }));
      } else {
        // Defensive: should be unreachable due to the early backend guard above.
        throw new Error(`Unsupported NER location: ${stage.location}`);
      }

      const processingTime = performance.now() - startTime;

      this.emit('nerComplete', { entities, processingTime });

      this.logger?.debug('NER extraction complete', {
        operation: 'executeNER',
        component: 'KnowledgePipeline',
        attributes: {
          entityCount: entities.length,
          processingTime,
        },
      });

      return entities;
    } catch (error) {
      this.emit('error', { error: error as Error, stage: 'ner' });
      throw error;
    } finally {
      stage.processing = false;
    }
  }

  /**
   * Execute spell check.
   */
  private async executeSpellCheck(text: string): Promise<string> {
    const stage = this.stages.get('spellCheck')!;
    if (!stage.enabled || stage.location === 'disabled') {
      return text;
    }

    // API gateway no longer proxies NLP endpoints (TASK-216).
    // If caller configured backend spellcheck, fail fast with a clear error.
    if (stage.location === 'backend') {
      throw new Error(
        'Backend spell check is not supported via the API gateway: /nlp/* endpoints are not available. ' +
          'Set KnowledgePipeline spellCheck.location to "browser" or disable spell check.',
      );
    }

    stage.processing = true;

    try {
      let corrected: string;

      // Prefer browser execution for both explicit browser mode and "auto" mode.
      if (stage.location === 'browser' || stage.location === 'auto') {
        // Browser-based spell check (simplified - would use a library in production)
        corrected = text; // Placeholder - no modification
      } else {
        // Defensive: should be unreachable due to the early backend guard above.
        throw new Error(`Unsupported spellCheck location: ${stage.location}`);
      }

      this.emit('spellCheckComplete', { original: text, corrected });

      this.logger?.debug('Spell check complete', {
        operation: 'executeSpellCheck',
        component: 'KnowledgePipeline',
      });

      return corrected;
    } catch (error) {
      this.emit('error', { error: error as Error, stage: 'spellCheck' });
      throw error;
    } finally {
      stage.processing = false;
    }
  }

  /**
   * Execute summarization.
   */
  private async executeSummarization(contextId: string): Promise<string> {
    const stage = this.stages.get('summarization')!;
    if (!stage.enabled || stage.location === 'disabled') {
      return '';
    }

    if (!this.apiClient) {
      throw new Error('API client required for summarization');
    }

    stage.processing = true;

    try {
      const response = await this.apiClient.post<{ content: string }>(SUMMARY_ENDPOINTS.GENERATE(contextId), {
        type: 'summary',
        dnaStyleId: this.config.summarization.dnaStyleId,
      });

      this.emit('summaryComplete', { summary: response.content });

      this.logger?.debug('Summarization complete', {
        operation: 'executeSummarization',
        component: 'KnowledgePipeline',
        attributes: { contextId },
      });

      return response.content;
    } catch (error) {
      this.emit('error', { error: error as Error, stage: 'summarization' });
      throw error;
    } finally {
      stage.processing = false;
    }
  }

  /**
   * Get stages that should auto-trigger.
   */
  private getAutoStages(): KnowledgeStage[] {
    return Array.from(this.stages.values()).filter((stage) => stage.enabled && stage.triggerMode === 'auto' && stage.location !== 'disabled');
  }

  /**
   * Emit a pipeline event.
   */
  private emit<K extends keyof KnowledgePipelineEvents>(event: K, payload: KnowledgePipelineEvents[K]): void {
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
 * Factory function to create a KnowledgePipeline.
 */
export function createKnowledgePipeline(
  config?: Partial<KnowledgePipelineConfig>,
  apiClient?: AgenticClient,
  logger?: ISDKLogger,
): KnowledgePipeline {
  return new KnowledgePipeline(config, apiClient, logger);
}
