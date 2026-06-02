/**
 * useConsultationChain Hook Tests (TASK-329 P2)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConsultationChain } from '../useConsultationChain';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const fakeChain = [
  { id: 'A', parentConsultationId: null },
  { id: 'B', parentConsultationId: 'A' },
  { id: 'C', parentConsultationId: 'B' },
];

describe('useConsultationChain (TASK-329 P2)', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockStore: any;
  const mockGet = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockStore = { apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }, logger: mockLogger };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => vi.clearAllMocks());

  it('starts with an empty chain', () => {
    const { result } = renderHook(() => useConsultationChain());
    expect(result.current.chain).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('GETs the CHAIN endpoint and stores the result', async () => {
    mockGet.mockResolvedValue(fakeChain);
    const { result } = renderHook(() => useConsultationChain());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.fetchChain('C');
    });

    expect(mockGet).toHaveBeenCalledWith(CONSULTATION_ENDPOINTS.CHAIN('C'));
    expect(returned).toEqual(fakeChain);
    expect(result.current.chain).toEqual(fakeChain);
  });

  it('coerces a null response to an empty array', async () => {
    mockGet.mockResolvedValue(null);
    const { result } = renderHook(() => useConsultationChain());

    await act(async () => {
      await result.current.fetchChain('C');
    });

    expect(result.current.chain).toEqual([]);
  });

  it('sets error on failure', async () => {
    const error = new Error('boom');
    mockGet.mockRejectedValue(error);
    const { result } = renderHook(() => useConsultationChain());

    await act(async () => {
      try {
        await result.current.fetchChain('C');
      } catch {
        /* expected */
      }
    });

    expect(result.current.error).toEqual(error);
  });
});
