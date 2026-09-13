/**
 * TASK-957 F-8 — the ingest's attribution reaches the ledger row.
 *
 * `recordSteps` maps its inputs into entities and then emits usage FROM THE
 * ENTITIES, so four fields that have no column on `AgentTrajectoryStep` —
 * `doctorId`, `nodeId`, `workflowVersionId`, `nodeType` — cannot survive that
 * hop on their own. They are paired with their entity positionally (the
 * entities array IS `inputs.map(...)`) and handed to the mapper as options,
 * beside `device`, which already worked this way for the same reason.
 *
 * What this pins is the JOIN, not the stamping: the mapper's own tests cover
 * what a given option produces. What could break here is the pairing — a batch
 * where step 2's identity lands on step 1's row is a silently wrong
 * attribution, not a failure, so a multi-step batch is the case that matters.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionKind, AgentStepStatus, AgentStepType } from '@arcaai/domains';

import { AgentTrajectoryService } from '../agent-trajectory.service';
import type { CreateAgentTrajectoryStepInput } from '../dto';

const TENANT = 'tenant-1';

const repository = { createMany: vi.fn(), findAll: vi.fn(), delete: vi.fn(), listSessionSummaries: vi.fn() };
const usageLedger = { recordUsage: vi.fn() };
const cls = { get: vi.fn().mockReturnValue(undefined), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };

const makeService = () =>
  new AgentTrajectoryService(repository as never, eventEmitter as never, cls as never, undefined, usageLedger as never);

function step(overrides: Partial<CreateAgentTrajectoryStepInput> = {}): CreateAgentTrajectoryStepInput {
  return {
    tenantId: TENANT,
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: 'wf-1',
    runId: 'run-1',
    seq: 0,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-09-13T10:00:00.000Z'),
    endedAt: new Date('2026-09-13T10:00:02.000Z'),
    stats: { provider: 'lm-studio', model: 'qwen3-32b', prompt_tokens: 100, predicted_tokens: 20, trigger: 'WORKFLOW_RUN' },
    ...overrides,
  };
}

const rows = () => usageLedger.recordUsage.mock.calls.map(([input]) => input.common);

beforeEach(() => {
  vi.clearAllMocks();
  repository.createMany.mockResolvedValue({ count: 1 });
  usageLedger.recordUsage.mockResolvedValue({ outboxIds: ['ob-1'], events: 1 });
});

describe('recordSteps — identity threading (TASK-957 F-8)', () => {
  it('carries the step’s clinician and node onto its ledger row', async () => {
    await makeService().recordSteps([
      step({ doctorId: 'dr-9', nodeId: 'draft-note', workflowVersionId: 'wfv-7', nodeType: 'core.agent' }),
    ]);

    const [row] = rows();
    expect(row.doctorId).toBe('dr-9');
    expect(row.attributesJson).toMatchObject({ nodeId: 'draft-note', workflowVersionId: 'wfv-7' });
  });

  it('pairs each step with its OWN identity across a multi-step batch', async () => {
    await makeService().recordSteps([
      step({ seq: 0, nodeId: 'first-node', doctorId: 'dr-1' }),
      step({ seq: 1, nodeId: 'second-node', doctorId: 'dr-2' }),
    ]);

    const emitted = rows();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ doctorId: 'dr-1', attributesJson: expect.objectContaining({ nodeId: 'first-node' }) });
    expect(emitted[1]).toMatchObject({ doctorId: 'dr-2', attributesJson: expect.objectContaining({ nodeId: 'second-node' }) });
  });

  it('keeps a consultation-lane step’s row unchanged when the ingest carried none', async () => {
    await makeService().recordSteps([step()]);

    const [row] = rows();
    expect(row.doctorId).toBeUndefined();
    expect(row.attributesJson).not.toHaveProperty('nodeId');
    expect(row.attributesJson).not.toHaveProperty('workflowVersionId');
  });

  it('never puts nodeType on the row — accepted at the ingest, not a ledger dimension', async () => {
    await makeService().recordSteps([step({ nodeId: 'draft-note', nodeType: 'core.agent' })]);

    expect(rows()[0].attributesJson).not.toHaveProperty('nodeType');
  });
});

/**
 * The worker-CPU rows take the same identity. The GATEWAY half lands here ahead
 * of a sender on purpose: the ingest runs under `forbidNonWhitelisted`, so the
 * accepting side must exist before the first flush that carries these keys, or
 * that flush 400s entirely. The harness half reads them off the activity input
 * in `temporal/compute_metering.py`, which is a different lane's file.
 */
describe('recordComputeSamples — identity threading (TASK-957 F-8)', () => {
  const sample = (overrides: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    sessionId: 'wf-1',
    runId: 'run-1',
    activityId: '7',
    attempt: 1,
    activityType: 'core.agent',
    cpuMs: 1250,
    wallMs: 4000,
    ...overrides,
  });

  it('stamps the node and the clinician when the sample carried them', async () => {
    await makeService().recordComputeSamples([
      sample({ nodeId: 'draft-note', workflowVersionId: 'wfv-7', doctorId: 'dr-9' }) as never,
    ]);

    const [row] = rows();
    expect(row.doctorId).toBe('dr-9');
    expect(row.attributesJson).toMatchObject({ nodeId: 'draft-note', workflowVersionId: 'wfv-7' });
  });

  it('emits the row it always did when the sample carried none', async () => {
    await makeService().recordComputeSamples([sample() as never]);

    const [row] = rows();
    expect(row.doctorId).toBeUndefined();
    expect(row.attributesJson).not.toHaveProperty('nodeId');
    expect(row.attributesJson).not.toHaveProperty('workflowVersionId');
  });
});
