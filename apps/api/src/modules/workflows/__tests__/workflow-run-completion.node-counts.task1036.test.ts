/**
 * TASK-1036 (lane B6b) — the TASK-982 settled-node counts on the run row, under protocol v2.
 *
 * The harness no longer puts `nodeCount` / `failedNodeCount` / `degradedNodeCount` /
 * `skippedNodeCount` on the terminal event: they are derived from the run's `node.completed` /
 * `node.failed` events. The watcher already folded them when `run.completed` arrived (B3a); the
 * idle harness re-check — the path a LOST terminal event takes — recorded NO counts, so a run whose
 * completion event never reached its stream kept `nodeCount = null` forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunAppendInput } from '@arcaai/async-contract';
import { WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY } from '@arcaai/applications';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { runCompletedCountsFromStages } from '../run-completed-counts';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';
import { FakeRedisServer } from './fake-redis-streams';

const TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';
const TS = '2026-10-04T10:00:00.000Z';
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };
const ev = (input: Omit<RunAppendInput, 'runId' | 'ts'>): RunAppendInput => ({ runId: RUN_ID, ts: TS, ...input });

const STAGES = [
  { stage_index: 0, nodes: [{ node_id: 'a', node_type: 'core.trigger', status: 'COMPLETED' }] },
  {
    stage_index: 1,
    nodes: [
      { node_id: 'b', node_type: 'core.agent', status: 'DEGRADED' },
      { node_id: 'c', node_type: 'core.agent', status: 'FAILED' },
      { node_id: 'd', node_type: 'core.agent', status: 'SKIPPED' },
    ],
  },
];

function build(server: FakeRedisServer, upstream: Record<string, unknown>) {
  const settings = {
    resolvePlatform: vi.fn((key: string) => ({ key, value: key === WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY ? 5 : undefined })),
  };
  const hub = new RunEventStreamHub(CONFIG as never, settings as never);
  hub.connectionFactory = () => server.connection() as never;
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const harnessGateway = { getWorkflowRun: vi.fn().mockResolvedValue({ runId: RUN_ID, startedAt: null, endedAt: null, ...upstream }) };
  const service = new WorkflowRunCompletionService(runs as never, cls as never, hub, undefined, harnessGateway as never, settings as never);
  return { service, hub, runs };
}

afterEach(() => vi.useRealTimers());

describe('runCompletedCountsFromStages — the harness state query is a count source too', () => {
  it('counts every settled node, by status', () => {
    expect(runCompletedCountsFromStages(STAGES)).toEqual({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 1, skippedNodeCount: 1 });
  });

  it('reports nothing (not zero) when the harness answered no stages', () => {
    expect(runCompletedCountsFromStages([])).toEqual({});
    expect(runCompletedCountsFromStages(undefined)).toEqual({});
  });
});

describe('the idle harness re-check (a lost terminal event) still records the counts', () => {
  it('folds them from the node events the watcher saw', async () => {
    vi.useFakeTimers();
    const server = new FakeRedisServer();
    server.appendV2(ev({ type: 'node.started', nodeId: 'a', data: { kind: 'k' } }));
    server.appendV2(ev({ type: 'node.completed', nodeId: 'a', data: { status: 'COMPLETED', durationMs: 1 } }));
    server.appendV2(ev({ type: 'node.started', nodeId: 'b', data: { kind: 'k' } }));
    server.appendV2(
      ev({
        type: 'node.failed',
        nodeId: 'b',
        data: { durationMs: 1, error: { code: 'MODEL_ERROR', message: 'The model returned an error.' }, willRetry: true },
      }),
    );
    server.appendV2(ev({ type: 'node.started', nodeId: 'b', data: { kind: 'k', attempt: 2 } }));
    server.appendV2(ev({ type: 'node.completed', nodeId: 'b', data: { status: 'DEGRADED', durationMs: 1 } }));
    server.appendV2(ev({ type: 'node.started', nodeId: 'c', data: { kind: 'k' } }));
    server.appendV2(
      ev({
        type: 'node.failed',
        nodeId: 'c',
        data: { durationMs: 1, error: { code: 'MODEL_ERROR', message: 'The model returned an error.' }, willRetry: false },
      }),
    );
    // No `run.completed` — it was lost. The harness has the authoritative terminal status.
    const { service, hub, runs } = build(server, { status: 'DEGRADED', stages: [] });
    service.watch(TENANT, RUN_ID);
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runs.recordRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, status: 'COMPLETED', nodeCount: 3, failedNodeCount: 1, degradedNodeCount: 1, skippedNodeCount: 0 }),
    );
    await service.onModuleDestroy();
    await hub.onModuleDestroy();
  });

  it('falls back to the harness stages when the stream holds no node events', async () => {
    vi.useFakeTimers();
    const server = new FakeRedisServer();
    const { service, hub, runs } = build(server, { status: 'FAILED', stages: STAGES });
    service.watch(TENANT, RUN_ID);
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runs.recordRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, status: 'FAILED', nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 1, skippedNodeCount: 1 }),
    );
    await service.onModuleDestroy();
    await hub.onModuleDestroy();
  });
});
