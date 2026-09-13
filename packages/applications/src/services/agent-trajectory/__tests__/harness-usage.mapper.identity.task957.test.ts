/**
 * TASK-957 F-8 — the workflow-lane ledger row names the clinician and the node.
 *
 * `doctorId` is an EXISTING column on the event (the STT streaming lane has
 * always set it); `nodeId` / `workflowVersionId` are new allow-listed
 * attributes. All three arrive through `BuildHarnessUsageOptions` rather than
 * off the persisted step, because `AgentTrajectoryStep` has no column for any
 * of them — they are ATTRIBUTION the ingest carried, not state the trajectory
 * table stores, and inventing three columns to relay three values through a
 * table that nothing reads them from would be the expensive way to be right.
 *
 * The absence cases are the load-bearing half. A consultation-lane step carries
 * none of this, and its row must stay byte-identical to what it has always
 * emitted — a `doctorId: null` that used to be absent is a diff in every
 * downstream comparison, and an empty-string `nodeId` is a rollup bucket.
 */
import { describe, expect, it } from 'vitest';
import { AgentSessionKind, AgentStepStatus, AgentStepType, AgentTrajectoryStepFactory } from '@arcaai/domains';

import { buildHarnessUsageEvent } from '../harness-usage.mapper';
import { validateUsageAttributes } from '../../usageLedger/usage-attributes';

const step = () =>
  AgentTrajectoryStepFactory.CreateStep({
    tenantId: 'tenant-1',
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: 'wf-session-1',
    runId: 'wf-run-1',
    seq: 3,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-09-13T10:00:00.000Z'),
    endedAt: new Date('2026-09-13T10:00:02.000Z'),
    stats: { provider: 'lm-studio', model: 'qwen3-32b', prompt_tokens: 100, predicted_tokens: 20, trigger: 'WORKFLOW_RUN' },
  });

describe('buildHarnessUsageEvent — identity (TASK-957 F-8)', () => {
  it('stamps the clinician on the row and the node identity in attributesJson', () => {
    const event = buildHarnessUsageEvent(step(), {
      doctorId: 'dr-9',
      nodeId: 'draft-note',
      workflowVersionId: 'wfv-7',
    })!;

    expect(event.common.doctorId).toBe('dr-9');
    expect(event.common.attributesJson).toMatchObject({ nodeId: 'draft-note', workflowVersionId: 'wfv-7' });
    expect(validateUsageAttributes(event.common.attributesJson)).toEqual([]);
  });

  it('omits every one it was not given — a consultation-lane row is unchanged', () => {
    const event = buildHarnessUsageEvent(step())!;

    expect(event.common.doctorId).toBeUndefined();
    expect(event.common.attributesJson).not.toHaveProperty('nodeId');
    expect(event.common.attributesJson).not.toHaveProperty('workflowVersionId');
  });

  it('takes each independently — a run with no clinician still names its node', () => {
    const event = buildHarnessUsageEvent(step(), { nodeId: 'draft-note', workflowVersionId: 'wfv-7' })!;

    expect(event.common.doctorId).toBeUndefined();
    expect(event.common.attributesJson?.nodeId).toBe('draft-note');
  });

  it('leaves the units and the idempotency key alone — identity is attribution, not identity-of-row', () => {
    const withIdentity = buildHarnessUsageEvent(step(), { doctorId: 'dr-9', nodeId: 'n', workflowVersionId: 'v' })!;
    const without = buildHarnessUsageEvent(step())!;

    expect(withIdentity.units).toEqual(without.units);
    expect(withIdentity.common.idempotencyKey).toBe(without.common.idempotencyKey);
  });
});
