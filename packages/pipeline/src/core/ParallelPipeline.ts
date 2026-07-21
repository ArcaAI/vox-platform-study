/**
 * @arcaai/pipeline - ParallelPipeline
 *
 * Executes pipeline stages in parallel. All stages receive the same input
 * and execute concurrently. Results are collected from all stages.
 */

import { EventEmitter } from 'eventemitter3';
import type { IPipeline, IPipelineStage, PipelineContext, PipelineState, PipelineEventMap } from '../types/index.js';
import { PipelineEvent, PipelineError, PipelineErrorCode, DEFAULT_PIPELINE_STATE } from '../types/index.js';

/**
 * Configuration for a stage in the parallel pipeline.
 */
interface StageEntry<TInput = unknown, TOutput = unknown> {
  stage: IPipelineStage<TInput, TOutput>;
  priority: number;
  /** Whether to wait for this stage before completing */
  required: boolean;
}

/**
 * Result from parallel pipeline execution.
 */
export interface ParallelPipelineResult<TOutput> {
  /** Results from all stages, keyed by stage name */
  results: Map<string, TOutput>;
  /** Errors from failed stages, keyed by stage name */
  errors: Map<string, Error>;
  /** Whether all required stages succeeded */
  success: boolean;
  /** Total execution duration */
  durationMs: number;
}

/**
 * Trigger mode for parallel pipeline stages.
 */
export type ParallelTriggerMode = 'auto' | 'manual';

/**
 * ParallelPipeline executes stages concurrently.
 *
 * All stages receive the same input and execute in parallel.
 * Supports required vs optional stages and manual triggering.
 *
 * @example
 * ```typescript
 * const pipeline = new ParallelPipeline('knowledge-processing');
 *
 * pipeline.addStage(nerStage, { required: true, triggerMode: 'auto' });
 * pipeline.addStage(spellCheckStage, { required: false, triggerMode: 'manual' });
 * pipeline.addStage(summarizationStage, { required: false, triggerMode: 'manual' });
 *
 * // Auto stages run immediately
 * const result = await pipeline.execute(transcriptText);
 *
 * // Manual stages can be triggered separately
 * await pipeline.triggerStage('spell-check');
 * ```
 */
export class ParallelPipeline<TInput, TOutput> implements IPipeline<TInput, ParallelPipelineResult<TOutput>> {
  readonly name: string;

  private stages: Map<string, StageEntry & { triggerMode: ParallelTriggerMode }> = new Map();
  private state: PipelineState = { ...DEFAULT_PIPELINE_STATE };
  private emitter = new EventEmitter();
  private abortController: AbortController | null = null;
  private currentRunId: string | null = null;
  private currentInput: TInput | null = null;
  private currentContext: PipelineContext | null = null;

  // Store results for later retrieval
  private results: Map<string, TOutput> = new Map();
  private errors: Map<string, Error> = new Map();

  /**
   * Per-stage serialization chain. Every call to `executeStage` for the same
   * stage name appends to this chain so concurrent invocations (e.g. multiple
   * `triggerStage('s')` calls, or a `triggerStage` overlapping `execute()`)
   * never race on the shared `results` / `errors` maps.
   */
  private stageLocks: Map<string, Promise<unknown>> = new Map();

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Get the current pipeline state.
   */
  getState(): PipelineState {
    return { ...this.state };
  }

  /**
   * Add a stage to the pipeline.
   */
  addStage<TSInput, TSOutput>(
    stage: IPipelineStage<TSInput, TSOutput>,
    options?: {
      priority?: number;
      required?: boolean;
      triggerMode?: ParallelTriggerMode;
    },
  ): void {
    const entry = {
      stage: stage as IPipelineStage<unknown, unknown>,
      priority: options?.priority ?? this.stages.size * 10,
      required: options?.required ?? true,
      triggerMode: options?.triggerMode ?? 'auto',
    };

    this.stages.set(stage.name, entry);
    this.updateState({ totalStages: this.stages.size });
  }

  /**
   * Remove a stage from the pipeline.
   */
  removeStage(stageName: string): void {
    this.stages.delete(stageName);
    this.updateState({ totalStages: this.stages.size });
  }

  /**
   * Get a stage by name.
   */
  getStage(stageName: string): IPipelineStage<unknown, unknown> | undefined {
    return this.stages.get(stageName)?.stage;
  }

  /**
   * Get all stages.
   */
  getStages(): IPipelineStage<unknown, unknown>[] {
    return Array.from(this.stages.values()).map((e) => e.stage);
  }

  /**
   * Enable or disable a stage.
   */
  async setStageEnabled(stageName: string, enabled: boolean): Promise<void> {
    const entry = this.stages.get(stageName);
    if (!entry) return;

    if (enabled) {
      await entry.stage.onEnable?.();
    } else {
      await entry.stage.onDisable?.();
    }
    entry.stage.config.enabled = enabled;
  }

