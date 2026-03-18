/**
 * useArcaPipelines Hook Tests (REFACTOR-01)
 *
 * Tests for the focused pipeline control hook extracted from useArca.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArcaPipelines } from '../useArcaPipelines';
import { useAgenticStore } from '../../store';

vi.mock('../../store', () => {
  const mockStore = {
    pluginManager: null,
    consultation: { id: 'c-1' },
    logger: null,
    initialized: true,
    entities: [],
    addEntities: vi.fn(),
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

describe('useArcaPipelines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return pipeline state', () => {
    const { result } = renderHook(() => useArcaPipelines());

    expect(result.current.transcription).toBeNull();
    expect(result.current.knowledge).toBeNull();
  });

  it('should expose pipeline control actions', () => {
    const { result } = renderHook(() => useArcaPipelines());

    expect(typeof result.current.pauseTranscription).toBe('function');
    expect(typeof result.current.resumeTranscription).toBe('function');
    expect(typeof result.current.triggerNER).toBe('function');
    expect(typeof result.current.triggerSummarization).toBe('function');
  });
});
