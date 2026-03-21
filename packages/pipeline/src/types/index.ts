/**
 * @arcaai/pipeline - Type Definitions
 *
 * Core types for pipeline processing infrastructure.
 */

// =============================================================================
// Pipeline State
// =============================================================================

/**
 * Pipeline execution status.
 */
export type PipelineStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'COMPLETED';

/**
 * Current state of a pipeline.
 */
export interface PipelineState {
  /** Current execution status */
  status: PipelineStatus;
  /** Name of the currently executing stage (if running) */
  currentStage?: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Error if status is ERROR */
  error?: Error;
  /** Timestamp of last state change */
  lastUpdated: number;
  /** Number of completed stages */
  completedStages: number;
  /** Total number of stages */
  totalStages: number;
}

/**
 * Default pipeline state.
 */
export const DEFAULT_PIPELINE_STATE: PipelineState = {
  status: 'IDLE',
  progress: 0,
  lastUpdated: Date.now(),
  completedStages: 0,
  totalStages: 0,
};

// =============================================================================
// Pipeline Context
// =============================================================================

/**
 * Context passed through pipeline stages.
 * Contains shared data and metadata for the pipeline execution.
 */
export interface PipelineContext {
  /** Unique identifier for this pipeline run */
  runId: string;
  /** Pipeline name */
  pipelineName: string;
  /** Timestamp when pipeline started */
  startTime: number;
  /** Custom metadata that can be passed through stages */
  metadata: Record<string, unknown>;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Logger for stage execution */
  logger?: PipelineLogger;
}

/**
 * Minimal logger interface for pipeline logging.
 */
export interface PipelineLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// =============================================================================
// Pipeline Stage
// =============================================================================

/**
 * Result of a stage execution.
 */
export interface StageResult<TOutput> {
  /** Output data from the stage */
  output: TOutput;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether the stage was skipped */
  skipped: boolean;
  /** Optional metadata from the stage */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for a pipeline stage.
 */
export interface StageConfig {
  /** Whether the stage is enabled */
  enabled: boolean;
  /** Priority for execution order (lower = earlier) */
  priority: number;
  /** Timeout in milliseconds (optional) */
  timeout?: number;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Custom configuration specific to the stage */
  options?: Record<string, unknown>;
}

/**
 * Retry configuration for a stage.
 */
export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;
  /** Delay between retries in milliseconds */
  retryDelayMs: number;
  /** Whether to use exponential backoff */
  exponentialBackoff?: boolean;
}

/**
 * Default stage configuration.
 */
export const DEFAULT_STAGE_CONFIG: StageConfig = {
  enabled: true,
  priority: 0,
};

// =============================================================================
// Pipeline Events
// =============================================================================

/**
 * Events emitted by pipelines.
 */
export enum PipelineEvent {
  /** Pipeline started */
  Started = 'started',
  /** Pipeline completed successfully */
  Completed = 'completed',
  /** Pipeline encountered an error */
  Error = 'error',
  /** Pipeline was paused */
  Paused = 'paused',
  /** Pipeline was resumed */
  Resumed = 'resumed',
  /** Pipeline was cancelled */
  Cancelled = 'cancelled',
  /** Pipeline state changed */
  StateChange = 'stateChange',
  /** Stage started execution */
  StageStarted = 'stageStarted',
  /** Stage completed */
  StageCompleted = 'stageCompleted',
  /** Stage failed */
  StageFailed = 'stageFailed',
  /** Stage was skipped */
  StageSkipped = 'stageSkipped',
  /** Data output from pipeline */
  Data = 'data',
}

/**
 * Event payload for stage events.
 */
export interface StageEventPayload {
  /** Stage name */
  stageName: string;
  /** Execution duration (for completed/failed) */
  durationMs?: number;
  /** Error (for failed) */
  error?: Error;
  /** Result (for completed) */
  result?: unknown;
}

/**
 * Event map for pipeline events.
 */
export interface PipelineEventMap {
  [PipelineEvent.Started]: { runId: string; timestamp: number };
  [PipelineEvent.Completed]: { runId: string; durationMs: number; timestamp: number };
  [PipelineEvent.Error]: { runId: string; error: Error; stage?: string; timestamp: number };
  [PipelineEvent.Paused]: { runId: string; timestamp: number };
  [PipelineEvent.Resumed]: { runId: string; timestamp: number };
  [PipelineEvent.Cancelled]: { runId: string; timestamp: number };
  [PipelineEvent.StateChange]: PipelineState;
  [PipelineEvent.StageStarted]: StageEventPayload;
  [PipelineEvent.StageCompleted]: StageEventPayload;
  [PipelineEvent.StageFailed]: StageEventPayload;
  [PipelineEvent.StageSkipped]: StageEventPayload;
  [PipelineEvent.Data]: { type: string; data: unknown; timestamp: number };
}

// =============================================================================
// Pipeline Interface
// =============================================================================

/**
 * Base interface for all pipelines.
 */
export interface IPipeline<TInput, TOutput> {
  /** Pipeline name */
  readonly name: string;
  /** Current pipeline state */
  getState(): PipelineState;
  /** Execute the pipeline */
  execute(input: TInput, context?: Partial<PipelineContext>): Promise<TOutput>;
  /** Pause the pipeline */
  pause(): void;
  /** Resume the pipeline */
  resume(): void;
  /** Cancel the pipeline */
  cancel(): void;
  /** Reset the pipeline to initial state */
  reset(): void;
  /** Subscribe to pipeline events */
  on<K extends PipelineEvent>(event: K, listener: (payload: PipelineEventMap[K]) => void): void;
  /** Unsubscribe from pipeline events */
  off<K extends PipelineEvent>(event: K, listener: (payload: PipelineEventMap[K]) => void): void;
}

// =============================================================================
// Pipeline Stage Interface
// =============================================================================

/**
 * Interface that all pipeline stages must implement.
 */
export interface IPipelineStage<TInput, TOutput> {
  /** Stage name */
  readonly name: string;
  /** Stage configuration */
  config: StageConfig;
  /** Execute the stage */
  execute(input: TInput, context: PipelineContext): Promise<TOutput>;
  /** Check if the stage can execute (optional validation) */
  canExecute?(input: TInput, context: PipelineContext): boolean;
  /** Initialize the stage (optional) */
  init?(): Promise<void>;
  /** Destroy the stage and release resources (optional) */
  destroy?(): Promise<void>;
  /** Called when stage is enabled */
  onEnable?(): Promise<void>;
  /** Called when stage is disabled */
  onDisable?(): Promise<void>;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for pipeline errors.
 */
export enum PipelineErrorCode {
  STAGE_FAILED = 'STAGE_FAILED',
  TIMEOUT = 'TIMEOUT',
  CANCELLED = 'CANCELLED',
  INVALID_INPUT = 'INVALID_INPUT',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  ALREADY_RUNNING = 'ALREADY_RUNNING',
}

/**
 * Pipeline-specific error class.
 */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly stage?: string;
  readonly cause?: Error;

  constructor(
    code: PipelineErrorCode,
    message: string,
    options?: { stage?: string; cause?: Error }
  ) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.stage = options?.stage;
    this.cause = options?.cause;
  }
}
