/**
 * useArcaAudio Hook Tests (REFACTOR-01)
 *
 * Tests for the focused audio management hook extracted from useArca.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

vi.mock('../../store', () => {
  const mockStore = {
    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    transcriptSegments: [],
    audioLanguage: 'en',
    audioPlugins: {
      noiseFilter: { isActive: false, isInitialized: false },
      vad: { isActive: false, isInitialized: false },
      stt: { isActive: false, isInitialized: false, provider: 'auto' },
    },
    audioError: null,
    pluginManager: null,
    consultation: null,
    apiClient: null,
    logger: null,
    initialized: true,
    contextItems: [],
    entities: [],
    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
  };

  return {
    useAgenticStore: vi.fn(() => mockStore),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
    selectConsultation: vi.fn(() => null),
    selectIsCapturing: vi.fn(() => false),
    selectAudioLevel: vi.fn(() => 0),
    selectEntities: vi.fn(() => []),
    selectSummaries: vi.fn(() => []),
  };
});

describe('useArcaAudio', () => {
  let mockStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = (useAgenticStore as any)();
  });

  it('should return audio state from store', () => {
    const { result } = renderHook(() => useArcaAudio());

    expect(result.current.isCapturing).toBe(false);
    expect(result.current.isMuted).toBe(false);
    expect(result.current.level).toBe(0);
    expect(result.current.isSpeaking).toBe(false);
    expect(result.current.currentTranscript).toBe('');
    expect(result.current.language).toBe('en');
    expect(result.current.error).toBeNull();
  });

  it('should expose mute and unmute actions', () => {
    const { result } = renderHook(() => useArcaAudio());

    act(() => {
      result.current.mute();
    });
    expect(mockStore.setIsMuted).toHaveBeenCalledWith(true);

    act(() => {
      result.current.unmute();
    });
    expect(mockStore.setIsMuted).toHaveBeenCalledWith(false);
  });

  it('should expose start and stop as async functions', () => {
    const { result } = renderHook(() => useArcaAudio());

    expect(typeof result.current.start).toBe('function');
    expect(typeof result.current.stop).toBe('function');
    expect(typeof result.current.toggleNoiseFilter).toBe('function');
    expect(typeof result.current.toggleSTT).toBe('function');
    expect(typeof result.current.toggleVAD).toBe('function');
  });

  it('should expose plugin states', () => {
    const { result } = renderHook(() => useArcaAudio());

    expect(result.current.plugins).toEqual({
      noiseFilter: { isActive: false, isInitialized: false },
      vad: { isActive: false, isInitialized: false },
      stt: { isActive: false, isInitialized: false, provider: 'auto' },
    });
  });
});
