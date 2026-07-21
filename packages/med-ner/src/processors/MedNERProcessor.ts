/**
 * @arcaai/med-ner - MedNERProcessor
 *
 * Medical Named Entity Recognition processor using Transformers.js.
 * Extracts medical entities from text using BERT-based NER models.
 */

import { pipeline, env } from '@huggingface/transformers';
import type { TokenClassificationPipeline } from '@huggingface/transformers';

import {
  type MedNEROptions,
  type MedNEROptionsWithCallbacks,
  type MedNERResult,
  type MedNERStats,
  type EntitySpan,
  type RawTokenResult,
  type ModelLoadProgress,
  type MedNERDevice,
  type ModelReference,
  MedicalEntityType,
  LABEL_TO_ENTITY_TYPE,
  MODEL_MAP,
  DEFAULT_MED_NER_OPTIONS,
  MedNERError,
  MedNERErrorCode,
} from '../types/index.js';

import { getMedNERBrowserSupport, getRecommendedDevice, isMedNERSupported } from '../utils/browserSupport.js';

import { mergeAdjacentEntities, mergeOverlappingEntities, filterEntitiesByType, filterEntitiesByThreshold } from '../utils/entityUtils.js';
import { chunkByTokens, mergeChunkEntities, type Tokenizer, type TokenChunk } from '../utils/chunking.js';
import { MedNERWorkerClient } from '../workers/workerClient.js';

// Configure Transformers.js for browser usage
if (typeof window !== 'undefined') {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
}

/**
 * Shape returned by Transformers.js when an aggregation strategy is set
 * (`simple`, `first`, `max`, `average`). Each row is a merged word-level
 * entity group rather than a BIO subword token.
 */
interface AggregatedTokenResult {
  entity_group: string;
  word: string;
  score: number;
  start: number;
  end: number;
}

function isAggregatedResult(r: RawTokenResult | AggregatedTokenResult): r is AggregatedTokenResult {
  return typeof (r as AggregatedTokenResult).entity_group === 'string';
}

/**
 * Convert a pipeline row (either BIO or aggregated) into our EntitySpan.
 */
