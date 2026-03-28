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
  MedicalEntityType,
  LABEL_TO_ENTITY_TYPE,
  MODEL_MAP,
  DEFAULT_MED_NER_OPTIONS,
  MedNERError,
  MedNERErrorCode,
} from '../types/index.js';

import { getMedNERBrowserSupport, isMedNERSupported } from '../utils/browserSupport.js';

import { mergeAdjacentEntities, mergeOverlappingEntities, filterEntitiesByType, filterEntitiesByThreshold } from '../utils/entityUtils.js';

// Configure Transformers.js for browser usage
if (typeof window !== 'undefined') {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
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

  private options: Required<Omit<MedNEROptions, 'entityTypes' | 'onProgress' | 'dtype'>> & {
    entityTypes?: MedicalEntityType[];
    onProgress?: (progress: ModelLoadProgress) => void;
    dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  };

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
      enableStats: options.enableStats ?? DEFAULT_MED_NER_OPTIONS.enableStats,
      statsInterval: options.statsInterval ?? DEFAULT_MED_NER_OPTIONS.statsInterval,
      entityTypes: options.entityTypes,
      onProgress: options.onProgress,
      dtype: options.dtype,
    };

    // Initialize entity counts
    Object.values(MedicalEntityType).forEach((type) => {
      this.stats.entityCounts[type] = 0;
    });

    // Set model ID in stats
    this.stats.modelId = this.resolveModelId(this.options.model);
  }

  /**
   * Resolve model name to HuggingFace model ID.
   */
  private resolveModelId(model: string): string {
    return MODEL_MAP[model] || model;
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

    const modelId = this.resolveModelId(this.options.model);

    try {
      // Emit progress: downloading
      this.emitProgress({ status: 'downloading', progress: 0 });

      // Load the NER pipeline
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.pipeline = (await (pipeline as any)('token-classification', modelId, {
        dtype: this.options.dtype ?? support.recommendedDtype,
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
      })) as TokenClassificationPipeline;

      // Update state
      this._initialized = true;
      this.stats.isReady = true;
      this.stats.modelId = modelId;

      // Emit progress: ready
      this.emitProgress({ status: 'ready' });

      // Start stats emission if enabled
      if (this.options.enableStats) {
        this.startStatsEmission();
      }
    } catch (error) {
      const nerError = new MedNERError(
        MedNERErrorCode.MODEL_LOAD_FAILED,
        `Failed to load NER model '${modelId}': ${error instanceof Error ? error.message : 'Unknown error'}`,
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
    if (!this._initialized || !this.pipeline) {
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

      // Handle long texts by chunking
      if (text.length > this.options.maxLength) {
        entities = await this.extractChunked(text);
      } else {
        entities = await this.extractSingle(text);
      }

      // Post-process entities
      entities = this.postProcessEntities(entities, text);

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
   */
  private async extractSingle(text: string): Promise<EntitySpan[]> {
    if (!this.pipeline) return [];

    const rawResults = (await this.pipeline(text)) as RawTokenResult[];

    return rawResults.map((result) => ({
      text: result.word.replace(/^##/, ''),
      type: this.mapLabelToEntityType(result.entity),
      start: result.start,
      end: result.end,
      score: result.score,
      rawLabel: result.entity,
      tokenIndex: result.index,
    }));
  }

  /**
   * Extract entities from long text using chunking.
   */
  private async extractChunked(text: string): Promise<EntitySpan[]> {
    const chunks = this.chunkText(text);
    const allEntities: EntitySpan[] = [];

    for (const chunk of chunks) {
      const chunkEntities = await this.extractSingle(chunk.text);

      // Adjust entity positions based on chunk offset
      for (const entity of chunkEntities) {
        entity.start += chunk.offset;
        entity.end += chunk.offset;
      }

      allEntities.push(...chunkEntities);
    }

    return allEntities;
  }

  /**
   * Split text into overlapping chunks.
   */
  private chunkText(text: string): Array<{ text: string; offset: number }> {
    const chunks: Array<{ text: string; offset: number }> = [];
    const maxLength = this.options.maxLength;
    const overlap = this.options.chunkOverlap;

    let offset = 0;
    while (offset < text.length) {
      const end = Math.min(offset + maxLength, text.length);
      chunks.push({
        text: text.slice(offset, end),
        offset,
      });

      if (end === text.length) break;
      offset += maxLength - overlap;
    }

    return chunks;
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
    this.pipeline = null;
    this._initialized = false;
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
