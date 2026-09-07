/**
 * TASK-893 §3.4 — `useSaveModel`, the explicit save that replaced `useAutosave`.
 *
 * The transport contract is asserted VERBATIM against what autosave did, because that half was
 * not the thing being redesigned: `If-Match` is sent, the body carries the ETag-derived
 * `expectedVersion`, a 412 pauses and is never retried by itself, a 428 (or a missing ETag, the
 * same client bug one step earlier) reports through `onMissingPrecondition`, and `resume()` is
 * the only way out of a pause.
 *
 * What IS new is asserted just as hard: there is no timer. The old suite had to
 * `advanceTimersByTimeAsync(1000)` before a single PATCH appeared; here the request is in flight
 * the moment `save()` is called. A debounce that survived the rewrite would show up as a test
 * that needs fake timers to pass — so this file deliberately uses none.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSaveModel } from '../use-save-model';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(responder: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}

/** A fresh set of spies per test. `getEtag` is the only thing any test varies, so it is a plain
 *  parameter rather than a partial-override spread — which keeps every mock concretely typed. */
function options(getEtag: () => string | null = () => '"1"') {
  return {
    definitionId: 'd-1',
    getEtag,
    onSaved: vi.fn(),
    onStateChange: vi.fn(),
    onMissingPrecondition: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSaveModel', () => {
  it('PATCHes immediately — no debounce, no timer to advance', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'd-1', name: 'Final', version: 2 }, { headers: { etag: '"2"' } }));
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    await act(async () => {
      await result.current.save({ name: 'Final' });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].headers['if-match']).toBe('"1"');
    expect(calls[0].body).toEqual({ name: 'Final', expectedVersion: 1 });
    expect(opts.onSaved).toHaveBeenCalledWith({ id: 'd-1', name: 'Final', version: 2 }, '"2"');
    expect(opts.onStateChange).toHaveBeenNthCalledWith(1, 'saving');
    expect(opts.onStateChange).toHaveBeenNthCalledWith(2, 'saved');
    expect(result.current.saving).toBe(false);
  });

  it('reports `saving` while the request is in flight and clears it afterwards', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFetchMock(async () => {
      await gate;
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    });
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.save({ name: 'A' });
    });
    expect(result.current.saving).toBe(true);

    await act(async () => {
      release?.();
      await pending;
    });
    expect(result.current.saving).toBe(false);
  });

  it('is single-flight: a second save while one is in flight sends nothing', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = installFetchMock(async () => {
      await gate;
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    });
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.save({ name: 'A' });
    });
    await act(async () => {
      await result.current.save({ name: 'B' }); // a second click on the same stale ETag
    });
    expect(calls).toHaveLength(1);

    await act(async () => {
      release?.();
      await pending;
    });
    expect(calls).toHaveLength(1);
  });

  it('on 412: pauses, reports "conflict", keeps the error for OccConflictAlert, and does NOT retry', async () => {
    const calls = installFetchMock(() => new Response(JSON.stringify({ statusCode: 412, message: 'version conflict' }), { status: 412 }));
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    await act(async () => {
      await result.current.save({ name: 'A' });
    });

    expect(opts.onStateChange).toHaveBeenCalledWith('conflict');
    expect(result.current.paused).toBe(true);
    expect(result.current.lastError).not.toBeNull();

    await act(async () => {
      await result.current.save({ name: 'B' }); // must be a no-op while paused
    });
    expect(calls).toHaveLength(1);
  });

  it('resume() clears the pause and the error, so the NEXT save is allowed through', async () => {
    let call = 0;
    installFetchMock(() => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ statusCode: 412, message: 'conflict' }), { status: 412 });
      return Response.json({ id: 'd-1', version: 3 }, { headers: { etag: '"3"' } });
    });
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    await act(async () => {
      await result.current.save({ name: 'A' });
    });
    expect(result.current.paused).toBe(true);

    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
    expect(result.current.lastError).toBeNull();

    await act(async () => {
      await result.current.save({ name: 'B' });
    });
    expect(opts.onSaved).toHaveBeenCalledWith({ id: 'd-1', version: 3 }, '"3"');
  });

  it('on 428 (missing precondition): reports it as a client bug and an error state, and does not pause', async () => {
    installFetchMock(() => new Response(JSON.stringify({ statusCode: 428, message: 'precondition required' }), { status: 428 }));
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    await act(async () => {
      await result.current.save({ name: 'A' });
    });

    expect(opts.onMissingPrecondition).toHaveBeenCalled();
    expect(opts.onStateChange).toHaveBeenCalledWith('error');
    expect(result.current.paused).toBe(false);
  });

  it('with no ETag captured yet: reports the missing precondition and sends NOTHING', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'd-1' }));
    const opts = options(() => null);
    const { result } = renderHook(() => useSaveModel(opts));

    await act(async () => {
      await result.current.save({ name: 'A' });
    });

    expect(calls).toHaveLength(0);
    expect(opts.onMissingPrecondition).toHaveBeenCalled();
    // Nothing was attempted, so nothing failed: the save state is left exactly as the caller had it.
    expect(opts.onStateChange).not.toHaveBeenCalled();
  });

  it('on any other failure: reports "error" without pausing, so the user can simply save again', async () => {
    const calls = installFetchMock(() => new Response(JSON.stringify({ statusCode: 500, message: 'boom' }), { status: 500 }));
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));

    await act(async () => {
      await result.current.save({ name: 'A' });
    });
    expect(opts.onStateChange).toHaveBeenCalledWith('error');
    expect(result.current.paused).toBe(false);

    await act(async () => {
      await result.current.save({ name: 'A' });
    });
    expect(calls).toHaveLength(2);
  });

  it('sends the graph as the patch body when one is supplied', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } }));
    const opts = options();
    const { result } = renderHook(() => useSaveModel(opts));
    const graph = { version: 1 as const, nodes: [{ id: 'n1', type: 'core.trigger', config: {} }], edges: [] };

    await act(async () => {
      await result.current.save({ graph });
    });

    expect(calls[0].body).toEqual({ graph, expectedVersion: 1 });
  });
});
