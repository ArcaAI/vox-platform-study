/**
 * `useAutosave`. Verifies: debounce coalescing (rapid `schedule()` calls
 * within the window fire exactly one PATCH with the merged/latest patch), If-Match is sent, a
 * 412 pauses autosave and does NOT retry, a 428 surfaces as `onMissingPrecondition` (a client
 * bug, not a safety net), and `resume()` is required to un-pause.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from '../use-autosave';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(responder: (call: RecordedCall) => Response): RecordedCall[] {
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAutosave', () => {
  it('debounce-coalesces rapid schedule() calls into exactly one PATCH carrying the merged patch and If-Match', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'd-1', name: 'Final', version: 2 }, { headers: { etag: '"2"' } }));
    const onSaved = vi.fn();
    const onStateChange = vi.fn();
    const { result } = renderHook(() => useAutosave({ definitionId: 'd-1', getEtag: () => '"1"', onSaved, onStateChange }));

    act(() => {
      result.current.schedule({ name: 'First' });
      result.current.schedule({ name: 'Second' });
      result.current.schedule({ name: 'Final' });
    });

    expect(calls).toHaveLength(0); // still debouncing
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].headers['if-match']).toBe('"1"');
    expect(calls[0].body).toEqual({ name: 'Final', expectedVersion: 1 });
    expect(onSaved).toHaveBeenCalledWith({ id: 'd-1', name: 'Final', version: 2 }, '"2"');
    expect(onStateChange).toHaveBeenCalledWith('saving');
    expect(onStateChange).toHaveBeenCalledWith('saved');
  });

  it('on 412: pauses autosave, reports "conflict", and does NOT auto-retry a later schedule()', async () => {
    installFetchMock(() => new Response(JSON.stringify({ statusCode: 412, message: 'version conflict' }), { status: 412 }));
    const onStateChange = vi.fn();
    const { result } = renderHook(() => useAutosave({ definitionId: 'd-1', getEtag: () => '"1"', onSaved: vi.fn(), onStateChange }));

    act(() => result.current.schedule({ name: 'A' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onStateChange).toHaveBeenCalledWith('conflict');
    expect(result.current.paused).toBe(true);

    const callsBefore = vi.mocked(fetch).mock.calls.length;
    act(() => result.current.schedule({ name: 'B' })); // must be a no-op while paused
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('resume() clears the pause, so the NEXT schedule() is allowed through', async () => {
    let call = 0;
    installFetchMock(() => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ statusCode: 412, message: 'conflict' }), { status: 412 });
      return Response.json({ id: 'd-1', version: 3 }, { headers: { etag: '"3"' } });
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useAutosave({ definitionId: 'd-1', getEtag: () => '"1"', onSaved, onStateChange: vi.fn() }));

    act(() => result.current.schedule({ name: 'A' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.paused).toBe(true);

    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);

    act(() => result.current.schedule({ name: 'B' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onSaved).toHaveBeenCalledWith({ id: 'd-1', version: 3 }, '"3"');
  });

  it('on 428 (missing precondition): calls onMissingPrecondition — a client bug, not retried as a safety net', async () => {
    installFetchMock(() => new Response(JSON.stringify({ statusCode: 428, message: 'precondition required' }), { status: 428 }));
    const onMissingPrecondition = vi.fn();
    const { result } = renderHook(() =>
      useAutosave({ definitionId: 'd-1', getEtag: () => '"1"', onSaved: vi.fn(), onStateChange: vi.fn(), onMissingPrecondition }),
    );
    act(() => result.current.schedule({ name: 'A' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onMissingPrecondition).toHaveBeenCalled();
  });

  it('cancel() drops a pending debounced save without sending it', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'd-1' }));
    const { result } = renderHook(() => useAutosave({ definitionId: 'd-1', getEtag: () => '"1"', onSaved: vi.fn(), onStateChange: vi.fn() }));
    act(() => result.current.schedule({ name: 'A' }));
    act(() => result.current.cancel());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls).toHaveLength(0);
  });
});
