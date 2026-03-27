/**
 * @arcaai/pipeline - PipelineStage
 *
 * Abstract base class for implementing pipeline stages.
 * Provides common functionality and a template for stage implementations.
 */

import type { IPipelineStage, PipelineContext, StageConfig } from '../types/index.js';
import { DEFAULT_STAGE_CONFIG } from '../types/index.js';

/**
 * Abstract base class for pipeline stages.
 *
 * Extend this class to create custom stages. It provides:
 * - Configuration management
 * - Enable/disable lifecycle
 * - Abstract execute method for implementation
 *
 * @example
 * ```typescript
 * class MyTransformStage extends PipelineStage<string, number> {
 *   constructor() {
 *     super('my-transform');
 *   }
 *
 *   protected async onExecute(input: string, context: PipelineContext): Promise<number> {
 *     // Transform string to number
 *     return parseInt(input, 10);
 *   }
 * }
 * ```
 */
export abstract class PipelineStage<TInput, TOutput> implements IPipelineStage<TInput, TOutput> {
  readonly name: string;
  config: StageConfig;

  private _initialized = false;

  constructor(name: string, config?: Partial<StageConfig>) {
    this.name = name;
    this.config = { ...DEFAULT_STAGE_CONFIG, ...config };
  }

  /**
   * Check if the stage is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if the stage is initialized.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize the stage.
   */
  async init(): Promise<void> {
    if (this._initialized) {
      return;
    }

    await this.onInit();
    this._initialized = true;
  }

  /**
   * Destroy the stage and release resources.
   */
  async destroy(): Promise<void> {
    if (!this._initialized) {
      return;
    }

    await this.onDestroy();
    this._initialized = false;
  }

  /**
   * Enable the stage.
   */
  async enable(): Promise<void> {
    if (this.config.enabled) {
      return;
    }

    this.config.enabled = true;
    await this.onEnable?.();
  }

  /**
   * Disable the stage.
   */
  async disable(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    this.config.enabled = false;
    await this.onDisable?.();
  }

  /**
   * Execute the stage with timeout and error handling.
   */
  async execute(input: TInput, context: PipelineContext): Promise<TOutput> {
    // Check if stage can execute
    if (this.canExecute && !this.canExecute(input, context)) {
      throw new Error(`Stage '${this.name}' cannot execute with given input`);
    }

    // Apply timeout if configured
    if (this.config.timeout) {
      return this.executeWithTimeout(input, context, this.config.timeout);
    }

    // Apply retry if configured
    if (this.config.retry) {
      return this.executeWithRetry(input, context);
    }

    return this.onExecute(input, context);
  }

  /**
   * Execute with timeout.
   */
  private async executeWithTimeout(input: TInput, context: PipelineContext, timeoutMs: number): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Stage '${this.name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.onExecute(input, context)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Execute with retry logic.
   */
  private async executeWithRetry(input: TInput, context: PipelineContext): Promise<TOutput> {
    const { maxRetries, retryDelayMs, exponentialBackoff } = this.config.retry!;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.onExecute(input, context);
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries) {
          const delay = exponentialBackoff ? retryDelayMs * Math.pow(2, attempt) : retryDelayMs;

          context.logger?.warn(`Stage '${this.name}' failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, {
            error: lastError.message,
          });

          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Update stage configuration.
   */
  updateConfig(config: Partial<StageConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // =========================================================================
  // Abstract/Override Methods
  // =========================================================================

  /**
   * Execute the stage logic.
   * Must be implemented by subclasses.
   */
  protected abstract onExecute(input: TInput, context: PipelineContext): Promise<TOutput>;

  /**
   * Initialize stage-specific resources.
   * Override to implement initialization logic.
   */
  protected async onInit(): Promise<void> {
    // Override in subclass
  }

  /**
   * Cleanup stage-specific resources.
   * Override to implement cleanup logic.
   */
  protected async onDestroy(): Promise<void> {
    // Override in subclass
  }

  /**
   * Called when the stage is enabled.
   * Override to implement enable behavior.
   */
  async onEnable?(): Promise<void> {
    // Override in subclass
  }

  /**
   * Called when the stage is disabled.
   * Override to implement disable behavior.
   */
  async onDisable?(): Promise<void> {
    // Override in subclass
  }

  /**
   * Check if the stage can execute with the given input.
   * Override to implement validation logic.
   */
  canExecute?(input: TInput, context: PipelineContext): boolean {
    return true;
  }
}

/**
 * Factory function type for creating pipeline stages.
 */
export type PipelineStageFactory<TInput, TOutput, TConfig = unknown> = (config?: TConfig) => PipelineStage<TInput, TOutput>;
