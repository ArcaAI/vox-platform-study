/**
 * @arcaai/pipeline - PipelineOrchestrator
 *
 * Coordinates multiple pipelines with unified state management.
 * Manages pipeline lifecycle, data flow between pipelines, and overall system state.
 */

import { EventEmitter } from 'eventemitter3';
import type { IPipeline, PipelineState, PipelineContext, PipelineEventMap, PipelineLogger } from '../types/index.js';
import { PipelineEvent, PipelineError, PipelineErrorCode } from '../types/index.js';

/**
 * Overall orchestrator state.
 */
export interface OrchestratorState {
  /** Whether the orchestrator is initialized */
  initialized: boolean;
  /** Overall status derived from all pipelines */
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR';
  /** Individual pipeline states */
  pipelines: Map<string, PipelineState>;
  /** Whether all pipelines can be safely closed */
  canClose: boolean;
  /** Pending operations across all pipelines */
  pendingOperations: string[];
  /** Last updated timestamp */
  lastUpdated: number;
}

/**
 * Events emitted by the orchestrator.
 */
export enum OrchestratorEvent {
  /** Orchestrator initialized */
  Initialized = 'initialized',
  /** Orchestrator state changed */
  StateChange = 'stateChange',
  /** Pipeline registered */
  PipelineRegistered = 'pipelineRegistered',
  /** Pipeline unregistered */
  PipelineUnregistered = 'pipelineUnregistered',
  /** Data passed between pipelines */
  DataFlow = 'dataFlow',
  /** Error in orchestrator */
  Error = 'error',
}

/**
 * Event map for orchestrator events.
 */
export interface OrchestratorEventMap {
  [OrchestratorEvent.Initialized]: { timestamp: number };
  [OrchestratorEvent.StateChange]: OrchestratorState;
  [OrchestratorEvent.PipelineRegistered]: { pipelineName: string; timestamp: number };
  [OrchestratorEvent.PipelineUnregistered]: { pipelineName: string; timestamp: number };
  [OrchestratorEvent.DataFlow]: {
    sourcePipeline: string;
    targetPipeline: string;
    dataType: string;
    timestamp: number;
  };
  [OrchestratorEvent.Error]: { error: Error; pipeline?: string; timestamp: number };
}

/**
 * Configuration for data flow between pipelines.
 */
interface DataFlowConfig {
  /** Source pipeline name */
  source: string;
  /** Target pipeline name */
  target: string;
  /** Transform function to convert source output to target input */
  transform?: (data: unknown) => unknown;
  /** Whether to auto-execute target pipeline on source completion */
  autoExecute?: boolean;
}

/**
 * PipelineOrchestrator coordinates multiple pipelines.
 *
 * Features:
 * - Unified state management across pipelines
 * - Data flow routing between pipelines
 * - Lifecycle management (init, pause, resume, destroy)
 * - Overall system status tracking
 *
 * @example
 * ```typescript
 * const orchestrator = new PipelineOrchestrator();
 *
 * orchestrator.register('transcription', transcriptionPipeline);
 * orchestrator.register('knowledge', knowledgePipeline);
 *
 * // Set up data flow: transcription output -> knowledge input
 * orchestrator.connect('transcription', 'knowledge', {
 *   autoExecute: true,
 * });
 *
 * await orchestrator.init();
 * await orchestrator.execute('transcription', audioData);
 * ```
 */
/**
 * Listener triplet held per registered pipeline so `unregister`/`destroy`
 * can deterministically remove them from the pipeline's emitter.
 */
interface RegisteredListeners {
  stateChange: (state: PipelineState) => void;
  completed: (payload: PipelineEventMap[PipelineEvent.Completed]) => void;
  error: (payload: PipelineEventMap[PipelineEvent.Error]) => void;
}

export class PipelineOrchestrator {
  private pipelines: Map<string, IPipeline<unknown, unknown>> = new Map();
  private pipelineListeners: Map<string, RegisteredListeners> = new Map();
  /**
   * Last successful execute() result per pipeline name. Captured so
   * `handlePipelineCompleted` can pass the actual value to a downstream
   * `autoExecute` target.
   */
  private pipelineResults: Map<string, unknown> = new Map();
  private dataFlows: DataFlowConfig[] = [];
  private state: OrchestratorState = {
    initialized: false,
    status: 'IDLE',
    pipelines: new Map(),
    canClose: true,
    pendingOperations: [],
    lastUpdated: Date.now(),
  };
  private emitter = new EventEmitter();
  private logger?: PipelineLogger;

