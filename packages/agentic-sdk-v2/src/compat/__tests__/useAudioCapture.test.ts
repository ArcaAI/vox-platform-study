/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioCapture } from '../useAudioCapture';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../hooks/useArcaAudio', () => ({
  useArcaAudio: vi.fn(),
}));
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

function makeAudioMock(overrides: Record<string, unknown> = {}) {
  return {
    isCapturing: false,
    level: 0,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Reactive store mock for the pre-start selection plus the diagnostics fields. The diagnostics are optional on the mock shape
// (not just the value) so `installStore()` with no third argument reproduces
// a test-double store that never set them at all — the "undefined" case the
// hook must degrade from, not merely a store that set them to a falsy value.
let storeState: {
  pendingSttProvider: 'primary' | 'fallback' | null;
  setPendingSttProvider: (v: 'primary' | 'fallback' | null) => void;
  audioUplinkBitrate?: number;
  audioLostThisSession?: boolean;
  audioDroppedFrameCount?: number;
};
function installStore(
  pendingSttProvider: 'primary' | 'fallback' | null = null,
  diagnostics: { audioUplinkBitrate?: number; audioLostThisSession?: boolean; audioDroppedFrameCount?: number } = {},
) {
  storeState = {
    pendingSttProvider,
    setPendingSttProvider: vi.fn((v) => {
      storeState.pendingSttProvider = v;
    }),
    ...diagnostics,
  };
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
  );
}

describe('useAudioCapture', () => {
  let audioMock: ReturnType<typeof makeAudioMock>;

  beforeEach(() => {
    audioMock = makeAudioMock();
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    installStore();
  });

  it('startRecording → audio.start()', async () => {
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledTimes(1);
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1' });
  });

  it('forwards the end-user language + languageMode to audio.start (order-independent pick)', async () => {
    const { result } = renderHook(() =>
      useAudioCapture({ options: { sttPipelineId: 'p1' }, language: 'en', languageMode: 'en' }),
    );
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1', language: 'en', languageMode: 'en' });
  });

  it('forwards the pending pre-start provider selection as startOn and clears it', async () => {
    installStore('fallback');
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1', startOn: 'fallback' });
    expect(storeState.setPendingSttProvider).toHaveBeenCalledWith(null);
  });

  it('omits startOn from audio.start when no pre-start selection is pending', async () => {
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1' });
    expect(storeState.setPendingSttProvider).not.toHaveBeenCalled();
  });

  it('omits language/languageMode from audio.start when not selected (frozen v1 shape)', async () => {
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1' });
  });

  // Audio source selection. Before it, these fields were dropped on
  // the floor and a compat consumer could only ever record the default mic.
  it('forwards mic selection (deviceId/secondaryDeviceId/additionalDeviceIds) + gains to audio.start', async () => {
    const { result } = renderHook(() =>
      useAudioCapture({
        options: { sttPipelineId: 'p1' },
        deviceId: 'mic-A',
        secondaryDeviceId: 'mic-B',
        additionalDeviceIds: ['mic-C'],
        sourceGains: [1, 0.8, 0.6],
      }),
    );
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({
      pipelineId: 'p1',
      deviceId: 'mic-A',
      secondaryDeviceId: 'mic-B',
      additionalDeviceIds: ['mic-C'],
      sourceGains: [1, 0.8, 0.6],
    });
  });

  it('forwards pre-built sourceStreams (file-backed capture) to audio.start', async () => {
    const streams = [{ id: 'file-1' }, { id: 'file-2' }] as unknown as MediaStream[];
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' }, sourceStreams: streams }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1', sourceStreams: streams });
  });

  it('omits every source field from audio.start when none is selected (frozen v1 shape)', async () => {
    const { result } = renderHook(() =>
      useAudioCapture({ options: { sttPipelineId: 'p1' }, additionalDeviceIds: [], sourceStreams: [], sourceGains: [] }),
    );
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1' });
  });

  it('is idempotent when capture already running (no double-start with the STT hook)', async () => {
    audioMock = makeAudioMock({ isCapturing: true });
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    const { result } = renderHook(() => useAudioCapture({}));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).not.toHaveBeenCalled();
  });

  it('stopRecording → audio.stop() when capturing', async () => {
    audioMock = makeAudioMock({ isCapturing: true });
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    const { result } = renderHook(() => useAudioCapture({}));
    await act(async () => {
      await result.current.stopRecording();
    });
    expect(audioMock.stop).toHaveBeenCalledTimes(1);
  });

  it('reflects capture state via isRecording', () => {
    audioMock = makeAudioMock({ isCapturing: true });
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    const { result } = renderHook(() => useAudioCapture({}));
    expect(result.current.isRecording).toBe(true);
    expect(result.current.isReady).toBe(true);
  });

  it('never invokes onAudioData (v2 owns PCM transport)', async () => {
    const onAudioData = vi.fn();
    const { result } = renderHook(() => useAudioCapture({ onAudioData }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(onAudioData).not.toHaveBeenCalled();
  });

  // Compat diagnostics parity. Backpressure audio
  // loss and uplink bitrate previously lived only on the v2 store (finding
  // I-3); these fields let a compat integrator tell "silence is being sent"
  // from "nothing is being sent" without reaching into the store directly.
  describe('diagnostics fields', () => {
    it('reflects uplinkBitrate/audioLost/droppedFrames from the store and updates reactively as the store writes them', () => {
      installStore(null, { audioUplinkBitrate: 128_000, audioLostThisSession: true, audioDroppedFrameCount: 3 });
      const { result, rerender } = renderHook(() => useAudioCapture({}));

      expect(result.current.uplinkBitrate).toBe(128_000);
      expect(result.current.audioLost).toBe(true);
      expect(result.current.droppedFrames).toBe(3);

      // Simulate the store publishing new values mid-session (e.g. the 1 Hz
      // uplink sampler and another dropped frame) and re-render, mirroring
      // how a real Zustand subscription would propagate the write.
      storeState.audioUplinkBitrate = 256_000;
      storeState.audioLostThisSession = false;
      storeState.audioDroppedFrameCount = 7;
      rerender();

      expect(result.current.uplinkBitrate).toBe(256_000);
      expect(result.current.audioLost).toBe(false);
      expect(result.current.droppedFrames).toBe(7);
    });

    it('defaults uplinkBitrate/audioLost/droppedFrames to 0/false/0 when the store never set them', () => {
      installStore(); // no diagnostics — a test-double store lacking these fields entirely
      const { result } = renderHook(() => useAudioCapture({}));

      expect(result.current.uplinkBitrate).toBe(0);
      expect(result.current.audioLost).toBe(false);
      expect(result.current.droppedFrames).toBe(0);
    });

    it('keeps every pre-existing return key present alongside the new diagnostics fields (frozen v1 shape, superset check)', () => {
      const { result } = renderHook(() => useAudioCapture({}));
      const preExistingKeys = [
        'isRecording',
        'deviceStatus',
        'sourceLevels',
        'startRecording',
        'stopRecording',
        'getDeviceStatus',
        'error',
        'isReady',
      ];
      for (const key of preExistingKeys) {
        expect(result.current).toHaveProperty(key);
      }
      expect(result.current).toHaveProperty('uplinkBitrate');
      expect(result.current).toHaveProperty('audioLost');
      expect(result.current).toHaveProperty('droppedFrames');
    });
  });
});
