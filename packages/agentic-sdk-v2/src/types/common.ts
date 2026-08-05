/**
 * @arcaai/vox - Common Types
 *
 * Shared types used across the SDK.
 */

// =============================================================================
// Status Types
// =============================================================================

/**
 * Standardized hook status
 */
export interface HookStatus {
  /** Whether an operation is in progress */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
}

/**
 * Extended status for async operations
 */
export interface AsyncStatus extends HookStatus {
  /** Whether processing is in progress */
  isProcessing?: boolean;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * SDK Error with additional context
 */
export class AgenticError extends Error {
  /** Error code for programmatic handling */
  code: AgenticErrorCode;
  /** Original error if wrapped */
  cause?: Error;
  /** Additional context */
  context?: Record<string, unknown>;

  constructor(code: AgenticErrorCode, message: string, options?: { cause?: Error; context?: Record<string, unknown> }) {
    super(message);
    this.name = 'AgenticError';
    this.code = code;
    this.cause = options?.cause;
    this.context = options?.context;
  }
}

/**
 * SDK Error codes
 *
 * `FORBIDDEN` and `RATE_LIMITED` let consumers
 * can distinguish HTTP 403 (lacking permission) and HTTP 429 (throttled) from
 * the generic 4xx `VALIDATION_ERROR` bucket. `RATE_LIMITED` was already used
 * for the client-side rate limiter in `AgenticClient`; adding it here closes
 * a pre-existing type hole.
 */
export type AgenticErrorCode =
  | 'NOT_INITIALIZED'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'AUDIO_ERROR'
  | 'PLUGIN_ERROR'
  | 'MODEL_LOAD_ERROR'
  | 'STORAGE_ERROR'
  | 'CONFIG_NOT_READY'
  // TASK-545: `TranscriptionPipeline.resolveSTTRuntimeProvider()` throws this
  // instead of silently falling back to on-device transcription when local
  // transcription is disabled (`LOCAL_TRANSCRIPTION_ENABLED = false` in
  // `core/constants.ts`) and no backend transport is configured.
  | 'LOCAL_TRANSCRIPTION_DISABLED'
  // TASK-612: `useArcaAudio.startAudio` / `addSource` throw this instead of
  // silently streaming zeros when a caller-injected `MediaStream`
  // (`AudioStartOptions.sourceStreams`, or `addSource({ stream })`) has no
  // audio track, or no track with `readyState === 'live'`.
  | 'SOURCE_STREAM_NOT_LIVE'
  // TASK-612 Lane C (RC-2, OD-2a): `useArcaAudio.startAudio`'s CALL-TIME
  // idempotence guard throws this instead of silently dropping
  // capture-shaped options (`deviceId`, `sourceStreams`, `dynamicSources`,
  // ...) when a call lands while capture is already active — e.g. the
  // compat layer's two coordinating hooks racing to start the mic. A call
  // carrying only options the running session already applies (language,
  // pipelineId) is unaffected — that stays a silent, designed no-op.
  | 'CAPTURE_OPTIONS_DROPPED'
  | 'UNKNOWN_ERROR';

// =============================================================================
// Event Types
// =============================================================================

/**
 * SDK event types
 */
export type AgenticEventType =
  | 'initialized'
  | 'error'
  | 'consultation:created'
  | 'consultation:ended'
  | 'audio:started'
  | 'audio:stopped'
  | 'transcription:interim'
  | 'transcription:final'
  | 'context:added'
  | 'summary:generated'
  | 'preferences:updated';

/**
 * Event handler type
 */
export type AgenticEventHandler<T = unknown> = (data: T) => void;

// =============================================================================
// Pagination Types
// =============================================================================

/** Allowed page-size values accepted by the API */
export type AllowedPageSize = 10 | 20 | 50;

/** Ordered options exposed to UI page-size selectors */
export const PAGE_SIZE_OPTIONS: readonly AllowedPageSize[] = [10, 20, 50] as const;

/** Default number of items per page when no explicit limit is provided */
export const DEFAULT_PAGE_SIZE: AllowedPageSize = 10;

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  /** Data items */
  data: T[];
  /** Total count */
  total: number;
  /** Current page */
  page: number;
  /** Items per page */
  limit: number;
  /** Total pages */
  totalPages: number;
  /** Has more pages */
  hasMore: boolean;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  /** Page number (1-based) */
  page?: number;
  /** Items per page (10 | 20 | 50, defaults to 10) */
  limit?: AllowedPageSize | number;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Make all properties optional recursively
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Extract function parameters as object
 */
export type FunctionParams<T extends (...args: unknown[]) => unknown> = T extends (...args: infer P) => unknown ? P : never;
