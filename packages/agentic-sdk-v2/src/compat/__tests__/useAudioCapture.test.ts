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

// Reactive store mock for the TASK-586 pre-start selection.
let storeState: { pendingSttProvider: 'primary' | 'fallback' | null; setPendingSttProvider: (v: 'primary' | 'fallback' | null) => void };
function installStore(pendingSttProvider: 'primary' | 'fallback' | null = null) {
  storeState = {
    pendingSttProvider,
    setPendingSttProvider: vi.fn((v) => {
      storeState.pendingSttProvider = v;
    }),
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

  it('forwards the pending pre-start provider selection as startOn and clears it (TASK-586)', async () => {
    installStore('fallback');
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ pipelineId: 'p1', startOn: 'fallback' });
    expect(storeState.setPendingSttProvider).toHaveBeenCalledWith(null);
  });

  it('omits startOn from audio.start when no pre-start selection is pending (TASK-586)', async () => {
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
});
