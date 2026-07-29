/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioCapture } from '../useAudioCapture';
import { useArcaAudio } from '../../hooks/useArcaAudio';

vi.mock('../../hooks/useArcaAudio', () => ({
  useArcaAudio: vi.fn(),
}));

function makeAudioMock(overrides: Record<string, unknown> = {}) {
  return {
    isCapturing: false,
    level: 0,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('useAudioCapture', () => {
  let audioMock: ReturnType<typeof makeAudioMock>;

  beforeEach(() => {
    audioMock = makeAudioMock();
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
  });

  it('startRecording → audio.start()', async () => {
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startRecording();
    });
    expect(audioMock.start).toHaveBeenCalledTimes(1);
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
