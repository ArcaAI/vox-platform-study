/**
 * @vitest-environment jsdom
 *
 * The delivered-metadata timeline anchor is lost when CAPTURE starts first.
 *
 * The compat layer drives ONE audio graph through TWO hooks. `useAudioCapture`
 * is the only one carrying device/source selection, so an app that lets a user
 * pick a microphone must start capture from THAT hook — and in that order
 * `audio.isCapturing` is already true when `startTranscription()` runs, its
 * idempotency guard returns early, and the capture-relative base
 * (`captureStartMsRef`) is never established.
 *
 * Both consequences are silent:
 *  - `sendAudioData(pcm, metadata)` stamps `atMs = 0` on EVERY timeline entry,
 *    so the timeline collapses onto a single instant;
 *  - `pickMetadataForFinal(..., captureStartMs = undefined)` degrades to sticky
 * "most-recent", so per-segment metadata attribution is lost
 *    a clinician's `role`/`device_id` lands on the wrong utterance.
 *
 * These tests observe the anchor the only way an app can: through WHICH caller
 * metadata a delivered final is attributed to. With a correct anchor a final
 * whose `startTime` falls between two `sendAudioData` calls carries the EARLIER
 * one; with the anchor missing (all `atMs = 0`, or the sticky degrade) it
 * carries the most recent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSpeechToText } from '../useArcaSpeechToText';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn() }));

// The batch/upload members are untouched here; stub the service so the module
// graph stays light (same shape the sibling suites use).
vi.mock('../../core/FileTranscriptionService', () => ({
  FileTranscriptionService: class {
    uploadAndTranscribeWithProgress = vi.fn();
    getJob = vi.fn();
    cancelJob = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

type MockState = {
  transcriptSegments: unknown[];
  currentTranscript: string;
  setAudioLanguage?: (language: string) => void;
  setSttLanguageMode?: (mode: string | undefined) => void;
  pendingSttProvider?: 'primary' | 'fallback' | null;
  setPendingSttProvider?: (v: 'primary' | 'fallback' | null) => void;
  apiClient?: unknown;
  logger?: unknown;
};

function installStore(state: MockState): void {
  // Augment in place — tests reassign `state.transcriptSegments` and rerender,
  // relying on the mock reading the live reference.
  state.setAudioLanguage ??= vi.fn();
  state.setSttLanguageMode ??= vi.fn();
  state.pendingSttProvider ??= null;
  state.setPendingSttProvider ??= vi.fn();
  state.apiClient ??= null;
  state.logger ??= null;
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: MockState) => unknown) => selector(state));
}

const audioMock = {
  isCapturing: false,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  sttConnectionState: 'connected' as string,
  activePipeline: null as { id: string; isFallback: boolean } | null,
};

const baseProps = { sessionId: 'session-1', language: 'en' };

describe('useArcaSpeechToText — capture-relative timeline anchor', () => {
  let now: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    audioMock.isCapturing = false;
    audioMock.sttConnectionState = 'connected';
    audioMock.activePipeline = null;
    audioMock.start.mockClear().mockResolvedValue(undefined);
    audioMock.stop.mockClear().mockResolvedValue(undefined);
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    now = vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Deliver one final at `startTime` seconds; return the `role` the timeline attributed to it. */
  function roleAttributedToFinal(
    state: MockState,
    rerender: () => void,
    onTranscript: ReturnType<typeof vi.fn>,
    startTime: number,
  ): unknown {
    state.transcriptSegments = [...state.transcriptSegments, { text: 'utterance', isFinal: true, startTime, endTime: startTime + 1 }];
    act(() => rerender());
    const calls = onTranscript.mock.calls;
    return (calls[calls.length - 1][2] as Record<string, unknown>).role;
  }

  it('anchors when useAudioCapture won the start race (capture-first, flip after mount)', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    now.mockReturnValue(1000);
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    // The device-selecting hook started the SHARED graph at t=2000.
    audioMock.isCapturing = true;
    now.mockReturnValue(2000);
    act(() => rerender());

    // The app still calls startTranscription; the idempotency guard early-returns.
    await act(async () => {
      await result.current.startTranscription();
    });
    expect(audioMock.start).not.toHaveBeenCalled();

    now.mockReturnValue(2100); // atMs = 100
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(5000); // atMs = 3000
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    // final at startTime=1s → 1000ms: only the atMs=100 entry precedes it.
    // Without the anchor both entries are atMs 0 (or the sticky degrade fires)
    // and the final wrongly carries 'patient'.
    expect(roleAttributedToFinal(state, rerender, onTranscript, 1)).toBe('clinician');
  });

  it('anchors when capture is ALREADY active at mount (hook mounted mid-capture)', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    audioMock.isCapturing = true;
    now.mockReturnValue(2000);
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    now.mockReturnValue(2100); // atMs = 100
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(5000); // atMs = 3000
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    expect(roleAttributedToFinal(state, rerender, onTranscript, 1)).toBe('clinician');
  });

  it('still anchors on the STT-first order (no regression)', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    now.mockReturnValue(1000);
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));
    await act(async () => {
      await result.current.startTranscription();
    });
    expect(audioMock.start).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1100); // atMs = 100
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(4000); // atMs = 3000
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    expect(roleAttributedToFinal(state, rerender, onTranscript, 1)).toBe('clinician');
  });

  it('does not RE-anchor when the capture flip arrives after an STT-first start', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    now.mockReturnValue(1000); // startTranscription anchors here
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));
    await act(async () => {
      await result.current.startTranscription();
    });

    // The graph reports capturing only 3s later; the base must stay at 1000.
    audioMock.isCapturing = true;
    now.mockReturnValue(4000);
    act(() => rerender());

    now.mockReturnValue(4100); // atMs = 3100 (would be 100 if re-anchored)
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(8000); // atMs = 7000 (would be 4000 if re-anchored)
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    // final at startTime=4s → 4000ms: with the original base only the atMs=3100
    // entry precedes; a re-anchored base would let BOTH precede → 'patient'.
    expect(roleAttributedToFinal(state, rerender, onTranscript, 4)).toBe('clinician');
  });

  it('re-anchors afresh after stopTranscription, on the next capture', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    audioMock.isCapturing = true;
    now.mockReturnValue(1000);
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    now.mockReturnValue(1100);
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'first-session' }));

    await act(async () => {
      await result.current.stopTranscription();
    });
    audioMock.isCapturing = false;
    act(() => rerender());

    // Re-open at t=10000 — the base must follow, not stay at 1000.
    audioMock.isCapturing = true;
    now.mockReturnValue(10000);
    act(() => rerender());

    now.mockReturnValue(10100); // atMs = 100
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(13000); // atMs = 3000
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    // A stale base (1000) puts BOTH entries beyond a startTime=1s final → sticky
    // 'patient'; a fresh base attributes it to 'clinician'.
    expect(roleAttributedToFinal(state, rerender, onTranscript, 1)).toBe('clinician');
  });

  it('does not drift the anchor across repeated renders while capturing', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    audioMock.isCapturing = true;
    now.mockReturnValue(2000); // the one true base
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    now.mockReturnValue(3000);
    act(() => rerender());
    now.mockReturnValue(4000);
    act(() => rerender());

    now.mockReturnValue(4100); // atMs = 2100 (would be 100 if the base drifted to 4000)
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(8000); // atMs = 6000 (would be 4000 if the base drifted)
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    // final at startTime=4s → 4000ms: a drifted base would let BOTH entries
    // precede and deliver 'patient'.
    expect(roleAttributedToFinal(state, rerender, onTranscript, 4)).toBe('clinician');
  });
});
