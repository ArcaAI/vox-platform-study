/**
 * compat `useAudioCapture` — `audioProcessing` forwarding (TASK-608).
 *
 * A v1-migrating app starts the mic HERE (before
 * `useArcaSpeechToText.startTranscription()`), so this hook is the boundary at
 * which the raw-capture request either reaches `audio.start` or dies. The
 * underlying `getUserMedia` change is unreachable from a compat app otherwise.
 *
 * Note this is BROWSER-level processing, deliberately separate from the v1
 * `audioSettings.noiseSuppression` flag — that one toggles the SDK's own
 * RNNoise pipeline stage. The two are independent, and an app that wants
 * genuinely unprocessed audio has to turn both off.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioCapture } from '../useAudioCapture';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn() }));
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAudioCapture — audioProcessing (TASK-608)', () => {
  let audioMock: { isCapturing: boolean; level: number; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    audioMock = { isCapturing: false, level: 0, start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    const storeState = { pendingSttProvider: null, setPendingSttProvider: vi.fn() };
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: typeof storeState) => unknown) =>
      selector(storeState),
    );
  });

  async function startWith(props: Record<string, unknown>) {
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' }, ...props }));
    await act(async () => {
      await result.current.startRecording();
    });
    return audioMock.start.mock.calls[0][0] as Record<string, unknown>;
  }

  it('forwards the raw-capture request verbatim to audio.start', async () => {
    const audioProcessing = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    expect(await startWith({ audioProcessing })).toEqual({ pipelineId: 'p1', audioProcessing });
  });

  it('carries audioProcessing alongside a selected external device', async () => {
    expect(await startWith({ deviceId: 'usb-array-1', audioProcessing: { autoGainControl: false } })).toEqual({
      pipelineId: 'p1',
      deviceId: 'usb-array-1',
      audioProcessing: { autoGainControl: false },
    });
  });

  it('produces the exact pre-608 options object when the prop is omitted', async () => {
    expect(await startWith({})).toEqual({ pipelineId: 'p1' });
  });
});
