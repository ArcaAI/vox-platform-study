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
 * KnowledgePipeline manages text processing for knowledge extraction.
 *
 * The pipeline consists of three parallel stages:
 * 1. NER: Extracts medical entities from text — DISABLED by default (TASK-1006):
 *    `@arcaai/med-ner` (in-browser NER) was deleted, so `location: 'browser'`
 *    throws. Server-side NER is an agent task (`useAgentInvocation` with a
 *    `NAMED_ENTITY_RECOGNITION` agent) — see `.claude/rules/08-vox-sdk.md`.
 * 2. SpellCheck: Corrects spelling errors
 * 3. Summarization: Generates conversation summaries
 *
 * Stages can be triggered automatically or manually based on configuration.
 *
 * @example
 * ```typescript
 * const pipeline = new KnowledgePipeline({
 *   ner: { enabled: false, location: 'disabled', triggerMode: 'auto' },
 *   spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' },
 *   summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
 * }, apiClient);
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
   * Initialize the pipeline.
   *
   * TASK-1006 (following TASK-865): the browser never runs a model —
   * `@arcaai/med-ner` was deleted, so there is no browser NER to lazy-load
   * any more. `executeNER()` throws if a host configures `ner.location:
   * 'browser'` explicitly.
   */
  async init(): Promise<void> {
    this.updateState({ isReady: true });

    this.logger?.info('KnowledgePipeline initialized', {
      operation: 'init',
      component: 'KnowledgePipeline',
      success: true,
    });
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
   *
   * TASK-1006 (following TASK-865): the browser never runs a model.
   * `@arcaai/med-ner` (in-browser NER) was deleted, so `location: 'browser'`
   * and `'auto'` now throw instead of loading a client model. Entity
   * extraction is a server-side agent task — invoke a `NAMED_ENTITY_RECOGNITION`
   * agent via `useAgentInvocation` instead (see `.claude/rules/08-vox-sdk.md`).
   */
  private async executeNER(text: string): Promise<MedicalEntity[]> {
    const stage = this.stages.get('ner')!;
    if (!stage.enabled || stage.location === 'disabled') {
      return [];
    }

    if (stage.location === 'backend') {
      throw new Error(
        'Backend NER is not wired in KnowledgePipeline. Invoke a published NAMED_ENTITY_RECOGNITION ' +
          'agent via useAgentInvocation() instead, or disable NER.',
      );
    }

    // 'browser' / 'auto': the in-browser processor (@arcaai/med-ner) was
    // deleted (TASK-1006) — the browser never runs a model.
    throw new Error(
      'Client-side NER is disabled: @arcaai/med-ner was removed (TASK-1006). Entity extraction runs ' +
        'server-side — invoke a published NAMED_ENTITY_RECOGNITION agent via useAgentInvocation(), or ' +
        'set KnowledgePipeline ner.location to "disabled".',
    );
  }

  /**
   * Execute spell check.
   */
  private async executeSpellCheck(text: string): Promise<string> {
    const stage = this.stages.get('spellCheck')!;
    if (!stage.enabled || stage.location === 'disabled') {
      return text;
    }

    // API gateway no longer proxies NLP endpoints.
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
