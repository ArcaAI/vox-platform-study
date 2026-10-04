/**
 * TASK-1038 — the WebSocket run plane, brought to parity with the SSE route.
 *
 * - G11: a `lastEventId` the producer's MAXLEN trim has already evicted is answered with a
 *   resync snapshot, exactly as SSE answers it — before, the socket silently resumed from the
 *   surviving tail and the client never learnt about the hole.
 * - R-9: a client whose unsent buffer is above `workflowRuns.wsMaxBufferedBytes` is not sent
 *   more frames until it catches up (`bufferedAmount` used to be ignored).
 * - R-2: a lost completion event closes the socket with a terminal snapshot after an idle
 *   re-check, instead of heartbeating forever.
 * - R-1: reads go through the shared `RunEventStreamHub`.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeResumeToken } from '@arcaai/async-contract';
import { WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY, WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY } from '@arcaai/applications';
import { RunEventStreamHub } from '../../workflows/run-event-stream-hub';
import { RUN_EVENT_TRANSPORT, runEventStreamKey } from '../../workflows/workflow-run-event';
import { FakeRedisServer } from '../../workflows/__tests__/fake-redis-streams';
import { WORKFLOW_RUN_TICKET_NAMESPACE, WorkflowWsGateway } from '../workflow-ws.gateway';

const TENANT = '10000000-0000-0000-0000-000000000001';
const USER = '20000000-0000-0000-0000-000000000002';
const RUN = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43';
const KEY = runEventStreamKey(RUN);
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };

function envelope(type: string, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: TENANT,
    type,
    occurredAt: '2026-10-04T00:00:00.000Z',
    correlationId: RUN,
    causationId: null,
    idempotencyKey: `wf:run:${RUN}:${type}:${JSON.stringify(payload)}`,
    payload,
  };
}

const status = (value: string) => ({ runId: RUN, slug: 'flow', workflowVersionNumber: 1, status: value, stages: [], startedAt: null, endedAt: null });

function makeSocket() {
  const listeners: Record<string, (() => void)[]> = {};
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(() => {
      socket.readyState = 3;
      (listeners.close ?? []).forEach((cb) => cb());
    }),
    ping: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
  };
  return socket;
}

function frames(socket: ReturnType<typeof makeSocket>) {
  return socket.send.mock.calls.map(
    (call) => JSON.parse(String(call[0])) as { event: string; id?: string; data: { payload: { status?: string; nodeId?: string } } },
  );
}

function build(server: FakeRedisServer, getRunStatus: ReturnType<typeof vi.fn>, values: Record<string, number> = {}) {
  const settings = { resolvePlatform: vi.fn((key: string) => ({ key, value: values[key] })) };
  const hub = new RunEventStreamHub(CONFIG as never, settings as never);
  hub.connectionFactory = () => server.connection() as never;
  const tickets = { consumeTicket: vi.fn(async () => ({ scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:${RUN}`, tenantId: TENANT, userId: USER })) };
  const cls = { set: vi.fn(), run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const gateway = new WorkflowWsGateway(tickets as never, { getRunStatus } as never, cls as never, hub, undefined, settings as never);
  return { gateway, hub };
}

const req = (lastEventId?: string) => ({
  url: `/ws/workflows?slug=flow&runId=${RUN}&ticket=t-1${lastEventId ? `&lastEventId=${encodeURIComponent(lastEventId)}` : ''}`,
  headers: {},
});

afterEach(() => vi.useRealTimers());

describe('TASK-1038 G11 — WS trimmed-gap resync', () => {
  it('re-snapshots when lastEventId was trimmed, then delivers everything still retained', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.node.started', { nodeId: 'n1' }));
    server.appendEnvelope(KEY, envelope('workflow.node.completed', { nodeId: 'n1' }));
    server.appendEnvelope(KEY, envelope('workflow.node.started', { nodeId: 'n2' }));
    server.appendEnvelope(KEY, envelope('workflow.run.completed', { status: 'SUCCEEDED' }));
    server.trimThrough(KEY, '2-0');
    const getRunStatus = vi.fn().mockResolvedValue(status('RUNNING'));
    const { gateway, hub } = build(server, getRunStatus);
    const socket = makeSocket();

    await gateway.handleConnection(socket as never, req(encodeResumeToken(RUN_EVENT_TRANSPORT, '1-0')) as never);

    const events = frames(socket);
    expect(events.map((frame) => frame.event)).toEqual([
      'workflow.run.progress', // connect snapshot
      'workflow.run.progress', // resync snapshot: the client is told about the hole
      'workflow.node.started',
      'workflow.run.completed',
    ]);
    expect(events[1].id).toBeUndefined();
    expect(getRunStatus).toHaveBeenCalledTimes(2);
    await hub.onModuleDestroy();
  });
});

describe('TASK-1038 R-9 — WS backpressure', () => {
  it('sends nothing more while bufferedAmount is above the threshold, and resumes once it drains', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.node.started', { nodeId: 'n1' }));
    server.appendEnvelope(KEY, envelope('workflow.run.completed', { status: 'SUCCEEDED' }));
    const { gateway, hub } = build(server, vi.fn().mockResolvedValue(status('RUNNING')), { [WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY]: 64 * 1024 });
    const socket = makeSocket();
    socket.bufferedAmount = 5 * 1024 * 1024; // the client is far behind

    const connecting = gateway.handleConnection(socket as never, req() as never);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames(socket).map((frame) => frame.event)).toEqual(['workflow.run.progress']);

    socket.bufferedAmount = 0;
    await connecting;
    expect(frames(socket).map((frame) => frame.event)).toEqual(['workflow.run.progress', 'workflow.node.started', 'workflow.run.completed']);
    await hub.onModuleDestroy();
  });
});

describe('TASK-1038 R-2 — WS terminal fallback', () => {
  it('closes with a terminal snapshot when the run ended but its completion event never arrived', async () => {
    vi.useFakeTimers();
    const server = new FakeRedisServer();
    const getRunStatus = vi.fn().mockResolvedValueOnce(status('RUNNING')).mockResolvedValue(status('CANCELED'));
    const { gateway, hub } = build(server, getRunStatus, { [WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY]: 5 });
    const socket = makeSocket();

    const connecting = gateway.handleConnection(socket as never, req() as never);
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await connecting;

    const events = frames(socket);
    expect(events.map((frame) => frame.event)).toEqual(['workflow.run.progress', 'workflow.run.completed']);
    expect(events[1].data.payload.status).toBe('CANCELED');
    expect(socket.close).toHaveBeenCalledWith(1000, 'run completed');
    await hub.onModuleDestroy();
  });

  it('starts the stream retention clock on the completion event', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.run.completed', { status: 'SUCCEEDED' }));
    const { gateway, hub } = build(server, vi.fn().mockResolvedValue(status('RUNNING')));
    await gateway.handleConnection(makeSocket() as never, req() as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.ttls.get(KEY)).toBe(24 * 3600);
    await hub.onModuleDestroy();
  });
});
