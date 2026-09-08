/**
 * TASK-931 — `transport: 'socket'` on the workflow run stream (INTERFACES §4, amendment A-1).
 *
 * What the SDK must do, and in this order: mint a RUN-SCOPED single-use ticket at
 * `POST …/runs/{runId}/stream-ticket`, resolve the `url` that response returns against the
 * client's `baseUrl` (`http(s)` → `ws(s)`), and read the same event objects the SSE lane
 * yields — so `streamRun`, `waitForRun` and `runAndStream` differ by one option and nothing
 * else at the call site.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { FakeWebSocket } from '../../core/__tests__/support/fake-websocket';
import { SocketUnavailableError } from '../../core/errors';
import type { WorkflowRunEvent } from '../../types/workflow';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.reset();
});

function stubFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error(`stubFetch: no response configured for call ${index}`);
    return next();
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The amendment A-1 shape: `expiresAt` (epoch ms) and `scope`, NOT `expiresIn`. */
const TICKET = () =>
  json(
    {
      ticket: 'tkt-1',
      expiresAt: Date.now() + 30_000,
      scope: 'workflow_run:run-1',
      url: '/ws/workflows?slug=triage&runId=run-1&ticket=tkt-1',
    },
    201,
  );

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

function client(fetchImpl: typeof fetch): HopeClient {
  return new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'k', fetch: fetchImpl, maxRetries: 0 });
}

const COMPLETED = envelope('workflow.run.completed', {
  runId: 'run-1',
  slug: 'triage',
  workflowVersionNumber: 3,
  status: 'COMPLETED',
  stages: [],
  startedAt: '2026-09-08T00:00:00.000Z',
  endedAt: '2026-09-08T00:00:01.000Z',
});

describe('streamRun({ transport: "socket" })', () => {
  it('mints a run-scoped ticket, opens the URL it returns as ws://, and yields the same events', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { fetch, calls } = stubFetch([TICKET]);
    const events: WorkflowRunEvent[] = [];

    const pump = (async (): Promise<void> => {
      for await (const event of client(fetch).workflows.streamRun('triage', 'run-1', { transport: 'socket' })) events.push(event);
    })();

    const socket = await FakeWebSocket.opened();
    socket.emitMessage(JSON.stringify({ event: 'workflow.run.progress', id: 'c1', data: envelope('workflow.run.progress', { status: 'RUNNING' }) }));
    socket.emitMessage(JSON.stringify({ event: 'workflow.run.completed', id: 'c2', data: COMPLETED }));
    socket.emitClose();
    await pump;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/triage/runs/run-1/stream-ticket');
    expect(calls[0]!.init.method).toBe('POST');
    expect(socket.url).toBe('ws://localhost:8868/ws/workflows?slug=triage&runId=run-1&ticket=tkt-1');

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('workflow.run.progress');
    // The frame's `id` becomes `resumeToken`, exactly as the SSE lane's `id:` line does.
    expect(events[0]!.resumeToken).toBe('c1');
    expect(events[1]!.type).toBe('workflow.run.completed');
  });

  it('forwards a resume cursor as the `lastEventId` query parameter the WS gateway reads', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { fetch } = stubFetch([TICKET]);

    const pump = (async (): Promise<void> => {
      for await (const _ of client(fetch).workflows.streamRun('triage', 'run-1', { transport: 'socket', lastEventId: 'c7' })) void _;
    })();
    const socket = await FakeWebSocket.opened();
    socket.emitClose();
    await pump;

    expect(socket.url).toContain('lastEventId=c7');
  });

  it('throws SocketUnavailableError BEFORE minting a ticket when the runtime has no WebSocket', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const { fetch, calls } = stubFetch([TICKET]);

    await expect(
      (async (): Promise<void> => {
        for await (const _ of client(fetch).workflows.streamRun('triage', 'run-1', { transport: 'socket' })) void _;
      })(),
    ).rejects.toBeInstanceOf(SocketUnavailableError);
    // A single-use ticket that is never used is a ticket wasted; check the runtime first.
    expect(calls).toHaveLength(0);
  });

  it('leaves SSE as the default — no ticket is minted without the option', async () => {
    const { fetch, calls } = stubFetch([() => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })]);

    for await (const _ of client(fetch).workflows.streamRun('triage', 'run-1')) void _;

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/triage/runs/run-1/stream');
  });
});

describe('waitForRun({ transport: "socket" })', () => {
  it('returns the terminal status from the socket lane, with no extra read', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { fetch, calls } = stubFetch([TICKET]);

    const pending = client(fetch).workflows.waitForRun('triage', 'run-1', { transport: 'socket' });
    const socket = await FakeWebSocket.opened();
    socket.emitMessage(JSON.stringify({ event: 'workflow.run.completed', id: 'c2', data: COMPLETED }));
    socket.emitClose();

    await expect(pending).resolves.toMatchObject({ runId: 'run-1', slug: 'triage', status: 'COMPLETED', workflowVersionNumber: 3 });
    expect(calls).toHaveLength(1);
  });
});

describe('runAndStream({ transport: "socket" })', () => {
  it('starts the run over HTTP, then hands off to the socket for its events', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { fetch, calls } = stubFetch([() => json({ runId: 'run-1', slug: 'triage', status: 'accepted' }, 202), TICKET]);
    const events: WorkflowRunEvent[] = [];

    const pump = (async (): Promise<void> => {
      for await (const event of client(fetch).workflows.runAndStream('triage', { input: { note: 'n' } }, { transport: 'socket' })) {
        events.push(event);
      }
    })();

    const socket = await FakeWebSocket.opened();
    socket.emitMessage(JSON.stringify({ event: 'workflow.run.completed', id: 'c2', data: COMPLETED }));
    socket.emitClose();
    await pump;

    // `?mode=stream` would put the events on the POST's own response — the socket lane cannot
    // use that, so the start is a plain async run and the socket is opened against its runId.
    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/triage/runs');
    expect(calls[1]!.url).toBe('http://localhost:8868/api/v1/workflows/triage/runs/run-1/stream-ticket');
    expect(events.map((e) => e.type)).toEqual(['workflow.run.completed']);
  });
});
