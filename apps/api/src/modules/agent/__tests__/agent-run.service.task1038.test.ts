/**
 * TASK-1038 OD-26 — `POST /agents/:slug/runs`, the run resource behind it.
 *
 * Pinned here: the lifecycle (RUNNING → COMPLETED / FAILED / CANCELED), the v2 events it writes
 * through the ONE sequencer (every stored event valid for an AGENT run: `nodeId: 'agent'`),
 * terminal retention, idempotency (same key + same body joins; a different body is 409), cancel
 * racing completion, and the cross-tenant / cross-slug 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, ServiceUnavailableException, BadGatewayException } from '@nestjs/common';
import { RUN_EVENTS_KEY, parseStoredRunEvent, runEventProblems } from '@arcaai/async-contract';
import { AgentRunService, agentRunLinks, type AgentRunOutcome } from '../agent-run.service';
import { FakeAgentRunRedis } from './fake-agent-run-redis';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER_TENANT = '51000000-0000-0000-0000-000000000000';

let redis: FakeAgentRunRedis;
const settings = { resolvePlatform: vi.fn(() => ({ value: 24 })), resolve: vi.fn(() => ({ value: 30 })) };

function service(): AgentRunService {
  return new AgentRunService(redis as never, settings as never);
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
    expect(events[4].data).toMatchObject({ status: 'COMPLETED', tokens: { in: 12, out: 4 }, result: { kind: 'inline', value: { text: 'The note.' } } });
  });

  it('puts the terminal retention on all three keys (OD-25: 24 h), closing the stream', async () => {
    const { state } = await service().start(startInput(async () => ({ output: { text: 'x' }, tokens: { in: 1, out: 1 } })));
    await flush();
    expect(redis.ttls.get(RUN_EVENTS_KEY(state.runId))).toBe(24 * 3600);
    // The run document itself is kept for `workflowRuns.resultRetentionDays` (30 d).
    expect(redis.ttls.get(`agent:run:${TENANT}:${state.runId}`)).toBe(30 * 86_400);
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
  });
});

describe('no run store', () => {
  it('is a named 503, never a run that cannot be followed', async () => {
    redis.connected = false;
    await expect(service().start(startInput(async () => ({ output: {}, tokens: { in: 0, out: 0 } })))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
