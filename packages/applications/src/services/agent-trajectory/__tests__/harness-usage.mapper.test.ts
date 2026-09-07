/**
 * buildHarnessUsageEvent.
 *
 * Pure mapping from one persisted `AgentTrajectoryStep` (LLM_CALL, AD-1
 * GenerationStats) onto the usage-ledger's `{common, units}` batch input, or
 * `null` when the step carries nothing billable. Covered here in isolation
 * from `AgentTrajectoryService` so the token-mapping / provider-canonicalization
 * / idempotency-key-derivation logic has its own focused test surface.
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
import { buildHarnessUsageEvent } from '../harness-usage.mapper';

const TENANT = 'tenant-1';
const CID = 'consultation-1';
const SESSION = 'wf-session-1';
const RUN = 'wf-run-1';

function makeStep(overrides: Partial<Parameters<typeof AgentTrajectoryStepFactory.CreateStep>[0]> = {}) {
  return AgentTrajectoryStepFactory.CreateStep({
    tenantId: TENANT,
    consultationId: CID,
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: SESSION,
    runId: RUN,
    seq: 3,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-08-06T10:00:00.000Z'),
    endedAt: new Date('2026-08-06T10:00:02.000Z'),
    ...overrides,
  });
}

describe('buildHarnessUsageEvent', () => {
  it('maps prompt_tokens/predicted_tokens onto INPUT_TOKEN/OUTPUT_TOKEN with a stable, retry-safe idempotency key', () => {
    const step = makeStep({
      stats: { stop_reason: 'stop', prompt_tokens: 120, predicted_tokens: 45, total_tokens: 165, provider: 'lm-studio', model: 'phi-4' },
    });

    const event = buildHarnessUsageEvent(step);

    expect(event).not.toBeNull();
    expect(event!.common).toMatchObject({
      tenantId: TENANT,
      // Derived from the (sessionId, runId, seq) composite — the SAME tuple
      // that dedupes trajectory persistence — NOT the entity's auto-generated
      // row id (a fresh UUIDv7 every call, including retries).
      idempotencyKey: `harness:step:${SESSION}:${RUN}:3`,
      occurredAt: step.endedAt,
      capability: AiCapability.LLM,
      operation: 'harness.step',
      provider: 'lm-studio',
      model: 'phi-4',
      deployment: AiDeploymentKind.SELF_HOSTED,
      consultationId: CID,
      requestId: RUN,
      sessionId: SESSION,
    });
    expect(event!.common.attributesJson).toMatchObject({ engine: 'lm-studio', interrupted: false });
    expect(event!.units).toEqual(
      expect.arrayContaining([
        { unit: AiUsageUnit.INPUT_TOKEN, quantity: 120 },
        { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 45 },
      ]),
    );
    expect(event!.units).toHaveLength(2);
  });

  it('a retried/re-delivered step (same session/run/seq, fresh entity id) yields the SAME idempotency key', () => {
    const stats = { prompt_tokens: 10, predicted_tokens: 5, provider: 'ollama', model: 'llama3' };
    const first = buildHarnessUsageEvent(makeStep({ stats }));
    const retried = buildHarnessUsageEvent(makeStep({ stats })); // a fresh CreateStep() call ⇒ a fresh entity.id

    expect(first!.common.idempotencyKey).toBe(retried!.common.idempotencyKey);
  });

  it('a different seq on the same session/run produces a DIFFERENT key', () => {
    const stats = { prompt_tokens: 10, predicted_tokens: 5, provider: 'ollama', model: 'llama3' };
    const stepA = buildHarnessUsageEvent(makeStep({ stats, seq: 3 }));
    const stepB = buildHarnessUsageEvent(makeStep({ stats, seq: 4 }));

    expect(stepA!.common.idempotencyKey).not.toBe(stepB!.common.idempotencyKey);
  });

  it('returns null for a non-LLM_CALL step even when it carries a stats-shaped payload', () => {
    const step = makeStep({ stepType: AgentStepType.PHASE, stats: { prompt_tokens: 10, predicted_tokens: 5, provider: 'ollama' } });
    expect(buildHarnessUsageEvent(step)).toBeNull();
  });

  it('returns null for an LLM_CALL step with no stats at all', () => {
    const step = makeStep({ stats: undefined });
    expect(buildHarnessUsageEvent(step)).toBeNull();
  });

  it('returns null when stats carries zero/absent token counts (never emits a zero-quantity row)', () => {
    const step = makeStep({ stats: { stop_reason: 'stop', provider: 'ollama', model: 'x', prompt_tokens: 0, predicted_tokens: 0 } });
    expect(buildHarnessUsageEvent(step)).toBeNull();
  });

  it('drops the OUTPUT_TOKEN row when only prompt_tokens is present (no invented zero-quantity units)', () => {
    const step = makeStep({ stats: { provider: 'ollama', model: 'x', prompt_tokens: 30 } });
    const event = buildHarnessUsageEvent(step);
    expect(event!.units).toEqual([{ unit: AiUsageUnit.INPUT_TOKEN, quantity: 30 }]);
  });

  it('returns null when the stats block carries no provider (never guesses attribution)', () => {
    const step = makeStep({ stats: { prompt_tokens: 10, predicted_tokens: 5, model: 'x' } });
    expect(buildHarnessUsageEvent(step)).toBeNull();
  });

  it('canonicalizes TEXT-internal provider spellings onto the ledger vocabulary (azure_openai -> azure)', () => {
    const step = makeStep({ stats: { prompt_tokens: 10, predicted_tokens: 5, provider: 'azure_openai', model: 'gpt-4o' } });
    const event = buildHarnessUsageEvent(step);
    expect(event!.common.provider).toBe('azure');
    expect(event!.common.deployment).toBe(AiDeploymentKind.CLOUD);
    expect(event!.common.attributesJson).toMatchObject({ engine: 'azure' });
  });

  it('classifies a cloud provider as CLOUD deployment (never derives BYOK without a signal)', () => {
    const step = makeStep({ stats: { prompt_tokens: 10, predicted_tokens: 5, provider: 'anthropic', model: 'claude-sonnet-5' } });
    const event = buildHarnessUsageEvent(step);
    expect(event!.common.deployment).toBe(AiDeploymentKind.CLOUD);
    expect(event!.common.costBasis).toBeUndefined();
  });

  it('marks interrupted: true for a non-OK step status', () => {
    const step = makeStep({
      status: AgentStepStatus.ERROR,
      stats: { prompt_tokens: 10, predicted_tokens: 5, provider: 'ollama', model: 'x' },
    });
    const event = buildHarnessUsageEvent(step);
    expect(event!.common.attributesJson).toMatchObject({ interrupted: true });
  });

  it('falls back occurredAt to startedAt when endedAt is missing', () => {
    const step = makeStep({
      endedAt: null,
      stats: { prompt_tokens: 10, predicted_tokens: 5, provider: 'ollama', model: 'x' },
    });
    const event = buildHarnessUsageEvent(step);
    expect(event!.common.occurredAt).toEqual(step.startedAt);
  });
});

/**
 * F14 — the three dimensions the WORKFLOW lane knows and the consultation lane does not.
 *
 * A workflow-lane `core.agent` generation produced no ledger row at all until the harness
 * started recording its LLM_CALL step (`nodes/_shared.record_generation_and_flush`). That step
 * carries the same AD-1 `GenerationStats` the consultation lane records, PLUS `trigger`,
 * `funding_tier` and `guardrail` — the answers to "why did this run", "whose money paid for it"
 * and "was it screened", none of which the mapper could previously read anywhere.
 *
 * Both vocabularies are CLOSED (`usage-attributes.ts`): an unrecognised value is dropped rather
 * than forked into the rollup dimension, and an absent funding tier stays absent — a guessed
 * tier silently converts tenant-funded spend into platform COGS.
 */
