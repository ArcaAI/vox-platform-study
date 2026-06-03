/**
 * useArcaAudio — Clinical Playground consolidation tests (TASK-331 doc-06).
 *
 * Covers the SDK bucket of the Developer Playgrounds — Clinical review:
 *   - F3 / Q5: mic selection (`deviceId`), 2-mic mixing (`secondaryDeviceId`)
 *     via @arcaai/room's `AudioMixer`, and prefs-driven `startFromPreferences()`.
 *   - F2: dual-capture wiring (`dualCaptureEnabled`) using `DualStreamRecorder`
 *     fed by the pipeline's raw + processed tracks, surfaced via `onDualCapture`.
 *   - Regression: `start()` with no options behaves exactly as before.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Hoisted mocks for @arcaai/room (AudioMixer + AudioContextManager) and the
// core DualStreamRecorder so we can assert wiring without real Web Audio.
// ---------------------------------------------------------------------------
const roomMocks = vi.hoisted(() => {
  const mixerCtor = vi.fn();
  const addSource = vi.fn();
  const getMixedTrack = vi.fn(() => ({ kind: 'audio', label: 'mixed-track' }));
  const dispose = vi.fn();

  class MockAudioMixer {
    constructor(ctx: unknown) {
      mixerCtor(ctx);
    }
    addSource = addSource;
    getMixedTrack = getMixedTrack;
    dispose = dispose;
  }

  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));

  return { mixerCtor, addSource, getMixedTrack, dispose, MockAudioMixer, acquire, getInstance };
});

const dualMocks = vi.hoisted(() => {
  const ctor = vi.fn();
  const startSpy = vi.fn();
  const stopSpy = vi.fn(async () => ({ raw: new Blob(['raw']), processed: new Blob(['proc']) }));

  class MockDualStreamRecorder {
    private running = false;
    constructor(rawTrack: unknown, processedTrack: unknown, options?: unknown) {
      ctor(rawTrack, processedTrack, options);
    }
    get isRecording(): boolean {
      return this.running;
    }
    start(): void {
      this.running = true;
      startSpy();
    }
    async stop() {
      this.running = false;
      return stopSpy();
    }
  }

  return { ctor, startSpy, stopSpy, MockDualStreamRecorder };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioMixer: roomMocks.MockAudioMixer,
    AudioContextManager: { getInstance: roomMocks.getInstance },
  };
});

vi.mock('../../core/DualStreamRecorder', () => ({
  DualStreamRecorder: dualMocks.MockDualStreamRecorder,
}));

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStoreData),
}));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, stop: vi.fn() };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    _track: track,
  };
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
    ...overrides,
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return mockStoreData;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => makeStream('default')),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// F3 — mic selection
// ===========================================================================
describe('useArcaAudio — F3 mic selection (deviceId)', () => {
  it('start({ deviceId }) requests the specified device via an exact constraint', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-123' });
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'mic-123' } },
    });
  });
});

// ===========================================================================
// F3 — 2-mic mixing via @arcaai/room AudioMixer
// ===========================================================================
describe('useArcaAudio — F3 dual-mic mixing (secondaryDeviceId)', () => {
  it('start({ secondaryDeviceId }) mixes both inputs and initializes the pipeline with the mixed track', async () => {
    const primary = makeStream('primary');
    const secondary = makeStream('secondary');
    (navigator.mediaDevices.getUserMedia as any)
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(secondary);

    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    // Both microphones were opened.
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-A' } } });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-B' } } });

    // The room AudioMixer combined the two streams.
    expect(roomMocks.mixerCtor).toHaveBeenCalledTimes(1);
    expect(roomMocks.addSource).toHaveBeenCalledTimes(2);
    expect(roomMocks.getMixedTrack).toHaveBeenCalled();

    // The pipeline is initialized with the mixed track, not the raw primary.
    expect(pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'mixed-track' }),
      expect.objectContaining({ sampleRate: 48000 }),
    );
  });
});

// ===========================================================================
// F3 / Q5 — prefs-driven start
// ===========================================================================
describe('useArcaAudio — F3/Q5 startFromPreferences()', () => {
  it('exists as an action', () => {
    const { result } = renderHook(() => useArcaAudio());
    expect(typeof result.current.startFromPreferences).toBe('function');
  });

  it('derives options from prefs/config (remote workflow → backend pipeline) and starts', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({
      pluginManager,
      preferences: {
        language: 'th',
        workflowMode: 'remote',
        remoteConfig: { pipelineId: 'pipe-xyz', assignedBy: 'admin' },
        custom: { deviceId: 'mic-A' },
      },
    });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.startFromPreferences();
    });

    // Language derived from prefs.
    expect(mockStoreData.setAudioLanguage).toHaveBeenCalledWith('th');
    // Device derived from prefs.custom.
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-A' } } });
    // Backend STT provider chosen → pipelineId forwarded to the plugin manager.
    expect(pluginManager.setRuntimeOptions).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: 'pipe-xyz', language: 'th' }),
    );
  });

  it('omits the backend pipeline when workflow is local (local STT provider)', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({
      pluginManager,
      preferences: {
        language: 'en',
        workflowMode: 'local',
        remoteConfig: { pipelineId: 'pipe-should-not-be-used', assignedBy: 'admin' },
      },
    });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.startFromPreferences();
    });

    expect(pluginManager.setRuntimeOptions).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: undefined }),
    );
  });
});

// ===========================================================================
// F2 — dual-capture wiring
// ===========================================================================
describe('useArcaAudio — F2 dual capture (dualCaptureEnabled)', () => {
  it('constructs DualStreamRecorder from pipeline tracks and emits blobs via onDualCapture on stop', async () => {
    const rawTrack = { kind: 'audio', label: 'raw' };
    const processedTrack = { kind: 'audio', label: 'processed' };
    const pipeline = {
      getRawInputTrack: vi.fn(() => rawTrack),
      getProcessedTrack: vi.fn(() => processedTrack),
    };
    const pluginManager = createMockPluginManager({
      getTranscriptionPipeline: vi.fn(() => pipeline),
    });
    setupStore({ pluginManager, preferences: { workflowMode: 'local' } });

    const onDualCapture = vi.fn();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ dualCaptureEnabled: true, onDualCapture });
    });

    // Recorder built from the pre-noise-filter (raw) and post-filter (processed) tracks.
    expect(dualMocks.ctor).toHaveBeenCalledWith(rawTrack, processedTrack, undefined);
    expect(dualMocks.startSpy).toHaveBeenCalledTimes(1);
    expect(onDualCapture).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.stop();
    });

    expect(dualMocks.stopSpy).toHaveBeenCalledTimes(1);
    expect(onDualCapture).toHaveBeenCalledWith({
      raw: expect.any(Blob),
      processed: expect.any(Blob),
    });
  });

  it('does not wire dual capture when the workflow is remote', async () => {
    const pipeline = {
      getRawInputTrack: vi.fn(() => ({ kind: 'audio', label: 'raw' })),
      getProcessedTrack: vi.fn(() => ({ kind: 'audio', label: 'processed' })),
    };
    const pluginManager = createMockPluginManager({
      getTranscriptionPipeline: vi.fn(() => pipeline),
    });
    setupStore({ pluginManager, preferences: { workflowMode: 'remote' } });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ dualCaptureEnabled: true });
    });

    expect(dualMocks.ctor).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Regression — start() with no options is unchanged
// ===========================================================================
describe('useArcaAudio — regression: start() with no options', () => {
  it('requests a plain audio stream and wires no mixer / recorder', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(roomMocks.mixerCtor).not.toHaveBeenCalled();
    expect(dualMocks.ctor).not.toHaveBeenCalled();
    expect(pluginManager.initialize).toHaveBeenCalledTimes(1);
    expect(mockStoreData.setIsCapturing).toHaveBeenCalledWith(true);
  });
});