  /**
   * Set the trigger mode for a stage.
   */
  setTriggerMode(stageName: string, mode: ParallelTriggerMode): void {
    const entry = this.stages.get(stageName);
    if (entry) {
      entry.triggerMode = mode;
    }
  }

  /**
   * Execute the pipeline (auto-triggered stages only).
   */
  async execute(input: TInput, contextOverrides?: Partial<PipelineContext>): Promise<ParallelPipelineResult<TOutput>> {
    if (this.state.status === 'RUNNING') {
      throw new PipelineError(PipelineErrorCode.ALREADY_RUNNING, `Pipeline '${this.name}' is already running`);
    }

    // Create run context
    const runId = this.generateRunId();
    this.currentRunId = runId;
    this.currentInput = input;
    this.abortController = new AbortController();

    const context: PipelineContext = {
      runId,
      pipelineName: this.name,
      startTime: Date.now(),
      metadata: {},
      abortSignal: this.abortController.signal,
      ...contextOverrides,
    };
    this.currentContext = context;

    // Clear previous results
    this.results.clear();
    this.errors.clear();

    // Initialize state
    this.updateState({
      status: 'RUNNING',
      progress: 0,
      completedStages: 0,
      error: undefined,
      currentStage: undefined,
    });

    this.emit(PipelineEvent.Started, { runId, timestamp: Date.now() });

    const startTime = performance.now();

    // Get auto-triggered enabled stages
    const autoStages = Array.from(this.stages.values()).filter((e) => e.stage.config.enabled && e.triggerMode === 'auto');

    try {
      // Execute all auto stages in parallel
      await Promise.all(autoStages.map((entry) => this.executeStage(entry, input, context)));

      // Check if all required stages succeeded
      const requiredStages = autoStages.filter((e) => e.required);
      const allRequiredSucceeded = requiredStages.every((e) => this.results.has(e.stage.name));

      const durationMs = performance.now() - startTime;

      // Update state
      this.updateState({
        status: allRequiredSucceeded ? 'COMPLETED' : 'ERROR',
        progress: 100,
        currentStage: undefined,
      });

      this.emit(PipelineEvent.Completed, {
        runId,
        durationMs,
        timestamp: Date.now(),
      });

      return {
        results: new Map(this.results),
        errors: new Map(this.errors),
        success: allRequiredSucceeded,
        durationMs,
      };
    } catch (error) {
      this.updateState({
        status: 'ERROR',
        error: error as Error,
        currentStage: undefined,
      });

      this.emit(PipelineEvent.Error, {
        runId,
        error: error as Error,
        timestamp: Date.now(),
      });

      return {
        results: new Map(this.results),
        errors: new Map(this.errors),
        success: false,
        durationMs: performance.now() - startTime,
      };
    }
  }

