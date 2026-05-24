/**
 * useArcaContext Hook Tests (REFACTOR-01; TASK-297 DEF-H3).
 *
 * Tests for the focused context management hook extracted from useArca.
 * The hook now reads via selector subscriptions, so the mock store applies
 * the supplied selector to its synthetic state.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArcaContext } from '../useArcaContext';
import { useAgenticStore } from '../../store';

const mockStore = {
  contextItems: [] as unknown[],
  entities: [] as unknown[],
  sharedContext: [] as unknown[],
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

vi.mock('../../store', () => {
  return {
    // TASK-297 DEF-H3 — apply selector against synthetic mock state. When
    // called with no selector (or with undefined), return the whole store.
    useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => {
      if (typeof selector === 'function') return selector(mockStore);
      return mockStore;
    }),
    selectTranscriptions: (s: { contextItems: { type?: string }[] }) =>
      s.contextItems.filter((i) => i.type === 'transcription'),
    selectCaseNotes: (s: { contextItems: { type?: string }[] }) =>
      s.contextItems.filter((i) => i.type === 'case_note'),
    selectWorknotes: (s: { contextItems: { type?: string }[] }) =>
      s.contextItems.filter((i) => i.type === 'WORKNOTE'),
    selectAttachments: (s: { contextItems: { type?: string }[] }) =>
      s.contextItems.filter((i) => i.type === 'ATTACHMENT'),
    selectIsAudioSource: () => false,
    selectTranscriptionPipelineState: () => null,
    selectKnowledgePipelineState: () => null,
    selectConsultation: (s: { consultation: unknown }) => s.consultation,
    selectIsCapturing: () => false,
    selectAudioLevel: () => 0,
    selectEntities: (s: { entities: unknown[] }) => s.entities,
    selectSummaries: () => [],
    selectApiClient: (s: { apiClient: unknown }) => s.apiClient,
    selectContextItems: (s: { contextItems: unknown[] }) => s.contextItems,
    selectSharedContext: (s: { sharedContext: unknown[] }) => s.sharedContext,
    selectContextLoading: (s: { contextLoading: boolean }) => s.contextLoading,
    selectContextError: (s: { contextError: unknown }) => s.contextError,
    selectLogger: (s: { logger: unknown }) => s.logger,
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

  it('TASK-297 DEF-H3: invokes selectors with state instead of returning whole store', () => {
    renderHook(() => useArcaContext());
    // Each render runs ~10 selector calls; the call count is non-zero.
    expect((useAgenticStore as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(5);
  });
});