function normaliseRawResult(result: RawTokenResult | AggregatedTokenResult, mapLabel: (label: string) => MedicalEntityType): EntitySpan {
  if (isAggregatedResult(result)) {
    return {
      text: result.word,
      type: mapLabel(result.entity_group),
      start: result.start,
      end: result.end,
      score: result.score,
      rawLabel: result.entity_group,
    };
  }
  return {
    text: result.word.replace(/^##/, ''),
    type: mapLabel(result.entity),
    start: result.start,
    end: result.end,
    score: result.score,
    rawLabel: result.entity,
    tokenIndex: result.index,
  };
}

/**
 * MedNERProcessor provides Medical Named Entity Recognition.
 *
 * Features:
 * - Multiple pre-trained biomedical NER models
 * - Configurable confidence thresholds
 * - Entity type filtering
 * - Automatic entity merging
 * - Long text chunking support
 * - Statistics emission for monitoring
 *
 * @example
 * ```typescript
 * import { MedNERProcessor, createMedNER } from '@arcaai/med-ner';
 *
 * const ner = createMedNER({
 *   model: 'biomedical',
 *   threshold: 0.6,
 *   entityTypes: ['DISEASE', 'MEDICATION'],
 * });
 *
 * // Initialize the processor
 * await ner.init();
 *
 * // Extract entities from text
 * const result = await ner.extract(
 *   'Patient diagnosed with Type 2 Diabetes and prescribed Metformin 500mg.'
 * );
 *
 * console.log(result.entities);
 * // [
 * //   { text: 'Type 2 Diabetes', type: 'DISEASE', score: 0.95, ... },
 * //   { text: 'Metformin', type: 'MEDICATION', score: 0.92, ... },
 * //   { text: '500mg', type: 'DOSAGE', score: 0.88, ... },
 * // ]
 *
 * // Cleanup
 * await ner.destroy();
 * ```
 */
export class MedNERProcessor {
  readonly name = 'med-ner-processor';

  private options: Required<Omit<MedNEROptions, 'entityTypes' | 'onProgress' | 'dtype' | 'workerFactory'>> & {
    entityTypes?: MedicalEntityType[];
    onProgress?: (progress: ModelLoadProgress) => void;
    dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
    workerFactory?: () => Worker;
  };

  /**
   * Resolved tokenizer callable, set after `init()`. Wraps the model's
   * tokenizer so `chunkByTokens` can count tokens deterministically.
   */
  private tokenizer: Tokenizer | null = null;

  /** Worker client when running off-main-thread. */
  private workerClient: MedNERWorkerClient | null = null;

  // NER pipeline from Transformers.js
  private pipeline: TokenClassificationPipeline | null = null;

  // Callbacks
  private callbacks: {
    onEntitiesExtracted?: (result: MedNERResult) => void;
    onError?: (error: MedNERError) => void;
  } = {};

  // State
  private _initialized = false;
  private _isProcessing = false;
  private _activeDevice: MedNERDevice | null = null;

  // Statistics
  private stats: MedNERStats = {
    isReady: false,
    isProcessing: false,
    textsProcessed: 0,
    entitiesExtracted: 0,
    entityCounts: {} as Record<MedicalEntityType, number>,
    averageProcessingTime: 0,
    averageConfidence: 0,
    modelId: '',
    timestamp: Date.now(),
  };

  // Stats tracking
  private totalProcessingTime = 0;
  private totalConfidence = 0;
  private totalConfidenceCount = 0;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // Event listeners
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();

  constructor(options: MedNEROptionsWithCallbacks = {}) {
    // Extract callbacks
    this.callbacks = {
      onEntitiesExtracted: options.onEntitiesExtracted,
      onError: options.onError,
    };

    // Merge options with defaults
    this.options = {
      ...DEFAULT_MED_NER_OPTIONS,
      model: options.model ?? DEFAULT_MED_NER_OPTIONS.model,
      threshold: options.threshold ?? DEFAULT_MED_NER_OPTIONS.threshold,
      mergeAdjacent: options.mergeAdjacent ?? DEFAULT_MED_NER_OPTIONS.mergeAdjacent,
      mergeOverlapping: options.mergeOverlapping ?? DEFAULT_MED_NER_OPTIONS.mergeOverlapping,
      maxLength: options.maxLength ?? DEFAULT_MED_NER_OPTIONS.maxLength,
      chunkOverlap: options.chunkOverlap ?? DEFAULT_MED_NER_OPTIONS.chunkOverlap,
      maxTokens: options.maxTokens ?? DEFAULT_MED_NER_OPTIONS.maxTokens,
      stride: options.stride ?? DEFAULT_MED_NER_OPTIONS.stride,
      enableStats: options.enableStats ?? DEFAULT_MED_NER_OPTIONS.enableStats,
      statsInterval: options.statsInterval ?? DEFAULT_MED_NER_OPTIONS.statsInterval,
      entityTypes: options.entityTypes,
      onProgress: options.onProgress,
      dtype: options.dtype,
      workerFactory: options.workerFactory,
    };

    // Initialize entity counts
    Object.values(MedicalEntityType).forEach((type) => {
      this.stats.entityCounts[type] = 0;
    });

    // Set model ID in stats
    this.stats.modelId = this.resolveModel(this.options.model).id;
  }

  /**
   * Resolve a model preset name (or a raw HuggingFace model id) to its
   * pinned reference. Custom ids that are not in MODEL_MAP get an empty
   * revision (no pin) — by design, only the curated presets are pinned.
   */
  private resolveModel(model: string): ModelReference {
    return MODEL_MAP[model] ?? { id: model, revision: '' };
  }

  /**
   * Check if this processor is supported in the current browser.
   */
  isSupported(): boolean {
    return isMedNERSupported();
  }

  /**
   * Check if the processor is initialized.
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Check if the processor is currently processing.
   */
  isProcessing(): boolean {
    return this._isProcessing;
  }

  /**
   * Initialize the NER processor and load the model.
   */
  async init(): Promise<void> {
    if (this._initialized) {
      return;
    }

    // Check browser support
    const support = getMedNERBrowserSupport();
    if (!support.nerSupported) {
      throw new MedNERError(MedNERErrorCode.NOT_SUPPORTED, support.unsupportedReason ?? 'Medical NER not supported in this browser');
    }

    const modelRef = this.resolveModel(this.options.model);
    const device = await getRecommendedDevice();
    this._activeDevice = device;

    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info(`[@arcaai/med-ner] resolved compute device='${device}' for model='${modelRef.id}'`);
    }

    // Off-main-thread path. The worker imports
    // `@huggingface/transformers` itself; we never touch it here.
    if (this.options.workerFactory) {
      try {
        const worker = this.options.workerFactory();
        this.workerClient = new MedNERWorkerClient(worker);
        this.emitProgress({ status: 'downloading', progress: 0 });
        await this.workerClient.init(
          {
            modelId: modelRef.id,
            revision: modelRef.revision || undefined,
            dtype: this.options.dtype,
            device,
            maxTokens: this.options.maxTokens,
            stride: this.options.stride,
          },
          (progress) => {
            this.emitProgress(progress);
            this.options.onProgress?.(progress);
          },
        );

        this._initialized = true;
        this.stats.isReady = true;
        this.stats.modelId = modelRef.id;
        this.emitProgress({ status: 'ready' });

        if (this.options.enableStats) {
          this.startStatsEmission();
        }
        return;
      } catch (error) {
        const nerError = new MedNERError(
          MedNERErrorCode.MODEL_LOAD_FAILED,
          `Failed to load NER model '${modelRef.id}' in Worker: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error instanceof Error ? error : undefined,
        );
        this.workerClient?.dispose();
        this.workerClient = null;
        this.emitProgress({ status: 'error' });
        this.callbacks.onError?.(nerError);
        throw nerError;
      }
    }

    try {
      // Emit progress: downloading
      this.emitProgress({ status: 'downloading', progress: 0 });

      // Build pipeline options. We always pass `aggregation_strategy: 'simple'`
      // (H-6) so the runtime merges BIO subword tokens into word-level entity
      // groups before they cross the worker boundary. The `revision` is the
      // pinned commit SHA (R-12), and `device` is what `getRecommendedDevice`
      // resolved (H-1).
      const pipelineOptions: Record<string, unknown> = {
        dtype: this.options.dtype ?? support.recommendedDtype,
        device,
        aggregation_strategy: 'simple',
        progress_callback: (progressData: unknown) => {
          const data = progressData as {
            status?: string;
            file?: string;
            progress?: number;
            loaded?: number;
            total?: number;
          };
          this.emitProgress({
            status: data.status === 'ready' ? 'ready' : 'downloading',
            file: data.file,
            progress: data.progress,
            loaded: data.loaded,
            total: data.total,
          });
          this.options.onProgress?.({
            status: data.status === 'ready' ? 'ready' : 'downloading',
            file: data.file,
            progress: data.progress,
            loaded: data.loaded,
            total: data.total,
          });
        },
      };
      if (modelRef.revision) {
        pipelineOptions.revision = modelRef.revision;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @huggingface/transformers' `pipeline()` factory is overloaded per-task; a dynamic task string here doesn't resolve to one specific overload, so the call must go through `any` before asserting the known return shape
      this.pipeline = (await (pipeline as any)('token-classification', modelRef.id, pipelineOptions)) as TokenClassificationPipeline;

      // Adapt the pipeline's tokenizer into our chunker's Tokenizer signature.
      // Transformers.js v3 exposes the tokenizer at `pipeline.tokenizer` with
      // a callable signature returning a `BatchEncoding`-like object whose
      // `input_ids` carries the token IDs. We tolerate any of the common
      // return shapes via duck typing.
      this.tokenizer = this.buildTokenizer(this.pipeline);

      // Update state
      this._initialized = true;
      this.stats.isReady = true;
      this.stats.modelId = modelRef.id;

      // Emit progress: ready
      this.emitProgress({ status: 'ready' });

      // Start stats emission if enabled
      if (this.options.enableStats) {
        this.startStatsEmission();
      }
    } catch (error) {
      const nerError = new MedNERError(
        MedNERErrorCode.MODEL_LOAD_FAILED,
        `Failed to load NER model '${modelRef.id}': ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      );

      this.emitProgress({ status: 'error' });
      this.callbacks.onError?.(nerError);
      throw nerError;
    }
  }

  /**
   * Extract medical entities from text.
   *
   * @param text - The text to process
   * @returns Promise<MedNERResult>
   */
  async extract(text: string): Promise<MedNERResult> {
    if (!this._initialized || (!this.pipeline && !this.workerClient)) {
      throw new MedNERError(MedNERErrorCode.NOT_INITIALIZED, 'MedNERProcessor is not initialized. Call init() first.');
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new MedNERError(MedNERErrorCode.INVALID_INPUT, 'Input text is empty or invalid.');
    }

    this._isProcessing = true;
    this.stats.isProcessing = true;
    const startTime = performance.now();

    try {
      let entities: EntitySpan[];

      if (this.workerClient) {
        // The worker performs chunking, inference, and post-processing in one
        // round-trip. We pass the post-processing knobs across so the worker
        // returns the final list ready to consume.
        entities = await this.workerClient.extract({
          text,
          threshold: this.options.threshold,
          entityTypes: this.options.entityTypes,
          mergeAdjacent: this.options.mergeAdjacent,
          mergeOverlapping: this.options.mergeOverlapping,
        });
      } else {
        const charBudget = this.options.maxLength;
        const tokensOverBudget = this.tokenizer !== null && this.tokenizer(text).length > this.options.maxTokens;
        if (text.length > charBudget || tokensOverBudget) {
          entities = await this.extractChunked(text);
        } else {
          entities = await this.extractSingle(text);
        }
        entities = this.postProcessEntities(entities, text);
      }

      const processingTime = performance.now() - startTime;

      // Update statistics
      this.updateStats(entities, processingTime);

      const result: MedNERResult = {
        text,
        entities,
        processingTime,
        model: this.stats.modelId,
        timestamp: Date.now(),
      };

      // Emit result
      this.emit('data', { type: 'ner-extraction', data: result, timestamp: Date.now() });
      this.callbacks.onEntitiesExtracted?.(result);

      return result;
    } catch (error) {
      const nerError = new MedNERError(
        MedNERErrorCode.PROCESSING_ERROR,
        `Failed to process text: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      );

      this.callbacks.onError?.(nerError);
      throw nerError;
    } finally {
      this._isProcessing = false;
      this.stats.isProcessing = false;
    }
  }

  /**
   * Extract entities from a single text chunk.
   *
   * Handles both pipeline output shapes:
   *   - aggregation_strategy='simple' / 'first' / 'max' / 'average' →
   *     `[{ entity_group, score, word, start, end }]`
   *   - aggregation_strategy='none' (legacy BIO) →
   *     `[{ entity, score, word, index, start, end }]`
   */
  private async extractSingle(text: string): Promise<EntitySpan[]> {
    if (!this.pipeline) return [];

    const rawResults = (await this.pipeline(text)) as Array<RawTokenResult | AggregatedTokenResult>;

    return rawResults.map((result) => normaliseRawResult(result, (label) => this.mapLabelToEntityType(label)));
  }

  /**
   * Extract entities from long text using token-aware sentence chunking.
   * Falls back to a single-chunk pass if no tokenizer is available yet
   * (e.g. before init() resolved).
   */
  private async extractChunked(text: string): Promise<EntitySpan[]> {
    if (!this.tokenizer) {
      return this.extractSingle(text);
    }

    const chunks = chunkByTokens(text, this.tokenizer, {
      maxTokens: this.options.maxTokens,
      stride: this.options.stride,
    });

    const chunkResults: Array<{ chunk: TokenChunk; entities: EntitySpan[] }> = [];
    for (const chunk of chunks) {
      const chunkEntities = await this.extractSingle(chunk.text);
      // Adjust entity positions back into the original document.
      for (const entity of chunkEntities) {
        entity.start += chunk.offset;
        entity.end += chunk.offset;
      }
      chunkResults.push({ chunk, entities: chunkEntities });
    }

    return mergeChunkEntities(chunkResults);
  }

  /**
   * Adapt the model's tokenizer (if exposed by the pipeline) into the
   * uniform `Tokenizer` signature used by `chunkByTokens`. Returns `null`
   * if no usable tokenizer is found.
   */
  private buildTokenizer(pipeline: TokenClassificationPipeline | null): Tokenizer | null {
    if (!pipeline) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `tokenizer` isn't part of `TokenClassificationPipeline`'s public type; this is deliberate duck-typing across library versions (see doc comment above)
    const tok = (pipeline as any).tokenizer;
    if (!tok) return null;

    return (text: string): ArrayLike<unknown> => {
      try {
        // Transformers.js v3 tokenizers are callable; the result has
        // `input_ids` (a Tensor or ArrayLike).
        const encoded = typeof tok === 'function' ? tok(text) : tok.encode?.(text);
        if (!encoded) return [];
        const ids = encoded.input_ids ?? encoded;
        // Tensors expose `.data`, plain arrays do not.
        const arr = ids.data ?? ids;
        if (typeof arr.length === 'number') return arr as ArrayLike<unknown>;
        return [];
      } catch {
        return [];
      }
    };
  }

  /**
   * Map raw model label to MedicalEntityType.
   */
  private mapLabelToEntityType(label: string): MedicalEntityType {
    return LABEL_TO_ENTITY_TYPE[label] ?? MedicalEntityType.OTHER;
  }

  /**
   * Post-process extracted entities.
   */
  private postProcessEntities(entities: EntitySpan[], originalText: string): EntitySpan[] {
    let processed = entities;

    // Filter by threshold
    processed = filterEntitiesByThreshold(processed, this.options.threshold);

    // Merge adjacent entities of the same type (handles B-I-O tagging)
    if (this.options.mergeAdjacent) {
      processed = mergeAdjacentEntities(processed, originalText);
    }

    // Merge overlapping entities
    if (this.options.mergeOverlapping) {
      processed = mergeOverlappingEntities(processed);
    }

    // Filter by entity type if specified
    if (this.options.entityTypes && this.options.entityTypes.length > 0) {
      processed = filterEntitiesByType(processed, this.options.entityTypes);
    }

    // Filter out 'OTHER' type unless explicitly requested
    if (!this.options.entityTypes?.includes(MedicalEntityType.OTHER)) {
      processed = processed.filter((e) => e.type !== MedicalEntityType.OTHER);
    }

    return processed;
  }

  /**
   * Update processing statistics.
   */
  private updateStats(entities: EntitySpan[], processingTime: number): void {
    this.stats.textsProcessed++;
    this.stats.entitiesExtracted += entities.length;
    this.totalProcessingTime += processingTime;
    this.stats.averageProcessingTime = this.totalProcessingTime / this.stats.textsProcessed;

    // Update entity counts
    for (const entity of entities) {
      this.stats.entityCounts[entity.type] = (this.stats.entityCounts[entity.type] || 0) + 1;
      this.totalConfidence += entity.score;
      this.totalConfidenceCount++;
    }

    if (this.totalConfidenceCount > 0) {
      this.stats.averageConfidence = this.totalConfidence / this.totalConfidenceCount;
    }
  }

  /**
   * Start periodic stats emission.
   */
  private startStatsEmission(): void {
    this.statsInterval = setInterval(() => {
      this.stats.timestamp = Date.now();
      this.emit('data', { type: 'ner-stats', data: this.stats, timestamp: Date.now() });
    }, this.options.statsInterval);
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

  /**
   * Emit progress event.
   */
  private emitProgress(progress: ModelLoadProgress): void {
    this.emit('data', { type: 'ner-progress', data: progress, timestamp: Date.now() });
  }

  /**
   * Destroy the processor and release resources.
   */
  async destroy(): Promise<void> {
    this.stopStatsEmission();
    if (this.workerClient) {
      try {
        await this.workerClient.destroy();
      } catch {
        // Worker may already be dead; we'll dispose unconditionally below.
      }
      this.workerClient.dispose();
      this.workerClient = null;
    }
    this.pipeline = null;
    this.tokenizer = null;
    this._initialized = false;
    this._activeDevice = null;
    this.stats.isReady = false;
    this.listeners.clear();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Get the current model ID.
   */
  getModelId(): string {
    return this.stats.modelId;
  }

  /**
   * Get the compute backend chosen by `init()` (`'webgpu'` or `'wasm'`).
   *
   * Returns `null` before `init()` has resolved (and after `destroy()`).
   */
  getActiveDevice(): MedNERDevice | null {
    return this._activeDevice;
  }

  /**
   * Get current processing statistics.
   */
  getStats(): MedNERStats {
    return { ...this.stats, timestamp: Date.now() };
  }

  /**
   * Get the current options.
   */
  getOptions(): MedNEROptions {
    return { ...this.options };
  }

  /**
   * Update options dynamically.
   * Note: Changing the model requires reinitialize.
   */
  updateOptions(options: Partial<MedNEROptions>): void {
    if (options.threshold !== undefined) {
      this.options.threshold = options.threshold;
    }
    if (options.entityTypes !== undefined) {
      this.options.entityTypes = options.entityTypes;
    }
    if (options.mergeAdjacent !== undefined) {
      this.options.mergeAdjacent = options.mergeAdjacent;
    }
    if (options.mergeOverlapping !== undefined) {
      this.options.mergeOverlapping = options.mergeOverlapping;
    }
    if (options.enableStats !== undefined) {
      this.options.enableStats = options.enableStats;
      if (options.enableStats && !this.statsInterval) {
        this.startStatsEmission();
      } else if (!options.enableStats && this.statsInterval) {
        this.stopStatsEmission();
      }
    }
    if (options.statsInterval !== undefined) {
      this.options.statsInterval = options.statsInterval;
      if (this.options.enableStats) {
        this.stopStatsEmission();
        this.startStatsEmission();
      }
    }
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats.textsProcessed = 0;
    this.stats.entitiesExtracted = 0;
    this.stats.averageProcessingTime = 0;
    this.stats.averageConfidence = 0;
    Object.values(MedicalEntityType).forEach((type) => {
      this.stats.entityCounts[type] = 0;
    });
    this.totalProcessingTime = 0;
    this.totalConfidence = 0;
    this.totalConfidenceCount = 0;
  }

  // =========================================================================
  // Event Emitter Methods
  // =========================================================================

  /**
   * Subscribe to events.
   */
  on(event: string, callback: (data: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  /**
   * Unsubscribe from events.
   */
  off(event: string, callback: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  /**
   * Emit an event.
   */
  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event listener for '${event}':`, error);
      }
    });
  }
}

/**
 * Factory function to create a MedNERProcessor.
 *
 * @param options - Processor options
 * @returns MedNERProcessor instance
 */
export function createMedNER(options?: MedNEROptionsWithCallbacks): MedNERProcessor {
  return new MedNERProcessor(options);
}