  constructor(options?: { logger?: PipelineLogger }) {
    this.logger = options?.logger;
  }

  /**
   * Get the current orchestrator state.
   */
  getState(): OrchestratorState {
    return {
      ...this.state,
      pipelines: new Map(this.state.pipelines),
    };
  }

  /**
   * Register a pipeline with the orchestrator.
   *
   * Listener references are stored so `unregister`/`destroy` can remove
   * them from the pipeline's emitter — without this bookkeeping, repeated
   * register/unregister cycles leak listeners.
   */
  register<TInput, TOutput>(name: string, pipeline: IPipeline<TInput, TOutput>): void {
    if (this.pipelines.has(name)) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Pipeline '${name}' is already registered`);
    }

    this.pipelines.set(name, pipeline as IPipeline<unknown, unknown>);

    const listeners: RegisteredListeners = {
      stateChange: (state) => this.handlePipelineStateChange(name, state),
      completed: (payload) => this.handlePipelineCompleted(name, payload),
      error: (payload) => this.handlePipelineError(name, payload),
    };
    this.pipelineListeners.set(name, listeners);

    pipeline.on(PipelineEvent.StateChange, listeners.stateChange);
    pipeline.on(PipelineEvent.Completed, listeners.completed);
    pipeline.on(PipelineEvent.Error, listeners.error);

    this.state.pipelines.set(name, pipeline.getState());
    this.updateState();

    this.emit(OrchestratorEvent.PipelineRegistered, {
      pipelineName: name,
      timestamp: Date.now(),
    });

    this.logger?.info(`Pipeline '${name}' registered`, { pipeline: name });
  }

  /**
   * Unregister a pipeline. Removes the listeners installed by `register`.
   */
  async unregister(name: string): Promise<void> {
    const pipeline = this.pipelines.get(name);
    if (!pipeline) return;

    this.removePipelineListeners(name);

    this.dataFlows = this.dataFlows.filter((flow) => flow.source !== name && flow.target !== name);

    await this.destroyPipeline(name);

    this.pipelines.delete(name);
    this.state.pipelines.delete(name);
    this.pipelineResults.delete(name);
    this.updateState();

    this.emit(OrchestratorEvent.PipelineUnregistered, {
      pipelineName: name,
      timestamp: Date.now(),
    });

    this.logger?.info(`Pipeline '${name}' unregistered`, { pipeline: name });
  }

  /**
   * Remove the orchestrator-owned listeners for a registered pipeline.
   */
  private removePipelineListeners(name: string): void {
    const pipeline = this.pipelines.get(name);
    const listeners = this.pipelineListeners.get(name);
    if (!pipeline || !listeners) return;

    pipeline.off(PipelineEvent.StateChange, listeners.stateChange);
    pipeline.off(PipelineEvent.Completed, listeners.completed);
    pipeline.off(PipelineEvent.Error, listeners.error);

    this.pipelineListeners.delete(name);
  }

  /**
   * Connect two pipelines for data flow.
   */
  connect(sourcePipeline: string, targetPipeline: string, options?: { transform?: (data: unknown) => unknown; autoExecute?: boolean }): void {
    if (!this.pipelines.has(sourcePipeline)) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Source pipeline '${sourcePipeline}' not found`);
    }

    if (!this.pipelines.has(targetPipeline)) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Target pipeline '${targetPipeline}' not found`);
    }

    this.dataFlows.push({
      source: sourcePipeline,
      target: targetPipeline,
      transform: options?.transform,
      autoExecute: options?.autoExecute ?? false,
    });

    this.logger?.debug(`Connected '${sourcePipeline}' -> '${targetPipeline}'`, {
      autoExecute: options?.autoExecute,
    });
  }

  /**
   * Disconnect two pipelines.
   */
  disconnect(sourcePipeline: string, targetPipeline: string): void {
    this.dataFlows = this.dataFlows.filter((flow) => !(flow.source === sourcePipeline && flow.target === targetPipeline));
  }

  /**
   * Get a registered pipeline.
   */
  getPipeline<TInput, TOutput>(name: string): IPipeline<TInput, TOutput> | undefined {
    return this.pipelines.get(name) as IPipeline<TInput, TOutput> | undefined;
  }

  /**
   * Initialize all registered pipelines.
   */
  async init(): Promise<void> {
    if (this.state.initialized) {
      return;
    }

    this.logger?.info('Initializing orchestrator');

    for (const [name, pipeline] of this.pipelines) {
      try {
        // Pipelines with init method
        if ('init' in pipeline && typeof pipeline.init === 'function') {
          await (pipeline as { init: () => Promise<void> }).init();
        }
        this.logger?.debug(`Pipeline '${name}' initialized`);
      } catch (error) {
        this.logger?.error(`Failed to initialize pipeline '${name}'`, {
          error: (error as Error).message,
        });
        throw error;
      }
    }

    this.state.initialized = true;
    this.updateState();

    this.emit(OrchestratorEvent.Initialized, { timestamp: Date.now() });
    this.logger?.info('Orchestrator initialized');
  }

  /**
   * Execute a specific pipeline. Successful results are captured per-pipeline
   * so that connected targets configured with `autoExecute` can be invoked
   * with the actual produced value. Data flows are fired after the result
   * is captured, not from the source pipeline's `Completed` event (which
   * fires before this method has the chance to store the resolved value).
   */
  async execute<TInput, TOutput>(pipelineName: string, input: TInput, context?: Partial<PipelineContext>): Promise<TOutput> {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Pipeline '${pipelineName}' not found`);
    }

    this.state.pendingOperations.push(`${pipelineName}:execute`);
    this.updateState();

    let success = false;
    let result: unknown;
    try {
      result = await pipeline.execute(input, context);
      this.pipelineResults.set(pipelineName, result);
      success = true;
      return result as TOutput;
    } finally {
      this.state.pendingOperations = this.state.pendingOperations.filter((op) => op !== `${pipelineName}:execute`);
      this.updateState();
      if (success) {
        this.fireDataFlows(pipelineName);
      }
    }
  }

  /**
   * Emit `DataFlow` events for every flow rooted at `pipelineName`, and
   * for those configured with `autoExecute`, run the target pipeline with
   * the (optionally transformed) source result.
   */
  private fireDataFlows(pipelineName: string): void {
    const flows = this.dataFlows.filter((flow) => flow.source === pipelineName);
    const sourceResult = this.pipelineResults.get(pipelineName);

    for (const flow of flows) {
      this.emit(OrchestratorEvent.DataFlow, {
        sourcePipeline: flow.source,
        targetPipeline: flow.target,
        dataType: 'completion',
        timestamp: Date.now(),
      });

      this.logger?.debug(`Data flow triggered: '${flow.source}' -> '${flow.target}'`);

      if (!flow.autoExecute) continue;

      const targetPipeline = this.pipelines.get(flow.target);
      if (!targetPipeline) continue;

      const targetInput = flow.transform ? flow.transform(sourceResult) : sourceResult;

      void this.execute(flow.target, targetInput).catch((error: Error) => {
        this.emit(OrchestratorEvent.Error, {
          error,
          pipeline: flow.target,
          timestamp: Date.now(),
        });
        this.logger?.error(`Auto-executed target pipeline '${flow.target}' failed`, {
          error: error.message,
        });
      });
    }
  }

  /**
   * Pause all running pipelines.
   */
  pauseAll(): void {
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.getState().status === 'RUNNING') {
        pipeline.pause();
      }
    }
    this.logger?.info('All pipelines paused');
  }

  /**
   * Resume all paused pipelines.
   */
  resumeAll(): void {
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.getState().status === 'PAUSED') {
        pipeline.resume();
      }
    }
    this.logger?.info('All pipelines resumed');
  }

  /**
   * Cancel all running pipelines.
   */
  cancelAll(): void {
    for (const pipeline of this.pipelines.values()) {
      const state = pipeline.getState();
      if (state.status === 'RUNNING' || state.status === 'PAUSED') {
        pipeline.cancel();
      }
    }
    this.logger?.info('All pipelines cancelled');
  }

  /**
   * Reset all pipelines.
   */
  resetAll(): void {
    for (const pipeline of this.pipelines.values()) {
      pipeline.reset();
    }
    this.logger?.info('All pipelines reset');
  }

  /**
   * Destroy a specific pipeline.
   */
  async destroyPipeline(name: string): Promise<void> {
    const pipeline = this.pipelines.get(name);
    if (!pipeline) return;

    // Pipelines with destroy method
    if ('destroy' in pipeline && typeof pipeline.destroy === 'function') {
      await (pipeline as { destroy: () => Promise<void> }).destroy();
    }
    this.logger?.debug(`Pipeline '${name}' destroyed`);
  }

  /**
   * Destroy all pipelines and the orchestrator. Listener references stored
   * during `register` are removed first so we never leave handlers attached
   * to a long-lived pipeline emitter.
   */
  async destroy(): Promise<void> {
    this.logger?.info('Destroying orchestrator');

    this.cancelAll();

    for (const name of [...this.pipelines.keys()]) {
      this.removePipelineListeners(name);
    }

    for (const name of this.pipelines.keys()) {
      await this.destroyPipeline(name);
    }

    this.pipelines.clear();
    this.pipelineListeners.clear();
    this.pipelineResults.clear();
    this.dataFlows = [];
    this.state = {
      initialized: false,
      status: 'IDLE',
      pipelines: new Map(),
      canClose: true,
      pendingOperations: [],
      lastUpdated: Date.now(),
    };

    this.logger?.info('Orchestrator destroyed');
  }

  /**
   * Check if all pipelines can be safely closed.
   */
  canClose(): boolean {
    return this.state.canClose;
  }

  /**
   * Get pending operations.
   */
  getPendingOperations(): string[] {
    return [...this.state.pendingOperations];
  }

  /**
   * Subscribe to orchestrator events.
   */
  on<K extends OrchestratorEvent>(event: K, listener: (payload: OrchestratorEventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  /**
   * Unsubscribe from orchestrator events.
   */
  off<K extends OrchestratorEvent>(event: K, listener: (payload: OrchestratorEventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Handle pipeline state change.
   */
  private handlePipelineStateChange(pipelineName: string, state: PipelineState): void {
    this.state.pipelines.set(pipelineName, state);
    this.updateState();
  }

  /**
   * Reserved for completion side-effects on the orchestrator state. Data
   * flow / autoExecute is handled by `fireDataFlows` from `execute()` so
   * the source result is guaranteed to have been captured first.
   */
  private handlePipelineCompleted(_pipelineName: string, _payload: PipelineEventMap[PipelineEvent.Completed]): void {
    // No-op today — kept for symmetry and future hook points.
  }

  /**
   * Handle pipeline error.
   */
  private handlePipelineError(pipelineName: string, payload: PipelineEventMap[PipelineEvent.Error]): void {
    this.emit(OrchestratorEvent.Error, {
      error: payload.error,
      pipeline: pipelineName,
      timestamp: Date.now(),
    });
  }

  /**
   * Update orchestrator state.
   */
  private updateState(): void {
    // Calculate overall status
    const statuses = Array.from(this.state.pipelines.values()).map((s) => s.status);

    let overallStatus: OrchestratorState['status'] = 'IDLE';
    if (statuses.some((s) => s === 'ERROR')) {
      overallStatus = 'ERROR';
    } else if (statuses.some((s) => s === 'RUNNING')) {
      overallStatus = 'RUNNING';
    } else if (statuses.some((s) => s === 'PAUSED')) {
      overallStatus = 'PAUSED';
    }

    // Calculate canClose
    const canClose = this.state.pendingOperations.length === 0 && !statuses.some((s) => s === 'RUNNING');

    this.state = {
      ...this.state,
      status: overallStatus,
      canClose,
      lastUpdated: Date.now(),
    };

    this.emit(OrchestratorEvent.StateChange, this.getState());
  }

  /**
   * Emit an event.
   */
  private emit<K extends OrchestratorEvent>(event: K, payload: OrchestratorEventMap[K]): void {
    this.emitter.emit(event, payload);
  }
}
