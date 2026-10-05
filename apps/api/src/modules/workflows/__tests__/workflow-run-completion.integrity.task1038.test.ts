/**
 * TASK-1038 — the background completion watcher.
 *
 * R-2: it used to die on the first XREAD error (the `consume` loop threw, `watch()` logged it and
 * dropped the watcher), and a lost `workflow.run.completed` left the run row `RUNNING` until some
 * reader happened to ask. It now retries with backoff, and re-checks the run with the harness
 * while idle.
 *
 * D-I (consumer): the harness puts the run's delivered result on the completed event
 * (`payload.result`: `{kind:'inline', value}` or `{kind:'ref', bucket, key, sizeBytes, sha256}`);
 * the watcher persists it as `WorkflowRun.resultRef`, which was always null before.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY } from '@arcaai/applications';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';
import { runEventStreamKey } from '../workflow-run-event';
import { FakeRedisServer } from './fake-redis-streams';

const TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';
const KEY = runEventStreamKey(RUN_ID);
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };

function completed(payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: TENANT,
    type: 'workflow.run.completed',
    occurredAt: '2026-10-04T00:00:00.000Z',
    correlationId: RUN_ID,
    causationId: null,
    idempotencyKey: `wf:run:${RUN_ID}:completed`,
    payload,
  };
}

function build(server: FakeRedisServer, options: { checkSeconds?: number; upstreamStatus?: string } = {}) {
  const settings = {
    resolvePlatform: vi.fn((key: string) => ({ key, value: key === WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY ? options.checkSeconds : undefined })),
  };
  const hub = new RunEventStreamHub(CONFIG as never, settings as never);
  hub.connectionFactory = () => server.connection() as never;
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const harnessGateway = {
    getWorkflowRun: vi
      .fn()
      .mockResolvedValue({ runId: RUN_ID, status: options.upstreamStatus ?? 'RUNNING', stages: [], startedAt: null, endedAt: null }),
  };
  const service = new WorkflowRunCompletionService(runs as never, cls as never, hub, undefined, harnessGateway as never, settings as never);
  return { service, hub, runs, harnessGateway };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => vi.useRealTimers());

describe('TASK-1038 R-2 — the completion watcher', () => {
  it('survives an XREAD error: it retries and still records the terminal status', async () => {
    const server = new FakeRedisServer();
    const { service, hub, runs } = build(server);
    expect(service.watch(TENANT, RUN_ID)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.connections[0].failNextXread = new Error('READONLY You can not write against a read only replica');
    server.connections[0].releaseBlock();
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.appendEnvelope(KEY, completed({ status: 'SUCCEEDED' }));

    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, status: 'COMPLETED' }));
    await service.onModuleDestroy();
    await hub.onModuleDestroy();
  });

  it('re-checks the run with the harness while idle, and records it when the completion event was lost', async () => {
    vi.useFakeTimers();
    const server = new FakeRedisServer();
    const { service, hub, runs, harnessGateway } = build(server, { checkSeconds: 5, upstreamStatus: 'DEGRADED' });
    service.watch(TENANT, RUN_ID);

    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harnessGateway.getWorkflowRun).toHaveBeenCalledWith(RUN_ID);
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, status: 'COMPLETED', terminalReason: 'DEGRADED' }));
    expect(service.activeWatchers).toBe(0);
    await service.onModuleDestroy();
    await hub.onModuleDestroy();
  });

  it('starts the stream retention clock when it observes the terminal event', async () => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, completed({ status: 'SUCCEEDED' }));
    const { service, hub } = build(server);
    service.watch(TENANT, RUN_ID);
    await until(() => server.ttls.has(KEY));
    expect(server.ttls.get(KEY)).toBe(24 * 3600);
    await service.onModuleDestroy();
    await hub.onModuleDestroy();
  });
});

describe('TASK-1038 D-I — the delivered result reaches the read model', () => {
  it.each([
    ['inline', { kind: 'inline', value: { note: 'SOAP', codes: ['J06.9'] } }],
    ['ref', { kind: 'ref', bucket: 'tenant-bucket', key: 'runs/r1/result.json', sizeBytes: 300_000, sha256: 'a'.repeat(64) }],
  ])('persists a %s result as WorkflowRun.resultRef', async (_label, result) => {
    const server = new FakeRedisServer();
    server.appendEnvelope(KEY, completed({ status: 'SUCCEEDED', result }));
    const { service, hub, runs } = build(server);
    service.watch(TENANT, RUN_ID);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, resultRef: result }));
    await service.onModuleDestroy();
    await hub.onModuleDestroy();
  });

  it('leaves resultRef untouched when the run delivered nothing, and ignores a malformed result', async () => {
    const { service, runs } = build(new FakeRedisServer());
    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', '2026-10-04T00:00:00.000Z', null, {}, undefined);
    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', '2026-10-04T00:00:00.000Z', null, {}, {
      kind: 'ref',
      bucket: 'b',
    } as never);
    expect(runs.recordRunFinished.mock.calls[0][0].resultRef).toBeUndefined();
    expect(runs.recordRunFinished.mock.calls[1][0].resultRef).toBeUndefined();
    await service.onModuleDestroy();
  });
});
