/**
 * EvalPromotionGateService unit tests.
 *
 * The gate is the OD-3 mandatory eval on template approval / prompt pin
 * re-point: if a node bound to the template references a golden set AND its
 * gate is enabled, it runs the eval and — in `block` mode — reports a blocked
 * promotion on failure. Mode comes from the `agentic.eval.promotionGate`
 * registry setting.
 *
 * TASK-815 / OD-11 moved DISCOVERY only. It used to find golden sets through
 * `DepartmentAgentRepository.findByBoundTemplate`; it now walks the tenant's
 * ACTIVE PUBLISHED workflow definitions and reads the `evalGate` on any node
 * whose config binds the template. The gate itself, its three modes, its 409
 * `EVAL_GATE_FAILED` contract and its no-golden-set warning are unchanged —
 * OD-11's first reading ("remove the gate") was withdrawn.
 *
 * The behaviour OD-11 ADDS is the explicit tenant-admin toggle: `enabled:
 * false` on the gate means the approval proceeds with a recorded warning,
 * exactly as "no golden set attached" always did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalPromotionGateService } from '../eval-promotion-gate.service';

const TENANT = 'tenant-1';
const TPL = 'tpl-1';

const mockWorkflowDefinitionRepository = { findActivePublishedByTenant: vi.fn() };
const mockEvalRunService = { runGoldenSet: vi.fn() };
const mockEffectiveSettings = { resolveEffective: vi.fn() };

/** A node bound to `TPL` and carrying an enabled gate on `goldenSetId`. */
function gatedNode(id: string, goldenSetId: string | null, enabled = true, promptTemplateId: string = TPL) {
  return {
    id,
    type: 'generate.text',
    config: {
      taskKey: 'text.finalize',
      promptTemplateId,
      ...(goldenSetId ? { evalGate: { goldenSetId, enabled } } : {}),
    },
  };
}

function definition(nodes: unknown[], slug = 'consultation-default') {
  return { id: `wfdef-${slug}`, slug, paletteKey: 'consultation', graph: { version: 1, nodes, edges: [] } };
}

describe('EvalPromotionGateService', () => {
  let service: EvalPromotionGateService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'block' });
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([definition([gatedNode('note_writer', 'set-1')])]);
    mockEvalRunService.runGoldenSet.mockResolvedValue({
      run: { id: 'run-1' },
      passed: true,
      failures: [],
      aggregates: { pdsqi_mean: 4.5 },
    });
    service = new EvalPromotionGateService(mockWorkflowDefinitionRepository as never, mockEvalRunService as never, mockEffectiveSettings as never);
  });

  it('runs the eval for a bound node’s golden set and passes it through', async () => {
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });

    expect(mockWorkflowDefinitionRepository.findActivePublishedByTenant).toHaveBeenCalledWith(TENANT);
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(
      expect.objectContaining({ goldenSetId: 'set-1', tenantId: TENANT, triggerType: 'PROMOTION', promptTemplateId: TPL }),
    );
    expect(verdict.mode).toBe('block');
    expect(verdict.evaluated).toBe(true);
    expect(verdict.passed).toBe(true);
    expect(verdict.blocked).toBe(false);
    expect(verdict.runIds).toEqual(['run-1']);
  });

  it('BLOCKS in block-mode when the eval fails — the safety control still fires after the repoint', async () => {
    // This is the OD-11 acceptance test: "prove a bound+enabled node still
    // BLOCKS a failing approval".
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

  it('skips entirely in off-mode (no eval run, no definition read)', async () => {
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'off' });
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.mode).toBe('off');
    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('proceeds with a warning when no bound node carries a gate', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([definition([gatedNode('note_writer', null)])]);
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(verdict.warning).toMatch(/no golden set/i);
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('OD-11 — a DISABLED gate proceeds with a recorded warning rather than blocking', async () => {
    // The tenant-admin toggle. Disabling is an explicit act with a visible
    // consequence: the promotion is ungated and says so.
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([definition([gatedNode('note_writer', 'set-1', false)])]);
    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(verdict.warning).toMatch(/no golden set/i);
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('ignores nodes bound to a DIFFERENT template', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      definition([gatedNode('other_writer', 'set-other', true, 'tpl-other'), gatedNode('note_writer', 'set-1')]),
    ]);
    await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledTimes(1);
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(expect.objectContaining({ goldenSetId: 'set-1' }));
  });

  it('gates EVERY bound node across EVERY published definition on approve', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      definition([gatedNode('note_writer', 'set-1')], 'consultation-default'),
      definition([gatedNode('discharge_writer', 'set-2')], 'discharge'),
    ]);
    await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates a golden set referenced by more than one node', async () => {
    // Two nodes on the same golden set is one eval, not two: the eval is an
    // expensive external call and running it twice tells nobody anything new.
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      definition([gatedNode('a', 'set-1'), gatedNode('b', 'set-1')]),
    ]);
    await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' });
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledTimes(1);
  });

  it('scopes to a single NODE for a pin re-point', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      definition([gatedNode('node-1', 'set-1'), gatedNode('node-2', 'set-2')]),
    ]);
    await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, agentId: 'node-2', trigger: 'pin' });
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

  it('a definition read failure never silently un-gates — it propagates', async () => {
    // The one place the gate must NOT be tolerant. Swallowing this into "no
    // golden set" would turn a database outage into a silently ungated
    // approval, which is the failure mode this whole control exists against.
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockRejectedValue(new Error('db down'));
    await expect(service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: TPL, trigger: 'approve' })).rejects.toThrow(/db down/);
  });
});
