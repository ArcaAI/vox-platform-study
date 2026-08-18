/**
 * @arcaai/vox - Error Utilities Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isAgenticError,
  getErrorCode,
  getErrorMessage,
  wrapError,
  isNetworkError,
  isAuthError,
  isRetriableError,
  withRetry,
  classifyHttpError,
  classifyTextError,
} from '../errorUtils';
import type { RetryOptions } from '../errorUtils';
import { AgenticError } from '../../types';

describe('errorUtils', () => {
  describe('isAgenticError', () => {
    it('should return true for AgenticError instances', () => {
      const error = new AgenticError('NETWORK_ERROR', 'Network failed');
      expect(isAgenticError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Regular error');
      expect(isAgenticError(error)).toBe(false);
    });

    it('should return false for non-error values', () => {
      expect(isAgenticError('string error')).toBe(false);
      expect(isAgenticError(null)).toBe(false);
      expect(isAgenticError(undefined)).toBe(false);
      expect(isAgenticError(123)).toBe(false);
    });
  });

  describe('getErrorCode', () => {
    it('should return code from AgenticError', () => {
      const error = new AgenticError('API_ERROR', 'API failed');
      expect(getErrorCode(error)).toBe('API_ERROR');
    });

    it('should return UNKNOWN_ERROR for regular Error', () => {
      const error = new Error('Regular error');
      expect(getErrorCode(error)).toBe('UNKNOWN_ERROR');
    });

    it('should return UNKNOWN_ERROR for non-error values', () => {
      expect(getErrorCode('string')).toBe('UNKNOWN_ERROR');
      expect(getErrorCode(null)).toBe('UNKNOWN_ERROR');
    });
  });

  describe('getErrorMessage', () => {
    it('should return message from Error', () => {
      const error = new Error('Test message');
      expect(getErrorMessage(error)).toBe('Test message');
    });

    it('should return message from AgenticError', () => {
      const error = new AgenticError('API_ERROR', 'API failed');
      expect(getErrorMessage(error)).toBe('API failed');
    });

    it('should return string as-is', () => {
      expect(getErrorMessage('String error message')).toBe('String error message');
    });

    it('should return default message for unknown types', () => {
      expect(getErrorMessage(null)).toBe('An unknown error occurred');
      expect(getErrorMessage(undefined)).toBe('An unknown error occurred');
      expect(getErrorMessage(123)).toBe('An unknown error occurred');
    });
  });

  describe('wrapError', () => {
    it('should return AgenticError unchanged', () => {
      const original = new AgenticError('API_ERROR', 'API failed');
      const wrapped = wrapError(original);
      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error as AgenticError', () => {
      const original = new Error('Regular error');
      const wrapped = wrapError(original);

      expect(wrapped).toBeInstanceOf(AgenticError);
      expect(wrapped.code).toBe('UNKNOWN_ERROR');
      expect(wrapped.message).toBe('Regular error');
      expect(wrapped.cause).toBe(original);
    });

    it('should use provided code', () => {
      const original = new Error('Network failed');
      const wrapped = wrapError(original, 'NETWORK_ERROR');

      expect(wrapped.code).toBe('NETWORK_ERROR');
    });

    it('should use provided message', () => {
      const original = new Error('Original message');
      const wrapped = wrapError(original, 'API_ERROR', 'Custom message');

      expect(wrapped.message).toBe('Custom message');
    });

    it('should handle string errors', () => {
      const wrapped = wrapError('String error');

      expect(wrapped).toBeInstanceOf(AgenticError);
      expect(wrapped.code).toBe('UNKNOWN_ERROR');
      expect(wrapped.message).toBe('String error');
      expect(wrapped.cause).toBeUndefined();
    });

    it('should handle null/undefined', () => {
      const wrapped = wrapError(null);

      expect(wrapped).toBeInstanceOf(AgenticError);
      expect(wrapped.message).toBe('An unknown error occurred');
    });
  });

  describe('isNetworkError', () => {
    it('should return true for AgenticError with NETWORK_ERROR code', () => {
      const error = new AgenticError('NETWORK_ERROR', 'Network failed');
      expect(isNetworkError(error)).toBe(true);
    });

    it('should return false for AgenticError with other code', () => {
      const error = new AgenticError('API_ERROR', 'API failed');
      expect(isNetworkError(error)).toBe(false);
    });

    it('should return true for TypeError', () => {
      const error = new TypeError('Failed to fetch');
      expect(isNetworkError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Regular error');
      expect(isNetworkError(error)).toBe(false);
    });
  });

  describe('isAuthError', () => {
    it('should return true for AUTHENTICATION_ERROR', () => {
      const error = new AgenticError('AUTHENTICATION_ERROR', 'Unauthorized');
      expect(isAuthError(error)).toBe(true);
    });

    it('should return false for other error codes', () => {
      const error = new AgenticError('API_ERROR', 'API failed');
      expect(isAuthError(error)).toBe(false);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Auth failed');
      expect(isAuthError(error)).toBe(false);
    });
  });

  describe('isRetriableError', () => {
    it('should return true for NETWORK_ERROR', () => {
      const error = new AgenticError('NETWORK_ERROR', 'Network failed');
      expect(isRetriableError(error)).toBe(true);
    });

    it('should return true for API_ERROR', () => {
      const error = new AgenticError('API_ERROR', 'API failed');
      expect(isRetriableError(error)).toBe(true);
    });

    it('should return false for AUTHENTICATION_ERROR', () => {
      const error = new AgenticError('AUTHENTICATION_ERROR', 'Unauthorized');
      expect(isRetriableError(error)).toBe(false);
    });

    it('should return true for TypeError (network error)', () => {
      const error = new TypeError('Failed to fetch');
      expect(isRetriableError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Regular error');
      expect(isRetriableError(error)).toBe(false);
    });
  });

  // ===========================================================================
  // withRetry (HOOK-07 — extracted from useArca)
  // ===========================================================================

  describe('withRetry', () => {
    // --- Happy path ---

    it('should return the result on first success (no retries needed)', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(fn, { delayMs: 0 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should return the result after retrying a retriable error', async () => {
      const networkErr = new AgenticError('NETWORK_ERROR', 'Network failed');
      const fn = vi.fn().mockRejectedValueOnce(networkErr).mockResolvedValueOnce('recovered');

      const result = await withRetry(fn, { maxRetries: 3, delayMs: 0 });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // --- Non-retriable errors ---

    it('should throw immediately for non-retriable errors (no retry)', async () => {
      const authErr = new AgenticError('AUTHENTICATION_ERROR', 'Unauthorized');
      const fn = vi.fn().mockRejectedValue(authErr);

      await expect(withRetry(fn, { maxRetries: 3, delayMs: 0 })).rejects.toThrow('Unauthorized');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately for VALIDATION_ERROR (non-retriable)', async () => {
      const validationErr = new AgenticError('VALIDATION_ERROR', 'Bad input');
      const fn = vi.fn().mockRejectedValue(validationErr);

      await expect(withRetry(fn, { maxRetries: 5, delayMs: 0 })).rejects.toThrow('Bad input');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately for regular Error (non-retriable)', async () => {
      const regularErr = new Error('Not an agentic error');
      const fn = vi.fn().mockRejectedValue(regularErr);

      await expect(withRetry(fn, { maxRetries: 3, delayMs: 0 })).rejects.toThrow('Not an agentic error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    // --- Max retries exhausted ---

    it('should throw after exhausting all retries', async () => {
      const apiErr = new AgenticError('API_ERROR', 'Server error');
      const fn = vi.fn().mockRejectedValue(apiErr);

      await expect(withRetry(fn, { maxRetries: 2, delayMs: 0 })).rejects.toThrow('Server error');
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should throw the last error after max retries', async () => {
      const err1 = new AgenticError('NETWORK_ERROR', 'First failure');
      const err2 = new AgenticError('NETWORK_ERROR', 'Second failure');
      const err3 = new AgenticError('NETWORK_ERROR', 'Third failure');
      const fn = vi.fn().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2).mockRejectedValueOnce(err3);

      await expect(withRetry(fn, { maxRetries: 2, delayMs: 0 })).rejects.toThrow('Third failure');
    });

    // --- Exponential backoff ---

    it('should use exponential backoff: delay * 2^attempt', async () => {
      const delays: number[] = [];
      const origSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler, ms?: number) => {
        delays.push(ms ?? 0);
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const apiErr = new AgenticError('API_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValue(apiErr);

      try {
        await withRetry(fn, { maxRetries: 3, delayMs: 1000 });
      } catch {
        // expected
      }

      // backoff delays: 1000*2^0=1000, 1000*2^1=2000, 1000*2^2=4000
      expect(delays).toEqual([1000, 2000, 4000]);

      vi.restoreAllMocks();
    });

    // --- onRetry callback ---

    it('should call onRetry before each retry attempt', async () => {
      const networkErr = new AgenticError('NETWORK_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValueOnce(networkErr).mockRejectedValueOnce(networkErr).mockResolvedValueOnce('ok');

      const onRetry = vi.fn();
      const result = await withRetry(fn, { maxRetries: 3, delayMs: 0, onRetry });

      expect(result).toBe('ok');
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, networkErr);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, networkErr);
    });

    it('should not call onRetry when succeeding on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const onRetry = vi.fn();

      await withRetry(fn, { delayMs: 0, onRetry });
      expect(onRetry).not.toHaveBeenCalled();
    });

    it('should not call onRetry for non-retriable errors', async () => {
      const authErr = new AgenticError('AUTHENTICATION_ERROR', 'Denied');
      const fn = vi.fn().mockRejectedValue(authErr);
      const onRetry = vi.fn();

      await expect(withRetry(fn, { delayMs: 0, onRetry })).rejects.toThrow('Denied');
      expect(onRetry).not.toHaveBeenCalled();
    });

    // --- Default values ---

    it('should default to 3 retries when maxRetries not provided', async () => {
      const apiErr = new AgenticError('API_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValue(apiErr);

      await expect(withRetry(fn, { delayMs: 0 })).rejects.toThrow('Fail');
      expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('should work with maxRetries: 0 (no retries)', async () => {
      const apiErr = new AgenticError('API_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValue(apiErr);

      await expect(withRetry(fn, { maxRetries: 0, delayMs: 0 })).rejects.toThrow('Fail');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    // --- Edge: delayMs: 0 ---

    it('should retry immediately when delayMs is 0', async () => {
      const networkErr = new AgenticError('NETWORK_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValueOnce(networkErr).mockResolvedValueOnce('ok');

      const result = await withRetry(fn, { maxRetries: 1, delayMs: 0 });

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // --- Edge: TypeError (retriable via isNetworkError) ---

    it('should retry TypeError (treated as network error)', async () => {
      const typeErr = new TypeError('Failed to fetch');
      const fn = vi.fn().mockRejectedValueOnce(typeErr).mockResolvedValueOnce('recovered');

      const result = await withRetry(fn, { maxRetries: 2, delayMs: 0 });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // --- Edge: fn never called with undefined options ---

    it('should accept undefined options', async () => {
      const fn = vi.fn().mockResolvedValue(42);

      const result = await withRetry(fn, undefined);
      expect(result).toBe(42);
    });

    // --- Edge: fn rejects with non-Error value ---

    it('should not retry when fn rejects with a string (non-retriable)', async () => {
      const fn = vi.fn().mockRejectedValue('string rejection');

      await expect(withRetry(fn, { maxRetries: 3, delayMs: 0 })).rejects.toBe('string rejection');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry when fn rejects with null', async () => {
      const fn = vi.fn().mockRejectedValue(null);

      await expect(withRetry(fn, { maxRetries: 3, delayMs: 0 })).rejects.toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    // --- Edge: interleaved error types during retries ---

    it('should stop retrying if a retriable error is followed by a non-retriable one', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new AgenticError('API_ERROR', 'Retriable'))
        .mockRejectedValueOnce(new AgenticError('AUTHENTICATION_ERROR', 'Non-retriable'));

      await expect(withRetry(fn, { maxRetries: 5, delayMs: 0 })).rejects.toThrow('Non-retriable');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // --- Edge: onRetry callback throws ---

    it('should propagate error when onRetry callback throws (fail-fast)', async () => {
      const networkErr = new AgenticError('NETWORK_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValueOnce(networkErr).mockResolvedValueOnce('recovered');

      const badOnRetry = vi.fn(() => {
        throw new Error('onRetry bug');
      });

      // onRetry is called before the delay — if it throws, the error propagates
      // and the retry loop is aborted. This is intentional: callers should not
      // pass buggy callbacks.
      await expect(withRetry(fn, { maxRetries: 2, delayMs: 0, onRetry: badOnRetry })).rejects.toThrow('onRetry bug');

      // fn was called once (initial attempt), then onRetry threw before retry
      expect(fn).toHaveBeenCalledTimes(1);
      expect(badOnRetry).toHaveBeenCalledTimes(1);
    });

    // --- Edge: fn succeeds on exact last retry ---

    it('should return result when fn succeeds on the last possible attempt', async () => {
      const apiErr = new AgenticError('API_ERROR', 'Fail');
      const fn = vi.fn().mockRejectedValueOnce(apiErr).mockRejectedValueOnce(apiErr).mockResolvedValueOnce('last-attempt-success');

      const result = await withRetry(fn, { maxRetries: 2, delayMs: 0 });

      expect(result).toBe('last-attempt-success');
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    // --- Edge: large maxRetries value ---

    it('should handle large maxRetries without stack overflow', async () => {
      const networkErr = new AgenticError('NETWORK_ERROR', 'Fail');
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 50) throw networkErr;
        return 'done';
      });

      const result = await withRetry(fn, { maxRetries: 100, delayMs: 0 });
      expect(result).toBe('done');
      expect(fn).toHaveBeenCalledTimes(50);
    });

    // --- RetryOptions type ---

    it('should export RetryOptions type (compile check)', () => {
      const opts: RetryOptions = {
        maxRetries: 5,
        delayMs: 500,
        onRetry: () => {},
      };
      expect(opts.maxRetries).toBe(5);
    });
  });

  // ===========================================================================
  // classifyHttpError
  // ===========================================================================

  describe('classifyHttpError', () => {
    it('should map 401 → AUTHENTICATION_ERROR', () => {
      expect(classifyHttpError(401)).toBe('AUTHENTICATION_ERROR');
    });
    it('should map 403 → FORBIDDEN', () => {
      expect(classifyHttpError(403)).toBe('FORBIDDEN');
    });
    it('should map 404 → NOT_FOUND', () => {
      expect(classifyHttpError(404)).toBe('NOT_FOUND');
    });
    it('should map 429 → RATE_LIMITED', () => {
      expect(classifyHttpError(429)).toBe('RATE_LIMITED');
    });
    it('should map other 4xx (400, 422) → VALIDATION_ERROR', () => {
      expect(classifyHttpError(400)).toBe('VALIDATION_ERROR');
      expect(classifyHttpError(422)).toBe('VALIDATION_ERROR');
    });
    it('should map 5xx (500, 503) → API_ERROR', () => {
      expect(classifyHttpError(500)).toBe('API_ERROR');
      expect(classifyHttpError(503)).toBe('API_ERROR');
    });
    it('should map non-error status (200, 0) → API_ERROR (defensive)', () => {
      expect(classifyHttpError(200)).toBe('API_ERROR');
      expect(classifyHttpError(0)).toBe('API_ERROR');
    });
  });

  // Map text-service errors → AgenticErrorCode.
  describe('classifyTextError', () => {
    it('maps `model_not_found` → NOT_FOUND regardless of status', () => {
      expect(classifyTextError({ error_code: 'model_not_found' }, 500)).toBe('NOT_FOUND');
    });

    it('maps `provider_unavailable` / `provider_timeout` → API_ERROR', () => {
      expect(classifyTextError({ error_code: 'provider_unavailable' })).toBe('API_ERROR');
      expect(classifyTextError({ error_code: 'provider_timeout' })).toBe('API_ERROR');
    });

    it('maps `context_too_long` / `invalid_request` → VALIDATION_ERROR', () => {
      expect(classifyTextError({ error_code: 'context_too_long' })).toBe('VALIDATION_ERROR');
      expect(classifyTextError({ error_code: 'invalid_request' })).toBe('VALIDATION_ERROR');
      expect(classifyTextError({ error_code: 'validation_error' })).toBe('VALIDATION_ERROR');
    });

    it('maps `auth_required` / `unauthorized` → AUTHENTICATION_ERROR', () => {
      expect(classifyTextError({ error_code: 'auth_required' })).toBe('AUTHENTICATION_ERROR');
      expect(classifyTextError({ error_code: 'unauthorized' })).toBe('AUTHENTICATION_ERROR');
    });

    it('maps `forbidden` → FORBIDDEN', () => {
      expect(classifyTextError({ error_code: 'forbidden' })).toBe('FORBIDDEN');
    });

    it('maps `rate_limited` / `too_many_requests` → RATE_LIMITED', () => {
      expect(classifyTextError({ error_code: 'rate_limited' })).toBe('RATE_LIMITED');
      expect(classifyTextError({ error_code: 'too_many_requests' })).toBe('RATE_LIMITED');
    });

    it('maps `task_cancelled` → API_ERROR (caller still inspects local AbortSignal)', () => {
      expect(classifyTextError({ error_code: 'task_cancelled' })).toBe('API_ERROR');
    });

    it('falls back to HTTP-status classification when error_code is missing', () => {
      expect(classifyTextError({ detail: 'oops' }, 404)).toBe('NOT_FOUND');
      expect(classifyTextError({ detail: 'oops' }, 429)).toBe('RATE_LIMITED');
      expect(classifyTextError({ detail: 'oops' }, 503)).toBe('API_ERROR');
    });

    it('handles null / undefined payload safely', () => {
      expect(classifyTextError(undefined)).toBe('API_ERROR');
      expect(classifyTextError(null)).toBe('API_ERROR');
      expect(classifyTextError(undefined, 401)).toBe('AUTHENTICATION_ERROR');
    });

    it('treats error_code case-insensitively', () => {
      expect(classifyTextError({ error_code: 'MODEL_NOT_FOUND' })).toBe('NOT_FOUND');
      expect(classifyTextError({ error_code: 'Forbidden' })).toBe('FORBIDDEN');
    });

  });
});
