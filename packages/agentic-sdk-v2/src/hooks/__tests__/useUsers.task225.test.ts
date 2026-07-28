/**
 * useUsers search method
 *
 * Tests that useUsers exposes a `search(query, options?)` method
 * that calls GET /users?search={query}&limit={limit} and returns
 * results without overwriting the main `users` state.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUsers } from '../useUsers';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUsers search', () => {
  let mockStore: any;
  const mockGet = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockStore = {
      apiClient: {
        get: mockGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
      logger: createMockLogger(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should expose a search method on the hook return', () => {
    const { result } = renderHook(() => useUsers());
    expect(result.current).toHaveProperty('search');
    expect(typeof result.current.search).toBe('function');
  });

  it('should call GET /users?search={query} with default limit', async () => {
    const searchResults = [{ id: 'u-1', username: 'john_doe', email: 'john@test.com' }];
    mockGet.mockResolvedValue(searchResults);
    const { result } = renderHook(() => useUsers());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.search('john');
    });

    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining(`${USER_ENDPOINTS.LIST}?`));
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('search=john'));
    expect(resp).toEqual(searchResults);
  });

  it('should include limit parameter when provided in options', async () => {
    mockGet.mockResolvedValue([]);
    const { result } = renderHook(() => useUsers());

    await act(async () => {
      await result.current.search('jane', { limit: 10 });
    });

    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('limit=10'));
  });

  it('should return array of User objects', async () => {
    const users = [
      { id: 'u-1', username: 'john', email: 'john@test.com' },
      { id: 'u-2', username: 'johnny', email: 'johnny@test.com' },
    ];
    mockGet.mockResolvedValue(users);
    const { result } = renderHook(() => useUsers());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.search('john');
    });

    expect(Array.isArray(resp)).toBe(true);
    expect(resp).toHaveLength(2);
  });

  it('should NOT overwrite the main users state', async () => {
    const mainUsers = [
      { id: 'u-1', username: 'existing1' },
      { id: 'u-2', username: 'existing2' },
    ];
    const searchResults = [{ id: 'u-3', username: 'searched_user' }];

    mockGet.mockResolvedValueOnce(mainUsers);
    const { result } = renderHook(() => useUsers());

    await act(async () => {
      await result.current.list();
    });
    expect(result.current.users).toEqual(mainUsers);

    mockGet.mockResolvedValueOnce(searchResults);
    await act(async () => {
      await result.current.search('searched');
    });

    expect(result.current.users).toEqual(mainUsers);
  });

  it('should return empty array when no results match', async () => {
    mockGet.mockResolvedValue([]);
    const { result } = renderHook(() => useUsers());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.search('nonexistent');
    });

    expect(resp).toEqual([]);
  });

  it('should throw when SDK is not initialized', async () => {
    mockStore.apiClient = null;
    (useAgenticStore as any).mockReturnValue(mockStore);
    const { result } = renderHook(() => useUsers());

    await expect(
      act(async () => {
        await result.current.search('test');
      }),
    ).rejects.toThrow('SDK not initialized');
  });
});
