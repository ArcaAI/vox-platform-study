/**
 * TASK-1050 W2e round 3 — the run watcher enters the consultation's guardrail hold on a
 * `run.paused` (reason `guardrail_hold`): a harness run that pauses on a block BEFORE its evaluation
 * has drained would otherwise leave the consultation un-held. The notice is the one the stream
 * carried in its preceding `guardrail.notice` event (same `noticeId`). A standalone run (no
 * consultation) holds nothing. The hook never blocks or throws into the watcher.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RunAppendInput } from '@arcaai/async-contract';
import runEvents from '../../../../../../tests/contracts/guardrail-run-events.fixture.json';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';
import { FakeRedisServer } from './fake-redis-streams';

const TENANT = '50000000-0000-0000-0000-000000000000';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af991050';
const TS = '2026-10-07T10:00:00.000Z';
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };
const ev = (input: Omit<RunAppendInput, 'runId' | 'ts'>): RunAppendInput => ({ runId: RUN_ID, ts: TS, ...input });

/** The contract's outbound block notice (consultation-bound, node `n_note`). */
const BLOCK = (runEvents as unknown as { notices: Array<Record<string, unknown>> }).notices[1];
const CONSULTATION = BLOCK.consultationId as string;

function build(server: FakeRedisServer, enter = vi.fn(async () => ({ consultationId: CONSULTATION, noticeId: BLOCK.noticeId, reason: 'GUARDRAIL_HOLD', paused: true }))) {
  const hub = new RunEventStreamHub(CONFIG as never, undefined);
  hub.connectionFactory = () => server.connection() as never;
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const holds = { enterGuardrailHold: enter };
  const service = new WorkflowRunCompletionService(runs as never, cls as never, hub, undefined, undefined, undefined, holds as never);
  return { service, hub, runs, holds };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function pausedStream(server: FakeRedisServer, opts: { noticeFirst?: boolean } = {}): void {
  if (opts.noticeFirst !== false) server.appendV2(ev({ type: 'guardrail.notice', nodeId: 'n_note', data: BLOCK as never }));
  server.appendV2(ev({ type: 'run.paused', data: { reason: 'guardrail_hold', noticeId: BLOCK.noticeId as string, nodeId: 'n_note' } }));
  server.appendV2(ev({ type: 'run.failed', data: { status: 'FAILED', durationMs: 5, error: { code: 'GUARDRAIL_BLOCKED', message: 'A guardrail blocked the content.' } }, retentionSeconds: 60 }));
}

describe('completion watcher — run.paused guardrail_hold', () => {
  it('a consultation-bound run: enters the hold with the notice the stream carried', async () => {
    const server = new FakeRedisServer();
    pausedStream(server);
    const { service, hub, runs, holds } = build(server);

    service.watch(TENANT, RUN_ID, CONSULTATION);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);

    expect(holds.enterGuardrailHold).toHaveBeenCalledTimes(1);
    const [tenantId, consultationId, notice] = holds.enterGuardrailHold.mock.calls[0] as unknown as [string, string, { noticeId: string; type: string }];
    expect([tenantId, consultationId]).toEqual([TENANT, CONSULTATION]);
    expect(notice).toMatchObject({ noticeId: BLOCK.noticeId, type: 'guardrail.blocked', messageKey: BLOCK.messageKey });
    await hub.onModuleDestroy();
  });

  it('a run started without a consultation id still holds the consultation its notice names', async () => {
    const server = new FakeRedisServer();
    pausedStream(server);
    const { service, hub, runs, holds } = build(server);
    service.watch(TENANT, RUN_ID);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(holds.enterGuardrailHold).toHaveBeenCalledWith(TENANT, CONSULTATION, expect.objectContaining({ noticeId: BLOCK.noticeId }));
    await hub.onModuleDestroy();
  });

  it('a standalone run (no consultation anywhere) holds nothing', async () => {
    const server = new FakeRedisServer();
    const standalone = { ...BLOCK };
    delete standalone.consultationId;
    server.appendV2(ev({ type: 'guardrail.notice', nodeId: 'n_note', data: standalone as never }));
    server.appendV2(ev({ type: 'run.paused', data: { reason: 'guardrail_hold', noticeId: BLOCK.noticeId as string, nodeId: 'n_note' } }));
    server.appendV2(ev({ type: 'run.failed', data: { status: 'FAILED', durationMs: 5, error: { code: 'GUARDRAIL_BLOCKED', message: 'A guardrail blocked the content.' } }, retentionSeconds: 60 }));
    const { service, hub, runs, holds } = build(server);
    service.watch(TENANT, RUN_ID);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(holds.enterGuardrailHold).not.toHaveBeenCalled();
    await hub.onModuleDestroy();
  });

  it('a pause whose notice never appeared on the stream holds nothing (and the watcher carries on)', async () => {
    const server = new FakeRedisServer();
    pausedStream(server, { noticeFirst: false });
    const { service, hub, runs, holds } = build(server);
    service.watch(TENANT, RUN_ID, CONSULTATION);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(holds.enterGuardrailHold).not.toHaveBeenCalled();
    await hub.onModuleDestroy();
  });

  it('never blocks or throws into the watcher: a failing hold entry still lets the terminal status land', async () => {
    const server = new FakeRedisServer();
    pausedStream(server);
    const { service, hub, runs, holds } = build(
      server,
      vi.fn(async () => {
        throw new Error('hold down');
      }),
    );
    service.watch(TENANT, RUN_ID, CONSULTATION);
    await until(() => runs.recordRunFinished.mock.calls.length > 0);
    expect(holds.enterGuardrailHold).toHaveBeenCalled();
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, status: 'FAILED' }));
    await hub.onModuleDestroy();
  });
});
