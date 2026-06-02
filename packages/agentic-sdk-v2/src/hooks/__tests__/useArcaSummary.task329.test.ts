/**
 * useArcaSummary — TASK-329 (P6) diff + tag methods.
 *
 * Verifies the new summary-management methods hit the correct consultation-
 * scoped endpoints with the right verbs/payloads.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArcaSummary } from '../useArcaSummary';
import { SUMMARY_ENDPOINTS } from '../../core/constants';

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../store', () => {
  const mockStore = {
    summaries: [],
    dnaStyle: null,
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
  };
  return { useAgenticStore: vi.fn(() => mockStore) };
});

const CTX = 'ctx-9';

describe('useArcaSummary — TASK-329 diff + tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the new diff + tag actions', () => {
    const { result } = renderHook(() => useArcaSummary());
    expect(typeof result.current.diffSummaryVersions).toBe('function');
    expect(typeof result.current.getSummaryTags).toBe('function');
    expect(typeof result.current.tagSummary).toBe('function');
    expect(typeof result.current.deleteSummaryTag).toBe('function');
  });

  it('diffSummaryVersions GETs the /diff endpoint with from/to query params', async () => {
    apiClient.get.mockResolvedValue({ contextItemId: CTX, from: {}, to: {} });
    const { result } = renderHook(() => useArcaSummary());

    await result.current.diffSummaryVersions(CTX, 1, 3);

    expect(apiClient.get).toHaveBeenCalledWith(`${SUMMARY_ENDPOINTS.DIFF('c-1', CTX)}?from=1&to=3`);
  });

  it('getSummaryTags GETs the /tags endpoint', async () => {
    apiClient.get.mockResolvedValue([]);
    const { result } = renderHook(() => useArcaSummary());

    await result.current.getSummaryTags(CTX);

    expect(apiClient.get).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.TAGS('c-1', CTX));
  });

  it('tagSummary POSTs the tag payload to the /tags endpoint', async () => {
    apiClient.post.mockResolvedValue({ id: 't-1', tagValue: 'reviewed' });
    const { result } = renderHook(() => useArcaSummary());

    await result.current.tagSummary(CTX, { tagKey: 'status', tagValue: 'reviewed', color: '#0f0' });

    expect(apiClient.post).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.TAGS('c-1', CTX), {
      tagKey: 'status',
      tagValue: 'reviewed',
      color: '#0f0',
    });
  });

  it('deleteSummaryTag DELETEs the /tags/:tagId endpoint', async () => {
    apiClient.delete.mockResolvedValue(undefined);
    const { result } = renderHook(() => useArcaSummary());

    await result.current.deleteSummaryTag(CTX, 'tag-7');

    expect(apiClient.delete).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.TAG('c-1', CTX, 'tag-7'));
  });
});
