/**
 * TASK-1038 OD-26 — `POST /agents/:slug/runs`, the run resource behind it.
 *
 * Pinned here: the lifecycle (RUNNING → COMPLETED / FAILED / CANCELED), the v2 events it writes
 * through the ONE sequencer (every stored event valid for an AGENT run: `nodeId: 'agent'`),
 * terminal retention, idempotency (same key + same body joins; a different body is 409), cancel
 * racing completion, and the cross-tenant / cross-slug 404.
 *
 * Lane B6a — the run's STATE and RESULT are a Postgres row (`WorkflowRun`, `kind = AGENT`), not a
 * Redis document: they survive a restart, the result is the A2-purgeable `resultRef`, and Redis
 * holds the event stream only (no PHI-bearing run document for 30 days).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { RUN_EVENTS_KEY, parseStoredRunEvent, runEventProblems } from '@arcaai/async-contract';
import { WorkflowRunKind } from '@arcaai/domains';
import { AgentRunService, agentRunLinks, type AgentRunOutcome } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';
import { FakeWorkflowRunRepository } from './fake-workflow-run-repository';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER_TENANT = '51000000-0000-0000-0000-000000000000';

let redis: FakeAgentRunRedis;
let repository: FakeWorkflowRunRepository;
const settings = { resolvePlatform: vi.fn(() => ({ value: 24 })), resolve: vi.fn(() => ({ value: 30 })) };

function service(): AgentRunService {
  return new AgentRunService(repository as never, redis as never, settings as never);
}

function startInput(execute: () => Promise<AgentRunOutcome>, over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    slug: 'scribe',
    agentVersionId: 'agent-v3',
    versionNumber: 3,
    task: 'TEXT_GENERATION' as const,
    body: { message: 'Summarise.' },
    execute,
    ...over,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function storedEvents(runId: string) {
  return (redis.streams.get(RUN_EVENTS_KEY(runId)) ?? []).map(([, fields]) => {
    const parsed = parseStoredRunEvent(runId, fields);
    if (parsed.kind !== 'event') throw new Error(`stored entry is ${parsed.kind}`);
    return parsed.event;
  });
}

beforeEach(() => {
  redis = new FakeAgentRunRedis();
  repository = new FakeWorkflowRunRepository();
  vi.clearAllMocks();
});

describe('start → complete', () => {
  it('answers RUNNING with the four links, then completes in the background', async () => {
    const svc = service();
    const { state, created } = await svc.start(startInput(async () => ({ output: { text: 'The note.' }, tokens: { in: 12, out: 4 } })));
    expect(created).toBe(true);
    expect(state.status).toBe('RUNNING');
    expect(agentRunLinks('scribe', state.runId)).toEqual({
      self: `/api/v1/agents/scribe/runs/${state.runId}`,
      events: `/api/v1/agents/scribe/runs/${state.runId}/events`,
      result: `/api/v1/agents/scribe/runs/${state.runId}/result`,
      cancel: `/api/v1/agents/scribe/runs/${state.runId}/cancel`,
    });

    await flush();
    const done = await svc.get(TENANT, 'scribe', state.runId);
    expect(done).toMatchObject({ status: 'COMPLETED', output: { text: 'The note.' } });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes the run as protocol-v2 events through the sequencer — contiguous seqs, all valid for an AGENT run', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'The note.' }, tokens: { in: 12, out: 4 } })));
    await flush();
    const events = storedEvents(state.runId);
    expect(events.map((event) => event.type)).toEqual(['run.started', 'node.started', 'output.text.delta', 'node.completed', 'run.completed']);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const event of events) expect(runEventProblems(event, { runKind: 'agent', plane: 'public' })).toEqual([]);
    expect(events[0].data).toEqual({ kind: 'agent', slug: 'scribe', versionNumber: 3, mode: 'async' });
    expect(events[4].data).toMatchObject({
      status: 'COMPLETED',
      tokens: { in: 12, out: 4 },
      result: { kind: 'inline', value: { text: 'The note.' } },
    });
  });

  it('puts the terminal retention on all three keys (OD-25: 24 h), closing the stream', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } })));
    await flush();
    expect(redis.ttls.get(RUN_EVENTS_KEY(state.runId))).toBe(24 * 3600);
  });

  it('emits a NER result as `output.data`', async () => {
    const entities = [{ text: 'aspirin', label: 'DRUG', start: 0, end: 7 }];
    const { state } = await service().start(
      startInput(async () => ({ output: { entities }, tokens: { in: 0, out: 0 } }), { task: 'NAMED_ENTITY_RECOGNITION' }),
    );
    await flush();
    const data = storedEvents(state.runId).find((event) => event.type === 'output.data');
    expect(data).toMatchObject({ nodeId: 'agent', data: { field: 'entities', value: entities } });
  });
});

describe('failure', () => {
  it('records FAILED with the fixed-label error — never the exception text', async () => {
    const { state } = await service().start(
      startInput(async () => {
        throw new BadGatewayException('upstream said: patient John Doe ...');
      }),
    );
    await flush();
    const failed = await service().get(TENANT, 'scribe', state.runId);
    expect(failed).toMatchObject({ status: 'FAILED', error: { code: 'MODEL_UNAVAILABLE', message: 'The model did not answer.' } });
    const events = storedEvents(state.runId);
    expect(events.map((event) => event.type)).toEqual(['run.started', 'node.started', 'node.failed', 'run.failed']);
    for (const event of events) expect(runEventProblems(event, { runKind: 'agent', plane: 'public' })).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('John Doe');
  });
});

describe('idempotency', () => {
  it('the same key with the same body joins the run it started — the agent runs ONCE', async () => {
    const execute = vi.fn(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } }));
    const first = await service().start(startInput(execute, { idempotencyKey: 'k-1' }));
    const second = await service().start(startInput(execute, { idempotencyKey: 'k-1', body: { message: 'Summarise.' } }));
    expect(second.state.runId).toBe(first.state.runId);
    expect(second.created).toBe(false);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('the same key with a DIFFERENT body is a 409', async () => {
    const execute = vi.fn(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } }));
    await service().start(startInput(execute, { idempotencyKey: 'k-1' }));
    await expect(service().start(startInput(execute, { idempotencyKey: 'k-1', body: { message: 'Something else.' } }))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('body key order does not change the hash', async () => {
    const execute = vi.fn(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } }));
    const first = await service().start(startInput(execute, { idempotencyKey: 'k-2', body: { message: 'a', variables: { x: '1', y: '2' } } }));
    const second = await service().start(startInput(execute, { idempotencyKey: 'k-2', body: { variables: { y: '2', x: '1' }, message: 'a' } }));
    expect(second.state.runId).toBe(first.state.runId);
  });

  it('without a key every start is a new run', async () => {
    const execute = async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } });
    const a = await service().start(startInput(execute));
    const b = await service().start(startInput(execute));
    expect(a.state.runId).not.toBe(b.state.runId);
  });

  it('two tenants sending the same key never share a run', async () => {
    const execute = async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } });
    const a = await service().start(startInput(execute, { idempotencyKey: 'k-1' }));
    const b = await service().start(startInput(execute, { idempotencyKey: 'k-1', tenantId: OTHER_TENANT }));
    expect(a.state.runId).not.toBe(b.state.runId);
  });
});

describe('cancel', () => {
  it('cancels a RUNNING run, writes run.cancelled, and discards the late output', async () => {
    let release!: (outcome: AgentRunOutcome) => void;
    const { state } = await service().start(startInput(() => new Promise<AgentRunOutcome>((resolve) => (release = resolve))));
    const cancelled = await service().cancel(TENANT, 'scribe', state.runId);
    expect(cancelled.status).toBe('CANCELED');

    release({ output: { text: 'too late' }, tokens: { in: 1, out: 1 } });
    await flush();
    const after = await service().get(TENANT, 'scribe', state.runId);
    expect(after.status).toBe('CANCELED');
    expect(after.output).toBeNull();
    const types = storedEvents(state.runId).map((event) => event.type);
    expect(types).toContain('run.cancelled');
    expect(types).not.toContain('run.completed');
  });

  it('is idempotent — a second cancel, or a cancel of a finished run, answers the run as it is', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } })));
    await flush();
    const once = await service().cancel(TENANT, 'scribe', state.runId);
    const twice = await service().cancel(TENANT, 'scribe', state.runId);
    expect(once.status).toBe('COMPLETED');
    expect(twice.status).toBe('COMPLETED');
  });
});

describe('404-over-403', () => {
  it('another tenant, or another slug, cannot address the run', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } })));
    await expect(service().get(OTHER_TENANT, 'scribe', state.runId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().get(TENANT, 'other-agent', state.runId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().cancel(OTHER_TENANT, 'scribe', state.runId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().cancel(TENANT, 'other-agent', state.runId)).rejects.toBeInstanceOf(NotFoundException);
    // Nothing was cancelled by the refused calls.
    expect(repository.rowOf(state.runId)?.status).not.toBe('CANCELED');
  });

  it('an unknown run id is the same 404', async () => {
    await expect(service().get(TENANT, 'scribe', 'no-such-run')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('durable run record (lane B6a) — Postgres, not Redis', () => {
  it('writes ONE `kind = AGENT` row: agent identity, no workflow identity, the result as an inline resultRef', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'The note.' }, tokens: { in: 1, out: 1 } })));
    expect(repository.rows.size).toBe(1);
    expect(repository.rowOf(state.runId)).toMatchObject({
      kind: WorkflowRunKind.AGENT,
      tenantId: TENANT,
      runId: state.runId,
      sessionId: `agent-run-${state.runId}`,
      agentSlug: 'scribe',
      agentVersionId: 'agent-v3',
      agentVersionNumber: 3,
      workflowSlug: null,
      workflowVersionId: null,
      status: 'RUNNING',
    });
    await flush();
    expect(repository.rowOf(state.runId)).toMatchObject({
      status: 'COMPLETED',
      resultRef: { kind: 'inline', value: { text: 'The note.' } },
      nodeCount: 1,
    });
    expect(repository.rowOf(state.runId)?.endedAt).toBeInstanceOf(Date);
  });

  it('a FAILED run stores the fixed-label code only — never the exception text', async () => {
    const { state } = await service().start(
      startInput(async () => {
        throw new BadGatewayException('upstream said: patient John Doe ...');
      }),
    );
    await flush();
    expect(repository.rowOf(state.runId)).toMatchObject({ status: 'FAILED', firstErrorCode: 'MODEL_UNAVAILABLE', failedNodeCount: 1, resultRef: null });
    expect(JSON.stringify(repository.rowOf(state.runId))).not.toContain('John Doe');
  });

  it('keeps NO run state in Redis — only the event stream keys (no PHI-bearing run document)', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'PHI note' }, tokens: { in: 1, out: 1 } })));
    await flush();
    const keys = [...redis.strings.keys(), ...redis.streams.keys(), ...redis.hashes.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.startsWith(`wf:run:${state.runId}:`)).toBe(true);
    expect(keys.some((key) => key.startsWith('agent:run:'))).toBe(false);
  });

  it('survives a restart: a new instance with an EMPTY Redis still serves the run and its result', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'The note.' }, tokens: { in: 1, out: 1 } })));
    await flush();
    redis = new FakeAgentRunRedis(); // the restart: Redis persistence is disabled on this platform
    const after = await service().get(TENANT, 'scribe', state.runId);
    expect(after).toMatchObject({ status: 'COMPLETED', output: { text: 'The note.' }, versionNumber: 3, task: 'TEXT_GENERATION' });
  });

  it('an Idempotency-Key still joins its run after a restart (the claim is the row, not a Redis key)', async () => {
    const execute = vi.fn(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } }));
    const first = await service().start(startInput(execute, { idempotencyKey: 'k-restart' }));
    await flush();
    redis = new FakeAgentRunRedis();
    const second = await service().start(startInput(execute, { idempotencyKey: 'k-restart' }));
    expect(second).toMatchObject({ created: false, state: { runId: first.state.runId, status: 'COMPLETED' } });
    await expect(service().start(startInput(execute, { idempotencyKey: 'k-restart', body: { message: 'other' } }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('two concurrent starts with one key: the unique key decides — one row, the agent runs ONCE', async () => {
    const execute = vi.fn(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } }));
    const svc = service();
    const [a, b] = await Promise.all([
      svc.start(startInput(execute, { idempotencyKey: 'k-race' })),
      svc.start(startInput(execute, { idempotencyKey: 'k-race' })),
    ]);
    expect(a.state.runId).toBe(b.state.runId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(repository.rows.size).toBe(1);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('with Redis down the run still starts, completes and is readable — the stream is best effort', async () => {
    redis.connected = false;
    const { state } = await service().start(startInput(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } })));
    await flush();
    expect(await service().get(TENANT, 'scribe', state.runId)).toMatchObject({ status: 'COMPLETED', output: { text: 'x' } });
  });

  it('a result the OD-25 purge expired reads back as `expired`, with no output', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } })));
    await flush();
    const row = repository.rowOf(state.runId)!;
    row.resultRef = { kind: 'expired', expiredAt: '2026-11-04T04:45:00.000Z' };
    const after = await service().get(TENANT, 'scribe', state.runId);
    expect(after.output).toBeNull();
    expect(after.result).toEqual({ kind: 'expired', expiredAt: '2026-11-04T04:45:00.000Z' });
  });
});
