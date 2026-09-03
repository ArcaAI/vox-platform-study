/**
 * optimistic concurrency on the session lifecycle POSTs.
 *
 * `POST /consultations/:id/prime`, `/close` and `/reopen` all carry
 * `@RequiresIfMatch()` + `@ExpectedVersion()` on the gateway
 * (`requiresIfMatch: true` for all three in `apps/api/route-manifest.json`), so
 * a validator-less request answers `428 Precondition Required`. The SDK sent a
 * bare `apiClient.post(...)`, which made every call fail.
 *
 * These tests pin the same shape `useArcaSession.update` already uses:
 *
 *   1. send `If-Match: "<version>"` (the strong validator the SDK read with
 *      this consultation) via `postWithHeaders` — the house POST + If-Match
 *      helper, as in `useArcaSummary.approveSummary`,
 *   2. refresh the stored consultation (and therefore its `version`) from the
 *      200 response, so a second lifecycle call sends the NEW validator,
 *   3. surface `412 Precondition Failed` as a `ConfigConflictError`,
 *   4. send NO precondition when the loaded row carries no `version` — a 428
 *      that names the missing header beats a fabricated CAS (`update`'s rule).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSession } from '../useArcaSession';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger, createMockConsultation } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS } from '../../core/constants';
import { ConfigConflictError } from '../../types/settings';
import { AgenticError } from '../../types/common';

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

/* eslint-disable @typescript-eslint/no-explicit-any -- store/client doubles model only the consumed surface */

const conflict = () => new AgenticError('UNKNOWN_ERROR', 'HTTP 412', { context: { status: 412, currentVersion: 9 } });

type Lifecycle = 'prime' | 'close' | 'reopen';

const ENDPOINT: Record<Lifecycle, (id: string) => string> = {
  prime: CONSULTATION_ENDPOINTS.PRIME,
  close: CONSULTATION_ENDPOINTS.CLOSE,
  reopen: CONSULTATION_ENDPOINTS.REOPEN,
};

describe(' G1 — useArcaSession lifecycle writes send If-Match', () => {
  let mockStore: any;
  const mockPost = vi.fn();
  const mockPostWithHeaders = vi.fn();

  beforeEach(() => {
    mockPost.mockReset();
    mockPostWithHeaders.mockReset();
    mockStore = {
      apiClient: {
        post: mockPost,
        postWithHeaders: mockPostWithHeaders,
        patch: vi.fn(),
        patchWithIfMatch: vi.fn(),
        get: vi.fn(),
        getTenantId: vi.fn(),
      },
      consultation: createMockConsultation({ id: 'cons-1', version: 7 }),
      contextItems: [],
      sessionLoading: false,
      sessionError: null,
      logger: createMockLogger(),
      setConsultation: vi.fn(),
      addContextItem: vi.fn(),
      setSharedContext: vi.fn(),
      setSummaries: vi.fn(),
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => vi.clearAllMocks());

  it('exposes prime alongside close and reopen', () => {
    const { result } = renderHook(() => useArcaSession());
    expect(typeof result.current.prime).toBe('function');
    expect(typeof result.current.close).toBe('function');
    expect(typeof result.current.reopen).toBe('function');
  });

  describe.each<Lifecycle>(['prime', 'close', 'reopen'])('%s()', (action) => {
    it('POSTs the lifecycle route with If-Match carrying the row version', async () => {
      const updated = { ...mockStore.consultation, version: 8 };
      mockPostWithHeaders.mockResolvedValue(updated);

      const { result } = renderHook(() => useArcaSession());
      let response: unknown;
      await act(async () => {
        response = await result.current[action]();
      });

      expect(mockPostWithHeaders).toHaveBeenCalledWith(ENDPOINT[action]('cons-1'), {}, { 'If-Match': '"7"' });
      expect(mockPost).not.toHaveBeenCalled();
      expect(response).toEqual(updated);
    });

    it('refreshes the stored consultation (and its version) from the 200 response', async () => {
      const updated = { ...mockStore.consultation, version: 8, status: 'CLOSED' };
      mockPostWithHeaders.mockResolvedValue(updated);

      const { result } = renderHook(() => useArcaSession());
      await act(async () => {
        await result.current[action]();
      });

      expect(mockStore.setConsultation).toHaveBeenCalledWith(updated);
      expect(mockStore.setConsultation.mock.calls[0]![0].version).toBe(8);
    });

    it('surfaces 412 as a ConfigConflictError naming both versions', async () => {
      mockPostWithHeaders.mockRejectedValue(conflict());

      const { result } = renderHook(() => useArcaSession());
      let thrown: unknown;
      await act(async () => {
        await result.current[action]().catch((error: unknown) => {
          thrown = error;
        });
      });

      expect(thrown).toBeInstanceOf(ConfigConflictError);
      expect((thrown as ConfigConflictError).expectedVersion).toBe(7);
      expect((thrown as ConfigConflictError).currentVersion).toBe(9);
    });

    it('sends NO precondition when the loaded row carries no version', async () => {
      mockStore.consultation = createMockConsultation({ id: 'cons-1' });
      (useAgenticStore as any).mockReturnValue(mockStore);
      mockPost.mockResolvedValue(mockStore.consultation);

      const { result } = renderHook(() => useArcaSession());
      await act(async () => {
        await result.current[action]();
      });

      expect(mockPost).toHaveBeenCalledWith(ENDPOINT[action]('cons-1'), {});
      expect(mockPostWithHeaders).not.toHaveBeenCalled();
    });

    it('throws when no consultation is open', async () => {
      mockStore.consultation = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useArcaSession());

      await expect(
        act(async () => {
          await result.current[action]();
        }),
      ).rejects.toThrow('No consultation open');
    });
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any */
