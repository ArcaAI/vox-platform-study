/**
 * TASK-1038 E2 (fix 4, R2) — every agent run has a bounded duration, and cancel stops in-flight work.
 *
 * - The executor receives an `AbortSignal`; a cancel ABORTS the model call it is making (on this
 *   instance at once, and on another instance at its next status re-check), instead of letting it
 *   run on and discarding the output.
 * - A run still executing at `workflowRuns.agentRunMaxSeconds` (platform-only) is aborted and
 *   ends TIMED_OUT with `RUN_TIMED_OUT` (fixed label).
 * - A sweeper moves every `kind = AGENT` row left RUNNING past that ceiling (a crashed pod, a lost
 *   promise) to TIMED_OUT and appends `node.failed` + `run.failed` — so no row is RUNNING forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_EVENTS_KEY, parseStoredRunEvent, runErrorMessage, runEventProblems } from '@arcaai/async-contract';
import { WorkflowRunFactory } from '@arcaai/domains';
import { WORKFLOW_RUNS_AGENT_RUN_MAX_SECONDS_KEY } from '@arcaai/applications';
import { AgentRunService, type AgentRunOutcome } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';
import { FakeWorkflowRunRepository } from './fake-workflow-run-repository';

const TENANT = '50000000-0000-0000-0000-000000000000';
const CEILING_SECONDS = 120;
const RECHECK_SECONDS = 10;

let redis: FakeAgentRunRedis;
let repository: FakeWorkflowRunRepository;
const settings = {
  resolvePlatform: vi.fn((key: string) => ({
    value:
      key === WORKFLOW_RUNS_AGENT_RUN_MAX_SECONDS_KEY ? CEILING_SECONDS : key === 'workflowRuns.streamTerminalCheckSeconds' ? RECHECK_SECONDS : 24,
  })),
  resolve: vi.fn(() => ({ value: 30 })),
};

function service(): AgentRunService {
  return new AgentRunService(repository as never, redis as never, settings as never);
}

/** An executor that never answers on its own: it settles only when its signal aborts. */
function hangingExecutor(seen: { signal?: AbortSignal }) {
  return (signal: AbortSignal) =>
    new Promise<AgentRunOutcome>((_resolve, reject) => {
      seen.signal = signal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError' })));
    });
}

function startInput(execute: (signal: AbortSignal) => Promise<AgentRunOutcome>) {
  return {
    tenantId: TENANT,
    slug: 'scribe',
    agentVersionId: 'agent-v3',
    versionNumber: 3,
    task: 'TEXT_GENERATION' as const,
    body: { message: 'x' },
    execute,
  };
}

function storedTypes(runId: string): string[] {
  return (redis.streams.get(RUN_EVENTS_KEY(runId)) ?? []).map(([, fields]) => {
    const parsed = parseStoredRunEvent(runId, fields);
    if (parsed.kind !== 'event') throw new Error('not an event');
    return parsed.event.type;
  });
}

function storedFailed(runId: string) {
  for (const [, fields] of redis.streams.get(RUN_EVENTS_KEY(runId)) ?? []) {
    const parsed = parseStoredRunEvent(runId, fields);
    if (parsed.kind === 'event' && parsed.event.type === 'run.failed') return parsed.event;
  }
  return undefined;
}

beforeEach(() => {
  redis = new FakeAgentRunRedis();
  repository = new FakeWorkflowRunRepository();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cancel aborts the in-flight model call', () => {
  it('on the SAME instance: the executor’s signal aborts at once, and the run is CANCELED', async () => {
    const svc = service();
    const seen: { signal?: AbortSignal } = {};
    const { state } = await svc.start(startInput(hangingExecutor(seen)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.signal?.aborted).toBe(false);

    const cancelled = await svc.cancel(TENANT, 'scribe', state.runId);
    expect(cancelled.status).toBe('CANCELED');
    expect(seen.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await svc.get(TENANT, 'scribe', state.runId)).status).toBe('CANCELED');
    expect(storedTypes(state.runId)).not.toContain('run.failed');
  });

  it('on ANOTHER instance: the executing instance aborts at its next status re-check', async () => {
    vi.useFakeTimers();
    const executing = service();
    const seen: { signal?: AbortSignal } = {};
    const { state } = await executing.start(startInput(hangingExecutor(seen)));
    await service().cancel(TENANT, 'scribe', state.runId);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(RECHECK_SECONDS * 1000 + 1);
    expect(seen.signal?.aborted).toBe(true);
    expect((await executing.get(TENANT, 'scribe', state.runId)).status).toBe('CANCELED');
  });
});

