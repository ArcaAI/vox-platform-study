/**
 * useDnaStyle — erasure actions (INV-240).
 *
 * The DNA on/off toggle only stops FUTURE learning; the already-learned
 * profile stays stored and keeps being injected into the doctor's summary
 * prompts until it is erased. These are the SDK half of that erasure path.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaStyle } from '../useDnaStyle';
import { useAgenticStore } from '../../store/agenticStore';
import { DNA_STYLE_ENDPOINTS } from '../../core/constants';

function createMockLogger() {
  return {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    http: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withMeta: vi.fn().mockReturnThis(),
    withCorrelation: vi.fn().mockReturnThis(),
    withUser: vi.fn().mockReturnThis(),
    setCorrelationId: vi.fn(),
    getCorrelationId: vi.fn().mockReturnValue('mock-correlation-id'),
    generateCorrelationId: vi.fn().mockReturnValue('generated-correlation-id'),
    startOperation: vi.fn().mockReturnValue({ name: 'op', startTime: Date.now(), end: vi.fn(), error: vi.fn() }),
    flush: vi.fn().mockResolvedValue(undefined),
    getLevel: vi.fn().mockReturnValue('info'),
    setLevel: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    addTransport: vi.fn(),
    getTransportNames: vi.fn().mockReturnValue(['mock']),
  };
}

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const ERASURE_RESULT = { doctorId: 'd-1', deletedReports: 2, deletedVersions: 5 };

describe('useDnaStyle — erasure', () => {
  let mockStore: Record<string, unknown>;
  const mockGet = vi.fn();
  const mockDelete = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockDelete.mockReset();
    mockStore = {
      apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: mockDelete },
      logger: createMockLogger(),
    };
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('resetMyStyle', () => {
    it('DELETEs the owner-scoped my-style endpoint and returns the counts', async () => {
      mockDelete.mockResolvedValue(ERASURE_RESULT);
      const { result } = renderHook(() => useDnaStyle());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.resetMyStyle();
      });

      expect(mockDelete).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.RESET_MY_STYLE);
      expect(resp).toEqual(ERASURE_RESULT);
    });

    it('clears locally cached style and versions so an erased profile stops rendering', async () => {
      mockDelete.mockResolvedValue(ERASURE_RESULT);
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.resetMyStyle();
      });

      expect(result.current.style).toBeNull();
      expect(result.current.versions).toEqual([]);
    });

    it('surfaces a failure rather than reporting a successful erasure', async () => {
      mockDelete.mockRejectedValue(new Error('gateway down'));
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await expect(result.current.resetMyStyle()).rejects.toThrow('gateway down');
      });
    });
  });

  describe('deleteReport', () => {
    it('DELETEs the per-report endpoint with the encoded report id', async () => {
      mockDelete.mockResolvedValue({ ...ERASURE_RESULT, deletedReports: 1 });
      const { result } = renderHook(() => useDnaStyle());

      await act(async () => {
        await result.current.deleteReport('report 9');
      });

      expect(mockDelete).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.DELETE_REPORT('report 9'));
      expect(DNA_STYLE_ENDPOINTS.DELETE_REPORT('report 9')).toContain('report%209');
    });
  });
});