  /**
   * Manually trigger a specific stage.
   * Requires that execute() was called first to set the input.
   */
  async triggerStage(stageName: string): Promise<TOutput | null> {
    const entry = this.stages.get(stageName);
    if (!entry) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Stage '${stageName}' not found`);
    }

    if (!this.currentInput || !this.currentContext) {
      throw new PipelineError(PipelineErrorCode.NOT_INITIALIZED, 'Pipeline must be executed first to set input context');
    }

    if (!entry.stage.config.enabled) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Stage '${stageName}' is disabled`);
    }

    try {
      await this.executeStage(entry, this.currentInput, this.currentContext);
      return this.results.get(stageName) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get result from a specific stage.
   */
  getStageResult(stageName: string): TOutput | undefined {
    return this.results.get(stageName);
  }

  /**
   * Get error from a specific stage.
   */
  getStageError(stageName: string): Error | undefined {
    return this.errors.get(stageName);
  }

  /**
   * Pause the pipeline (no-op for parallel, included for interface compatibility).
   */
  pause(): void {
    // Parallel pipeline doesn't support pause
  }

  /**
   * Resume the pipeline (no-op for parallel).
   */
  resume(): void {
    // Parallel pipeline doesn't support resume
  }

  /**
   * Cancel the pipeline.
   */
  cancel(): void {
    if (this.state.status !== 'RUNNING') {
      return;
    }

    this.abortController?.abort();

    this.emit(PipelineEvent.Cancelled, {
      runId: this.currentRunId!,
      timestamp: Date.now(),
    });
  }

  /**
   * Reset the pipeline to initial state.
   */
  reset(): void {
    this.cancel();
    this.results.clear();
    this.errors.clear();
    this.stageLocks.clear();
    this.currentInput = null;
    this.currentContext = null;
    this.updateState({
      ...DEFAULT_PIPELINE_STATE,
      totalStages: this.stages.size,
    });
  }

  /**
   * Initialize all stages.
   */
  async init(): Promise<void> {
    for (const entry of this.stages.values()) {
      await entry.stage.init?.();
    }
  }

  /**
   * Destroy all stages.
   */
  async destroy(): Promise<void> {
    this.cancel();
    for (const entry of this.stages.values()) {
      await entry.stage.destroy?.();
    }
    this.stages.clear();
    this.reset();
  }

  /**
   * Subscribe to pipeline events.
   */
  on<K extends PipelineEvent>(event: K, listener: (payload: PipelineEventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  /**
   * Unsubscribe from pipeline events.
   */
  off<K extends PipelineEvent>(event: K, listener: (payload: PipelineEventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * Number of listeners currently registered for `event`. Useful for
   * detecting listener leaks during long-lived pipeline observation.
   */
  listenerCount(event: PipelineEvent): number {
    return this.emitter.listenerCount(event);
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Execute a single stage. Wraps the actual execution in a per-stage lock
   * so concurrent invocations against the same stage name serialize and do
   * not race on the shared `results` / `errors` maps.
   */
  private executeStage(entry: StageEntry & { triggerMode: ParallelTriggerMode }, input: TInput, context: PipelineContext): Promise<void> {
    const stageName = entry.stage.name;
    const previousLock = this.stageLocks.get(stageName) ?? Promise.resolve();
    const next = previousLock.catch(() => undefined).then(() => this.executeStageBody(entry, input, context));
    this.stageLocks.set(stageName, next);
    return next;
  }

  /**
   * Body of a single stage execution. Races `stage.execute(...)` against the
   * pipeline's abort signal so cancellation surfaces promptly even when the
   * stage's `onExecute` does not observe `ctx.abortSignal`.
   */
  private async executeStageBody(entry: StageEntry & { triggerMode: ParallelTriggerMode }, input: TInput, context: PipelineContext): Promise<void> {
    const stage = entry.stage;

    if (stage.canExecute && !stage.canExecute(input, context)) {
      this.emit(PipelineEvent.StageSkipped, { stageName: stage.name });
      return;
    }

    if (context.abortSignal?.aborted) {
      const cancelError = this.makeCancelError(context.abortSignal, stage.name);
      this.errors.set(stage.name, cancelError);
      this.emit(PipelineEvent.StageFailed, {
        stageName: stage.name,
        durationMs: 0,
        error: cancelError,
      });
      this.updateState({
        completedStages: this.results.size + this.errors.size,
        progress: Math.round(((this.results.size + this.errors.size) / this.stages.size) * 100),
      });
      if (entry.required) {
        throw cancelError;
      }
      return;
    }

    this.emit(PipelineEvent.StageStarted, { stageName: stage.name });

    const stageStartTime = performance.now();

    try {
      const result = (await this.raceWithAbort(stage.execute(input, context), context.abortSignal, stage.name)) as TOutput;
      const durationMs = performance.now() - stageStartTime;

      this.results.set(stage.name, result);

      this.emit(PipelineEvent.StageCompleted, {
        stageName: stage.name,
        durationMs,
        result,
      });

      this.updateState({
        completedStages: this.results.size + this.errors.size,
        progress: Math.round(((this.results.size + this.errors.size) / this.stages.size) * 100),
      });
    } catch (error) {
      const durationMs = performance.now() - stageStartTime;

      this.errors.set(stage.name, error as Error);

      this.emit(PipelineEvent.StageFailed, {
        stageName: stage.name,
        durationMs,
        error: error as Error,
      });

      this.updateState({
        completedStages: this.results.size + this.errors.size,
        progress: Math.round(((this.results.size + this.errors.size) / this.stages.size) * 100),
      });

      if (entry.required) {
        throw error;
      }
    }
  }

  /**
   * Race a stage's promise against the pipeline's abort signal so cancel
   * settles promptly even when the stage ignores `ctx.abortSignal`. The
   * underlying promise is intentionally allowed to settle in the background
   * (we cannot forcibly stop user code), but the pipeline does not wait on it.
   */
  private raceWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, stageName: string): Promise<T> {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(this.makeCancelError(signal, stageName));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private makeCancelError(signal: AbortSignal, stageName: string): Error {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    return new PipelineError(PipelineErrorCode.CANCELLED, `Stage '${stageName}' cancelled`, { stage: stageName });
  }

  /**
   * Emit an event.
   */
  private emit<K extends PipelineEvent>(event: K, payload: PipelineEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  /**
   * Update pipeline state and emit change event.
   */
  private updateState(updates: Partial<PipelineState>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdated: Date.now(),
    };
    this.emit(PipelineEvent.StateChange, this.state);
  }

  /**
   * Generate a unique run ID.
   */
  private generateRunId(): string {
    return `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
