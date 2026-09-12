/**
 * TASK-959 / TASK-957 F-1 + F-6 — what a trajectory step bills after this lane.
 *
 * Three changes land on this mapper and each one is money:
 *
 *  - **F-1** A workflow-run step becomes `operation: 'workflow.step'`, which is
 *    NOT in `NON_BILLABLE_LLM_OPERATIONS`. `harness.step` stays for the
 *    consultation lane, so the invoice engine's exclusion list is untouched and
 *    tenant-consumed workflow inference becomes billable BY CONSTRUCTION rather
 *    than by a rule someone has to remember.
 *  - **F-6** The five counts TEXT normalizes are read off the step's stats, so a
 *    reasoning model bound to a workflow agent is no longer structurally
 *    unbillable.
 *  - **§6.2** A losing fallback leg is an ordinary `LLM_CALL` step at its own
 *    `seq` with `leg: "failed"` and no token counts. It bills ONE `CPU_SECOND`
 *    row, because the attempt cost the platform real CPU and the tenant nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  AgentTrajectoryStepFactory,
  AiCapability,
  AiCostBasis,
  AiDeploymentKind,
  AiUsageUnit,
} from '@arcaai/domains';

import { buildHarnessUsageBatches, buildHarnessUsageEvent } from '../harness-usage.mapper';

const TENANT = 'tenant-1';
const SESSION = 'wf-session-1';
const RUN = 'wf-run-1';

function makeStep(overrides: Partial<Parameters<typeof AgentTrajectoryStepFactory.CreateStep>[0]> = {}) {
  return AgentTrajectoryStepFactory.CreateStep({
    tenantId: TENANT,
    consultationId: 'consultation-1',
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: SESSION,
    runId: RUN,
    seq: 3,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-09-12T10:00:00.000Z'),
    endedAt: new Date('2026-09-12T10:00:02.000Z'),
    ...overrides,
  });
}

const quantityOf = (batch: { units: { unit: AiUsageUnit; quantity: number | string }[] } | null | undefined, unit: AiUsageUnit) =>
  batch?.units.find((line) => line.unit === unit)?.quantity;

describe('buildHarnessUsageEvent — the operation split (TASK-957 F-1)', () => {
  it('bills a WORKFLOW_RUN step as workflow.step', () => {
    const step = makeStep({
      stats: { provider: 'lm-studio', model: 'phi-4', prompt_tokens: 120, predicted_tokens: 45, trigger: 'WORKFLOW_RUN' },
    });

    const event = buildHarnessUsageEvent(step);

    expect(event?.common.operation).toBe('workflow.step');
    // The capability stays LLM — it IS an LLM call; only the operation moves.
    expect(event?.common.capability).toBe(AiCapability.LLM);
    expect(event?.common.attributesJson?.trigger).toBe('WORKFLOW_RUN');
  });

  it('leaves the consultation lane on harness.step', () => {
    for (const stats of [
      { provider: 'lm-studio', prompt_tokens: 10 },
      { provider: 'lm-studio', prompt_tokens: 10, trigger: 'CONSULTATION' },
    ]) {
      expect(buildHarnessUsageEvent(makeStep({ stats }))?.common.operation).toBe('harness.step');
    }
  });

  it('does NOT change the idempotency key when the operation changes', () => {
    // The key is the (sessionId, runId, seq) tuple and nothing else. Folding the
    // operation in would make a step that re-POSTs after a deploy bill twice.
    const withTrigger = buildHarnessUsageEvent(makeStep({ stats: { provider: 'lm-studio', prompt_tokens: 10, trigger: 'WORKFLOW_RUN' } }));
    const without = buildHarnessUsageEvent(makeStep({ stats: { provider: 'lm-studio', prompt_tokens: 10 } }));

    expect(withTrigger?.common.idempotencyKey).toBe(`harness:step:${SESSION}:${RUN}:3`);
    expect(without?.common.idempotencyKey).toBe(withTrigger?.common.idempotencyKey);
  });

  it('ignores a trigger outside the closed vocabulary and stays on harness.step', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { provider: 'lm-studio', prompt_tokens: 10, trigger: 'WORKFLOW-RUN' } }));
    expect(event?.common.operation).toBe('harness.step');
    expect(event?.common.attributesJson?.trigger).toBeUndefined();
  });
});

describe('buildHarnessUsageEvent — the five counts (TASK-957 F-6)', () => {
  it('maps cache reads, cache writes and reasoning tokens when the step carries them', () => {
    const step = makeStep({
      stats: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        prompt_tokens: 500,
        predicted_tokens: 100,
        cache_read_tokens: 4000,
        cache_write_tokens: 250,
        reasoning_tokens: 900,
        trigger: 'WORKFLOW_RUN',
      },
    });

    const event = buildHarnessUsageEvent(step);

    expect(quantityOf(event, AiUsageUnit.CACHE_READ_TOKEN)).toBe(4000);
    expect(quantityOf(event, AiUsageUnit.CACHE_WRITE_TOKEN)).toBe(250);
    expect(quantityOf(event, AiUsageUnit.REASONING_TOKEN)).toBe(900);
  });

  it('emits no cache/reasoning row when the step carries none — never invented', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { provider: 'lm-studio', prompt_tokens: 10, predicted_tokens: 2 } }));
    expect(event?.units.map((line) => line.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });
});

describe('buildHarnessUsageEvent — compute and bytes', () => {
  it('bills a self-hosted step on the device the caller resolved', () => {
    const step = makeStep({ stats: { provider: 'lm-studio', prompt_tokens: 10, total_ms: 2500, trigger: 'WORKFLOW_RUN' } });

    expect(quantityOf(buildHarnessUsageEvent(step, { device: 'cuda' }), AiUsageUnit.GPU_SECOND)).toBe('2.500');
    expect(quantityOf(buildHarnessUsageEvent(step, { device: 'cpu' }), AiUsageUnit.CPU_SECOND)).toBe('2.500');
    // No device resolved → the cheaper unit, never nothing.
    expect(quantityOf(buildHarnessUsageEvent(step), AiUsageUnit.CPU_SECOND)).toBe('2.500');
  });

  it('prefers the engine clock and records bytes as wire counts', () => {
    const step = makeStep({
      stats: {
        provider: 'openai',
        model: 'gpt-5',
        prompt_tokens: 10,
        total_ms: 3000,
        engine_ms: 2400,
        request_bytes: 4096,
        response_bytes: 8192,
        trigger: 'WORKFLOW_RUN',
      },
    });

    const event = buildHarnessUsageEvent(step);

    // A cloud call is metered on the PLATFORM's CPU, whatever the engine reported.
    expect(quantityOf(event, AiUsageUnit.CPU_SECOND)).toBe('2.400');
    expect(quantityOf(event, AiUsageUnit.EGRESS_BYTE)).toBe(4096);
    expect(quantityOf(event, AiUsageUnit.INGRESS_BYTE)).toBe(8192);
    expect(event?.common.attributesJson?.byteSource).toBe('wire');
  });

  it('splits a tenant-funded step: notional tokens, INTERNAL platform second', () => {
    const step = makeStep({
      stats: { provider: 'anthropic', model: 'claude-sonnet-5', prompt_tokens: 10, total_ms: 1200, funding_tier: 'tenant', trigger: 'WORKFLOW_RUN' },
    });

    const result = buildHarnessUsageBatches(step);

    expect(result?.batch.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    expect(result?.platformBatch?.common.costBasis).toBe(AiCostBasis.INTERNAL);
    expect(result?.platformBatch?.common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(quantityOf(result?.platformBatch, AiUsageUnit.CPU_SECOND)).toBe('1.200');
  });

  it('emits nothing new for a step whose stats predate the timing fields', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { provider: 'lm-studio', prompt_tokens: 10, predicted_tokens: 2 } }), { device: 'cuda' });
    expect(event?.units.map((line) => line.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
    expect(event?.common.attributesJson?.device).toBeUndefined();
  });
});

describe('buildHarnessUsageEvent — a losing fallback leg (§6.2)', () => {
  const failedStep = (stats: Record<string, unknown> = {}) =>
    makeStep({
      seq: 1003,
      status: AgentStepStatus.ERROR,
      stats: { provider: 'azure-openai', model: 'gpt-5.4-mini', total_ms: 850, leg: 'failed', ...stats },
    });

  it('bills ONE CPU_SECOND row and no token rows', () => {
    const event = buildHarnessUsageEvent(failedStep());

    expect(event?.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '0.850' }]);
    expect(event?.common.attributesJson?.leg).toBe('failed');
    // The provider spelling is canonicalized exactly as a serving leg's is.
    expect(event?.common.provider).toBe('azure');
    expect(event?.common.deployment).toBe(AiDeploymentKind.CLOUD);
  });

  it('keys off the same (sessionId, runId, seq) tuple — no second key scheme', () => {
    expect(buildHarnessUsageEvent(failedStep())?.common.idempotencyKey).toBe(`harness:step:${SESSION}:${RUN}:1003`);
  });

  it('records the platform CPU of a failed TENANT-funded attempt as INTERNAL', () => {
    // The tenant's credential was never successfully spent — nothing was
    // generated — so there is nothing notional to record, and the seconds HOPE
    // burned trying are platform cost.
    const result = buildHarnessUsageBatches(failedStep({ funding_tier: 'tenant' }));

    expect(result?.batch.common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(result?.batch.common.costBasis).toBe(AiCostBasis.INTERNAL);
    expect(result?.batch.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '0.850' }]);
    expect(result?.platformBatch).toBeUndefined();
  });

  it('carries the workflow lane’s operation and trigger onto the failed leg', () => {
    const event = buildHarnessUsageEvent(failedStep({ trigger: 'WORKFLOW_RUN' }));
    expect(event?.common.operation).toBe('workflow.step');
    expect(event?.common.attributesJson?.trigger).toBe('WORKFLOW_RUN');
  });

  it('records nothing when the failed leg carries no timing to bill', () => {
    expect(buildHarnessUsageEvent(failedStep({ total_ms: undefined }))).toBeNull();
  });

  it('does not turn an ordinary errored step into a failed-leg row', () => {
    // Without `leg: "failed"` a non-OK step is an error record, not a metered
    // attempt — the existing behaviour (no billable unit ⇒ null) stands.
    const step = makeStep({ status: AgentStepStatus.ERROR, stats: { provider: 'lm-studio', total_ms: 900 } });
    expect(buildHarnessUsageEvent(step)).toBeNull();
  });

  it('does not fabricate a failed leg for an OK step that somehow carries the label', () => {
    const step = makeStep({ status: AgentStepStatus.OK, stats: { provider: 'lm-studio', total_ms: 900, leg: 'failed' } });
    expect(buildHarnessUsageEvent(step)).toBeNull();
  });
});
