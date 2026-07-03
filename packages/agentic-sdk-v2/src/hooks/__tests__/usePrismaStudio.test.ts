/**
 * usePrismaStudio Hook Tests (TASK-403)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrismaStudio } from '../usePrismaStudio';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { PSTUDIO_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('usePrismaStudio', () => {
  const mockGet = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    (useAgenticStore as any).mockReturnValue({
      apiClient: { get: mockGet },
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with a null status', () => {
    const { result } = renderHook(() => usePrismaStudio());
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('refreshStatus() GETs the always-on status probe and stores it', async () => {
    mockGet.mockResolvedValue({ enabled: true });
    const { result } = renderHook(() => usePrismaStudio());

    await act(async () => {
      await result.current.refreshStatus();
    });

    expect(mockGet).toHaveBeenCalledWith(PSTUDIO_ENDPOINTS.STATUS);
    expect(result.current.status).toEqual({ enabled: true });
  });

  it('surfaces errors and clears loading', async () => {
    mockGet.mockRejectedValue(new Error('Forbidden'));
    const { result } = renderHook(() => usePrismaStudio());

    await act(async () => {
      try {
        await result.current.refreshStatus();
      } catch {
        /* expected */
      }
    });

    expect(result.current.error?.message).toBe('Forbidden');
    expect(result.current.status).toBeNull();
  });
});
