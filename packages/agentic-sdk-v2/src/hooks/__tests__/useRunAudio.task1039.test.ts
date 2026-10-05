/**
 * TASK-1039 — `useRunAudio`: the microphone into a run.
 *
 * The capture and the backend STT session are `useArcaAudio`'s (`@arcaai/room` capture →
 * `@arcaai/stt` streaming transport → gateway), not a second implementation. What this adds is the
 * ORDER (the session is live before the run starts reading it) and the pairing (a run that fails
 * to start does not leave a microphone open). With a consultation open the run reads that
 * consultation; with none open (TASK-1042) the STT session is bound to the workflow and the run
 * carries `input.<audioField>.sttSessionId`.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RunAudioFieldError, useRunAudio } from '../useRunAudio';

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
const STREAM_AUDIO = { type: 'object', properties: { sttSessionId: { type: 'string', minLength: 1 } } };
const schemaGet = vi.fn();
const store: { consultation: { id: string } | null; apiClient: { get: typeof schemaGet }; pluginManager: unknown } = {
  consultation: { id: 'c-open' },
  apiClient: { get: schemaGet },
  pluginManager: { getTranscriptionPipeline: () => ({ getStreamingSessionManager: () => ({ getSessionId: () => 'stt-7' }) }) },
};
const order: string[] = [];

vi.mock('../useArcaAudio', () => ({ useArcaAudio: () => audio }));
vi.mock('../useRun', () => ({ useRun: () => run }));
vi.mock('../../store', () => ({ useAgenticStore: () => store }));

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  store.consultation = { id: 'c-open' };
  schemaGet.mockResolvedValue({
    slug: 'live-note',
    components: { Workflow_live_note_Input: { type: 'object', properties: { note: { type: 'string' }, audio: STREAM_AUDIO } } },
  });
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

describe('useRunAudio — standalone (no consultation open, TASK-1042)', () => {
  beforeEach(() => {
    store.consultation = null;
  });

  it('opens the microphone with the workflowSlug, then starts the run with input.<audioField>.sttSessionId', async () => {
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await result.current.start({ note: 'n' }, { idempotencyKey: 'k-1', audio: { language: 'en' } });
    });

    expect(schemaGet).toHaveBeenCalledWith('/workflows/live-note/schema');
    expect(order).toEqual(['audio.start', 'run.start']);
    expect(audio.start).toHaveBeenCalledWith({ language: 'en', workflowSlug: 'live-note' });
    expect(run.start).toHaveBeenCalledWith({ note: 'n', audio: { sttSessionId: 'stt-7' } }, { idempotencyKey: 'k-1' });
  });

  it('an explicit audioField skips the schema read', async () => {
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note', audioField: 'mic' }));

    await act(async () => {
      await result.current.start({ note: 'n' });
    });

    expect(schemaGet).not.toHaveBeenCalled();
    expect(run.start).toHaveBeenCalledWith({ note: 'n', mic: { sttSessionId: 'stt-7' } }, { idempotencyKey: undefined });
  });

  it('throws RunAudioFieldError BEFORE opening the microphone when the shape declares no (or several) live-audio keys', async () => {
    schemaGet.mockResolvedValue({
      slug: 'live-note',
      components: { Workflow_live_note_Input: { type: 'object', properties: { a: STREAM_AUDIO, b: STREAM_AUDIO } } },
    });
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await expect(result.current.start({ note: 'n' })).rejects.toBeInstanceOf(RunAudioFieldError);
    });

    expect(audio.start).not.toHaveBeenCalled();
    expect(run.start).not.toHaveBeenCalled();
  });

  it('closes the microphone when the run start is refused (a coded gateway refusal reaches the caller)', async () => {
    const refusal = Object.assign(new Error('bound elsewhere'), { code: 'RUN_AUDIO_SESSION_BOUND_ELSEWHERE' });
    run.start.mockRejectedValue(refusal);
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await expect(result.current.start({ note: 'n' })).rejects.toBe(refusal);
    });

    expect(order).toEqual(['audio.start', 'audio.stop']);
  });

  it('stop() ends the audio and never cancels the run', async () => {
    const { result } = renderHook(() => useRunAudio({ workflow: 'live-note' }));

    await act(async () => {
      await result.current.stop();
    });

    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(run.cancel).not.toHaveBeenCalled();
  });
});
