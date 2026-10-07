/**
 * TASK-1050 W2e — the three guardrail models in the checkpoint registry (README W0 follow-up):
 * `GuardrailEvaluation` and `GuardrailPolicyRevision` are LOG-ONLY (captured, never restored — a
 * restored verdict or policy value could outlive the policy it was decided under), while a
 * `GuardrailNotice` is restored WITH ITS CONSULTATION (an acknowledgement / hold state is part of the
 * clinical record). None of the three has soft delete.
 */
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_REGISTRY, descriptorFor } from '../registry';

const shape = (model: string) => {
  const d = descriptorFor(model);
  return `${d.category} ${d.policy} ${d.retire.kind} ${d.scope.kind} softDelete=${d.softDelete}`;
};

describe('checkpoint registry — TASK-1050 guardrail models', () => {
  it('captures GuardrailEvaluation and GuardrailPolicyRevision as logs, never restored', () => {
    expect(shape('GuardrailEvaluation')).toBe('LOGS CAPTURE_ONLY never tenantColumn softDelete=false');
    expect(shape('GuardrailPolicyRevision')).toBe('LOGS CAPTURE_ONLY never tenantColumn softDelete=false');
  });

  it('restores GuardrailNotice with its consultation (clinical, reconciled, hard-deleted when absent)', () => {
    expect(shape('GuardrailNotice')).toBe('CLINICAL RECONCILE hardDelete tenantColumn softDelete=false');
    expect(descriptorFor('GuardrailNotice').notes).toMatch(/consultation/i);
  });

  it('describes each of the three exactly once', () => {
    for (const model of ['GuardrailEvaluation', 'GuardrailNotice', 'GuardrailPolicyRevision']) {
      expect(CHECKPOINT_REGISTRY.filter((d) => d.model === model)).toHaveLength(1);
    }
  });
});