describe('buildHarnessUsageEvent — workflow-lane dimensions (F14)', () => {
  const base = { prompt_tokens: 812, predicted_tokens: 344, provider: 'lm-studio', model: 'gemma-4-e2b-it-qat' };

  it('carries the trigger and the screening disposition onto the ledger attributes', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { ...base, trigger: 'WORKFLOW_RUN', guardrail: 'screened' } }));

    expect(event!.common.attributesJson).toMatchObject({ trigger: 'WORKFLOW_RUN', guardrail: 'screened' });
  });

  it('a tenant-funded generation is metered BYOK on the BYOK_NOTIONAL basis', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { ...base, funding_tier: 'tenant' } }));

    // The pair has to move together: `UsageLedgerService` warns on either half alone.
    expect(event!.common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(event!.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
  });

  it('a platform-funded generation keeps the engine-derived deployment and the INTERNAL basis', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { ...base, funding_tier: 'platform' } }));

    expect(event!.common.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
    expect(event!.common.costBasis).toBeUndefined();
  });

  it('an absent funding tier is never guessed', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: base }));

    expect(event!.common.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
    expect(event!.common.costBasis).toBeUndefined();
  });

  it('a value outside either closed vocabulary is dropped, never forked into the dimension', () => {
    const event = buildHarnessUsageEvent(
      makeStep({ stats: { ...base, trigger: 'BECAUSE_I_SAID_SO', guardrail: 'probably', funding_tier: 'whoever' } }),
    );

    expect(event!.common.attributesJson).not.toHaveProperty('trigger');
    expect(event!.common.attributesJson).not.toHaveProperty('guardrail');
    expect(event!.common.costBasis).toBeUndefined();
    expect(event!.common.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
  });

  it('a consultation-lane step carrying none of them is byte-identical to before', () => {
    const event = buildHarnessUsageEvent(makeStep({ stats: { ...base, provider: 'ollama', model: 'llama3' } }));

    expect(event!.common.attributesJson).toEqual({ engine: 'ollama', interrupted: false });
  });
});
