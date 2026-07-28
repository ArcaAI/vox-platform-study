/**
 * useArca ↔ useArcaAudio Unification Tests
 *
 * Pins the contract that `useArca.audio` delegates to the same underlying
 * implementation as `useArcaAudio` so that:
 *  - `getUserMedia` is called exactly once even when both hooks are mounted
 *  - the canonical `AudioContextManager` singleton is acquired (no raw
 *    `new AudioContext()` leak)
 *  - `stop()` releases each `MediaStreamTrack` exactly once
 *  - subsequent unmount does not re-release tracks
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

// ===========================================================================
// Mock @arcaai/room — capture AudioContextManager calls
// ===========================================================================

const mockAudioContext = {
  sampleRate: 48000,
  state: 'running' as const,
  close: vi.fn().mockResolvedValue(undefined),
};

const mockAcquire = vi.fn();
const mockRelease = vi.fn();

vi.mock('@arcaai/room', () => {
  return {
    AudioContextManager: {
      getInstance: vi.fn(() => ({
        acquire: mockAcquire,
        release: mockRelease,
        getContext: vi.fn(() => mockAudioContext),
      })),
      resetInstance: vi.fn(),
    },
  };
});

// ===========================================================================
// Mock store with reactive setters so useArcaAudio.stop() can read back
// the activeStream that start() persisted.
// ===========================================================================

vi.mock('../../store', () => {
  return {
    useAgenticStore: vi.fn(),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
  };
});

interface MockTrack {
  label: string;
  kind: string;
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
}

interface MockStream {
  getTracks: () => MockTrack[];
  getAudioTracks: () => MockTrack[];
}

interface MockStore {
  apiClient: null;
  consultation: null;
  pluginManager: {
    setCallbacks: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    getStates: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
    getKnowledgePipeline: ReturnType<typeof vi.fn>;
    getTranscriptionPipeline: ReturnType<typeof vi.fn>;
  };
  logger: null;
  initialized: boolean;
  isCapturing: boolean;
  isMuted: boolean;
  audioLevel: number;
  isSpeaking: boolean;
  currentTranscript: string;
  transcriptSegments: unknown[];
  audioLanguage: string;
  audioPlugins: Record<string, unknown>;
  audioError: null;
  activeStream: MockStream | null;
  activeAudioContext: typeof mockAudioContext | null;
  contextItems: unknown[];
  entities: unknown[];
  sharedContext: unknown[];
  summaries: unknown[];
  dnaStyle: null;
  contextLoading: boolean;
  contextError: null;
  summaryGenerating: boolean;
  summaryError: null;
  sessionLoading: boolean;
  sessionError: null;
  globalError: null;
  relatedConsultations: unknown[];
  setIsCapturing: ReturnType<typeof vi.fn>;
  setIsMuted: ReturnType<typeof vi.fn>;
  setAudioLevel: ReturnType<typeof vi.fn>;
  setIsSpeaking: ReturnType<typeof vi.fn>;
  setCurrentTranscript: ReturnType<typeof vi.fn>;
  setAudioLanguage: ReturnType<typeof vi.fn>;
  setAudioPlugins: ReturnType<typeof vi.fn>;
  setAudioError: ReturnType<typeof vi.fn>;
  setActiveStream: ReturnType<typeof vi.fn>;
  setActiveAudioContext: ReturnType<typeof vi.fn>;
  addTranscriptSegment: ReturnType<typeof vi.fn>;
  addContextItem: ReturnType<typeof vi.fn>;
  addEntities: ReturnType<typeof vi.fn>;
  // Audio-drop actions the hook calls on start/stop and per drop.
  resetAudioDropped: ReturnType<typeof vi.fn>;
  markAudioLost: ReturnType<typeof vi.fn>;
  incrementDroppedFrames: ReturnType<typeof vi.fn>;
  // Streaming STT connection/pipeline actions (TASK-567 Phase F).
  setSttConnectionState: ReturnType<typeof vi.fn>;
  setActivePipeline: ReturnType<typeof vi.fn>;
}

let mockStore: MockStore;
let mockTrack: MockTrack;
let mockStream: MockStream;
let getUserMediaMock: ReturnType<typeof vi.fn>;

function createMockTrack(): MockTrack {
  return {
    label: 'mock-mic',
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
  };
}

function createMockStream(track: MockTrack): MockStream {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

function buildMockStore(): MockStore {
  const store: MockStore = {
    apiClient: null,
    consultation: null,
    pluginManager: {
      setCallbacks: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getStates: vi.fn(() => ({
        noiseFilter: { isActive: false, isInitialized: true },
        vad: { isActive: true, isInitialized: true },
        stt: { isActive: true, isInitialized: true, provider: 'auto' },
      })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getKnowledgePipeline: vi.fn(() => null),
      getTranscriptionPipeline: vi.fn(() => null),
    },
    logger: null,
    initialized: true,
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
    activeStream: null,
    activeAudioContext: null,
    contextItems: [],
    entities: [],
    sharedContext: [],
    summaries: [],
    dnaStyle: null,
    contextLoading: false,
    contextError: null,
    summaryGenerating: false,
    summaryError: null,
    sessionLoading: false,
    sessionError: null,
    globalError: null,
    relatedConsultations: [],
    setIsCapturing: vi.fn((v: boolean) => { store.isCapturing = v; }),
    setIsMuted: vi.fn((v: boolean) => { store.isMuted = v; }),
    setAudioLevel: vi.fn((v: number) => { store.audioLevel = v; }),
    setIsSpeaking: vi.fn((v: boolean) => { store.isSpeaking = v; }),
    setCurrentTranscript: vi.fn((v: string) => { store.currentTranscript = v; }),
    setAudioLanguage: vi.fn((v: string) => { store.audioLanguage = v; }),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setActiveStream: vi.fn((s: MockStream | null) => { store.activeStream = s; }),
    setActiveAudioContext: vi.fn((c: typeof mockAudioContext | null) => { store.activeAudioContext = c; }),
    addTranscriptSegment: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    // Audio-drop actions the hook calls on start/stop and per drop.
    resetAudioDropped: vi.fn(),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
    // Streaming STT connection/pipeline actions (TASK-567 Phase F).
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
  };
  return store;
}

beforeEach(() => {
  mockStore = buildMockStore();
  mockTrack = createMockTrack();
  mockStream = createMockStream(mockTrack);
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockStore);

  mockAcquire.mockReset().mockResolvedValue(mockAudioContext);
  mockRelease.mockReset();

  getUserMediaMock = vi.fn().mockResolvedValue(mockStream);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: getUserMediaMock,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ===========================================================================
// Tests
// ===========================================================================

describe('useArca ↔ useArcaAudio unification', () => {
  it('invokes getUserMedia exactly once when both hooks are mounted and start() is called once', async () => {
    const { result } = renderHook(() => {
      const arca = useArca();
      const audio = useArcaAudio();
      return { arca, audio };
    });

    await act(async () => {
      await result.current.arca.audio.start();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
  });

  it('routes start() through AudioContextManager (no raw new AudioContext)', async () => {
    const { result } = renderHook(() => {
      const arca = useArca();
      const audio = useArcaAudio();
      return { arca, audio };
    });

    await act(async () => {
      await result.current.arca.audio.start();
    });

    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockStore.setActiveStream).toHaveBeenCalledWith(mockStream);
    expect(mockStore.setActiveAudioContext).toHaveBeenCalledWith(mockAudioContext);
  });

  it('releases the microphone exactly once on stop()', async () => {
    const { result } = renderHook(() => {
      const arca = useArca();
      const audio = useArcaAudio();
      return { arca, audio };
    });

    await act(async () => {
      await result.current.arca.audio.start();
    });

    await act(async () => {
      await result.current.arca.audio.stop();
    });

    expect(mockTrack.stop).toHaveBeenCalledTimes(1);
    expect(mockStore.setActiveStream).toHaveBeenLastCalledWith(null);
  });

  it('does not re-release the microphone on host unmount after stop()', async () => {
    const { result, unmount } = renderHook(() => {
      const arca = useArca();
      const audio = useArcaAudio();
      return { arca, audio };
    });

    await act(async () => {
      await result.current.arca.audio.start();
    });

    await act(async () => {
      await result.current.arca.audio.stop();
    });

    expect(mockTrack.stop).toHaveBeenCalledTimes(1);

    unmount();

    expect(mockTrack.stop).toHaveBeenCalledTimes(1);
  });
});
