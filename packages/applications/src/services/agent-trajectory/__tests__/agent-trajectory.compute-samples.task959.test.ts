/**
 * TASK-959 §3.4 — the durable-function server's own CPU per workflow run.
 *
 * A trajectory step bills the INFERENCE a node performed. These rows bill what
 * `hope-harness-worker` burned orchestrating it — a different capability, a
 * different provider, and money nobody was counting before.
 *
 * Also TASK-957 F-5, the gateway half: emission was fire-and-forget with a
 * `warn` for company, so a Postgres blip between "the work happened" and "the
 * outbox row was written" was unbilled revenue that surfaced nowhere. A bounded
 * retry plus a counter is what turns that into something an alert can see.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AgentSessionKind, AgentStepStatus, AgentStepType, AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import { AgentTrajectoryService } from '../agent-trajectory.service';
import type { ComputeSampleInput, CreateAgentTrajectoryStepInput } from '../dto';

const TENANT = 'tenant-1';

const repository = { createMany: vi.fn(), findAll: vi.fn(), delete: vi.fn(), listSessionSummaries: vi.fn() };
const usageLedger = { recordUsage: vi.fn() };
const cls = { get: vi.fn().mockReturnValue(undefined), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };

function makeService(overrides: { metrics?: unknown } = {}) {
  return new AgentTrajectoryService(
    repository as never,
    eventEmitter as never,
    cls as never,
    undefined,
    usageLedger as never,
    undefined,
    overrides.metrics as never,
  );
}

function sample(overrides: Partial<ComputeSampleInput> = {}): ComputeSampleInput {
  return {
    tenantId: TENANT,
    sessionId: 'wf-1',
    runId: 'run-1',
    activityId: '7',
    attempt: 1,
    activityType: 'core.agent',
    cpuMs: 1.25,
    wallMs: 40,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.createMany.mockResolvedValue({ count: 1 });
  usageLedger.recordUsage.mockResolvedValue({ outboxIds: ['ob-1'], events: 1 });
});

describe('recordComputeSamples — one CPU_SECOND row per activity execution', () => {
  it('emits the WORKFLOW / harness row the ticket specifies', async () => {
    await makeService().recordComputeSamples([sample({ cpuMs: 1250 })]);

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    const [batch] = usageLedger.recordUsage.mock.calls[0];
    expect(batch.common).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: 'harness:cpu:wf-1:run-1:7:1',
      capability: AiCapability.WORKFLOW,
      operation: 'workflow.step',
      provider: 'harness',
      deployment: AiDeploymentKind.SELF_HOSTED,
      requestId: 'run-1',
      sessionId: 'wf-1',
    });
    expect(batch.common.attributesJson).toEqual({ engine: 'harness', device: 'cpu', activityType: 'core.agent' });
    expect(batch.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '1.250' }]);
  });

  it('keys a real RETRY apart from a redelivery of the same execution', async () => {
    await makeService().recordComputeSamples([sample({ attempt: 1 }), sample({ attempt: 2 })]);

    const keys = usageLedger.recordUsage.mock.calls.map(([batch]) => batch.common.idempotencyKey);
    expect(keys).toEqual(['harness:cpu:wf-1:run-1:7:1', 'harness:cpu:wf-1:run-1:7:2']);
  });

  it('carries a trigger when the worker supplied one, and stamps none when it did not', async () => {
    await makeService().recordComputeSamples([sample({ trigger: 'WORKFLOW_RUN' }), sample({ activityId: '8' })]);

    const [first] = usageLedger.recordUsage.mock.calls[0];
    const [second] = usageLedger.recordUsage.mock.calls[1];
    expect(first.common.attributesJson.trigger).toBe('WORKFLOW_RUN');
    expect(second.common.attributesJson.trigger).toBeUndefined();
  });

  it('drops a trigger outside the closed vocabulary rather than forking the dimension', async () => {
    await makeService().recordComputeSamples([sample({ trigger: 'WORKFLOW-RUN' as never })]);
    const [batch] = usageLedger.recordUsage.mock.calls[0];
    expect(batch.common.attributesJson.trigger).toBeUndefined();
  });

  it('emits nothing for a sample that burned no measurable CPU', async () => {
    await makeService().recordComputeSamples([sample({ cpuMs: 0 })]);
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });

  it('skips a sample that cannot be attributed rather than guessing a tenant', async () => {
    await makeService().recordComputeSamples([sample({ tenantId: '' }), sample({ activityId: '9' })]);

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    expect(usageLedger.recordUsage.mock.calls[0][0].common.activityId).toBeUndefined();
    expect(usageLedger.recordUsage.mock.calls[0][0].common.idempotencyKey).toBe('harness:cpu:wf-1:run-1:9:1');
  });

  it('does not let one bad sample stop the rest of the batch', async () => {
    await makeService().recordComputeSamples([sample({ runId: '' }), sample({ activityId: '9' })]);
    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an empty batch', async () => {
    await makeService().recordComputeSamples([]);
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });
});

describe('emission resilience (TASK-957 F-5, gateway half)', () => {
  const step = (): CreateAgentTrajectoryStepInput => ({
    tenantId: TENANT,
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: 'wf-1',
    runId: 'run-1',
    seq: 0,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-09-12T10:00:00.000Z'),
    endedAt: new Date('2026-09-12T10:00:02.000Z'),
    stats: { provider: 'lm-studio', model: 'phi-4', prompt_tokens: 10, predicted_tokens: 2 },
  });

  it('retries a transient outbox failure and lands the row', async () => {
    usageLedger.recordUsage.mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue({ outboxIds: ['ob-1'], events: 1 });

    await makeService().recordComputeSamples([sample()]);

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of attempts rather than holding the request open', async () => {
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox unavailable'));

    await makeService().recordComputeSamples([sample()]);

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(3);
  });

  it('never fails the caller — metering is a side effect of work already done', async () => {
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox unavailable'));

    await expect(makeService().recordComputeSamples([sample()])).resolves.toBeUndefined();
    await expect(makeService().recordSteps([step()])).resolves.toBeUndefined();
  });

  it('counts an exhausted emission so an alert can see what a warn line cannot', async () => {
    const inc = vi.fn();
    const metrics = { createCounter: vi.fn().mockReturnValue({ inc }) };
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox unavailable'));

    await makeService({ metrics }).recordComputeSamples([sample({ trigger: 'WORKFLOW_RUN' })]);

    expect(metrics.createCounter).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'hope_usage_emission_failed_total', labelNames: ['operation', 'trigger', 'reason'] }),
    );
    expect(inc).toHaveBeenCalledWith({ operation: 'workflow.step', trigger: 'WORKFLOW_RUN', reason: 'dropped' });
  });

  it('does not count a retry that eventually succeeded', async () => {
    const inc = vi.fn();
    const metrics = { createCounter: vi.fn().mockReturnValue({ inc }) };
    usageLedger.recordUsage.mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue({ outboxIds: ['ob-1'], events: 1 });

    await makeService({ metrics }).recordComputeSamples([sample()]);

    expect(inc).not.toHaveBeenCalled();
  });

  it('labels a step emission with its own operation, so workflow and consultation lanes alert apart', async () => {
    const inc = vi.fn();
    const metrics = { createCounter: vi.fn().mockReturnValue({ inc }) };
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox unavailable'));

    const workflowStep = { ...step(), stats: { ...(step().stats as object), trigger: 'WORKFLOW_RUN' } };
    await makeService({ metrics }).recordSteps([workflowStep]);

    expect(inc).toHaveBeenCalledWith({ operation: 'workflow.step', trigger: 'WORKFLOW_RUN', reason: 'dropped' });
  });

  it('works with no metrics service wired — observability is never a precondition', async () => {
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox unavailable'));
    await expect(makeService().recordComputeSamples([sample()])).resolves.toBeUndefined();
  });
});

/**
 * Two cases where retrying is not merely useless but HARMFUL.
 *
 * Found on review of the retry above, not from a failing test — which is why
 * they are pinned: neither shows up as a wrong number, only as a slow or
 * lock-holding request.
 */
