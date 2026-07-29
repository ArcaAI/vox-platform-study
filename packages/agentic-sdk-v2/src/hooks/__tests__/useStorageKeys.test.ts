/**
 * useStorageKeys Hook Tests
 *
 * Per-tenant storage access-key management. The create response carries the
 * secret exactly once.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStorageKeys } from '../useStorageKeys';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { STORAGE_KEY_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useStorageKeys', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockDelete = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    mockStore = { apiClient: { get: mockGet, post: mockPost, delete: mockDelete }, logger: mockLogger };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initial state is empty', () => {
    const { result } = renderHook(() => useStorageKeys());
    expect(result.current.keys).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe('list', () => {
    it('GETs LIST and stores keys (no secrets)', async () => {
      const keys = [{ id: 'k-1', accessKeyId: 'AK1' }];
      mockGet.mockResolvedValue(keys);
      const { result } = renderHook(() => useStorageKeys());

      let resp: any;
      await act(async () => {
        resp = await result.current.list();
      });

      expect(mockGet).toHaveBeenCalledWith(STORAGE_KEY_ENDPOINTS.LIST);
      expect(resp).toEqual(keys);
      expect(result.current.keys).toEqual(keys);
    });

    it('surfaces a server 403 as a clean AgenticError(FORBIDDEN)', async () => {
      mockGet.mockRejectedValue(new AgenticError('FORBIDDEN', 'Forbidden'));
      const { result } = renderHook(() => useStorageKeys());

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.list();
        } catch (e) {
          caught = e;
        }
      });

      expect(caught).toBeInstanceOf(AgenticError);
      expect((caught as AgenticError).code).toBe('FORBIDDEN');
    });
  });

  describe('create', () => {
    it('POSTs CREATE, returns the one-time secret, and appends to keys', async () => {
      const created = { id: 'k-new', accessKeyId: 'AK2', secret: 'one-time-secret' };
      mockGet.mockResolvedValue([{ id: 'k-1' }]);
      mockPost.mockResolvedValue(created);
      const { result } = renderHook(() => useStorageKeys());

      await act(async () => {
        await result.current.list();
      });

      let resp: any;
      await act(async () => {
        resp = await result.current.create({ label: 'ci' });
      });

      expect(mockPost).toHaveBeenCalledWith(STORAGE_KEY_ENDPOINTS.CREATE, { label: 'ci' });
      expect(resp.secret).toBe('one-time-secret');
      expect(result.current.keys).toEqual([{ id: 'k-1' }, created]);
    });
  });

  describe('revoke', () => {
    it('DELETEs DELETE(id) and drops from keys', async () => {
      mockGet.mockResolvedValue([{ id: 'k-1' }, { id: 'k-2' }]);
      mockDelete.mockResolvedValue({ id: 'k-1' });
      const { result } = renderHook(() => useStorageKeys());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.revoke('k-1');
      });

      expect(mockDelete).toHaveBeenCalledWith(STORAGE_KEY_ENDPOINTS.DELETE('k-1'));
      expect(result.current.keys).toEqual([{ id: 'k-2' }]);
    });
  });

  describe('SDK not initialized', () => {
    it('throws when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useStorageKeys());

      await expect(
        act(async () => {
          await result.current.list();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });
});
