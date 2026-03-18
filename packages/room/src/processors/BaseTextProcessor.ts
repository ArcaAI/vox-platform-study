/**
 * @arcaai/room - BaseTextProcessor
 *
 * Abstract base class for implementing text processors.
 * Provides a similar interface to BaseProcessor but for text-based processing
 * (like NER, summarization, spell-checking, etc.)
 */

import { TypedEventEmitter } from '../events/EventEmitter.js';
import { ProcessorEvent, type ProcessorEventMap } from '../events/ProcessorEvents.js';
import { ProcessorStatus, type TextProcessorStats } from './types.js';

/**
 * Options for initializing a text processor.
 */
export interface TextProcessorOptions {
  /** Optional configuration specific to the processor */
  config?: Record<string, unknown>;
}

/**
 * Abstract base class for text processors.
 *
 * Extend this class to create custom text processors. It provides:
 * - Event emission capabilities
 * - Status tracking
 * - Common lifecycle methods
 *
 * Unlike audio processors, text processors don't need to integrate with
 * the Web Audio API or handle media tracks. They process text input and
 * emit results via events.
 *
 * @example
 * ```typescript
 * class MyTextProcessor extends BaseTextProcessor {
 *   constructor() {
 *     super('my-text-processor');
 *   }
 *
 *   protected async onInit(): Promise<void> {
 *     // Load models, set up resources
 *   }
 *
 *   protected async onProcess(text: string): Promise<MyResult> {
 *     // Process text and return results
 *     return { entities: [] };
 *   }
 *
 *   protected async onDestroy(): Promise<void> {
 *     // Cleanup resources
 *   }
 * }
 *
 * // Usage:
 * const processor = new MyTextProcessor();
 * await processor.init();
 * const result = await processor.process('Some text');
 * await processor.destroy();
 * ```
 */
export abstract class BaseTextProcessor<
  TInput = string,
  TOutput = unknown,
