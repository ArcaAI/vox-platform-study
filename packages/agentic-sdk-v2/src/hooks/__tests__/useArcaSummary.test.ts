/**
 * useArcaSummary Hook Tests (REFACTOR-01)
 *
 * Tests for the focused summary management hook extracted from useArca.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArcaSummary } from '../useArcaSummary';
import { useAgenticStore } from '../../store';

vi.mock('../../store', () => {
  const mockStore = {
    summaries: [],
    dnaStyle: null,
    summaryGenerating: false,
    summaryError: null,
    consultation: { id: 'c-1' },
    apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
    logger: null,
    initialized: true,
    setSummaryGenerating: vi.fn(),
    setSummaryError: vi.fn(),
    addSummary: vi.fn(),
    setSummaries: vi.fn(),
  };

  return {
    useAgenticStore: vi.fn(() => mockStore),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
    selectConsultation: vi.fn(() => null),
    selectIsCapturing: vi.fn(() => false),
    selectAudioLevel: vi.fn(() => 0),
    selectEntities: vi.fn(() => []),
    selectSummaries: vi.fn(() => []),
  };
});

describe('useArcaSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return summary state from store', () => {
    const { result } = renderHook(() => useArcaSummary());

    expect(result.current.all).toEqual([]);
    expect(result.current.preSummary).toBeNull();
    expect(result.current.summary).toBeNull();
    expect(result.current.dnaStyle).toBeNull();
    expect(result.current.isGenerating).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should expose all summary actions', () => {
    const { result } = renderHook(() => useArcaSummary());

    expect(typeof result.current.generatePreSummary).toBe('function');
    expect(typeof result.current.generateSummary).toBe('function');
    expect(typeof result.current.updateSummary).toBe('function');
    expect(typeof result.current.analyzeDNA).toBe('function');
    expect(typeof result.current.loadSummaries).toBe('function');
    expect(typeof result.current.generateSummaryAsync).toBe('function');
    expect(typeof result.current.generatePreSummaryAsync).toBe('function');
    expect(typeof result.current.generateComprehensiveSummary).toBe('function');
    expect(typeof result.current.getLatestPreSummary).toBe('function');
    expect(typeof result.current.getSummaryHistory).toBe('function');
    expect(typeof result.current.compareSummaryVersions).toBe('function');
  });
});
