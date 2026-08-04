/**
 * compat `useAudioCapture` — `dynamicSources` forwarding (TASK-609).
 *
 * TASK-609 taught `useArcaAudio.start()` to build an `AudioMixer` for a SINGLE
 * capture source when `dynamicSources: true` is passed, so sources can be
 * added/removed mid-session without tearing down the WebSocket session. This
 * hook is the boundary at which a v1-migrating app actually starts capture —
 * without forwarding, the option is unreachable from the compat surface even
 * though the native hook already understands it.
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

describe('useAudioCapture — dynamicSources (TASK-609)', () => {
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

  it('forwards dynamicSources: true verbatim to audio.start', async () => {
    expect(await startWith({ dynamicSources: true })).toEqual({ pipelineId: 'p1', dynamicSources: true });
  });

  it('combines correctly with device selection', async () => {
    expect(await startWith({ deviceId: 'usb-array-1', dynamicSources: true })).toEqual({
      pipelineId: 'p1',
      deviceId: 'usb-array-1',
      dynamicSources: true,
    });
  });

  it('produces the exact pre-609 options object when the prop is omitted', async () => {
    expect(await startWith({})).toEqual({ pipelineId: 'p1' });
  });

  it('does not add the key when dynamicSources is false', async () => {
    expect(await startWith({ dynamicSources: false })).toEqual({ pipelineId: 'p1' });
  });
});
