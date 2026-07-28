/**
 * useTaskStream — the SMR task SSE consumed through the house ticket flow:
 * `useEventStream` mints a single-use scope-bound ticket via the BFF and the
 * browser connects DIRECTLY to the gateway (`smr_task:<taskId>`, matching the
 * route's `@StreamScope`). These tests lock that transport (no `/api/hope/`
 * stream tunnel), the replay contract (every (re)connect replays from 0-0, so
 * automatic reconnects are disabled and reopen() resets the accumulation), and
 * the `error` disambiguation (upstream failure frames carry a data string;
 * transport drops do not).
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStream } from '../use-task-stream';

/** Instrumented EventSource double (mirrors the use-event-stream test). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event?: Event) => void) | null = null;
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

  /** Named SSE frame — carries a data string like the real transport. */
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }

  /** Transport-level error — no data payload (useEventStream owns the retry policy). */
  fail(): void {
    this.onerror?.();
  }
}

let mintCalls: Array<{ url: string; body: unknown }> = [];

function stubTicketMint(): void {
  mintCalls = [];
  let counter = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      mintCalls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      counter += 1;
      return Response.json({ ticket: `tkt-${counter}`, expiresAt: Date.now() + 30_000, scope: 'smr_task:x' });
    }),
  );
}

function chunk(content: string): string {
  return JSON.stringify({ type: 'chunk', content, data: null });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  stubTicketMint();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useTaskStream', () => {
  it('mints an smr_task ticket and connects DIRECTLY to the gateway (never the BFF tunnel)', async () => {
    renderHook(() => useTaskStream('t-5531'));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0].url).toBe('/api/auth/stream-ticket');
    expect(mintCalls[0].body).toEqual({ scope: 'smr_task:t-5531' });

    expect(source.url).toContain('/api/v1/text/tasks/t-5531/stream');
    expect(source.url).toContain('ticket=tkt-1');
    // The BFF stream tunnel is gone — streams go straight to the gateway.
    expect(source.url).not.toContain('/api/hope/');
  });

  it('folds chunk/reasoning/usage/done frames', async () => {
    const { result } = renderHook(() => useTaskStream('t-5531'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => source.open());
    expect(result.current.status).toBe('streaming');

    act(() => {
      source.emit('chunk', chunk('The patient presents'));
      source.emit('chunk', chunk(' with dyspnea.'));
    });
    expect(result.current.content).toBe('The patient presents with dyspnea.');
    expect(result.current.chunkCount).toBe(2);

    act(() => source.emit('usage', JSON.stringify({ type: 'usage', data: { prompt_tokens: 20, completion_tokens: 214, total_tokens: 234 } })));
    expect(result.current.usage).toEqual({ prompt_tokens: 20, completion_tokens: 214, total_tokens: 234 });

    act(() => {
      source.emit('reasoning', JSON.stringify({ type: 'reasoning', content: 'Weighing differentials', data: null }));
      source.emit('reasoning', JSON.stringify({ type: 'reasoning', content: ' before answering.', data: null }));
    });
    expect(result.current.reasoning).toBe('Weighing differentials before answering.');

    act(() => source.emit('done', JSON.stringify({ type: 'done', data: { finish_reason: 'stop' } })));
    expect(result.current.status).toBe('done');
    expect(result.current.finishReason).toBe('stop');
    // Terminal frames stop the source (the SMR generator returned anyway).
    expect(source.closed).toBe(true);
  });

  it('maps the upstream `error` FRAME (data string present) to failed with its message', async () => {
    const { result } = renderHook(() => useTaskStream('t-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.open();
      source.emit('chunk', chunk('partial'));
      source.emit('error', JSON.stringify({ type: 'error', data: { error: 'provider crashed' } }));
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('provider crashed');
    expect(result.current.content).toBe('partial');
    expect(source.closed).toBe(true);
  });

  it('never auto-reconnects on a transport drop (a silent retry would re-append the 0-0 replay)', async () => {
    const { result } = renderHook(() => useTaskStream('t-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0];

    act(() => {
      first.open();
      first.emit('chunk', chunk('partial before drop'));
    });
    act(() => first.fail());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();
    // maxRetries: 0 — no second source appears on its own.
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('reopen() mints a FRESH ticket and the 0-0 replay resets the accumulation', async () => {
    const { result } = renderHook(() => useTaskStream('t-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0];

    act(() => {
      first.open();
      first.emit('chunk', chunk('partial before drop'));
    });
    act(() => first.fail());
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => result.current.reopen());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    const second = FakeEventSource.instances[1];
    // Tickets are single-use: the reconnect must not replay the consumed one.
    expect(second.url).toContain('ticket=tkt-2');

    act(() => {
      second.open();
      second.emit('chunk', chunk('full replay'));
    });
    // No duplication: the new connection key discarded the prior accumulation.
    expect(result.current.content).toBe('full replay');
    expect(result.current.chunkCount).toBe(1);
    expect(result.current.status).toBe('streaming');
  });

  it('close() stops the stream locally (the cancel affordance)', async () => {
    const { result } = renderHook(() => useTaskStream('t-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.open();
      source.emit('chunk', chunk('to be cancelled'));
    });
    act(() => result.current.close());

    expect(source.closed).toBe(true);
    expect(result.current.status).toBe('closed');
    expect(result.current.content).toBe('to be cancelled');
  });

  it('is idle without a task id (no ticket minted) and tears the source down when the id clears', async () => {
    const { result, rerender } = renderHook(({ taskId }: { taskId: string | null }) => useTaskStream(taskId), {
      initialProps: { taskId: null as string | null },
    });

    expect(result.current.status).toBe('idle');
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(mintCalls).toHaveLength(0);

    rerender({ taskId: 't-9' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    rerender({ taskId: null });
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(result.current.status).toBe('idle');
  });
});
