/**
 * useAudioCapture — CAPTURE_OPTIONS_DROPPED propagation.
 *
 * `useArcaAudio.startAudio`'s CALL-TIME idempotence guard now REJECTS (instead
 * of silently returning) when a second `start()` call lands while capture is
 * already active AND carries capture-shaped options (`sourceStreams`,
 * `deviceId`, ...) — see `task612-dropped-options.test.ts` for the guard's own
 * RED→GREEN coverage against the real hook.
 *
 * This file proves the OTHER half of AC-3: that rejection reaches the calling
 * hook. `useAudioCapture.startRecording()` (`../useAudioCapture.ts`) already
 * has a generic `catch (err) { setError(toErrorInfo(err)); onError?.(info);
 * throw err; }` around `audio.start(...)` — pre-existing, untouched by this
 * lane. Mirrors the `makeAudioMock`/`installStore` harness from the sibling
 * `useAudioCapture.test.ts` (not edited by this lane) with a double whose
 * `start()` rejects with the exact `AgenticError` the real guard now throws,
 * so this file characterizes the propagation CONTRACT at the compat boundary
 * without re-deriving the real guard's cross-module store wiring (that
 * integration is exercised end-to-end by ticket Lane I's e2e suite).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioCapture } from '../useAudioCapture';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';
import { AgenticError } from '../../types';

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

let storeState: { pendingSttProvider: 'primary' | 'fallback' | null; setPendingSttProvider: (v: 'primary' | 'fallback' | null) => void };
function installStore() {
  storeState = {
    pendingSttProvider: null,
    setPendingSttProvider: vi.fn((v) => {
      storeState.pendingSttProvider = v;
    }),
  };
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
  );
}

describe('useAudioCapture — CAPTURE_OPTIONS_DROPPED propagation', () => {
  beforeEach(() => {
    installStore();
  });

  it('(e) startRecording() rejects, sets `error`, and fires onError when audio.start() rejects with CAPTURE_OPTIONS_DROPPED', async () => {
    const rejection = new AgenticError(
      'CAPTURE_OPTIONS_DROPPED',
      "useArcaAudio.start: capture is already active, so this call's capture-shaped option(s) were dropped — sourceStreams. " +
        'Start capture from the hook that carries the sources BEFORE starting transcription.',
    );
    const audioMock = makeAudioMock({ start: vi.fn().mockRejectedValue(rejection) });
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);

    const onError = vi.fn();
    const streams = [{ id: 'ext-mic' }] as unknown as MediaStream[];
    const { result } = renderHook(() =>
      useAudioCapture({ options: { sttPipelineId: 'p1' }, sourceStreams: streams, onError }),
    );

    // Confirms the realistic scenario: this hook forwarded `sourceStreams` to
    // `audio.start(...)` — the exact call the real guard would have rejected
    // (the STT hook won the start race and the mic hook's sources were
    // dropped).
    await act(async () => {
      await expect(result.current.startRecording()).rejects.toBe(rejection);
    });
    expect(audioMock.start).toHaveBeenCalledWith(expect.objectContaining({ sourceStreams: streams }));

    // `error` state + `onError` — code/message specificity. Note:
    // `useAudioCapture`'s `toErrorInfo()` hardcodes `ErrorInfo.code` to
    // `'AUDIO_CAPTURE_ERROR'` for every thrown error (it does not thread the
    // wrapped `AgenticError.code` through) — so the assertion below is on the
    // propagated MESSAGE, which is the field that actually carries the
    // dropped-options detail across this boundary.
    expect(result.current.error).toEqual(
      expect.objectContaining({
        code: 'AUDIO_CAPTURE_ERROR',
        message: expect.stringContaining('sourceStreams'),
      }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('sourceStreams') }));
  });

  it('(e-control) startRecording() resolves and never calls onError on the happy path (sanity check for the mock harness above)', async () => {
    const audioMock = makeAudioMock();
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    const onError = vi.fn();
    const { result } = renderHook(() => useAudioCapture({ options: { sttPipelineId: 'p1' }, onError }));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});
