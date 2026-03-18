/**
 * @arcaai/pipeline - SequentialPipeline
 *
 * Executes pipeline stages in sequence, passing output from one stage
 * as input to the next. Supports pause/resume and cancellation.
 */

import { EventEmitter } from 'eventemitter3';
import type {
  IPipeline,
  IPipelineStage,
  PipelineContext,
  PipelineState,
  PipelineEventMap,
  StageResult,
} from '../types/index.js';
import {
  PipelineEvent,
  PipelineError,
  PipelineErrorCode,
  DEFAULT_PIPELINE_STATE,
} from '../types/index.js';

/**
 * Configuration for a stage in the sequential pipeline.
 */
interface StageEntry<TInput = unknown, TOutput = unknown> {
  stage: IPipelineStage<TInput, TOutput>;
  priority: number;
}

/**
 * SequentialPipeline executes stages in order.
 *
 * Each stage receives the output of the previous stage as input.
 * The pipeline can be paused, resumed, or cancelled during execution.
 *
 * @example
 * ```typescript
 * const pipeline = new SequentialPipeline('audio-processing');
 *
 * pipeline.addStage(noiseFilterStage, { priority: 10 });
 * pipeline.addStage(vadStage, { priority: 20 });
 * pipeline.addStage(sttStage, { priority: 30 });
 *
 * const transcript = await pipeline.execute(audioData);
 * ```
 */