describe('when NOT to retry', () => {
  const step = (): CreateAgentTrajectoryStepInput => ({
    tenantId: TENANT,
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: 'wf-1',
    runId: 'run-1',
    seq: 0,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-09-12T10:00:00.000Z'),
    endedAt: new Date('2026-09-12T10:00:02.000Z'),
    stats: { provider: 'lm-studio', model: 'phi-4', prompt_tokens: 10, predicted_tokens: 2 },
  });

  it('attempts ONCE inside an open transaction — a failed statement poisons it, so a retry cannot land', async () => {
    // And it is worse than useless: the sleeps hold the transaction's locks
    // open while it waits to fail again.
    const unitOfWork = { runInTransaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work({ tx: true })) };
    const service = new AgentTrajectoryService(
      repository as never,
      eventEmitter as never,
      cls as never,
      undefined,
      usageLedger as never,
      unitOfWork as never,
    );
    usageLedger.recordUsage.mockRejectedValue(new Error('deadlock detected'));

    await service.recordSteps([step()]);

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('does not retry a VALIDATION failure — it is deterministic, and 500 steps × 3 attempts is a timeout', async () => {
    usageLedger.recordUsage.mockRejectedValue(new ArgumentInvalidException('operation "workflow.steps" is not one of the frozen usage operations'));

    await makeService().recordComputeSamples([sample()]);

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
  });
});
