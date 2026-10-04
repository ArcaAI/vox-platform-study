/**
 * TASK-1039 — `useRunAudio`: the microphone into a run.
 *
 * The capture and the backend STT session are `useArcaAudio`'s (`@arcaai/room` capture →
 * `@arcaai/stt` streaming transport → gateway), not a second implementation. What this adds is the
 * ORDER (the session is live before the run starts reading it), the pairing (a run that fails to
 * start does not leave a microphone open), and the one honest limit of the business plane: a
 * workflow run reads live speech through its CONSULTATION, because no business-plane route binds
 * a bare STT session to a run (the sandbox start accepts `recording.sttSessionId`, but that route
 * is admin-plane).
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRunAudio } from '../useRunAudio';

const audio = {
  start: vi.fn(),
  stop: vi.fn(),
  isCapturing: false,
  level: 0,
  currentTranscript: '',
  transcriptSegments: [] as unknown[],
};
const run = {
  start: vi.fn(),
  cancel: vi.fn(),
  text: '',
  events: [],
  result: null,
  status: null,
  runId: null,
  lastSeq: 0,
  error: null,
};
const store: { consultation: { id: string } | null } = { consultation: { id: 'c-open' } };
const order: string[] = [];

vi.mock('../useArcaAudio', () => ({ useArcaAudio: () => audio }));
vi.mock('../useRun', () => ({ useRun: () => run }));
vi.mock('../../store', () => ({ useAgenticStore: () => store }));

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  store.consultation = { id: 'c-open' };
  audio.isCapturing = false;
  audio.start.mockImplementation(async () => void order.push('audio.start'));
  audio.stop.mockImplementation(async () => void order.push('audio.stop'));
  run.start.mockImplementation(async () => {
    order.push('run.start');
    return { runId: 'run-1' };
  });
});

describe('useRunAudio — a workflow run', () => {
  it('opens the microphone and the STT session FIRST, then starts the run on the open consultation', async () => {
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    let started: { runId: string } | undefined;
    await act(async () => {
      started = await result.current.start({ note: 'n' }, { idempotencyKey: 'k-1', audio: { language: 'en', agentSlug: 'asr' } });
    });

    expect(order).toEqual(['audio.start', 'run.start']);
    expect(audio.start).toHaveBeenCalledWith({ language: 'en', agentSlug: 'asr' });
    expect(run.start).toHaveBeenCalledWith({ note: 'n' }, { idempotencyKey: 'k-1', consultationId: 'c-open' });
    expect(started).toEqual({ runId: 'run-1' });
  });

  it('refuses a consultation that is not the one the microphone feeds, before opening the microphone', async () => {
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note', consultationId: 'c-other' }));

    await expect(result.current.start({ note: 'n' })).rejects.toThrow(/c-other/);
    expect(audio.start).not.toHaveBeenCalled();
    expect(run.start).not.toHaveBeenCalled();
  });

  it('runs unbound when no consultation is open (the audio is captured, the run reads none of it)', async () => {
    store.consultation = null;
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await result.current.start({ note: 'n' });
    });

    expect(run.start).toHaveBeenCalledWith({ note: 'n' }, { idempotencyKey: undefined, consultationId: undefined });
  });

  it('closes the microphone again when the run is refused', async () => {
    run.start.mockRejectedValue(new Error('input invalid'));
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await expect(result.current.start({ note: 'n' })).rejects.toThrow('input invalid');
    });

    expect(run.start).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['audio.start', 'audio.stop']);
  });

  it('starts no run when the microphone cannot be opened', async () => {
    audio.start.mockRejectedValue(new Error('NotAllowedError'));
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await expect(result.current.start({ note: 'n' })).rejects.toThrow('NotAllowedError');
    });

    expect(run.start).not.toHaveBeenCalled();
  });
});

describe('useRunAudio — stop and agents', () => {
  it('stop() ends the capture and never cancels the run', async () => {
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await result.current.stop();
    });

    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(run.cancel).not.toHaveBeenCalled();
  });

  it('never binds an AGENT run to a consultation', async () => {
    const { result } = renderHook(() => useRunAudio({ agent: 'summarizer' }));

    await act(async () => {
      await result.current.start({ message: 'hi' });
    });

    expect(run.start).toHaveBeenCalledWith({ message: 'hi' }, { idempotencyKey: undefined });
  });

  it('exposes the run and the capture side by side', () => {
    audio.isCapturing = true;
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    expect(result.current.run).toBe(run);
    expect(result.current.audio).toBe(audio);
    expect(result.current.isRecording).toBe(true);
  });
});
