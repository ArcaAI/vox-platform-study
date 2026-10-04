/**
 * TASK-1036 §10.2 / TASK-1038 protocol v2 — the admin trace stream the Test tab reads:
 * single-use ticket (never a JWT in the URL), `?protocol=2`, resume by `seq` on every reconnect,
 * replayed duplicates dropped, `ping` never delivered, `run.resync` delivered, closed on terminal.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunTraceStream } from '../use-run-trace-stream';

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
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, envelope: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify({ runId: 'run-1', ts: '2026-10-04T10:00:00.000Z', data: {}, ...envelope, type }) } as MessageEvent);
  }

  fail(): void {
    this.onerror?.();
  }
}

let mints: Array<{ scope: string }> = [];

beforeEach(() => {
  FakeEventSource.instances = [];
  mints = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  let counter = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      mints.push(JSON.parse(String(init?.body)) as { scope: string });
      counter += 1;
      return Response.json({ ticket: `tkt-${counter}`, expiresAt: Date.now() + 30_000, scope: 'x' });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

describe('useRunTraceStream', () => {
  it('is idle without a run', () => {
    const { result } = renderHook(() => useRunTraceStream(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.events).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('opens the admin trace with a run-scoped ticket and protocol 2 from the beginning', async () => {
    renderHook(() => useRunTraceStream('run-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(mints).toEqual([{ scope: 'workflow_run:run-1' }]);
    const url = new URL(latest().url);
    expect(url.pathname).toBe('/api/v1/admin/workflow-runs/run-1/trace/stream');
    expect(url.searchParams.get('protocol')).toBe('2');
    expect(url.searchParams.get('after')).toBe('0');
    expect(url.searchParams.get('ticket')).toBe('tkt-1');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('delivers events in order, drops replays and pings, and keeps the cursor', async () => {
    const { result } = renderHook(() => useRunTraceStream('run-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      latest().emit('run.started', { seq: 1, data: { kind: 'workflow', slug: 's', versionNumber: 1 } });
      latest().emit('node.started', { seq: 4, nodeId: 'n', data: { kind: 'core.agent' } });
      latest().emit('node.started', { seq: 4, nodeId: 'n', data: { kind: 'core.agent' } });
      latest().emit('ping', { seq: 9 });
    });
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 4]);
    expect(result.current.cursor).toBe(9);
  });

  it('reconnects with a FRESH ticket and resumes after the last seen seq', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useRunTraceStream('run-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => latest().emit('run.started', { seq: 3, data: { kind: 'workflow', slug: 's', versionNumber: 1 } }));
    act(() => latest().fail());
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const url = new URL(latest().url);
    expect(url.searchParams.get('after')).toBe('3');
    expect(url.searchParams.get('ticket')).toBe('tkt-2');
    expect(result.current.events).toHaveLength(1);
  });

  it('delivers a run.resync and moves the cursor to its seq', async () => {
    const { result } = renderHook(() => useRunTraceStream('run-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      latest().emit('node.started', { seq: 5, nodeId: 'n', data: { kind: 'core.agent' } });
      latest().emit('run.resync', { seq: 3, data: { reason: 'gap', snapshot: { status: 'RUNNING', lastSeq: 3, nodes: {}, outputs: {} } } });
    });
    expect(result.current.events.map((event) => event.type)).toEqual(['node.started', 'run.resync']);
    expect(result.current.cursor).toBe(3);
  });

  it('closes on the terminal event and does not reconnect', async () => {
    const { result } = renderHook(() => useRunTraceStream('run-1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => latest().emit('run.completed', { seq: 2, data: { status: 'COMPLETED', durationMs: 5, tokens: { in: 0, out: 0 } } }));
    expect(latest().closed).toBe(true);
    expect(result.current.status).toBe('closed');
    act(() => latest().fail());
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('starts over for a new run', async () => {
    const { result, rerender } = renderHook(({ runId }) => useRunTraceStream(runId), { initialProps: { runId: 'run-1' as string | null } });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => latest().emit('run.started', { seq: 1, data: { kind: 'workflow', slug: 's', versionNumber: 1 } }));
    rerender({ runId: 'run-2' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(result.current.events).toEqual([]);
    expect(new URL(latest().url).pathname).toBe('/api/v1/admin/workflow-runs/run-2/trace/stream');
    expect(new URL(latest().url).searchParams.get('after')).toBe('0');
  });
});
