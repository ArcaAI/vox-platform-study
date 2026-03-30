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
 */
export type AgenticErrorCode =
  | 'NOT_INITIALIZED'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'AUDIO_ERROR'
  | 'PLUGIN_ERROR'
  | 'MODEL_LOAD_ERROR'
  | 'STORAGE_ERROR'
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
