/**
 * useArcaContext Hook Tests (REFACTOR-01)
 *
 * Tests for the focused context management hook extracted from useArca.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArcaContext } from '../useArcaContext';
import { useAgenticStore } from '../../store';

vi.mock('../../store', () => {
  const mockStore = {
    contextItems: [],
    entities: [],
    sharedContext: [],
    contextLoading: false,
    contextError: null,
    consultation: { id: 'c-1' },
    apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
    logger: null,
    initialized: true,
    setContextLoading: vi.fn(),
    setContextError: vi.fn(),
    addContextItem: vi.fn(),
    updateContextItem: vi.fn(),
    setSharedContext: vi.fn(),
    setEntities: vi.fn(),
    addEntities: vi.fn(),
  };

  return {
    useAgenticStore: vi.fn(() => mockStore),
    selectTranscriptions: vi.fn((s: any) => s.contextItems.filter((i: any) => i.type === 'transcription')),
    selectCaseNotes: vi.fn((s: any) => s.contextItems.filter((i: any) => i.type === 'case_note')),
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

describe('useArcaContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return context state from store', () => {
    const { result } = renderHook(() => useArcaContext());

    expect(result.current.items).toEqual([]);
    expect(result.current.entities).toEqual([]);
    expect(result.current.sharedContext).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should expose all context actions', () => {
    const { result } = renderHook(() => useArcaContext());

    expect(typeof result.current.addCaseNote).toBe('function');
    expect(typeof result.current.addTranscription).toBe('function');
    expect(typeof result.current.updateItem).toBe('function');
    expect(typeof result.current.loadSharedContext).toBe('function');
    expect(typeof result.current.extractEntities).toBe('function');
    expect(typeof result.current.getContextVersions).toBe('function');
    expect(typeof result.current.triggerEntityExtraction).toBe('function');
    expect(typeof result.current.fetchTranscriptions).toBe('function');
    expect(typeof result.current.fetchCaseNotes).toBe('function');
  });

  it('should expose transcriptions and caseNotes computed from items', () => {
    const { result } = renderHook(() => useArcaContext());

    expect(result.current.transcriptions).toEqual([]);
    expect(result.current.caseNotes).toEqual([]);
  });
});
