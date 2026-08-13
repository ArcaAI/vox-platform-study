/**
 * useArcaAudio — SDK audio-drop surfacing.
 *
 * The streaming STT provider counts backpressure drops, but on the SDK path the
 * count dead-ends. These tests lock the hook's role in the push chain:
 *   - it registers `onAudioDrop` in the plugin callbacks and, on each drop,
 *     latches the loss (`markAudioLost`) and bumps the count (`incrementDroppedFrames`);
 *   - it exposes `droppedFrameCount` + `audioLostThisSession` from the store;
 *   - it resets the signal on start AND stop (session-sticky latch).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Hoisted @arcaai/room mock (AudioContextManager) so start() needs no real Web Audio.
const roomMocks = vi.hoisted(() => {
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));
  return { acquire, getInstance };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioContextManager: { getInstance: roomMocks.getInstance },
  };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStoreData),
}));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

function createMockPluginManager(overrides: Record<string, any> = {}) {
  return {
    setRuntimeOptions: vi.fn(),
    clearRuntimeOptions: vi.fn(),
    setCallbacks: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    getStates: vi.fn(() => ({
      noiseFilter: { isActive: false, isSupported: true },
      vad: { isActive: true, isSupported: true },
      stt: { isActive: true, isSupported: true, isProcessing: false },
    })),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    getTranscriptionPipeline: vi.fn(() => null),
    getKnowledgePipeline: vi.fn(() => null),
    ...overrides,
  };
}

function setupStore(overrides: Record<string, any> = {}) {
  mockStoreData = {
    pluginManager: createMockPluginManager(),
    consultation: { id: 'cons-1' },
    apiClient: null,
    logger: null,
    preferences: {},

    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    transcriptSegments: [],
    audioLanguage: 'en',
    audioPlugins: {
      noiseFilter: { isActive: false, isSupported: false },
      vad: { isActive: false, isSupported: false },
      stt: { isActive: false, isSupported: false, isProcessing: false },
    },
    audioError: null,
    activeStream: null,
    activeAudioContext: null,

    // Audio-drop state
    audioDroppedFrameCount: 0,
    audioLostThisSession: false,

    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setActiveStream: vi.fn(),
    setActiveAudioContext: vi.fn(),
    addTranscriptSegment: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    // Audio-drop actions
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
    resetAudioDropped: vi.fn(),
    // Streaming STT connection/pipeline actions
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
    ...overrides,
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return mockStoreData;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useArcaAudio — audio-drop surfacing', () => {
  it('exposes droppedFrameCount and audioLostThisSession from the store', () => {
    setupStore({ audioDroppedFrameCount: 4, audioLostThisSession: true });

    const { result } = renderHook(() => useArcaAudio());

    expect(result.current.droppedFrameCount).toBe(4);
    expect(result.current.audioLostThisSession).toBe(true);
  });

  it('registers onAudioDrop that latches loss and bumps the count on each drop', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });

    // The hook must have wired an onAudioDrop callback into the plugin manager.
    const callbacks = pluginManager.setCallbacks.mock.calls[0]?.[0];
    expect(typeof callbacks?.onAudioDrop).toBe('function');

    // Driving a drop latches the session loss AND increments the per-session count.
    act(() => {
      callbacks.onAudioDrop(1);
    });

    expect(mockStoreData.markAudioLost).toHaveBeenCalledTimes(1);
    expect(mockStoreData.incrementDroppedFrames).toHaveBeenCalledTimes(1);

    // Two more drops → two more increments (one per frame).
    act(() => {
      callbacks.onAudioDrop(2);
      callbacks.onAudioDrop(3);
    });
    expect(mockStoreData.incrementDroppedFrames).toHaveBeenCalledTimes(3);
  });

  it('resets the drop signal when a new capture session starts', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });

    expect(mockStoreData.resetAudioDropped).toHaveBeenCalled();
  });

  it('resets the drop signal on stop (session-sticky latch clears on start/stop)', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });
    (mockStoreData.resetAudioDropped as any).mockClear();

    await act(async () => {
      await result.current.stop();
    });

    expect(mockStoreData.resetAudioDropped).toHaveBeenCalledTimes(1);
  });
});
