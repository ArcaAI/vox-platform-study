/**
 * TASK-1042 — `runWithAudio`: a live STT session bound to a standalone workflow run.
 *
 * Pinned to the frozen contract: C1 (the session is created with `workflowSlug`, never a
 * consultation), C2 (`input[audioField] = { sttSessionId }`), C4 (finalize, then close the
 * session; the run is never cancelled). Everything is faked — no socket and no HTTP.
 */

import { describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../errors';
import { RunAudioFieldError, resolveStreamAudioField, runWithAudio, type RunWithAudioDeps } from '../run-with-audio';

const STREAM_AUDIO = { type: 'object', properties: { sttSessionId: { type: 'string', minLength: 1 } } };

function schemaWith(properties: Record<string, unknown>, slug = 'live-note') {
  return {
    slug,
    versionNumber: 1,
    triggerKinds: ['api'],
    protocols: ['http-sse'],
    modes: ['async'],
    components: { Workflow_live_note_Input: { type: 'object', properties } },
    asyncapi: {},
    contextSchema: null,
    reviewNodes: [],
  };
}

function makeDeps(overrides: Partial<RunWithAudioDeps<unknown>> = {}) {
  const order: string[] = [];
  const socket = {
    connect: vi.fn(async () => void order.push('socket.connect')),
    sendPcm16: vi.fn(),
    finalize: vi.fn(async () => void order.push('socket.finalize')),
    close: vi.fn(() => void order.push('socket.close')),
  };
  const deps: RunWithAudioDeps<unknown> = {
    schema: vi.fn(async () => {
      order.push('schema');
      return schemaWith({ note: { type: 'string' }, audio: STREAM_AUDIO });
    }),
    createStreamSession: vi.fn(async () => {
      order.push('session.create');
      return { sessionId: 'stt-1' } as never;
    }),
    socket: vi.fn(() => socket),
    closeStreamSession: vi.fn(async () => void order.push('session.close')),
    run: vi.fn(async () => {
      order.push('run');
      return { runId: 'run-1' } as never;
    }),
    ...overrides,
  };
  return { deps, order, socket };
}

describe('resolveStreamAudioField', () => {
  it('picks the single key whose schema is the stream-audio payload', () => {
    expect(resolveStreamAudioField(schemaWith({ note: { type: 'string' }, audio: STREAM_AUDIO }) as never)).toBe('audio');
  });

  it('throws RunAudioFieldError for zero keys', () => {
    expect(() => resolveStreamAudioField(schemaWith({ note: { type: 'string' } }) as never)).toThrow(RunAudioFieldError);
  });

  it('throws RunAudioFieldError for several keys, naming them', () => {
    const schema = schemaWith({ a: STREAM_AUDIO, b: STREAM_AUDIO });
    expect(() => resolveStreamAudioField(schema as never)).toThrow(/a, b/);
  });

  it('does not take a media-reference or an object with extra properties for stream audio', () => {
    const media = { type: 'object', properties: { mediaId: { type: 'string' }, mime: { type: 'string' } } };
    const extra = { type: 'object', properties: { sttSessionId: { type: 'string' }, other: { type: 'string' } } };
    expect(() => resolveStreamAudioField(schemaWith({ media, extra }) as never)).toThrow(RunAudioFieldError);
  });
});

describe('runWithAudio', () => {
  it('creates the session with workflowSlug, connects, then starts the run carrying sttSessionId', async () => {
    const { deps, order } = makeDeps();

    const result = await runWithAudio(
      deps,
      'live-note',
      { note: 'n' },
      { agentSlug: 'asr', language: 'en', sampleRate: 16000, idempotencyKey: 'k-1' },
    );

    expect(order).toEqual(['schema', 'session.create', 'socket.connect', 'run']);
    expect(deps.createStreamSession).toHaveBeenCalledWith(
      { workflowSlug: 'live-note', agentSlug: 'asr', language: 'en', sampleRate: 16000 },
      expect.anything(),
    );
    expect(deps.run).toHaveBeenCalledWith(
      'live-note',
      { note: 'n', audio: { sttSessionId: 'stt-1' } },
      expect.objectContaining({ idempotencyKey: 'k-1' }),
    );
    expect(result.run).toEqual({ runId: 'run-1' });
  });

  it('sends no consultationId and omits unset session fields', async () => {
    const { deps } = makeDeps();
    await runWithAudio(deps, 'live-note', {});
    expect(deps.createStreamSession).toHaveBeenCalledWith({ workflowSlug: 'live-note' }, expect.anything());
  });

  it('skips the schema read when audioField is given', async () => {
    const { deps } = makeDeps();
    await runWithAudio(deps, 'live-note', {}, { audioField: 'mic' });
    expect(deps.schema).not.toHaveBeenCalled();
    expect(deps.run).toHaveBeenCalledWith('live-note', { mic: { sttSessionId: 'stt-1' } }, expect.anything());
  });

  it('fails on an unresolvable field BEFORE any session is created', async () => {
    const { deps } = makeDeps({ schema: vi.fn(async () => schemaWith({ note: { type: 'string' } }) as never) });
    await expect(runWithAudio(deps, 'live-note', {})).rejects.toBeInstanceOf(RunAudioFieldError);
    expect(deps.createStreamSession).not.toHaveBeenCalled();
  });

  it('closes the socket and the session, and rethrows, when the run start is refused', async () => {
    const refusal = Object.assign(new Error('bound elsewhere'), { code: 'RUN_AUDIO_SESSION_BOUND_ELSEWHERE' });
    const { deps, order } = makeDeps({ run: vi.fn(async () => Promise.reject(refusal)) });

    await expect(runWithAudio(deps, 'live-note', {})).rejects.toBe(refusal);

    expect(order.slice(-2)).toEqual(['socket.close', 'session.close']);
  });

  it('closes the session when the socket cannot connect, and rethrows the original error', async () => {
    const boom = new Error('no WebSocket');
    const { deps, socket } = makeDeps();
    socket.connect.mockRejectedValue(boom);
    (deps.closeStreamSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cleanup failed'));

    await expect(runWithAudio(deps, 'live-note', {})).rejects.toBe(boom);
    expect(deps.closeStreamSession).toHaveBeenCalledWith('stt-1');
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('audio.sendPcm16 forwards to the socket', async () => {
    const { deps, socket } = makeDeps();
    const { audio } = await runWithAudio(deps, 'live-note', {});
    const chunk = new Int16Array(4);
    audio.sendPcm16(chunk);
    expect(socket.sendPcm16).toHaveBeenCalledWith(chunk);
  });

  it('audio.finalize() finalizes the socket then closes the session, once, and never cancels the run', async () => {
    const cancel = vi.fn();
    const { deps, order } = makeDeps({ run: vi.fn(async () => ({ runId: 'run-1', cancel }) as never) });
    const { audio } = await runWithAudio(deps, 'live-note', {});
    order.length = 0;

    await audio.finalize();
    await audio.finalize();

    expect(order).toEqual(['socket.finalize', 'socket.close', 'session.close']);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('audio.close() ends the audio without finalizing, and never cancels the run', async () => {
    const cancel = vi.fn();
    const { deps, order, socket } = makeDeps({ run: vi.fn(async () => ({ runId: 'run-1', cancel }) as never) });
    const { audio } = await runWithAudio(deps, 'live-note', {});
    order.length = 0;

    await audio.close();

    expect(socket.finalize).not.toHaveBeenCalled();
    expect(order).toEqual(['socket.close', 'session.close']);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('finalize resolves when the session is already gone after the socket finalize (the gateway answers 404)', async () => {
    // Live proof 2026-10-05: the socket `stop` ends the session server-side, so the DELETE that
    // follows finds nothing. After a SUCCESSFUL finalize that is the expected end, not a failure.
    const { deps } = makeDeps({ closeStreamSession: vi.fn(async () => Promise.reject(new NotFoundError({ message: 'Resource not found' }))) });
    const { audio } = await runWithAudio(deps, 'live-note', {});

    await expect(audio.finalize()).resolves.toBeUndefined();
  });

  it('a non-404 failure to close the session still surfaces from finalize', async () => {
    const { deps } = makeDeps({ closeStreamSession: vi.fn(async () => Promise.reject(new Error('gateway down'))) });
    const { audio } = await runWithAudio(deps, 'live-note', {});

    await expect(audio.finalize()).rejects.toThrow('gateway down');
  });

  it('still closes the session when the socket finalize throws', async () => {
    const { deps, socket } = makeDeps();
    socket.finalize.mockRejectedValue(new Error('socket gone'));
    const { audio } = await runWithAudio(deps, 'live-note', {});

    await expect(audio.finalize()).rejects.toThrow('socket gone');
    expect(deps.closeStreamSession).toHaveBeenCalledWith('stt-1');
  });
});
