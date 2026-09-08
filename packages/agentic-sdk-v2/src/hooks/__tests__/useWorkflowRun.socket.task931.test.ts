/**
 * TASK-931 — `useWorkflowRun({ transport: 'socket' })`, the browser half of INTERFACES §4.
 *
 * The same three steps the server SDK takes, with the browser's own `WebSocket`: mint a
 * RUN-SCOPED single-use ticket at `POST /workflows/{slug}/runs/{runId}/stream-ticket`, resolve
 * the `url` that response returns against the client's base (`http(s)` → `ws(s)`), and feed the
 * frames into the SAME state the SSE lane feeds — `events`, `status`, `lastEventId`,
 * `isRunning`, `stopWatching()`. A call site changes one option and nothing else.
 *
 * A JWT never travels in the URL; that is the whole reason the ticket exists.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkflowRun } from '../useWorkflowRun';

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  getBaseUrl: () => 'https://api.example.com/api/v1',
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined }),
}));

// The SSE lane must not be touched at all when `transport: 'socket'` is asked for.
let sseConnects = 0;
vi.mock('../../core/SSEClient', () => ({
  SSEClient: class {
    onEvent(): void {}
    onError(): void {}
    onOpen(): void {}
    connect(): void {
      sseConnects += 1;
    }
    disconnect(): void {}
    getLastEventId(): string | null {
      return null;
    }
  },
}));

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  emitFrame(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

function envelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: '01924f00-0000-7000-8000-000000000001',
    tenantId: 't',
    type,
    occurredAt: '2026-09-08T00:00:00.000Z',
    correlationId: 'run-1',
    causationId: null,
    idempotencyKey: 'k',
    payload,
  };
}

const TICKET = {
  ticket: 'tkt-1',
  expiresAt: Date.now() + 30_000,
  scope: 'workflow_run:run-1',
  url: '/ws/workflows?slug=triage&runId=run-1&ticket=tkt-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  sseConnects = 0;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  apiClient.get.mockResolvedValue({ data: [] });
  apiClient.post.mockResolvedValue(TICKET);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The last socket the hook opened. */
async function openedSocket(): Promise<FakeWebSocket> {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  // `.slice(-1)[0]` rather than `.at(-1)`: this package targets a lib without `Array.prototype.at`.
  return FakeWebSocket.instances.slice(-1)[0]!;
}

describe("useWorkflowRun({ transport: 'socket' })", () => {
  it('mints a run-scoped ticket and opens the ws:// URL it returns — never a JWT in the query string', async () => {
    const { result } = renderHook(() => useWorkflowRun({ transport: 'socket', skipInitialLoad: true }));

    act(() => {
      result.current.watch('triage', 'run-1');
    });
    const socket = await openedSocket();

    expect(apiClient.post).toHaveBeenCalledWith('/workflows/triage/runs/run-1/stream-ticket');
    expect(socket.url).toBe('wss://api.example.com/ws/workflows?slug=triage&runId=run-1&ticket=tkt-1');
    expect(sseConnects).toBe(0);
  });

  it('feeds the same state the SSE lane feeds — events, resume cursor and status', async () => {
    const { result } = renderHook(() => useWorkflowRun({ transport: 'socket', skipInitialLoad: true }));

    act(() => {
      result.current.watch('triage', 'run-1');
    });
    const socket = await openedSocket();

    act(() => {
      socket.emitFrame({
        event: 'workflow.run.progress',
        id: 'c1',
        data: envelope('workflow.run.progress', { runId: 'run-1', slug: 'triage', workflowVersionNumber: 3, status: 'RUNNING', stages: [] }),
      });
    });

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events[0]!.type).toBe('workflow.run.progress');
    expect(result.current.events[0]!.resumeToken).toBe('c1');
    expect(result.current.lastEventId).toBe('c1');
    expect(result.current.status?.status).toBe('RUNNING');
  });

  it('closes the socket on a terminal frame — a completed run is not something to keep watching', async () => {
    const { result } = renderHook(() => useWorkflowRun({ transport: 'socket', skipInitialLoad: true }));

    act(() => {
      result.current.watch('triage', 'run-1');
    });
    const socket = await openedSocket();

    act(() => {
      socket.emitFrame({
        event: 'workflow.run.completed',
        id: 'c2',
        data: envelope('workflow.run.completed', { runId: 'run-1', slug: 'triage', workflowVersionNumber: 3, status: 'COMPLETED', stages: [] }),
      });
    });

    await waitFor(() => expect(socket.closed).toBe(true));
    expect(result.current.isRunning).toBe(false);
  });

  it('stopWatching() closes the socket without cancelling the run', async () => {
    const { result } = renderHook(() => useWorkflowRun({ transport: 'socket', skipInitialLoad: true }));

    act(() => {
      result.current.watch('triage', 'run-1');
    });
    const socket = await openedSocket();

    act(() => {
      result.current.stopWatching();
    });

    await waitFor(() => expect(socket.closed).toBe(true));
    expect(apiClient.post).not.toHaveBeenCalledWith('/workflows/triage/runs/run-1/cancel');
  });

  it('forwards a resume cursor as the `lastEventId` query parameter', async () => {
    const { result } = renderHook(() => useWorkflowRun({ transport: 'socket', skipInitialLoad: true }));

    act(() => {
      result.current.watch('triage', 'run-1', 'c7');
    });

    expect((await openedSocket()).url).toContain('lastEventId=c7');
  });

  it('leaves SSE the default — no ticket is minted without the option', async () => {
    const { result } = renderHook(() => useWorkflowRun({ skipInitialLoad: true }));

    act(() => {
      result.current.watch('triage', 'run-1');
    });

    await waitFor(() => expect(sseConnects).toBe(1));
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
