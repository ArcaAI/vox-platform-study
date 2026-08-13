/**
 * compat `useAudioCapture` — `quietWindowMs` forwarding.
 *
 * The compat playground starts the mic HERE (before
 * `useArcaSpeechToText.startTranscription()`), so whichever options this hook
 * passes are the ones that win the shared-audio start race. A knob that stops
 * at this boundary is unreachable from a v1-migrating app no matter how well
 * it is threaded underneath.
 *
 * `0` is asserted explicitly: it is the "wait for the terminal status instead
 * of a quiet lull" setting, and the spread guard is `>= 0` rather than the
 * truthiness check its `drainTimeoutMs` neighbour uses.
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

describe('useAudioCapture — quietWindowMs', () => {
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

  it('PRESERVES quietWindowMs: 0 on the way to audio.start', async () => {
    expect(await startWith({ quietWindowMs: 0 })).toHaveProperty('quietWindowMs', 0);
  });

  it('forwards a positive quietWindowMs', async () => {
    expect(await startWith({ quietWindowMs: 3000 })).toHaveProperty('quietWindowMs', 3000);
  });

  it('carries both drain knobs together — the tail-final configuration a corpus run needs', async () => {
    expect(await startWith({ drainTimeoutMs: 30_000, quietWindowMs: 0 })).toEqual({
      pipelineId: 'p1',
      drainTimeoutMs: 30_000,
      quietWindowMs: 0,
    });
  });

  it.each([-1, Number.NaN])('drops a meaningless quietWindowMs (%p)', async (value) => {
    expect(await startWith({ quietWindowMs: value })).not.toHaveProperty('quietWindowMs');
  });

  it('produces the exact pre-597 options object when neither knob is set', async () => {
    expect(await startWith({})).toEqual({ pipelineId: 'p1' });
  });
});
