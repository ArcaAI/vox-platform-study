/**
 * @arcaai/vox - Error Utilities
 */

import { AgenticError, type AgenticErrorCode } from '../types';

/**
 * Check if an error is an AgenticError
 */
export function isAgenticError(error: unknown): error is AgenticError {
  return error instanceof AgenticError;
}

/**
 * Get error code from an error
 */
export function getErrorCode(error: unknown): AgenticErrorCode {
  if (isAgenticError(error)) {
    return error.code;
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Get error message from an error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
}

/**
 * Wrap an error as AgenticError
 */
export function wrapError(error: unknown, code: AgenticErrorCode = 'UNKNOWN_ERROR', message?: string): AgenticError {
  if (isAgenticError(error)) {
    return error;
  }

  const cause = error instanceof Error ? error : undefined;
  const msg = message ?? getErrorMessage(error);

  return new AgenticError(code, msg, { cause });
}

/**
 * Check if error is a network error
 */
export function isNetworkError(error: unknown): boolean {
  if (isAgenticError(error)) {
    return error.code === 'NETWORK_ERROR';
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

/**
 * Check if error is an authentication error
 */
export function isAuthError(error: unknown): boolean {
  if (isAgenticError(error)) {
    return error.code === 'AUTHENTICATION_ERROR';
  }
  return false;
}

/**
 * Check if error is retriable
 */
export function isRetriableError(error: unknown): boolean {
  if (isAgenticError(error)) {
    return error.code === 'NETWORK_ERROR' || error.code === 'API_ERROR';
  }
  return isNetworkError(error);
}

/**
 * Classify an HTTP response status into an `AgenticErrorCode`.
 *
 * Centralises the mapping shared by `AgenticClient`'s `request`,
 * `postFormData`, and `uploadFormData` call sites.
 *
 * Mapping:
 * - 401             → `AUTHENTICATION_ERROR`
 * - 403             → `FORBIDDEN`
 * - 404             → `NOT_FOUND`
 * - 429             → `RATE_LIMITED`
 * - other 4xx       → `VALIDATION_ERROR`
 * - 5xx and others  → `API_ERROR`
 */
export function classifyHttpError(status: number): AgenticErrorCode {
  if (status === 401) return 'AUTHENTICATION_ERROR';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'API_ERROR';
}

/**
 * Map an SMR (`apps/text`) error payload to an
 * `AgenticErrorCode`. The backend SMR proxy returns errors shaped as
 * `{ detail?, message?, error_code? }`; this helper picks the
 * `error_code` first (when present) and falls back to HTTP-status
 * classification. We intentionally do NOT throw if the inputs are
 * missing — `UNKNOWN_ERROR` is a safe default.
 *
 * SMR `error_code` taxonomy (`apps/text/app/errors.py`):
 *   - `model_not_found`         → `NOT_FOUND`
 *   - `provider_unavailable`    → `API_ERROR`
 *   - `provider_timeout`        → `API_ERROR`
 *   - `context_too_long`        → `VALIDATION_ERROR`
 *   - `invalid_request`         → `VALIDATION_ERROR`
 *   - `auth_required`           → `AUTHENTICATION_ERROR`
 *   - `forbidden`               → `FORBIDDEN`
 *   - `rate_limited`            → `RATE_LIMITED`
 *   - `task_cancelled`          → `API_ERROR` (caller should also inspect cancellation locally)
 *   - everything else           → fall through to HTTP-status classification.
 */
export function classifySmrError(
  payload: { error_code?: string; detail?: string; message?: string } | null | undefined,
  status?: number,
): AgenticErrorCode {
  const code = payload?.error_code?.toLowerCase();
  switch (code) {
    case 'model_not_found':
      return 'NOT_FOUND';
    case 'provider_unavailable':
    case 'provider_timeout':
    case 'task_cancelled':
      return 'API_ERROR';
    case 'context_too_long':
    case 'invalid_request':
    case 'validation_error':
      return 'VALIDATION_ERROR';
    case 'auth_required':
    case 'unauthorized':
      return 'AUTHENTICATION_ERROR';
    case 'forbidden':
      return 'FORBIDDEN';
    case 'rate_limited':
    case 'too_many_requests':
      return 'RATE_LIMITED';
    default:
      return typeof status === 'number' ? classifyHttpError(status) : 'API_ERROR';
  }
}

// =============================================================================
// Retry Utility (extracted from useArca — HOOK-07)
// =============================================================================

/**
 * Options for retry wrapper
 */
export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Delay between retries in ms — first retry uses this value, subsequent retries use exponential backoff (default: 1000) */
  delayMs?: number;
  /** Optional callback invoked before each retry attempt */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Execute an async function with automatic retries for retriable errors.
 *
 * Uses exponential backoff: delay * 2^attempt.
 * Non-retriable errors are thrown immediately without retry.
 *
 * @example
 * ```typescript
 * const result = await withRetry(() => apiClient.get('/data'), { maxRetries: 3 });
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const delayMs = options?.delayMs ?? 1000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetriableError(error)) {
        throw error;
      }

      if (attempt < maxRetries) {
        const backoffDelay = delayMs * Math.pow(2, attempt);
        options?.onRetry?.(attempt + 1, error);

        if (backoffDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
    }
  }

  throw lastError;
}
