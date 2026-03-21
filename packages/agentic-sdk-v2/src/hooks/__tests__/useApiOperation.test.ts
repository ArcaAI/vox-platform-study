/**
 * useApiOperation Hook Tests (TASK-039)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useApiOperation } from '../useApiOperation';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useApiOperation', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  const mockGet = vi.fn();
  const mockPost = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPost.mockReset();

    (useAgenticStore as any).mockReturnValue({
      apiClient: { get: mockGet, post: mockPost },
      logger: mockLogger,
    });
  });

  afterEach(() => { vi.clearAllMocks(); });

  describe('initial state', () => {
    it('should return isLoading false and error null', () => {
      const { result } = renderHook(() => useApiOperation('testHook'));
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('execute', () => {
    it('should call the operation function with apiClient', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));
      const fn = vi.fn().mockResolvedValue('result');

      let value: unknown;
      await act(async () => {
        value = await result.current.execute('op', fn);
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0]).toHaveProperty('get');
      expect(value).toBe('result');
    });

    it('should set isLoading false after execution completes', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));

      await act(async () => {
        await result.current.execute('op', vi.fn().mockResolvedValue('done'));
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('should set error on failure and re-throw', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));
      const err = new Error('API failed');
      const fn = vi.fn().mockRejectedValue(err);

      await act(async () => {
        try { await result.current.execute('op', fn); } catch { /* expected */ }
      });

      expect(result.current.error).toBe(err);
      expect(result.current.isLoading).toBe(false);
    });

    it('should throw when apiClient is null', async () => {
      (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
      const { result } = renderHook(() => useApiOperation('testHook'));

      await expect(
        act(async () => { await result.current.execute('op', vi.fn()); }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('should clear previous error on new successful call', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));

      await act(async () => {
        try { await result.current.execute('op', vi.fn().mockRejectedValue(new Error('fail'))); } catch { /* expected */ }
      });
      expect(result.current.error).not.toBeNull();

      await act(async () => {
        await result.current.execute('op', vi.fn().mockResolvedValue('ok'));
      });
      expect(result.current.error).toBeNull();
    });

    it('should start and end logger timer on success', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));
      await act(async () => {
        await result.current.execute('myOp', vi.fn().mockResolvedValue('ok'));
      });

      expect(mockLogger.startOperation).toHaveBeenCalledWith('myOp');
      const timer = mockLogger.startOperation.mock.results[0].value;
      expect(timer.end).toHaveBeenCalledWith(true);
    });

    it('should call timer.error on failure', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));
      const err = new Error('boom');

      await act(async () => {
        try { await result.current.execute('myOp', vi.fn().mockRejectedValue(err)); } catch { /* expected */ }
      });

      const timer = mockLogger.startOperation.mock.results[0].value;
      expect(timer.error).toHaveBeenCalledWith(err);
    });

    it('should work when logger is null', async () => {
      (useAgenticStore as any).mockReturnValue({
        apiClient: { get: mockGet },
        logger: null,
      });
      const { result } = renderHook(() => useApiOperation('testHook'));

      let value: unknown;
      await act(async () => {
        value = await result.current.execute('op', vi.fn().mockResolvedValue(42));
      });
      expect(value).toBe(42);
    });
  });

  describe('concurrent operations', () => {
    it('should keep isLoading true until all concurrent operations finish', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));

      let resolve1!: (v: string) => void;
      let resolve2!: (v: string) => void;
      const p1 = new Promise<string>((r) => { resolve1 = r; });
      const p2 = new Promise<string>((r) => { resolve2 = r; });

      let exec1: Promise<unknown>;
      let exec2: Promise<unknown>;

      await act(async () => {
        exec1 = result.current.execute('op1', () => p1);
        exec2 = result.current.execute('op2', () => p2);
      });

      expect(result.current.isLoading).toBe(true);

      await act(async () => { resolve1('done1'); await exec1!; });
      expect(result.current.isLoading).toBe(true);

      await act(async () => { resolve2('done2'); await exec2!; });
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('clearError', () => {
    it('should reset error to null', async () => {
      const { result } = renderHook(() => useApiOperation('testHook'));

      await act(async () => {
        try { await result.current.execute('op', vi.fn().mockRejectedValue(new Error('err'))); } catch { /* expected */ }
      });
      expect(result.current.error).not.toBeNull();

      act(() => { result.current.clearError(); });
      expect(result.current.error).toBeNull();
    });
  });
});
