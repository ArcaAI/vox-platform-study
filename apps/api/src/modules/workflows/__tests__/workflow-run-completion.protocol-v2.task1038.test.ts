/**
 * TASK-1038 B3a — the completion watcher and the blocking wait read protocol v2 terminal events.
 *
 * Producers write v2 only from this release (protocol-v2.md §6.1), so a watcher that understood
 * only `workflow.run.completed` would leave every new run `RUNNING` in the read model until the
 * idle harness re-check. The settled-node counts (TASK-982) are folded from the node events,
 * because `run.completed` does not carry them.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RunAppendInput } from '@arcaai/async-contract';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';
import { WorkflowStreamService } from '../workflow-stream.service';
import { FakeRedisServer } from './fake-redis-streams';

const TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';
const TS = '2026-10-04T10:00:00.000Z';
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };
const ev = (input: Omit<RunAppendInput, 'runId' | 'ts'>): RunAppendInput => ({ runId: RUN_ID, ts: TS, ...input });

function build(server: FakeRedisServer) {
  const hub = new RunEventStreamHub(CONFIG as never, undefined);
  hub.connectionFactory = () => server.connection() as never;
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const service = new WorkflowRunCompletionService(runs as never, cls as never, hub, undefined, undefined, undefined);
  return { service, hub, runs };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('completion watcher — protocol v2 terminal events', () => {
  it('run.completed → COMPLETED with the delivered result and counts folded from the node events', async () => {
    const server = new FakeRedisServer();
    server.appendV2(ev({ type: 'node.started', nodeId: 'a', data: { kind: 'k' } }));
    server.appendV2(ev({ type: 'node.completed', nodeId: 'a', data: { status: 'DEGRADED', durationMs: 1 } }));
    server.appendV2(ev({ type: 'node.started', nodeId: 'b', data: { kind: 'k' } }));
    server.appendV2(ev({ type: 'node.completed', nodeId: 'b', data: { status: 'SKIPPED', durationMs: 0 } }));
    server.appendV2(ev({ type: 'node.started', nodeId: 'c', data: { kind: 'k' } }));
    server.appendV2(ev({ type: 'transcript.final', data: { text: 'admin' } }));
    server.appendV2(ev({ type: 'node.completed', nodeId: 'c', data: { status: 'COMPLETED', durationMs: 3 } }));
    server.appendV2(
      ev({
        type: 'run.completed',
        data: { status: 'COMPLETED', durationMs: 9, tokens: { in: 1, out: 1 }, degraded: true, result: { kind: 'inline', value: { a: 1 } } },
        retentionSeconds: 60,
      }),
    );
    const { service, hub, runs } = build(server);

    expect(service.watch(TENANT, RUN_ID)).toBe(true);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);

    expect(runs.recordRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        status: 'COMPLETED',
        terminalReason: 'DEGRADED',
        nodeCount: 3,
        failedNodeCount: 0,
        degradedNodeCount: 1,
        skippedNodeCount: 1,
        resultRef: { kind: 'inline', value: { a: 1 } },
        endedAt: new Date(TS),
      }),
    );
    await hub.onModuleDestroy();
  });

  it('run.failed { TIMED_OUT } → TIMED_OUT, reason = the error code', async () => {
    const server = new FakeRedisServer();
    server.appendV2(
      ev({ type: 'run.failed', data: { status: 'TIMED_OUT', durationMs: 5, error: { code: 'RUN_TIMED_OUT', message: 'The run exceeded its time limit.' } }, retentionSeconds: 60 }),
    );
    const { service, hub, runs } = build(server);
    service.watch(TENANT, RUN_ID);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'TIMED_OUT', terminalReason: 'RUN_TIMED_OUT' }));
    await hub.onModuleDestroy();
  });

  it('run.cancelled → CANCELED', async () => {
    const server = new FakeRedisServer();
    server.appendV2(ev({ type: 'run.cancelled', data: { status: 'CANCELED', durationMs: 5 }, retentionSeconds: 60 }));
    const { service, hub, runs } = build(server);
    service.watch(TENANT, RUN_ID);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELED' }));
    await hub.onModuleDestroy();
  });
});

describe('blocking mode — a v2 terminal event ends the wait', () => {
  it('returns the authoritative status as soon as run.completed is stored', async () => {
    const server = new FakeRedisServer();
    const hub = new RunEventStreamHub(CONFIG as never, undefined);
    hub.connectionFactory = () => server.connection() as never;
    const getRunStatus = vi
      .fn()
      .mockResolvedValueOnce({ runId: RUN_ID, status: 'RUNNING' })
      .mockResolvedValue({ runId: RUN_ID, status: 'COMPLETED' });
    const service = new WorkflowStreamService({ getRunStatus } as never, { get: vi.fn(() => TENANT) } as never, hub, undefined);

    const waiting = service.awaitTerminal('flow', RUN_ID, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.appendV2(ev({ type: 'run.completed', data: { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }, retentionSeconds: 60 }));

    await expect(waiting).resolves.toMatchObject({ status: 'COMPLETED' });
    await hub.onModuleDestroy();
  });
});
