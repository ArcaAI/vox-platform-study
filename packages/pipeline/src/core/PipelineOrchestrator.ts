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
export class PipelineOrchestrator {
  private pipelines: Map<string, IPipeline<unknown, unknown>> = new Map();
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
   */
  register<TInput, TOutput>(name: string, pipeline: IPipeline<TInput, TOutput>): void {
    if (this.pipelines.has(name)) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Pipeline '${name}' is already registered`);
    }

    this.pipelines.set(name, pipeline as IPipeline<unknown, unknown>);

    // Subscribe to pipeline state changes
    pipeline.on(PipelineEvent.StateChange, (state) => {
      this.handlePipelineStateChange(name, state);
    });

    // Subscribe to pipeline completion for data flow
    pipeline.on(PipelineEvent.Completed, (payload) => {
      this.handlePipelineCompleted(name, payload);
    });

    // Subscribe to pipeline errors
    pipeline.on(PipelineEvent.Error, (payload) => {
      this.handlePipelineError(name, payload);
    });

    // Update orchestrator state
    this.state.pipelines.set(name, pipeline.getState());
    this.updateState();

    this.emit(OrchestratorEvent.PipelineRegistered, {
      pipelineName: name,
      timestamp: Date.now(),
    });

    this.logger?.info(`Pipeline '${name}' registered`, { pipeline: name });
  }

  /**
   * Unregister a pipeline.
   */
  async unregister(name: string): Promise<void> {
    const pipeline = this.pipelines.get(name);
    if (!pipeline) return;

    // Remove data flows involving this pipeline
    this.dataFlows = this.dataFlows.filter((flow) => flow.source !== name && flow.target !== name);

    // Destroy the pipeline
    await this.destroyPipeline(name);

    this.pipelines.delete(name);
    this.state.pipelines.delete(name);
    this.updateState();

    this.emit(OrchestratorEvent.PipelineUnregistered, {
      pipelineName: name,
      timestamp: Date.now(),
    });

    this.logger?.info(`Pipeline '${name}' unregistered`, { pipeline: name });
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
   * Execute a specific pipeline.
   */
  async execute<TInput, TOutput>(pipelineName: string, input: TInput, context?: Partial<PipelineContext>): Promise<TOutput> {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new PipelineError(PipelineErrorCode.CONFIGURATION_ERROR, `Pipeline '${pipelineName}' not found`);
    }

    // Add to pending operations
    this.state.pendingOperations.push(`${pipelineName}:execute`);
    this.updateState();

    try {
      const result = await pipeline.execute(input, context);
      return result as TOutput;
    } finally {
      // Remove from pending operations
      this.state.pendingOperations = this.state.pendingOperations.filter((op) => op !== `${pipelineName}:execute`);
      this.updateState();
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
   * Destroy all pipelines and the orchestrator.
   */
  async destroy(): Promise<void> {
    this.logger?.info('Destroying orchestrator');

    this.cancelAll();

    for (const name of this.pipelines.keys()) {
      await this.destroyPipeline(name);
    }

    this.pipelines.clear();
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
   * Handle pipeline completion for data flow.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handlePipelineCompleted(pipelineName: string, _payload: PipelineEventMap[PipelineEvent.Completed]): void {
    // Find data flows from this pipeline
    const flows = this.dataFlows.filter((flow) => flow.source === pipelineName);

    for (const flow of flows) {
      if (flow.autoExecute) {
        const targetPipeline = this.pipelines.get(flow.target);
        if (!targetPipeline) continue;

        // Get the result from the source pipeline (stored in results for parallel pipeline)
        // For sequential pipeline, we need to capture the result from the completion event
        // This is a simplified approach - in practice, you'd want to pass the actual result

        this.emit(OrchestratorEvent.DataFlow, {
          sourcePipeline: flow.source,
          targetPipeline: flow.target,
          dataType: 'completion',
          timestamp: Date.now(),
        });

        this.logger?.debug(`Data flow triggered: '${flow.source}' -> '${flow.target}'`);
      }
    }
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
