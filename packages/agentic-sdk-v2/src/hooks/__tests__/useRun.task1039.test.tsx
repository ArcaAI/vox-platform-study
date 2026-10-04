/**
 * TASK-1039 — `useRun`, the browser half of the run handle.
 *
 * Pinned to the gateway as it is after TASK-1038: protocol v2 selected with `?protocol=2`, a
 * run-scoped stream ticket for WORKFLOW runs (`POST …/runs/:runId/stream-ticket` → `sseUrl`), the
 * result route's `X-Hope-Result-Kind` header, and — because the gateway mints no ticket for AGENT
 * runs — a header-authenticated `fetch` stream for those.
 *
 * @vitest-environment jsdom
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AgenticError } from '../../types';
import { FakeEventSource } from '../../__tests__/mocks/fakeEventSource';
import { useRun, type UseRunReturn } from '../useRun';

const apiClient = {
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  get: vi.fn(),
  requestRaw: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined }),
}));

const TICKET = (n: number) => ({
  ticket: `tk${n}`,
  expiresAt: 1,
  scope: 'workflow_run:run-1',
  url: `/ws/workflows?slug=note-writer&runId=run-1&ticket=tk${n}`,
  sseUrl: `/api/v1/workflows/note-writer/runs/run-1/stream?protocol=2&ticket=tk${n}`,
});

const TOKENS = { in: 1, out: 2 };
const inlineResult = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'x-hope-result-kind': 'inline', 'content-type': 'application/json' } });
const sseResponse = (text: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  );
const frame = (type: string, seq: number, data: Record<string, unknown>, nodeId?: string) =>
  `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify({ seq, runId: 'run-1', type, ts: '2026-10-04T10:00:00.000Z', ...(nodeId ? { nodeId } : {}), data })}\n\n`;

const lastSource = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
const tuning = { reconnectDelayMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  apiClient.postWithHeaders.mockResolvedValue({ runId: 'run-1', status: 'started' });
  let minted = 0;
  apiClient.post.mockImplementation(async (path: string) => {
    if (path.endsWith('/stream-ticket')) return TICKET(++minted);
    return { runId: 'run-1', status: 'cancel_requested' };
  });
  apiClient.requestRaw.mockImplementation(async () => inlineResult({ text: 'Hello' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRun — a workflow run', () => {
  it('starts with an Idempotency-Key, sending the enveloped body', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));

    await act(async () => {
      await result.current.start({ note: 'n' });
    });

    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/workflows/note-writer/runs', { input: { note: 'n' } }, { 'Idempotency-Key': expect.stringMatching(/.{8,}/) });
    expect(result.current.runId).toBe('run-1');
    expect(result.current.status).toBe('RUNNING');
  });

  it('uses the caller idempotency key verbatim, and the consultation-bound route when asked', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));

    await act(async () => {
      await result.current.start({ note: 'n' }, { idempotencyKey: 'visit-42', consultationId: 'c-1' });
    });

    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/consultations/c-1/workflows/note-writer/runs', { input: { note: 'n' } }, { 'Idempotency-Key': 'visit-42' });
  });

  it('refuses server-stamped identity keys before any request leaves', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));

    await expect(result.current.start({ consultationId: 'x' })).rejects.toMatchObject({ name: 'ReservedRunIdentityError' });
    expect(apiClient.postWithHeaders).not.toHaveBeenCalled();
  });

  it('streams over EventSource with a RUN-SCOPED ticket, protocol v2, on the gateway origin', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));

    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    expect(apiClient.post).toHaveBeenCalledWith('/workflows/note-writer/runs/run-1/stream-ticket');
    expect(lastSource().url).toBe('https://api.example.com/api/v1/workflows/note-writer/runs/run-1/stream?protocol=2&ticket=tk1');
  });

  it('accumulates text, keeps typed events, and fetches the result when the run completes', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = lastSource();

    act(() => {
      source.open();
      source.emitV2('run.started', 1, { kind: 'workflow', slug: 'note-writer', versionNumber: 3 });
      source.emitV2('output.text.delta', 2, { field: 'text', text: 'Hel' }, 'n_note');
      source.emitV2('output.text.delta', 3, { field: 'text', text: 'lo' }, 'n_note');
      source.emitV2('output.text.delta', 4, { field: 'summary', text: 'ignored' }, 'n_note');
    });
    expect(result.current.text).toBe('Hello');
    expect(result.current.events.map((e) => e.type)).toEqual(['run.started', 'output.text.delta', 'output.text.delta', 'output.text.delta']);

    act(() => {
      source.emitV2('run.completed', 5, { status: 'COMPLETED', durationMs: 9, tokens: TOKENS });
    });

    await waitFor(() => expect(result.current.result).toEqual({ text: 'Hello' }));
    expect(result.current.status).toBe('COMPLETED');
    expect(result.current.lastSeq).toBe(5);
    expect(apiClient.requestRaw).toHaveBeenCalledWith('/workflows/note-writer/runs/run-1/result', expect.anything());
    expect(source.closed).toBe(true);
  });

  it('resumes by seq after a drop with a FRESH ticket, and drops the replayed events', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = lastSource();
    act(() => {
      first.open();
      first.emitV2('output.text.delta', 2, { field: 'text', text: 'Hel' }, 'n_note');
      first.emitV2('output.text.delta', 3, { field: 'text', text: 'lo' }, 'n_note');
      first.drop();
    });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = lastSource();
    expect(second.url).toBe('https://api.example.com/api/v1/workflows/note-writer/runs/run-1/stream?protocol=2&ticket=tk2&after=3');

    act(() => {
      second.open();
      second.emitV2('output.text.delta', 3, { field: 'text', text: 'lo' }, 'n_note'); // replayed
      second.emitV2('output.text.delta', 9, { field: 'text', text: '!' }, 'n_note'); // a jump is NOT loss
    });
    expect(result.current.text).toBe('Hello!');
  });

  it('applies run.resync: the snapshot replaces what was streamed', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = lastSource();

    act(() => {
      source.open();
      source.emitV2('output.text.delta', 1, { field: 'text', text: 'stale' }, 'n_note');
      source.emitV2('run.resync', 12, {
        reason: 'gap',
        snapshot: { status: 'RUNNING', lastSeq: 12, nodes: {}, outputs: { n_note: { text: 'Hello wor' } } },
      });
      source.emitV2('output.text.delta', 13, { field: 'text', text: 'ld' }, 'n_note');
    });

    expect(result.current.text).toBe('Hello world');
    expect(result.current.lastSeq).toBe(13);
  });

  it('starts a retried node over (node.started attempt > 1 discards its earlier partial text)', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = lastSource();

    act(() => {
      source.open();
      source.emitV2('output.text.delta', 1, { field: 'text', text: 'abandoned' }, 'n_note');
      source.emitV2('node.started', 2, { kind: 'core.agent', attempt: 2 }, 'n_note');
      source.emitV2('output.text.delta', 3, { field: 'text', text: 'kept' }, 'n_note');
    });

    expect(result.current.text).toBe('kept');
  });

  it('surfaces a failed run as an error with the fixed code, and does not fetch a result', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      lastSource().open();
      lastSource().emitV2('run.failed', 2, {
        status: 'FAILED',
        durationMs: 3,
        error: { code: 'MODEL_ERROR', message: 'The model returned an error.' },
      });
    });

    expect(result.current.status).toBe('FAILED');
    expect(result.current.error).toMatchObject({ code: 'MODEL_ERROR', message: 'The model returned an error.', runId: 'run-1' });
    expect(apiClient.requestRaw).not.toHaveBeenCalled();
  });

  it('reports a cancelled run as CANCELED without an error', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      lastSource().open();
      lastSource().emitV2('run.cancelled', 2, { status: 'CANCELED', durationMs: 3 });
    });

    expect(result.current.status).toBe('CANCELED');
    expect(result.current.error).toBeNull();
  });

  it('reads the legacy workflow frames too, for one release', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const legacy = (type: string, payload: Record<string, unknown>, id: string) =>
      lastSource().emit(
        type,
        { schemaVersion: 1, id: 'e', tenantId: 't', type, occurredAt: '2026-10-04T10:00:00.000Z', correlationId: 'run-1', causationId: null, idempotencyKey: 'k', payload },
        id,
      );

    act(() => {
      lastSource().open();
      legacy('workflow.token.delta', { nodeId: 'n1', text: 'Hi' }, '1-0');
      legacy('workflow.run.completed', { status: 'SUCCEEDED' }, '2-0');
    });

    expect(result.current.text).toBe('Hi');
    expect(result.current.status).toBe('COMPLETED');
  });

  it('records a start failure on `error` and rethrows it', async () => {
    apiClient.postWithHeaders.mockRejectedValue(new AgenticError('VALIDATION_ERROR', 'input invalid', { context: { status: 400 } }));
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));

    await act(async () => {
      await expect(result.current.start({ note: 'n' })).rejects.toThrow('input invalid');
    });

    expect(result.current.error?.message).toBe('input invalid');
    expect(result.current.status).toBeNull();
  });
});

describe('useRun — attach (resume on mount)', () => {
  it('follows an existing run from the persisted cursor, without starting another', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', runId: 'run-1', after: 4, ...tuning }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(apiClient.postWithHeaders).not.toHaveBeenCalled();
    expect(lastSource().url).toContain('ticket=tk1&after=4');
    expect(result.current.runId).toBe('run-1');
    expect(result.current.status).toBe('RUNNING');
  });

  it('replays from the start when only a runId is given', async () => {
    renderHook(() => useRun({ workflow: 'note-writer', runId: 'run-1', ...tuning }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(lastSource().url).not.toContain('after=');
  });
});

describe('useRun — unmount and cancel', () => {
  it('closes the stream on unmount and NEVER cancels the run', async () => {
    const { result, unmount } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = lastSource();

    unmount();

    expect(source.closed).toBe(true);
    expect(apiClient.post.mock.calls.some(([path]) => String(path).endsWith('/cancel'))).toBe(false);
  });

  it('cancel() posts once however often it is called, and not at all after the run ended', async () => {
    const { result } = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    await act(async () => {
      await Promise.all([result.current.cancel(), result.current.cancel()]);
    });
    expect(apiClient.post.mock.calls.filter(([path]) => path === '/workflows/note-writer/runs/run-1/cancel')).toHaveLength(1);

    act(() => {
      lastSource().open();
      lastSource().emitV2('run.cancelled', 2, { status: 'CANCELED', durationMs: 3 });
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(apiClient.post.mock.calls.filter(([path]) => String(path).endsWith('/cancel'))).toHaveLength(1);
  });
});

describe('useRun — the result', () => {
  async function completeRun(): Promise<{ result: { current: UseRunReturn } }> {
    const rendered = renderHook(() => useRun({ workflow: 'note-writer', ...tuning }));
    await act(async () => {
      await rendered.result.current.start({ note: 'n' });
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      lastSource().open();
      lastSource().emitV2('run.completed', 2, { status: 'COMPLETED', durationMs: 1, tokens: TOKENS });
    });
    return rendered;
  }

  it('follows a signed URL for a large result, WITHOUT the SDK credentials, and verifies the hash', async () => {
    const body = JSON.stringify({ text: 'x'.repeat(100) });
    const sha256 = createHash('sha256').update(body).digest('hex');
    apiClient.requestRaw.mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://store.example.com/o?sig=1', expiresAt: 'x', sizeBytes: body.length, sha256 }), {
        headers: { 'x-hope-result-kind': 'ref' },
      }),
    );
    const external = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', external);

    const { result } = await completeRun();

    await waitFor(() => expect(result.current.result).toEqual({ text: 'x'.repeat(100) }));
    expect(external).toHaveBeenCalledTimes(1);
    expect(external.mock.calls[0]![0]).toBe('https://store.example.com/o?sig=1');
    expect(external.mock.calls[0]![1] ?? {}).not.toHaveProperty('headers');
  });

  it('refuses bytes that do not match the declared hash', async () => {
    apiClient.requestRaw.mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://store.example.com/o', expiresAt: 'x', sizeBytes: 3, sha256: 'a'.repeat(64) }), { headers: { 'x-hope-result-kind': 'ref' } }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"text":"tampered"}')));

    const { result } = await completeRun();

    await waitFor(() => expect(result.current.error?.name).toBe('RunResultIntegrityError'));
    expect(result.current.result).toBeNull();
  });

  it('is null for a run that delivered nothing (204)', async () => {
    apiClient.requestRaw.mockResolvedValue(new Response(null, { status: 204 }));

    const { result } = await completeRun();

    await waitFor(() => expect(apiClient.requestRaw).toHaveBeenCalled());
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('rides out a 409 RUN_NOT_TERMINAL race with a short retry', async () => {
    apiClient.requestRaw
      .mockRejectedValueOnce(new AgenticError('VALIDATION_ERROR', 'not terminal', { context: { status: 409, code: 'RUN_NOT_TERMINAL' } }))
      .mockResolvedValueOnce(inlineResult({ text: 'Hello' }));

    const { result } = await completeRun();

    await waitFor(() => expect(result.current.result).toEqual({ text: 'Hello' }), { timeout: 3000 });
    expect(apiClient.requestRaw).toHaveBeenCalledTimes(2);
  });
});

describe('useRun — an agent run', () => {
  it('starts with the FLAT body, then follows through the header lane: no ticket exists for agent runs', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ runId: 'run-1', status: 'RUNNING', links: {} });
    apiClient.requestRaw.mockImplementation(async (path: string) => {
      if (path.includes('/events')) {
        return sseResponse(
          frame('output.text.delta', 2, { field: 'text', text: 'Hi' }, 'agent') + frame('run.completed', 3, { status: 'COMPLETED', durationMs: 1, tokens: TOKENS }),
        );
      }
      return inlineResult({ text: 'Hi' });
    });
    const { result } = renderHook(() => useRun({ agent: 'summarizer', ...tuning }));

    await act(async () => {
      await result.current.start({ message: 'hello' }, { idempotencyKey: 'k-1' });
    });

    await waitFor(() => expect(result.current.status).toBe('COMPLETED'));
    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/agents/summarizer/runs', { message: 'hello' }, { 'Idempotency-Key': 'k-1' });
    expect(apiClient.post.mock.calls.some(([path]) => String(path).endsWith('/stream-ticket'))).toBe(false);
    const eventsCall = apiClient.requestRaw.mock.calls.find(([path]) => String(path).includes('/events'))!;
    expect(eventsCall[0]).toBe('/agents/summarizer/runs/run-1/events?protocol=2');
    expect(eventsCall[1].headers).toMatchObject({ 'x-hope-run-protocol': '2' });
    expect(result.current.text).toBe('Hi');
    await waitFor(() => expect(result.current.result).toEqual({ text: 'Hi' }));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('cancels on the agent route', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ runId: 'run-1', status: 'RUNNING', links: {} });
    apiClient.requestRaw.mockImplementation(() => new Promise(() => undefined)); // a stream that never answers
    const { result } = renderHook(() => useRun({ agent: 'summarizer', ...tuning }));
    await act(async () => {
      await result.current.start({ message: 'hello' });
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(apiClient.post).toHaveBeenCalledWith('/agents/summarizer/runs/run-1/cancel');
  });
});

describe('useRun — configuration', () => {
  it('needs exactly one of workflow / agent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useRun({}))).toThrow(/exactly one of `workflow` or `agent`/);
    expect(() => renderHook(() => useRun({ workflow: 'a', agent: 'b' }))).toThrow(/exactly one of `workflow` or `agent`/);
    spy.mockRestore();
  });
});