describe('the run ceiling (workflowRuns.agentRunMaxSeconds)', () => {
  it('aborts a call still running at the ceiling and ends the run TIMED_OUT (RUN_TIMED_OUT, fixed label)', async () => {
    vi.useFakeTimers();
    const svc = service();
    const seen: { signal?: AbortSignal } = {};
    const { state } = await svc.start(startInput(hangingExecutor(seen)));

    await vi.advanceTimersByTimeAsync(CEILING_SECONDS * 1000 + 1);
    expect(seen.signal?.aborted).toBe(true);
    const after = await svc.get(TENANT, 'scribe', state.runId);
    expect(after.status).toBe('TIMED_OUT');
    expect(after.error).toEqual({ code: 'RUN_TIMED_OUT', message: runErrorMessage('RUN_TIMED_OUT') });
    const failed = storedFailed(state.runId);
    expect(failed?.data).toMatchObject({ status: 'TIMED_OUT', error: { code: 'RUN_TIMED_OUT', message: runErrorMessage('RUN_TIMED_OUT') } });
  });
});

describe('sweepStaleRuns — the backstop for a row nothing is executing any more', () => {
  async function seedRunning(runId: string, startedAt: Date) {
    await repository.create(
      WorkflowRunFactory.CreateAgentRun({
        tenantId: TENANT,
        runId,
        agentSlug: 'scribe',
        agentVersionId: 'agent-v3',
        agentVersionNumber: 3,
        startedAt,
        metaData: { agentTask: 'TEXT_GENERATION' },
      }),
    );
  }

  it('moves an AGENT row RUNNING past the ceiling to TIMED_OUT and appends node.failed + run.failed', async () => {
    const svc = service();
    const now = new Date('2026-10-05T10:00:00.000Z');
    svc.now = () => now;
    await seedRunning('stale-1', new Date(now.getTime() - (CEILING_SECONDS + 5) * 1000));
    await seedRunning('fresh-1', new Date(now.getTime() - 5 * 1000));

    const swept = await svc.sweepStaleRuns();
    expect(swept).toEqual({ timedOut: 1 });

    const stale = await svc.get(TENANT, 'scribe', 'stale-1');
    expect(stale.status).toBe('TIMED_OUT');
    expect(stale.error).toEqual({ code: 'RUN_TIMED_OUT', message: runErrorMessage('RUN_TIMED_OUT') });
    expect(stale.endedAt).toBe(now.toISOString());
    expect(storedTypes('stale-1')).toEqual(['node.failed', 'run.failed']);
    const failed = storedFailed('stale-1')!;
    expect(runEventProblems(failed, { runKind: 'agent', plane: 'public' })).toEqual([]);
    // Terminal retention starts the 24 h clock on the stream keys.
    expect(redis.ttls.get(RUN_EVENTS_KEY('stale-1'))).toBeGreaterThan(0);

    expect((await svc.get(TENANT, 'scribe', 'fresh-1')).status).toBe('RUNNING');
  });

  it('is idempotent: a second sweep times nothing out again and writes no second terminal event', async () => {
    const svc = service();
    const now = new Date('2026-10-05T10:00:00.000Z');
    svc.now = () => now;
    await seedRunning('stale-2', new Date(now.getTime() - (CEILING_SECONDS + 5) * 1000));
    await svc.sweepStaleRuns();
    expect(await svc.sweepStaleRuns()).toEqual({ timedOut: 0 });
    expect(storedTypes('stale-2').filter((type) => type === 'run.failed')).toHaveLength(1);
  });
});
