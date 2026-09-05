import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgenticInstructionsService, JUDGE_PROMPT_INSTRUMENT, JUDGE_PROMPT_HASH } from '../agentic-instructions.service';

/**
 * The agentic instructions inventory aggregator.
 * It is a pure read composition over `HarnessPolicyService.getEffectivePolicy`
 * (thresholds + safety) and `PromptResolutionService.resolve` (the prompt tier),
 * plus the vendored (non-editable) PDSQI judge-prompt pin. These specs mock both
 * collaborators and assert the aggregation shape + pass-through.
 */

const effectivePolicy = {
  id: 'pol-1',
  tenantId: 't1',
  source: 'tenant' as const,
  entityFaithfulnessThreshold: 1.0,
  coverageThreshold: 0.8,
  citationPresenceThreshold: 1.0,
  numericDoseThreshold: 1.0,
  groundednessThreshold: 0.75,
  safetyEnabled: true,
  phiEnabled: true,
  phiFailClosed: false,
  textProvider: 'lm-studio',
  textModel: 'medgemma',
  maxRegen: 2,
  gateSlaSeconds: 86400,
  gateEscalationSeconds: 43200,
  toolAllowlist: null,
  optimisticDeliveryEnabled: null,
  atomicFactEnabled: null,
  retrievalEnabled: null,
  warmStartEnabled: null,
  nerPriorsEnabled: null,
  maxEditReruns: null,
  regenFeedbackEnabled: null,
  updatedAt: '2026-07-19T00:00:00.000Z',
  version: 4,
};

const resolvedTier = {
  template: 'SOAP',
  promptId: '71000000-0000-0000-0000-000000000036',
  contextVariables: {},
  resolvedFrom: 'default' as const,
  resolutionTrace: { usedDefaults: ['template', 'promptId'] },
};

function makeService() {
  const harnessPolicyService = {
    getEffectivePolicy: vi.fn().mockResolvedValue(effectivePolicy),
  };
  const promptResolutionService = {
    resolve: vi.fn().mockResolvedValue(resolvedTier),
  };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn() };
  const service = new AgenticInstructionsService(
    harnessPolicyService as never,
    promptResolutionService as never,
    eventEmitter as never,
    cls as never,
  );
  return { service, harnessPolicyService, promptResolutionService };
}

describe('AgenticInstructionsService.getEffectiveInstructions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the effective harness policy for the passed tenant', async () => {
    const { service, harnessPolicyService } = makeService();
    await service.getEffectiveInstructions('t1');
    expect(harnessPolicyService.getEffectivePolicy).toHaveBeenCalledWith('t1');
  });

  it('projects the five sensor thresholds from the effective policy', async () => {
    const { service } = makeService();
    const out = await service.getEffectiveInstructions('t1');
    expect(out.sensorThresholds).toEqual({
      entityFaithfulnessThreshold: 1.0,
      coverageThreshold: 0.8,
      citationPresenceThreshold: 1.0,
      numericDoseThreshold: 1.0,
      groundednessThreshold: 0.75,
    });
  });

  it('carries the policy source through', async () => {
    const { service } = makeService();
    const out = await service.getEffectiveInstructions('t1');
    expect(out.tenantId).toBe('t1');
    expect(out.policySource).toBe('tenant');
  });

  it('builds the safety-criteria list from the safety knobs (safety + PHI)', async () => {
    const { service } = makeService();
    const out = await service.getEffectiveInstructions('t1');
    const keys = out.safetyCriteria.map((c) => c.key);
    expect(keys).toContain('safety');
    expect(keys).toContain('phi');
    const safety = out.safetyCriteria.find((c) => c.key === 'safety')!;
    expect(safety.enabled).toBe(true);
    const phi = out.safetyCriteria.find((c) => c.key === 'phi')!;
    expect(phi.enabled).toBe(true);
  });

  it('resolves the prompt tier and exposes template/promptId/resolvedFrom', async () => {
    const { service, promptResolutionService } = makeService();
    const out = await service.getEffectiveInstructions('t1', { departmentId: 'dep-1', promptType: 'new-patient' });
    expect(promptResolutionService.resolve).toHaveBeenCalledWith({
      tenantId: 't1',
      departmentId: 'dep-1',
      promptType: 'new-patient',
    });
    expect(out.promptTier.template).toBe('SOAP');
    expect(out.promptTier.promptId).toBe('71000000-0000-0000-0000-000000000036');
    expect(out.promptTier.resolvedFrom).toBe('default');
    expect(out.promptTier.departmentId).toBe('dep-1');
    expect(out.promptTier.promptType).toBe('new-patient');
  });

  // This surface accepts `promptType: 'pre-summary'`,
  // whose chain has NO department axis and cannot derive the tenant from a
  // Department row — omitting it makes the inventory report the SYSTEM default
  // (or raise a 503) instead of the tenant's own pre-summary template.
  it('passes the tenant through for a pre-summary resolution, which has no department axis', async () => {
    const { service, promptResolutionService } = makeService();
    await service.getEffectiveInstructions('t1', { promptType: 'pre-summary' });
    expect(promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', promptType: 'pre-summary' }));
  });

  it('exposes the vendored PDSQI judge-prompt pin (read-only, non-editable)', async () => {
    const { service } = makeService();
    const out = await service.getEffectiveInstructions('t1');
    expect(out.judgePrompt.instrument).toBe(JUDGE_PROMPT_INSTRUMENT);
    expect(out.judgePrompt.promptHash).toBe(JUDGE_PROMPT_HASH);
    expect(out.judgePrompt.editable).toBe(false);
    expect(out.judgePrompt.rubricDimensions.length).toBeGreaterThan(0);
  });
});
