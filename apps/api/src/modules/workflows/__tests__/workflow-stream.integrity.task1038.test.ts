/**
 * TASK-1038 — R-2 (terminal fallback), R-9 (backpressure) and the OD-25 stream TTL, on the SSE
 * and blocking delivery paths, plus the hub's own contract (wake on a new key, abort, a failed
 * read rejects only the reads it carried and the hub recovers).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY, WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY } from '@arcaai/applications';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowStreamService } from '../workflow-stream.service';
import { runEventStreamKey } from '../workflow-run-event';
import { FakeRedisServer } from './fake-redis-streams';

const TENANT = '22222222-2222-2222-2222-222222222222';
const KEY = runEventStreamKey('run-1');
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };

function envelope(type: string, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: TENANT,
    type,
    occurredAt: '2026-10-04T00:00:00.000Z',
    correlationId: 'run-1',
    causationId: null,
    idempotencyKey: `wf:run:run-1:${type}:${JSON.stringify(payload)}`,
    payload,
  };
}

function status(value: string) {
  return { runId: 'run-1', slug: 'flow', workflowVersionNumber: 1, status: value, stages: [], startedAt: '2026-10-04T00:00:00.000Z', endedAt: null };
}

function settingsWith(values: Record<string, number>) {
  return { resolvePlatform: vi.fn((key: string) => ({ key, value: values[key], source: 'system' })) };
}

function makeRes() {
  const listeners: Record<string, (() => void)[]> = {};
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((_chunk: string) => true),
    writableEnded: false,
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    once: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners[event] = (listeners[event] ?? []).filter((listener) => listener !== cb);
    }),
    emit(event: string) {
      (listeners[event] ?? []).slice().forEach((cb) => cb());
    },
  };
  return res;
}

function framesOf(res: ReturnType<typeof makeRes>) {
  return res.write.mock.calls
    .map((call) => String(call[0]))
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => JSON.parse(/\ndata: (.+)\n\n$/.exec(frame)![1]) as { type: string; payload: { status?: string } });
}

function build(server: FakeRedisServer, getRunStatus: ReturnType<typeof vi.fn>, settings = settingsWith({})) {
  const hub = new RunEventStreamHub(CONFIG as never, settings as never);
  hub.connectionFactory = () => server.connection() as never;
  const service = new WorkflowStreamService({ getRunStatus } as never, { get: vi.fn(() => TENANT) } as never, hub, settings as never);
  return { hub, service };
}

describe('TASK-1038 R-2 — a lost completion event no longer leaves a stream open forever', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('SSE: re-checks the run while idle and closes with a terminal snapshot', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.node.started', { nodeId: 'n1' }));
    // The producer died before it appended `workflow.run.completed`; the run IS finished.
    const getRunStatus = vi.fn().mockResolvedValueOnce(status('RUNNING')).mockResolvedValue(status('COMPLETED'));
    const { service, hub } = build(server, getRunStatus, settingsWith({ [WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY]: 5 }));
    const res = makeRes();

    const streaming = service.stream('flow', 'run-1', res as never);
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await streaming;

    const types = framesOf(res).map((frame) => frame.type);
    expect(types).toEqual(['workflow.run.progress', 'workflow.node.started', 'workflow.run.completed']);
    expect(framesOf(res).at(-1)?.payload.status).toBe('COMPLETED');
    expect(res.end).toHaveBeenCalled();
    await hub.onModuleDestroy();
  });

  it('blocking mode: answers the terminal status long before its ceiling', async () => {
    const server = new FakeRedisServer();
    const getRunStatus = vi.fn().mockResolvedValueOnce(status('RUNNING')).mockResolvedValue(status('FAILED'));
    const { service, hub } = build(server, getRunStatus, settingsWith({ [WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY]: 5 }));

    let settled: unknown = 'pending';
    const waiting = service.awaitTerminal('flow', 'run-1', 60_000).then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).not.toBe('pending');
    expect((settled as { status: string }).status).toBe('FAILED');
    await waiting;
    await hub.onModuleDestroy();
  });
});

describe('TASK-1038 R-9 — SSE honours the socket backpressure', () => {
  it('stops writing when write() returns false and resumes only on drain', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.node.started', { nodeId: 'n1' }));
    server.appendEnvelope(KEY, envelope('workflow.node.completed', { nodeId: 'n1' }));
    server.appendEnvelope(KEY, envelope('workflow.run.completed', { status: 'SUCCEEDED' }));
    const { service, hub } = build(server, vi.fn().mockResolvedValue(status('RUNNING')));
    const res = makeRes();
    // Snapshot fits; the first pushed frame fills the socket buffer.
    res.write.mockImplementationOnce(() => true).mockImplementationOnce(() => false);

    const streaming = service.stream('flow', 'run-1', res as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(framesOf(res).map((frame) => frame.type)).toEqual(['workflow.run.progress', 'workflow.node.started']);

    res.emit('drain');
    await streaming;
    expect(framesOf(res).map((frame) => frame.type)).toEqual([
      'workflow.run.progress',
      'workflow.node.started',
      'workflow.node.completed',
      'workflow.run.completed',
    ]);
    await hub.onModuleDestroy();
  });
});

describe('TASK-1038 OD-25 — a terminal run stream starts its retention clock', () => {
  it('EXPIREs the stream after the completion event, per workflowRuns.eventRetentionHours', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.run.completed', { status: 'SUCCEEDED' }));
    const { service, hub } = build(
      server,
      vi.fn().mockResolvedValue(status('RUNNING')),
      settingsWith({ [WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY]: 48 }),
    );

    await service.stream('flow', 'run-1', makeRes() as never);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(server.ttls.get(KEY)).toBe(48 * 3600);
    await hub.onModuleDestroy();
  });

  it('defaults to 24 h and never extends a clock already running (EXPIRE NX)', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, envelope('workflow.run.completed', { status: 'SUCCEEDED' }));
    const { hub } = build(server, vi.fn());

    await hub.expireAfterTerminal('run-1');
    expect(server.ttls.get(KEY)).toBe(24 * 3600);
    server.ttls.set(KEY, 10);
    await hub.expireAfterTerminal('run-1');
    expect(server.ttls.get(KEY)).toBe(10);
    await hub.onModuleDestroy();
  });
});

describe('RunEventStreamHub', () => {
  it('a read on a NEW key does not wait for the parked XREAD — the hub wakes it', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server, vi.fn());
    const quiet = hub.read('wf:run:quiet:events', '0-0', { timeoutMs: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 20)); // the XREAD for `quiet` is parked

    const startedAt = Date.now();
    const busy = hub.read('wf:run:busy:events', '0-0', { timeoutMs: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.appendEnvelope('wf:run:busy:events', envelope('workflow.node.started'));
    const entries = await busy;

    expect(entries).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(200);
    await hub.onModuleDestroy();
    expect(await quiet).toEqual([]);
  });

  it('an aborted read resolves empty and leaves nothing pending', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server, vi.fn());
    const controller = new AbortController();
    const read = hub.read(KEY, '0-0', { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    expect(await read).toEqual([]);
    expect(hub.pendingReads).toBe(0);
    await hub.onModuleDestroy();
  });

  it('a failed XREAD rejects the reads it carried, and the hub recovers after backing off', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server, vi.fn());
    const first = hub.read(KEY, '0-0', { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Fail the NEXT read the reader issues: release the parked one, which re-issues and fails.
    server.connections[0].failNextXread = new Error('connection reset');
    server.connections[0].releaseBlock();
    await expect(first).rejects.toThrow('connection reset');

    const second = hub.read(KEY, '0-0', { timeoutMs: 2_000 });
    server.appendEnvelope(KEY, envelope('workflow.node.started'));
    expect(await second).toHaveLength(1);
    await hub.onModuleDestroy();
  });
});
