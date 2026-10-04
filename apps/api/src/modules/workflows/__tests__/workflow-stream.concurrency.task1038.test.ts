/**
 * TASK-1038 R-1 — N concurrent run readers must not serialise behind one another.
 *
 * Before: each of the stream service, the completion watcher and the WS gateway held ONE
 * dedicated Redis connection, and every blocking `XREAD BLOCK 15000` of every SSE client,
 * blocking call and watcher queued on it. A connection answers one command at a time, so the
 * N-th reader's read was not even SENT until the N-1 reads ahead of it had each parked for
 * their full BLOCK window — head-of-line blocking, latency growing with the number of streams.
 *
 * The fake connection here serialises exactly like a socket does (`fake-redis-streams.ts`), so
 * this test is RED against a single shared reader and GREEN against the multiplexed hub.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowStreamService } from '../workflow-stream.service';
import { runEventStreamKey } from '../workflow-run-event';
import { FakeRedisServer } from './fake-redis-streams';

const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };

function completedEnvelope(runId: string) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: '22222222-2222-2222-2222-222222222222',
    type: 'workflow.run.completed',
    occurredAt: '2026-10-04T00:00:00.000Z',
    correlationId: runId,
    causationId: null,
    idempotencyKey: `wf:run:${runId}:completed`,
    payload: { status: 'SUCCEEDED' },
  };
}

async function buildService(server: FakeRedisServer, statuses: Map<string, string>) {
  const getRunStatus = vi.fn(async (_slug: string, runId: string) => ({
    runId,
    slug: 'flow',
    workflowVersionNumber: 1,
    status: statuses.get(runId) ?? 'RUNNING',
    stages: [],
    startedAt: '2026-10-04T00:00:00.000Z',
    endedAt: null,
  }));
  const cls = { get: vi.fn(() => 'tenant-1') };
  const hub = new RunEventStreamHub(CONFIG as never);
  hub.connectionFactory = () => server.connection() as never;
  const service = new WorkflowStreamService({ getRunStatus } as never, cls as never, hub);
  return { service, hub };
}

describe('TASK-1038 R-1 — concurrent run readers do not serialise', () => {
  it('the LAST of 50 parked blocking waits completes promptly when its run finishes', async () => {
    const server = new FakeRedisServer();
    const statuses = new Map<string, string>();
    const { service, hub } = await buildService(server, statuses);
    const runIds = Array.from({ length: 50 }, (_, i) => `run-${i}`);

    const waits = runIds.map((runId) => service.awaitTerminal('flow', runId, 1_500));
    // Let every wait take its snapshot and park its read.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const last = runIds[runIds.length - 1];
    const startedAt = Date.now();
    statuses.set(last, 'COMPLETED');
    server.appendEnvelope(runEventStreamKey(last), completedEnvelope(last));

    const terminal = await waits[waits.length - 1];
    const elapsedMs = Date.now() - startedAt;

    expect(terminal?.status).toBe('COMPLETED');
    // A serialised reader answers this one only after the others' BLOCK windows (or the 1.5 s
    // ceiling); the multiplexed hub answers in one round trip.
    expect(elapsedMs).toBeLessThan(300);

    await Promise.all(waits);
    await hub.onModuleDestroy();
  }, 10_000);

  it('uses a bounded number of Redis connections however many runs are watched', async () => {
    const server = new FakeRedisServer();
    const statuses = new Map<string, string>();
    const { service, hub } = await buildService(server, statuses);
    const runIds = Array.from({ length: 40 }, (_, i) => `run-${i}`);
    const waits = runIds.map((runId) => service.awaitTerminal('flow', runId, 300));
    await Promise.all(waits);

    // The hub's blocking reader + its control connection — never one per run.
    expect(server.connections.length).toBeLessThanOrEqual(2);
    await hub.onModuleDestroy();
  }, 10_000);
});
