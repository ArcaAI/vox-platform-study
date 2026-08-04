/**
 * useArcaAudio — browser audio-processing constraints (TASK-608).
 *
 * The SDK applies no gain, no noise suppression and no VAD gating of its own on
 * the backend-streaming path, but it called `getUserMedia` with NO audio
 * constraints — which is not the same thing as "unprocessed". Chrome, Edge and
 * Safari all default `echoCancellation`, `noiseSuppression` and
 * `autoGainControl` to ON, so every integrator was silently getting a
 * browser-DSP'd, auto-gained stream with no way to opt out through the SDK.
 *
 * `audioProcessing` is that opt-out: it is spread into the constraint object of
 * EVERY resolved source, so a caller can request genuinely raw capture.
 * Omitting it must reproduce the pre-608 request byte-for-byte.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const roomMocks = vi.hoisted(() => {
  const addSource = vi.fn();
  class MockAudioMixer {
    constructor(_ctx: unknown) {}
    addSource = addSource;
    getMixedTrack = () => ({ kind: 'audio', label: 'mixed-track' });
    dispose = vi.fn();
  }
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  return { MockAudioMixer, addSource, getInstance: vi.fn(() => ({ acquire })) };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioMixer: roomMocks.MockAudioMixer,
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
  const track = { kind: 'audio', label, enabled: true, readyState: 'live' as const, stop: vi.fn() };
  return { label, getAudioTracks: () => [track], getTracks: () => [track] };
}

function setupStore() {
  mockStoreData = {
    pluginManager: {
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getStates: vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: true },
        vad: { isActive: false, isSupported: true },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getTranscriptionPipeline: vi.fn(() => null),
      getKnowledgePipeline: vi.fn(() => null),
    },
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
    setAudioSourceLevels: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
    setSttLanguageMode: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setActiveStream: vi.fn(),
    setActiveAudioContext: vi.fn(),
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
    setAudioUplinkBitrate: vi.fn(),
    addTranscriptSegment: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    resetAudioDropped: vi.fn(),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
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

describe('useArcaAudio — audioProcessing constraints (TASK-608)', () => {
  it('requests the default mic with browser DSP disabled when asked for raw capture', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({
        audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    });

    expect((navigator.mediaDevices.getUserMedia as any).mock.calls[0][0]).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  });

  it('merges the constraints with an exact deviceId instead of replacing it', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({
        deviceId: 'mic-A',
        audioProcessing: { noiseSuppression: false, autoGainControl: false },
      });
    });

    expect((navigator.mediaDevices.getUserMedia as any).mock.calls[0][0]).toEqual({
      audio: { deviceId: { exact: 'mic-A' }, noiseSuppression: false, autoGainControl: false },
    });
  });

  it('applies the same constraints to EVERY source of a multi-mic capture', async () => {
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    ['mic-A', 'mic-B', 'mic-C'].map(makeStream).forEach((s) => getUserMedia.mockResolvedValueOnce(s));

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({
        deviceId: 'mic-A',
        secondaryDeviceId: 'mic-B',
        additionalDeviceIds: ['mic-C'],
        audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    });

    ['mic-A', 'mic-B', 'mic-C'].forEach((id, index) => {
      expect(getUserMedia.mock.calls[index][0]).toEqual({
        audio: {
          deviceId: { exact: id },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    });
  });

  it('emits only the keys the caller stated a preference for', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ audioProcessing: { autoGainControl: false } });
    });

    expect((navigator.mediaDevices.getUserMedia as any).mock.calls[0][0]).toEqual({
      audio: { autoGainControl: false },
    });
  });

  it('reproduces the pre-608 request exactly when the option is omitted', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({});
    });

    // `{ audio: true }` — NOT `{ audio: {} }`. An empty constraint object is a
    // different request shape, and the browser-default behaviour every existing
    // integrator relies on hangs off this exact literal.
    expect((navigator.mediaDevices.getUserMedia as any).mock.calls[0][0]).toEqual({ audio: true });
  });

  it('ignores an empty audioProcessing object rather than degrading to `{ audio: {} }`', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ audioProcessing: {} });
    });

    expect((navigator.mediaDevices.getUserMedia as any).mock.calls[0][0]).toEqual({ audio: true });
  });
});