export class SequentialPipeline<TInput, TOutput>
  implements IPipeline<TInput, TOutput>
{
  readonly name: string;

  private stages: StageEntry[] = [];
  private state: PipelineState = { ...DEFAULT_PIPELINE_STATE };
  private emitter = new EventEmitter();
  private abortController: AbortController | null = null;
  private pausePromise: { resolve: () => void; promise: Promise<void> } | null = null;
  private currentRunId: string | null = null;

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
    options?: { priority?: number }
  ): void {
    const entry: StageEntry = {
      stage: stage as IPipelineStage<unknown, unknown>,
      priority: options?.priority ?? this.stages.length * 10,
    };

    this.stages.push(entry);
    this.sortStages();
    this.updateState({ totalStages: this.stages.length });
  }

  /**
   * Remove a stage from the pipeline.
   */
  removeStage(stageName: string): void {
    const index = this.stages.findIndex((e) => e.stage.name === stageName);
    if (index !== -1) {
      this.stages.splice(index, 1);
      this.updateState({ totalStages: this.stages.length });
    }
  }

  /**
   * Get a stage by name.
   */
  getStage(stageName: string): IPipelineStage<unknown, unknown> | undefined {
    return this.stages.find((e) => e.stage.name === stageName)?.stage;
  }

  /**
   * Get all stages in execution order.
   */
  getStages(): IPipelineStage<unknown, unknown>[] {
    return this.stages.map((e) => e.stage);
  }

  /**
   * Enable or disable a stage.
   */
  async setStageEnabled(stageName: string, enabled: boolean): Promise<void> {
    const entry = this.stages.find((e) => e.stage.name === stageName);
    if (!entry) return;

    if (enabled) {
      await entry.stage.onEnable?.();
    } else {
      await entry.stage.onDisable?.();
    }
    entry.stage.config.enabled = enabled;
  }

  /**
   * Execute the pipeline.
   */
  async execute(
    input: TInput,
    contextOverrides?: Partial<PipelineContext>
  ): Promise<TOutput> {
    if (this.state.status === 'RUNNING') {
      throw new PipelineError(
        PipelineErrorCode.ALREADY_RUNNING,
        `Pipeline '${this.name}' is already running`
      );
    }

    // Create run context
    const runId = this.generateRunId();
    this.currentRunId = runId;
    this.abortController = new AbortController();

    const context: PipelineContext = {
      runId,
      pipelineName: this.name,
      startTime: Date.now(),
      metadata: {},
      abortSignal: this.abortController.signal,
      ...contextOverrides,
    };

    // Initialize state
    this.updateState({
      status: 'RUNNING',
      progress: 0,
      completedStages: 0,
      error: undefined,
      currentStage: undefined,
    });

    this.emit(PipelineEvent.Started, { runId, timestamp: Date.now() });

    const enabledStages = this.stages.filter((e) => e.stage.config.enabled);
    let currentOutput: unknown = input;
    const startTime = performance.now();

    try {
      for (let i = 0; i < enabledStages.length; i++) {
        // Check for cancellation
        if (this.abortController.signal.aborted) {
          throw new PipelineError(PipelineErrorCode.CANCELLED, 'Pipeline was cancelled');
        }

        // Wait if paused
        await this.waitIfPaused();

        const entry = enabledStages[i]!;
        const stage = entry.stage;

        // Check if stage can execute
        if (stage.canExecute && !stage.canExecute(currentOutput, context)) {
          // Skip stage
          this.emit(PipelineEvent.StageSkipped, { stageName: stage.name });
          context.logger?.info(`Skipping stage '${stage.name}' - canExecute returned false`);
          continue;
        }

        // Update state
        this.updateState({
          currentStage: stage.name,
          progress: Math.round((i / enabledStages.length) * 100),
        });

        this.emit(PipelineEvent.StageStarted, { stageName: stage.name });

        const stageStartTime = performance.now();

        try {
          // Execute stage
          currentOutput = await stage.execute(currentOutput, context);

          const durationMs = performance.now() - stageStartTime;

          this.emit(PipelineEvent.StageCompleted, {
            stageName: stage.name,
            durationMs,
            result: currentOutput,
          });

          this.updateState({
            completedStages: i + 1,
          });

          context.logger?.debug(`Stage '${stage.name}' completed`, { durationMs });
        } catch (error) {
          const durationMs = performance.now() - stageStartTime;

          this.emit(PipelineEvent.StageFailed, {
            stageName: stage.name,
            durationMs,
            error: error as Error,
          });

          throw new PipelineError(
            PipelineErrorCode.STAGE_FAILED,
            `Stage '${stage.name}' failed: ${(error as Error).message}`,
            { stage: stage.name, cause: error as Error }
          );
        }
      }

      // Pipeline completed
      const totalDuration = performance.now() - startTime;

      this.updateState({
        status: 'COMPLETED',
        progress: 100,
        currentStage: undefined,
      });

      this.emit(PipelineEvent.Completed, {
        runId,
        durationMs: totalDuration,
        timestamp: Date.now(),
      });

      return currentOutput as TOutput;
    } catch (error) {
      this.updateState({
        status: 'ERROR',
        error: error as Error,
        currentStage: undefined,
      });

      this.emit(PipelineEvent.Error, {
        runId,
        error: error as Error,
        stage: this.state.currentStage,
        timestamp: Date.now(),
      });

      throw error;
    } finally {
      this.currentRunId = null;
      this.abortController = null;
    }
  }

  /**
   * Pause the pipeline.
   */
  pause(): void {
    if (this.state.status !== 'RUNNING') {
      return;
    }

    this.pausePromise = this.createPausePromise();
    this.updateState({ status: 'PAUSED' });
    this.emit(PipelineEvent.Paused, {
      runId: this.currentRunId!,
      timestamp: Date.now(),
    });
  }

  /**
   * Resume the pipeline.
   */
  resume(): void {
    if (this.state.status !== 'PAUSED') {
      return;
    }

    if (this.pausePromise) {
      this.pausePromise.resolve();
      this.pausePromise = null;
    }

    this.updateState({ status: 'RUNNING' });
    this.emit(PipelineEvent.Resumed, {
      runId: this.currentRunId!,
      timestamp: Date.now(),
    });
  }

  /**
   * Cancel the pipeline.
   */
  cancel(): void {
    if (this.state.status !== 'RUNNING' && this.state.status !== 'PAUSED') {
      return;
    }

    // Resume if paused so the loop can exit
    if (this.pausePromise) {
      this.pausePromise.resolve();
      this.pausePromise = null;
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
    this.updateState({
      ...DEFAULT_PIPELINE_STATE,
      totalStages: this.stages.length,
    });
  }

  /**
   * Initialize all stages.
   */
  async init(): Promise<void> {
    for (const entry of this.stages) {
      await entry.stage.init?.();
    }
  }

  /**
   * Destroy all stages.
   */
  async destroy(): Promise<void> {
    this.cancel();
    for (const entry of this.stages) {
      await entry.stage.destroy?.();
    }
    this.stages = [];
    this.reset();
  }

  /**
   * Subscribe to pipeline events.
   */
  on<K extends PipelineEvent>(
    event: K,
    listener: (payload: PipelineEventMap[K]) => void
  ): void {
    this.emitter.on(event, listener);
  }

  /**
   * Unsubscribe from pipeline events.
   */
  off<K extends PipelineEvent>(
    event: K,
    listener: (payload: PipelineEventMap[K]) => void
  ): void {
    this.emitter.off(event, listener);
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

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
   * Sort stages by priority.
   */
  private sortStages(): void {
    this.stages.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Generate a unique run ID.
   */
  private generateRunId(): string {
    return `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Create a pause promise.
   */
  private createPausePromise(): { resolve: () => void; promise: Promise<void> } {
    let resolveFunc: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveFunc = resolve;
    });
    return { resolve: resolveFunc!, promise };
  }

  /**
   * Wait if the pipeline is paused.
   */
  private async waitIfPaused(): Promise<void> {
    if (this.pausePromise) {
      await this.pausePromise.promise;
    }
  }
}
