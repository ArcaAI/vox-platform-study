/**
 * @arcaai/vox - useApiOperation Hook (TASK-039)
 *
 * Generic helper that wraps async API operations with loading tracking,
 * error state, and logger instrumentation. Eliminates the 15-line
 * try/catch/finally boilerplate repeated across all CRUD hooks.
 *
 * Uses a counter-based loading tracker so concurrent operations
 * don't race on a single boolean flag.
 */

import { useState, useCallback, useMemo } from 'react';
import { useAgenticStore } from '../store';
import { withRetry, type RetryOptions } from '../utils/errorUtils';
import type { AgenticClient } from '../core/AgenticClient';
import type { ISDKLogger } from '../core/logger';

export interface ApiOperationState {
  isLoading: boolean;
  error: Error | null;
  clearError: () => void;
}

const DEFAULT_RETRY: RetryOptions = { maxRetries: 2, delayMs: 800 };

/**
 * Low-level hook that provides an SDK-initialized apiClient, a memoized
 * child logger, and counter-based loading / error state.
 *
 * Every CRUD hook composes this instead of duplicating the pattern.
 */
export function useApiOperation(hookName: string) {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child(hookName) as ISDKLogger | undefined, [store.logger, hookName]);

  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const isLoading = pendingCount > 0;

  const clearError = useCallback(() => setError(null), []);

  /**
   * Wraps an async operation with init-check, loading tracking,
   * error capture, logger timing, and automatic retry for retriable errors.
   */
  const execute = useCallback(
    async <T>(
      operationName: string,
      fn: (client: AgenticClient, log: ISDKLogger | undefined) => Promise<T>,
      retry?: RetryOptions | false,
    ): Promise<T> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setPendingCount((c) => c + 1);
      setError(null);
      const timer = logger?.startOperation(operationName);
      try {
        const retryOpts = retry === false ? undefined : { ...DEFAULT_RETRY, ...retry };
        const attempt = () => fn(apiClient, logger);
        const result = retryOpts
          ? await withRetry(attempt, {
              ...retryOpts,
              onRetry: (attemptNum, error) => {
                logger?.warn(`Retrying ${operationName} (attempt ${attemptNum})`, {
                  operation: operationName,
                  component: hookName,
                  attributes: { attempt: attemptNum, error: String(error) },
                });
                retryOpts.onRetry?.(attemptNum, error);
              },
            })
          : await attempt();
        timer?.end(true);
        return result;
      } catch (err) {
        const e = err as Error;
        setError(e);
        timer?.error(e);
        throw err;
      } finally {
        setPendingCount((c) => c - 1);
      }
    },
    [apiClient, logger, hookName],
  );

  return { execute, isLoading, error, clearError, apiClient, logger };
}
