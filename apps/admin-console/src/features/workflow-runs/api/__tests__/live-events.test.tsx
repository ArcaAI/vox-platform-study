/**
 * TASK-999 lane H — `useRunLiveEvents` never called `close()` on the terminal
 * `workflow.run.completed` frame, even though the gateway ends its HTTP response
 * (`res.end()`) right after writing it (`workflow-stream.service.ts:100`, the same
 * shape on the initial snapshot when a run is ALREADY terminal, `:99-101`). EventSource
 * cannot tell that clean close apart from a drop, so it fired `onerror` and
 * `useEventStream` minted a fresh ticket and reconnected — forever, since a completed run
 * publishes nothing more to read.
 *
 * Fixed by closing eagerly on `WORKFLOW_RUN_COMPLETED` and exposing `close` on the hook's
 * return value (the run-trace screen's own `enabled: isLiveRun` REST-derived gating stays as
 * a second, independent stop — belt and braces, not replaced).
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useRunLiveEvents,
  WORKFLOW_NODE_FAILED,
  WORKFLOW_NODE_STARTED,
  WORKFLOW_RUN_COMPLETED,
  WORKFLOW_RUN_PROGRESS,
} from '../live-events';

/** Instrumented EventSource double (mirrors `playground-consultation/api/__tests__/streams.test.tsx`). */
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

  open(): void {
    this.onopen?.();
  }

  /** Named SSE event — every frame on this channel carries `envelope.type` as its name. */
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

function stubTicket(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/stream-ticket') {
        const body = init?.body ? (JSON.parse(init.body as string) as { scope: string }) : { scope: '' };
        return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: body.scope });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }),
  );
}

const progressEnvelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'evt-1',
  tenantId: 'tnt-1',
  type: WORKFLOW_RUN_PROGRESS,
  occurredAt: '2026-09-22T10:00:00.000Z',
  correlationId: 'run-1',
  causationId: null,
  idempotencyKey: 'wf:run:run-1:status:RUNNING',
  payload: { runId: 'run-1', slug: 'triage', workflowVersionNumber: 1, status: 'RUNNING', stages: [], startedAt: 't0', endedAt: null },
  ...overrides,
});

const completedEnvelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'evt-2',
  tenantId: 'tnt-1',
  type: WORKFLOW_RUN_COMPLETED,
  occurredAt: '2026-09-22T10:00:05.000Z',
  correlationId: 'run-1',
  causationId: null,
  idempotencyKey: 'wf:run:run-1:status:COMPLETED',
  payload: { runId: 'run-1', slug: 'triage', workflowVersionNumber: 1, status: 'COMPLETED', stages: [], startedAt: 't0', endedAt: 't5' },
  ...overrides,
});

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  stubTicket();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useRunLiveEvents', () => {
  it('mints a workflow_run ticket and opens the slug/runId stream', async () => {
    const { result } = renderHook(() => useRunLiveEvents({ runId: 'run-1', slug: 'triage', enabled: true }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toContain('/api/v1/workflows/triage/runs/run-1/stream?ticket=');
    expect(result.current.status).toBe('connecting');
  });

  // RED before the fix: onEvent never called stream.close() on WORKFLOW_RUN_COMPLETED, and the
  // hook exposed no `close` at all — the gateway's res.end() was read as a drop and retried.
  it('closes the stream on the terminal workflow.run.completed frame — schedules no reconnect', async () => {
    const { result } = renderHook(() => useRunLiveEvents({ runId: 'run-1', slug: 'triage', enabled: true }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.open());

    act(() => source.emit(WORKFLOW_RUN_COMPLETED, completedEnvelope()));

    expect(source.closed).toBe(true);
    // No reconnect was ever scheduled — a second EventSource would appear if it had been.
    expect(FakeEventSource.instances).toHaveLength(1);
    // The terminal frame is a legitimate control event for this hook (unlike the live-summary
    // `closed: true` marker) — it belongs in the log, not hidden from it.
    expect(result.current.events.some((event) => event.type === WORKFLOW_RUN_COMPLETED)).toBe(true);
  });

  // RED before the fix would have passed vacuously (close() didn't exist yet); this proves the
  // NEW close() call is gated on WORKFLOW_RUN_COMPLETED and does not fire for every frame type.
  it('does not close the stream on a non-terminal workflow.run.progress or workflow.node.* frame', async () => {
    const { result } = renderHook(() => useRunLiveEvents({ runId: 'run-1', slug: 'triage', enabled: true }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.open());

    act(() => source.emit(WORKFLOW_RUN_PROGRESS, progressEnvelope()));
    expect(source.closed).toBe(false);

    act(() =>
      source.emit(WORKFLOW_NODE_STARTED, {
        ...progressEnvelope({ type: WORKFLOW_NODE_STARTED }),
        payload: { nodeId: 'n1', nodeType: 'interpreter.passthrough', status: 'RUNNING' },
      }),
    );
    expect(source.closed).toBe(false);

    act(() =>
      source.emit(WORKFLOW_NODE_FAILED, {
        ...progressEnvelope({ type: WORKFLOW_NODE_FAILED }),
        payload: { nodeId: 'n1', nodeType: 'interpreter.passthrough', status: 'ERROR', reason: 'boom' },
      }),
    );
    expect(source.closed).toBe(false);
    expect(result.current.status).not.toBe('closed');
  });

  it('exposes close() directly, for a caller that wants to stop the stream itself', async () => {
    const { result } = renderHook(() => useRunLiveEvents({ runId: 'run-1', slug: 'triage', enabled: true }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => result.current.close());
    expect(source.closed).toBe(true);
  });
});
