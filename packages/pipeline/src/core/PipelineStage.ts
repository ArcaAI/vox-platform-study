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
   *
   * Timeout and retry compose:
   * - When `timeout` is set, each attempt receives a context whose `abortSignal`
   *   is `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])`, so the user's
   *   `onExecute` can observe a single signal that fires on either user cancel
   *   or timeout.
   * - When `retry` is set, each attempt is wrapped with the timeout (if any),
   *   and the retry delay itself respects the user's abort signal so cancel
   *   short-circuits a pending retry.
   */
  async execute(input: TInput, context: PipelineContext): Promise<TOutput> {
    if (this.canExecute && !this.canExecute(input, context)) {
      throw new Error(`Stage '${this.name}' cannot execute with given input`);
    }

    if (this.config.retry) {
      return this.executeWithRetry(input, context);
    }

    if (this.config.timeout != null) {
      return this.executeOnceWithTimeout(input, context, this.config.timeout);
    }

    return this.onExecute(input, context);
  }

  /**
   * Run `onExecute` exactly once, applying a per-attempt timeout via
   * `AbortSignal.timeout(ms)`. The user's `context.abortSignal` is combined
   * with the timeout signal via `AbortSignal.any([...])` so user cancel and
   * timeout share a single child signal that is forwarded as `ctx.abortSignal`.
   *
   * The returned promise rejects:
   * - with a timeout error (`Stage '<name>' timed out after <ms>ms`) when the
   *   timeout signal fires before `onExecute` settles, or
   * - with the user's abort reason when the user signal fires first, or
   * - with the original `onExecute` error when it rejects on its own.
   */
  private async executeOnceWithTimeout(input: TInput, context: PipelineContext, timeoutMs: number): Promise<TOutput> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const userSignal = context.abortSignal;
    const combinedSignal = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;

    const childContext: PipelineContext = { ...context, abortSignal: combinedSignal };

    return new Promise<TOutput>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        combinedSignal.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = (): void => {
        if (timeoutSignal.aborted) {
          settle(() => reject(new Error(`Stage '${this.name}' timed out after ${timeoutMs}ms`)));
          return;
        }
        const reason = combinedSignal.reason;
        const err = reason instanceof Error ? reason : new Error(`Stage '${this.name}' aborted`);
        settle(() => reject(err));
      };

      if (combinedSignal.aborted) {
        onAbort();
        return;
      }
      combinedSignal.addEventListener('abort', onAbort, { once: true });

      this.onExecute(input, childContext).then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Execute with retry logic. Each attempt honours the per-attempt timeout
   * (when configured) via `executeOnceWithTimeout`, and the retry delay is
   * abort-aware so a cancellation during the delay short-circuits the loop.
   */
  private async executeWithRetry(input: TInput, context: PipelineContext): Promise<TOutput> {
    const { maxRetries, retryDelayMs, exponentialBackoff } = this.config.retry!;
    const timeoutMs = this.config.timeout;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (context.abortSignal?.aborted) {
        const reason = context.abortSignal.reason;
        throw reason instanceof Error ? reason : new Error(`Stage '${this.name}' cancelled before attempt ${attempt + 1}`);
      }

      try {
        if (timeoutMs != null) {
          return await this.executeOnceWithTimeout(input, context, timeoutMs);
        }
        return await this.onExecute(input, context);
      } catch (error) {
        lastError = error as Error;

        if (context.abortSignal?.aborted) {
          throw lastError;
        }

        if (attempt < maxRetries) {
          const delay = exponentialBackoff ? retryDelayMs * Math.pow(2, attempt) : retryDelayMs;

          context.logger?.warn(`Stage '${this.name}' failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, {
            error: lastError.message,
          });

          await this.sleepWithAbort(delay, context.abortSignal);
        }
      }
    }

    throw lastError;
  }

  /**
   * Sleep helper that resolves after `ms` or rejects if the optional
   * `signal` aborts during the wait.
   */
  private sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error(`Stage '${this.name}' cancelled during retry delay`));
        return;
      }
      const id = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(id);
        const reason = signal!.reason;
        reject(reason instanceof Error ? reason : new Error(`Stage '${this.name}' cancelled during retry delay`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  canExecute?(_input: TInput, _context: PipelineContext): boolean {
    return true;
  }
}

/**
 * Factory function type for creating pipeline stages.
 */
export type PipelineStageFactory<TInput, TOutput, TConfig = unknown> = (config?: TConfig) => PipelineStage<TInput, TOutput>;
