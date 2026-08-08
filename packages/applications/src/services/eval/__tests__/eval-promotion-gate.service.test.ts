/**
 * EvalPromotionGateService unit tests.
 *
 * The gate is the OD-3 mandatory eval on template approval / agent pin re-point:
 * if a department agent bound to the template references a golden set, it runs
 * the eval and — in `block` mode — reports a blocked promotion on failure. Mode
 * comes from the `agentic.eval.promotionGate` registry setting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalPromotionGateService } from '../eval-promotion-gate.service';

const TENANT = 'tenant-1';
const TPL = 'tpl-1';

// TASK-635 R5 — the gate now looks agents up through `findByBoundTemplate`,
// which ORs across the base binding AND the four capability-keyed columns, so a
// template bound only via (say) `revisitTemplateId` can no longer escape the
// gate at approve time.
const mockAgentRepository = { findByBoundTemplate: vi.fn() };
const mockEvalRunService = { runGoldenSet: vi.fn() };
const mockEffectiveSettings = { resolveEffective: vi.fn() };

function agent(over: Record<string, unknown> = {}) {
  return { id: 'agent-1', tenantId: TENANT, promptTemplateId: TPL, goldenSetId: 'set-1', ...over };
}

describe('EvalPromotionGateService', () => {
  let service: EvalPromotionGateService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'block' });
    mockAgentRepository.findByBoundTemplate.mockResolvedValue([agent()]);
    mockEvalRunService.runGoldenSet.mockResolvedValue({
      run: { id: 'run-1' },
      passed: true,
      failures: [],
      aggregates: { pdsqi_mean: 4.5 },
    });
    service = new EvalPromotionGateService(mockAgentRepository as never, mockEvalRunService as never, mockEffectiveSettings as never);
  });

  it('runs the eval for a bound agent’s golden set and passes it through', async () => {
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });

    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(
      expect.objectContaining({ goldenSetId: 'set-1', tenantId: TENANT, triggerType: 'PROMOTION', promptTemplateId: TPL }),
    );
    expect(verdict.mode).toBe('block');
    expect(verdict.evaluated).toBe(true);
    expect(verdict.passed).toBe(true);
    expect(verdict.blocked).toBe(false);
    expect(verdict.runIds).toEqual(['run-1']);
  });

  it('blocks in block-mode when the eval fails', async () => {
    mockEvalRunService.runGoldenSet.mockResolvedValue({
      run: { id: 'run-1' },
      passed: false,
      failures: ['pdsqi_accurate=2.0000 < 4.0'],
      aggregates: { pdsqi_accurate: 2.0 },
    });
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.passed).toBe(false);
    expect(verdict.blocked).toBe(true);
    expect(verdict.failures).toContain('pdsqi_accurate=2.0000 < 4.0');
  });

  it('does NOT block in warn-mode even when the eval fails', async () => {
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'warn' });
    mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'run-1' }, passed: false, failures: ['x'], aggregates: {} });
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.mode).toBe('warn');
    expect(verdict.passed).toBe(false);
    expect(verdict.blocked).toBe(false);
  });

  it('skips entirely in off-mode (no eval run)', async () => {
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'off' });
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.mode).toBe('off');
    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('proceeds with a warning when no bound agent references a golden set', async () => {
    mockAgentRepository.findByBoundTemplate.mockResolvedValue([agent({ goldenSetId: null })]);
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(verdict.warning).toMatch(/no golden set/i);
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('scopes to a single agent for a pin re-point', async () => {
    mockAgentRepository.findByBoundTemplate.mockResolvedValue([agent({ id: 'agent-1', goldenSetId: 'set-1' }), agent({ id: 'agent-2', goldenSetId: 'set-2' })]);
    await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, agentId: 'agent-2', trigger: 'pin' });
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledTimes(1);
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(expect.objectContaining({ goldenSetId: 'set-2' }));
  });

  it('defaults to block-mode if the setting cannot be resolved', async () => {
    mockEffectiveSettings.resolveEffective.mockRejectedValue(new Error('no resolver'));
    mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'run-1' }, passed: false, failures: ['x'], aggregates: {} });
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.mode).toBe('block');
    expect(verdict.blocked).toBe(true);
  });
});
