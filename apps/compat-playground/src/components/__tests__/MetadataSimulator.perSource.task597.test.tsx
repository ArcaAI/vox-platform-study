import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// TASK-597 open follow-up #2 — auto-tag attributes by the LOUDEST MIC.
//
// The original lane-C auto-tag could not tell which microphone was speaking
// (the SDK exposed one mixed meter) so it rotated round-robin and said so.
// `useAudioCapture` now publishes `sourceLevels` — one live level per capture
// source — and these tests pin the behaviour that difference buys:
//
//   • the row that is sent corresponds to the loudest source, not to a cursor;
//   • a change of loudest source mid-utterance re-tags immediately (a speaker
//     change must not wait for silence);
//   • one sustained utterance on one mic still emits exactly once;
//   • when there is NO per-source signal, the old rotation is still there and
//     the UI says which of the two modes is running.
//
// The mock capture hook re-renders on level changes the way the real
// store-backed hook does — a plain mutable would leave the provider reading a
// stale array and prove nothing.
// ---------------------------------------------------------------------------

const sendAudioDataMock = vi.fn();
const getDeviceStatusMock = vi.fn().mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 0 });

const levelState = vi.hoisted(() => {
  const subscribers = new Set<() => void>();
  return {
    current: [] as number[],
    subscribers,
    set(next: number[]) {
      this.current = next;
      subscribers.forEach((notify) => notify());
    },
    reset() {
      this.current = [];
    },
  };
});

vi.mock('@arcaai/vox/compat', async () => {
  const { useEffect, useReducer } = await vi.importActual<typeof import('react')>('react');
  return {
    ArcaCompatProvider: ({ children }: { children: ReactNode }) => children,
    useArcaSessionManager: () => ({ session: { id: 'sess-1', status: 'ACTIVE' }, isLoading: false, error: null }),
    useAudioCapture: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        const notify = () => force();
        levelState.subscribers.add(notify);
        return () => {
          levelState.subscribers.delete(notify);
        };
      }, []);
      return {
        isRecording: true,
        deviceStatus: null,
        sourceLevels: levelState.current,
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        getDeviceStatus: getDeviceStatusMock,
        error: null,
        isReady: true,
      };
    },
    useArcaSpeechToText: () => ({
      transcript: '',
      startTranscription: vi.fn(),
      stopTranscription: vi.fn(),
      sendAudioData: sendAudioDataMock,
      uploadAudioFile: vi.fn(),
      getTranscriptionStatus: vi.fn(),
      isUploading: false,
      uploadProgress: 0,
      error: null,
    }),
    useArcaSttLanguageModes: () => ({ modes: [], isLoading: false, error: null, refresh: vi.fn() }),
    useArcaSttProvider: () => ({
      usePipeline: false,
      switchStatus: 'idle',
      activeProvider: null,
      isFallbackActive: false,
      switchToPipeline: vi.fn(),
      switchToDefault: vi.fn(),
    }),
    useSMR: () => ({
      preSummarize: vi.fn(),
      summarize: vi.fn(),
      summarizeSync: vi.fn(),
      summarizeAsync: vi.fn(),
      loading: false,
      error: null,
    }),
  };
});

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { App } from '../../App';

const POLL_MS = 200;

async function connectAndEnableAutoTag(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.clear(screen.getByLabelText(/API endpoint/i));
  await user.type(screen.getByLabelText(/API endpoint/i), 'http://localhost:8868');
  await user.type(screen.getByLabelText(/API key/i), 'test-key');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('button', { name: 'Disconnect' });
  await user.click(screen.getByRole('tab', { name: 'Live transcription' }));
  await user.click(screen.getByRole('switch', { name: 'Auto-tag metadata rows on input level' }));
}

/**
 * Publish new per-source levels and let the poll observe them.
 *
 * TWO `act` calls on purpose: the level update must be COMMITTED (the provider
 * copies the array into its poll ref during render) before the interval runs.
 * Advancing fake timers inside the same `act` as the state update runs the poll
 * against the previous render's ref and the assertions all read as "no
 * per-source signal".
 */
async function publishLevels(levels: number[], ticks = 2) {
  await act(async () => {
    levelState.set(levels);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS * ticks);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  sendAudioDataMock.mockClear();
  getDeviceStatusMock.mockClear();
  getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 0 });
  levelState.reset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MetadataSimulator — auto-tag attributes to the loudest source', () => {
  it('sends the row of the LOUDEST mic, not the next row in rotation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    // Mic 2 is speaking; mic 1 is near-silent. A round-robin cursor would have
    // sent row 1 here — that was exactly the dishonest part.
    await publishLevels([4, 80]);

    expect(sendAudioDataMock).toHaveBeenCalledTimes(1);
    expect(sendAudioDataMock).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '2', speaker: '2' }));
  });

  it('re-tags when the loudest source CHANGES mid-utterance — a speaker change must not wait for silence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    await publishLevels([80, 4]);
    expect(sendAudioDataMock).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '1' }));

    // The level never drops below threshold — the OTHER mic simply takes over.
    await publishLevels([6, 75]);
    expect(sendAudioDataMock).toHaveBeenCalledTimes(2);
    expect(sendAudioDataMock).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '2' }));
  });

  it('still emits exactly once for one sustained utterance on one mic', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    await publishLevels([70, 2], 6);
    expect(sendAudioDataMock).toHaveBeenCalledTimes(1);

    // Silence re-arms; the same mic speaking again is a NEW turn on that mic.
    await publishLevels([1, 0], 3);
    expect(sendAudioDataMock).toHaveBeenCalledTimes(1);
    await publishLevels([70, 2], 3);
    expect(sendAudioDataMock).toHaveBeenCalledTimes(2);
    expect(sendAudioDataMock).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '1' }));
  });

  it('ignores a loud source that is still under the threshold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    await publishLevels([30, 34], 4); // default threshold is 35
    expect(sendAudioDataMock).not.toHaveBeenCalled();
  });

  it('never consults the mixed meter while a per-source signal exists', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    getDeviceStatusMock.mockClear();
    await publishLevels([4, 80], 3);

    expect(getDeviceStatusMock).not.toHaveBeenCalled();
  });
});

describe('MetadataSimulator — auto-tag mode is disclosed truthfully', () => {
  it('claims real per-mic attribution ONLY with two or more per-source meters', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    await publishLevels([10, 20], 1);

    expect(screen.getByText(/Per-mic attribution is live/i)).toBeInTheDocument();
    // …and the two weaker claims are NOT on screen. (Asserting the absence of
    // the bare string "round-robin" would be a false gate: the per-tab example
    // -code block renders this app's real source, which discusses it.)
    expect(screen.queryByText(/No per-source level available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/One audio source/i)).not.toBeInTheDocument();
  });

  it('with ONE source, says attribution is exact for the input but cannot separate speakers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    await publishLevels([40], 1);

    expect(screen.getByText(/One audio source/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot separate two speakers/i)).toBeInTheDocument();
  });

  it('with NO per-source signal, keeps the round-robin fallback AND discloses it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndEnableAutoTag(user);

    // `sourceLevels` stays [] — exactly the pre-follow-up world.
    expect(screen.getByText(/No per-source level available/i)).toBeInTheDocument();
    expect(screen.getByText(/it is.*not.*attribution/i)).toBeInTheDocument();

    getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 60 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    });

    // The old rotation still works — it was never removed, only demoted.
    expect(sendAudioDataMock).toHaveBeenCalledTimes(1);
    expect(sendAudioDataMock).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '1' }));
  });
});
