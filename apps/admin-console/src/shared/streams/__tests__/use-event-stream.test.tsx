import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from '../use-event-stream';

/** Instrumented EventSource double: records instances, exposes fire helpers. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    this.listeners.set(name, [...existing, listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(type: string, data: string): void {
    const event = { data } as MessageEvent;
    if (type === 'message') {
      this.onmessage?.(event);
      return;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  fail(): void {
    this.onerror?.();
  }
}

let ticketCounter = 0;
let mintCalls: Array<{ url: string; body: unknown }> = [];

function stubTicketMint(response?: () => Response) {
  mintCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      mintCalls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (response) return response();
      ticketCounter += 1;
      return Response.json({ ticket: `tkt-${ticketCounter}`, expiresAt: Date.now() + 30_000, scope: 'x' });
    }),
  );
}

beforeEach(() => {
  ticketCounter = 0;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const OPTIONS = { path: 'admin/dna-writing-styles/jobs/j-1/stream', scope: 'dna_job:j-1' };

describe('useEventStream', () => {
  it('mints a scope-bound ticket via the BFF and connects directly to the gateway with ?ticket=', async () => {
    stubTicketMint();
    const { result } = renderHook(() => useEventStream(OPTIONS));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(mintCalls[0].url).toBe('/api/auth/stream-ticket');
    expect(mintCalls[0].body).toEqual({ scope: 'dna_job:j-1' });
    // Direct gateway origin (NEXT_PUBLIC_API_HOST) — never the BFF proxy;
    // the ticket is the only credential in the URL (no JWT).
    expect(FakeEventSource.instances[0].url).toBe('http://localhost:8868/api/v1/admin/dna-writing-styles/jobs/j-1/stream?ticket=tkt-1');
    expect(FakeEventSource.instances[0].url).not.toContain('Bearer');

    act(() => FakeEventSource.instances[0].open());
    expect(result.current.status).toBe('open');
  });

  it('forwards default and named events with their type', async () => {
    stubTicketMint();
    const received: Array<[string, string]> = [];
    renderHook(() => useEventStream({ ...OPTIONS, eventNames: ['status', 'progress'], onEvent: (type, data) => received.push([type, data]) }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source.open();
      source.emit('status', '{"status":"processing"}');
      source.emit('progress', '{"progress":40}');
      source.emit('message', 'plain');
    });

    expect(received).toEqual([
      ['status', '{"status":"processing"}'],
      ['progress', '{"progress":40}'],
      ['message', 'plain'],
    ]);
  });

  it('suppresses the native retry and reconnects with a FRESH single-use ticket', async () => {
    vi.useFakeTimers();
    stubTicketMint();
    const { result } = renderHook(() => useEventStream(OPTIONS));

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0];
    act(() => first.open());
    act(() => first.fail());

    // The consumed-ticket connection must be closed (native retry killed).
    expect(first.closed).toBe(true);
    expect(result.current.status).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1].url).toContain('ticket=tkt-2');

    act(() => FakeEventSource.instances[1].open());
    expect(result.current.status).toBe('open');
  });

  it('lands on error after the retry budget is exhausted, and reopen() restarts', async () => {
    vi.useFakeTimers();
    stubTicketMint(() => Response.json({ message: 'nope' }, { status: 401 }));
    const { result } = renderHook(() => useEventStream({ ...OPTIONS, maxRetries: 1 }));

    // Initial mint fails -> one retry (1s) -> second mint fails -> error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await vi.waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toContain('401');
    expect(mintCalls).toHaveLength(2);

    stubTicketMint();
    act(() => result.current.reopen());
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].open());
    expect(result.current.status).toBe('open');
  });

  it('close() is terminal and unmount tears the connection down', async () => {
    stubTicketMint();
    const first = renderHook(() => useEventStream(OPTIONS));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].open());

    act(() => first.result.current.close());
    expect(first.result.current.status).toBe('closed');
    expect(FakeEventSource.instances[0].closed).toBe(true);
    first.unmount();

    const second = renderHook(() => useEventStream(OPTIONS));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    second.unmount();
    expect(FakeEventSource.instances[1].closed).toBe(true);
  });

  it('stays idle (no mint) when disabled or unresolved', () => {
    stubTicketMint();
    const disabled = renderHook(() => useEventStream({ ...OPTIONS, enabled: false }));
    const noPath = renderHook(() => useEventStream({ path: null, scope: null }));

    expect(disabled.result.current.status).toBe('idle');
    expect(noPath.result.current.status).toBe('idle');
    expect(mintCalls).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
