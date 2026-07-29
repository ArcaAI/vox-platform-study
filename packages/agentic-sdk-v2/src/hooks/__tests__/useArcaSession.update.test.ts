/**
 * useArcaSession.update Tests
 *
 * `session.update(input)` → PATCH /consultations/:id. Mirrors the existing
 * close()/reopen() lifecycle methods (which POST to /close and /reopen).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSession } from '../useArcaSession';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger, createMockConsultation } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

vi.mock('../../core/SimpleCrossTabSync', () => ({
  SimpleCrossTabSync: vi.fn(),
  createCrossTabSync: vi.fn(() => ({
    onContextAdded: vi.fn(),
    broadcastContext: vi.fn(),
    close: vi.fn(),
  })),
}));

describe('useArcaSession.update', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockPatch = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockPatch.mockReset();
    mockStore = {
      apiClient: { patch: mockPatch, post: vi.fn(), get: vi.fn(), getTenantId: vi.fn() },
      consultation: createMockConsultation({ id: 'cons-1' }),
      contextItems: [],
      sessionLoading: false,
      sessionError: null,
      logger: mockLogger,
      setConsultation: vi.fn(),
      addContextItem: vi.fn(),
      setSharedContext: vi.fn(),
      setSummaries: vi.fn(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes update alongside close and reopen', () => {
    const { result } = renderHook(() => useArcaSession());
    expect(typeof result.current.update).toBe('function');
    expect(typeof result.current.close).toBe('function');
    expect(typeof result.current.reopen).toBe('function');
  });

  it('PATCHes CONSULTATION_ENDPOINTS.UPDATE(id) with input and stores the result', async () => {
    const input = { department: 'Cardiology', metadata: { reviewed: true } };
    const updated = { ...mockStore.consultation, ...input };
    mockPatch.mockResolvedValue(updated);

    const { result } = renderHook(() => useArcaSession());

    let resp: any;
    await act(async () => {
      resp = await result.current.update(input);
    });

    expect(mockPatch).toHaveBeenCalledWith(CONSULTATION_ENDPOINTS.UPDATE('cons-1'), input);
    expect(mockStore.setConsultation).toHaveBeenCalledWith(updated);
    expect(resp).toEqual(updated);
  });

  it('throws when no consultation is open', async () => {
    mockStore.consultation = null;
    (useAgenticStore as any).mockReturnValue(mockStore);
    const { result } = renderHook(() => useArcaSession());

    await expect(
      act(async () => {
        await result.current.update({ department: 'X' });
      }),
    ).rejects.toThrow('No consultation open');
  });

  it('throws when SDK not initialized', async () => {
    mockStore.apiClient = undefined;
    (useAgenticStore as any).mockReturnValue(mockStore);
    const { result } = renderHook(() => useArcaSession());

    await expect(
      act(async () => {
        await result.current.update({ department: 'X' });
      }),
    ).rejects.toThrow('SDK not initialized');
  });

  it('propagates API errors', async () => {
    mockPatch.mockRejectedValue(new Error('Update failed'));
    const { result } = renderHook(() => useArcaSession());

    await expect(
      act(async () => {
        await result.current.update({ department: 'X' });
      }),
    ).rejects.toThrow('Update failed');
  });
});
