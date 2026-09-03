/**
 * optimistic concurrency on note-content writes.
 *
 * The three server routes (`PATCH :id/context/:contextId`,
 * `PATCH :id/summary/:summaryId`, `POST :id/summary/:contextItemId/approve`)
 * are `@RequiresIfMatch()`. These tests assert the SDK hooks:
 *
 *   1. send `If-Match: "<version>"` AND the body-field `expectedVersion`,
 *      sourced from the store (or an explicit override),
 *   2. surface `412 Precondition Failed` as a `ConfigConflictError`,
 *   3. refuse to issue a validator-less write when no version is known.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSummary } from '../useArcaSummary';
import { useArcaContext } from '../useArcaContext';
import { SUMMARY_ENDPOINTS, CONTEXT_ENDPOINTS } from '../../core/constants';
import { ConfigConflictError } from '../../types/settings';
import { AgenticError } from '../../types/common';

const mockPatchWithIfMatch = vi.fn();
const mockPostWithHeaders = vi.fn();

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  patchWithIfMatch: mockPatchWithIfMatch,
  postWithHeaders: mockPostWithHeaders,
};

const summary = { id: 's-1', contextItemId: 'ctx-1', content: 'old', type: 'summary', version: 7, createdAt: '', llmProvider: 'x', modelName: 'y' };
const contextItem = { id: 'ctx-9', consultationId: 'c-1', type: 'CASE_NOTE', content: 'old', version: 4 };

const mockStore: Record<string, unknown> = {
  summaries: [summary],
  contextItems: [contextItem],
  sharedContext: [],
  entities: [],
  contextLoading: false,
  contextError: null,
  summaryGenerating: false,
  summaryError: null,
  consultation: { id: 'c-1' },
  apiClient,
  logger: null,
  initialized: true,
  setSummaryGenerating: vi.fn(),
  setSummaryError: vi.fn(),
  addSummary: vi.fn(),
  setSummaries: vi.fn(),
  setContextLoading: vi.fn(),
  setContextError: vi.fn(),
  addContextItem: vi.fn(),
  updateContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
  addEntities: vi.fn(),
};

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => (typeof selector === 'function' ? selector(mockStore) : mockStore)),
  selectApiClient: (s: Record<string, unknown>) => s.apiClient,
  selectConsultation: (s: Record<string, unknown>) => s.consultation,
  selectContextItems: (s: Record<string, unknown>) => s.contextItems,
  selectSharedContext: (s: Record<string, unknown>) => s.sharedContext,
  selectEntities: (s: Record<string, unknown>) => s.entities,
  selectContextLoading: (s: Record<string, unknown>) => s.contextLoading,
  selectContextError: (s: Record<string, unknown>) => s.contextError,
  selectLogger: (s: Record<string, unknown>) => s.logger,
  selectTranscriptions: () => [],
  selectCaseNotes: () => [],
  selectWorknotes: () => [],
  selectAttachments: () => [],
}));

const conflict = () => new AgenticError('UNKNOWN_ERROR', 'HTTP 412', { context: { status: 412, currentVersion: 9 } });

describe(' SDK optimistic concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.summaries = [summary];
    mockStore.contextItems = [contextItem];
  });

  describe('useArcaSummary.updateSummary', () => {
    it('threads the store version through If-Match and expectedVersion', async () => {
      mockPatchWithIfMatch.mockResolvedValue({ ...summary, content: 'new', version: 8 });
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.updateSummary('s-1', 'new', { changeReason: 'edit' });
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.UPDATE('c-1', 's-1'), { content: 'new', expectedVersion: 7, changeReason: 'edit' }, '"7"');
    });

    it('prefers an explicit expectedVersion over the store value', async () => {
      mockPatchWithIfMatch.mockResolvedValue({ ...summary, version: 12 });
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.updateSummary('s-1', 'new', { expectedVersion: 11 });
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(expect.any(String), { content: 'new', expectedVersion: 11 }, '"11"');
    });

    it('surfaces 412 as ConfigConflictError', async () => {
      mockPatchWithIfMatch.mockRejectedValue(conflict());
      const { result } = renderHook(() => useArcaSummary());

      const thrown = await result.current.updateSummary('s-1', 'new').catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(ConfigConflictError);
      expect((thrown as ConfigConflictError).expectedVersion).toBe(7);
      expect((thrown as ConfigConflictError).currentVersion).toBe(9);
    });

    it('refuses to write when no version is known', async () => {
      mockStore.summaries = [];
      const { result } = renderHook(() => useArcaSummary());

      await expect(result.current.updateSummary('s-1', 'new')).rejects.toThrow(/No known row version/);
      expect(mockPatchWithIfMatch).not.toHaveBeenCalled();
    });
  });

  describe('useArcaSummary.approveSummary', () => {
    it('sends If-Match plus expectedVersion on the POST', async () => {
      mockPostWithHeaders.mockResolvedValue({ status: 'APPROVED' });
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.approveSummary('ctx-1');
      });

      expect(mockPostWithHeaders).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.APPROVE('c-1', 'ctx-1'), { expectedVersion: 7 }, { 'If-Match': '"7"' });
    });

    it('surfaces 412 as ConfigConflictError', async () => {
      mockPostWithHeaders.mockRejectedValue(conflict());
      const { result } = renderHook(() => useArcaSummary());

      const thrown = await result.current.approveSummary('ctx-1').catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ConfigConflictError);
    });
  });

  describe('useArcaContext.updateItem', () => {
    it('threads the store version through If-Match and expectedVersion', async () => {
      mockPatchWithIfMatch.mockResolvedValue({ ...contextItem, content: 'new', version: 5 });
      const { result } = renderHook(() => useArcaContext());

      await act(async () => {
        await result.current.updateItem('ctx-9', 'new');
      });

      expect(mockPatchWithIfMatch).toHaveBeenCalledWith(CONTEXT_ENDPOINTS.UPDATE('c-1', 'ctx-9'), { content: 'new', expectedVersion: 4 }, '"4"');
      expect(mockStore.updateContextItem).toHaveBeenCalledWith('ctx-9', { content: 'new', version: 5 });
    });

    it('surfaces 412 as ConfigConflictError', async () => {
      mockPatchWithIfMatch.mockRejectedValue(conflict());
      const { result } = renderHook(() => useArcaContext());

      const thrown = await result.current.updateItem('ctx-9', 'new').catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ConfigConflictError);
      expect((thrown as ConfigConflictError).expectedVersion).toBe(4);
    });

    it('refuses to write when no version is known', async () => {
      mockStore.contextItems = [];
      const { result } = renderHook(() => useArcaContext());

      await expect(result.current.updateItem('ctx-9', 'new')).rejects.toThrow(/No known row version/);
      expect(mockPatchWithIfMatch).not.toHaveBeenCalled();
    });
  });
});