> extends TypedEventEmitter<ProcessorEventMap> {
  readonly name: string;

  protected status: ProcessorStatus = ProcessorStatus.IDLE;
  protected _enabled = true;
  protected _stats: TextProcessorStats = {
    isActive: false,
    framesProcessed: 0,
    processingTimeMs: 0,
    tokensProcessed: 0,
    averageLatencyMs: 0,
    timestamp: Date.now(),
  };

  // Stats tracking
  private _totalLatencyMs = 0;
  private _processCount = 0;

  constructor(name: string) {
    super();
    this.name = name;
  }

  /**
   * Get the current processor status.
   */
  getStatus(): ProcessorStatus {
    return this.status;
  }

  /**
   * Check if the processor is enabled.
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Check if the processor has been initialized.
   */
  isInitialized(): boolean {
    return (
      this.status === ProcessorStatus.READY ||
      this.status === ProcessorStatus.ENABLED ||
      this.status === ProcessorStatus.DISABLED
    );
  }

  /**
   * Check if this processor is supported in the current environment.
   * Override in subclass to implement environment-specific checks.
   */
  isSupported(): boolean {
    return true;
  }

  /**
   * Get current processing statistics.
   */
  getStats(): TextProcessorStats {
    return {
      ...this._stats,
      timestamp: Date.now(),
    };
  }

  /**
   * Reset processing statistics.
   */
  resetStats(): void {
    this._stats = {
      isActive: this._enabled,
      framesProcessed: 0,
      processingTimeMs: 0,
      tokensProcessed: 0,
      averageLatencyMs: 0,
      timestamp: Date.now(),
    };
    this._totalLatencyMs = 0;
    this._processCount = 0;
  }

  /**
   * Initialize the processor.
   */
  async init(options?: TextProcessorOptions): Promise<void> {
    if (this.status !== ProcessorStatus.IDLE && this.status !== ProcessorStatus.DESTROYED) {
      throw new Error(`Cannot initialize processor in state: ${this.status}`);
    }

    this.status = ProcessorStatus.INITIALIZING;

    try {
      await this.onInit(options);
      this.status = ProcessorStatus.READY;
      this._stats.isActive = true;
      this.emit(ProcessorEvent.Ready);

      if (this._enabled) {
        this.status = ProcessorStatus.ENABLED;
        this.emit(ProcessorEvent.Enabled);
      }
    } catch (error) {
      this.status = ProcessorStatus.ERROR;
      this._stats.isActive = false;
      this.emit(ProcessorEvent.Error, {
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: false,
      });
      throw error;
    }
  }

  /**
   * Process text input and return results.
   *
   * @param input - The text or data to process
   * @returns Processing result
   */
  async process(input: TInput): Promise<TOutput> {
    if (!this.isInitialized()) {
      throw new Error('Processor not initialized. Call init() first.');
    }

    if (!this._enabled) {
      throw new Error('Processor is disabled');
    }

    const startTime = Date.now();

    try {
      const result = await this.onProcess(input);

      // Update stats
      const latency = Date.now() - startTime;
      this._stats.framesProcessed++;
      this._stats.processingTimeMs += latency;
      this._totalLatencyMs += latency;
      this._processCount++;
      this._stats.averageLatencyMs = this._totalLatencyMs / this._processCount;

      // Estimate tokens processed (if input is string)
      if (typeof input === 'string') {
        this._stats.tokensProcessed += input.length;
      }

      return result;
    } catch (error) {
      this.emit(ProcessorEvent.Error, {
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: true,
      });
      throw error;
    }
  }

  /**
   * Destroy the processor and release resources.
   */
  async destroy(): Promise<void> {
    if (this.status === ProcessorStatus.DESTROYED) {
      return;
    }

    try {
      await this.onDestroy();
    } finally {
      this._stats.isActive = false;
      this.status = ProcessorStatus.DESTROYED;
      this.emit(ProcessorEvent.Destroyed);
    }
  }

  /**
   * Enable the processor.
   */
  async enable(): Promise<void> {
    if (this._enabled) return;

    this._enabled = true;
    this._stats.isActive = true;
    await this.onEnable();
    this.status = ProcessorStatus.ENABLED;
    this.emit(ProcessorEvent.Enabled);
  }

  /**
   * Disable the processor.
   */
  async disable(): Promise<void> {
    if (!this._enabled) return;

    this._enabled = false;
    this._stats.isActive = false;
    await this.onDisable();
    this.status = ProcessorStatus.DISABLED;
    this.emit(ProcessorEvent.Disabled);
  }

  // =========================================================================
  // Abstract Methods (Must be implemented by subclasses)
  // =========================================================================

  /**
   * Initialize processor-specific resources.
   * Must be implemented by subclasses.
   *
   * @param options - Initialization options
   */
  protected abstract onInit(options?: TextProcessorOptions): Promise<void>;

  /**
   * Process the input and return the result.
   * Must be implemented by subclasses.
   *
   * @param input - The input to process
   * @returns Processing result
   */
  protected abstract onProcess(input: TInput): Promise<TOutput>;

  /**
   * Cleanup processor-specific resources.
   * Must be implemented by subclasses.
   */
  protected abstract onDestroy(): Promise<void>;

  // =========================================================================
  // Optional Override Methods
  // =========================================================================

  /**
   * Called when the processor is enabled.
   * Override to implement enable behavior.
   */
  protected async onEnable(): Promise<void> {
    // Override in subclass
  }

  /**
   * Called when the processor is disabled.
   * Override to implement disable behavior.
   */
  protected async onDisable(): Promise<void> {
    // Override in subclass
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  /**
   * Emit a data event with typed payload.
   *
   * @param type - The data type
   * @param data - The data payload
   */
  protected emitData<T>(type: string, data: T): void {
    this.emit(ProcessorEvent.Data, {
      type,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Update stats with additional token count.
   * Useful for processors that can track tokens more precisely.
   *
   * @param tokenCount - Number of tokens processed
   */
  protected addTokensProcessed(tokenCount: number): void {
    this._stats.tokensProcessed += tokenCount;
  }
}
