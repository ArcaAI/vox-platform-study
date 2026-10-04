/**
 * TASK-1038 B3a deliverable 2 — run protocol v2 on the run WebSocket (protocol-v2.md §1, §2,
 * §6.2): `?protocol=2` selects it; every text frame is the bare v2 envelope; `?after=<seq>`
 * resumes; the business plane only; an unsupported protocol closes with 4400 before anything is
 * sent; legacy clients keep `{ event, id, data }` frames derived from the stored v2 events.
 */
import { describe, expect, it, vi } from 'vitest';
import { runEventProblems } from '@arcaai/async-contract';
import type { RunAppendInput } from '@arcaai/async-contract';
import { RunEventStreamHub } from '../../workflows/run-event-stream-hub';
import { FakeRedisServer } from '../../workflows/__tests__/fake-redis-streams';
import { WORKFLOW_RUN_TICKET_NAMESPACE, WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED, WorkflowWsGateway } from '../workflow-ws.gateway';

const TENANT = '10000000-0000-0000-0000-000000000001';
const USER = '20000000-0000-0000-0000-000000000002';
const RUN = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43';
const TS = '2026-10-04T10:00:00.000Z';
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };
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

function build(server: FakeRedisServer, getRunStatus = vi.fn().mockResolvedValue(status('RUNNING'))) {
  const hub = new RunEventStreamHub(CONFIG as never, undefined);
  hub.connectionFactory = () => server.connection() as never;
  const tickets = { consumeTicket: vi.fn(async () => ({ scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:${RUN}`, tenantId: TENANT, userId: USER })) };
  const cls = { set: vi.fn(), get: vi.fn(() => TENANT), run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const gateway = new WorkflowWsGateway(tickets as never, { getRunStatus } as never, cls as never, hub, undefined, undefined);
  return { gateway, hub, tickets };
}

const ev = (input: Omit<RunAppendInput, 'runId' | 'ts'>): RunAppendInput => ({ runId: RUN, ts: TS, ...input });

function seed(server: FakeRedisServer) {
  server.appendV2(ev({ type: 'node.started', nodeId: 'n1', data: { kind: 'core.agent' } })); // 1
  server.appendV2(ev({ type: 'transcript.final', data: { text: 'admin only' } })); // 2
  server.appendV2(ev({ type: 'output.text.delta', nodeId: 'n1', data: { field: 'text', text: 'x' } })); // 3
  server.appendV2(ev({ type: 'run.completed', data: { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }, retentionSeconds: 60 })); // 4
}

const url = (query: string) => ({ url: `/ws/workflows?slug=flow&runId=${RUN}&ticket=t-1${query}`, headers: {} });

describe('WS run protocol v2', () => {
  it('?protocol=2 sends bare v2 envelopes, public subset only, and closes after the terminal event', async () => {
    const server = new FakeRedisServer();
    seed(server);
    const { gateway, hub } = build(server);
    const socket = makeSocket();

    await gateway.handleConnection(socket as never, url('&protocol=2') as never);

    const sent = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(sent.map((frame) => `${frame.seq}:${frame.type}`)).toEqual(['1:node.started', '3:output.text.delta', '4:run.completed']);
    for (const frame of sent) expect(runEventProblems(frame, { plane: 'public' })).toEqual([]);
    expect(Object.keys(sent[0])).toEqual(['seq', 'runId', 'type', 'ts', 'nodeId', 'data']);
    expect(socket.close).toHaveBeenCalledWith(1000, 'run completed');
    await hub.onModuleDestroy();
  });

  it('?after=<seq> resumes after that seq', async () => {
    const server = new FakeRedisServer();
    seed(server);
    const { gateway, hub } = build(server);
    const socket = makeSocket();

    await gateway.handleConnection(socket as never, url('&protocol=2&after=1') as never);

    const sent = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { seq: number });
    expect(sent.map((frame) => frame.seq)).toEqual([3, 4]);
    await hub.onModuleDestroy();
  });

  it('an unsupported protocol closes with 4400 BEFORE the ticket is consumed or anything is sent', async () => {
    const server = new FakeRedisServer();
    const { gateway, hub, tickets } = build(server);
    const socket = makeSocket();

    await gateway.handleConnection(socket as never, url('&protocol=3') as never);

    expect(socket.close).toHaveBeenCalledWith(WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED, expect.any(String));
    expect(socket.send).not.toHaveBeenCalled();
    expect(tickets.consumeTicket).not.toHaveBeenCalled();
    await hub.onModuleDestroy();
  });

  it('legacy (no protocol): { event, id, data } frames derived from the stored v2 events', async () => {
    const server = new FakeRedisServer();
    seed(server);
    const { gateway, hub } = build(server);
    const socket = makeSocket();

    await gateway.handleConnection(socket as never, url('') as never);

    const sent = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { event: string; id?: string });
    expect(sent.map((frame) => frame.event)).toEqual(['workflow.run.progress', 'workflow.node.started', 'workflow.token.delta', 'workflow.run.completed']);
    expect(sent[0].id).toBeUndefined();
    expect(sent.slice(1).every((frame) => typeof frame.id === 'string')).toBe(true);
    await hub.onModuleDestroy();
  });
});
