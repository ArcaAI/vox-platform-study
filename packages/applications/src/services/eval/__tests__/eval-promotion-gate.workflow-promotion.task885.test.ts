/**
 * TASK-885 (owner #7) — the eval promotion gate on the Global → SYSTEM WORKFLOW path.
 *
 * Owner #7, verbatim in substance: *the eval promotion gate must not block the Global → SYSTEM
 * path on evaluation evidence that does not exist yet — relax it to `warn` by default for that
 * path while keeping `block` available.*
 *
 * The two halves of that sentence are what this file pins:
 *
 *   - **by default** — when NOBODY has written `agentic.eval.promotionGate`, this path resolves
 *     `warn`, even though the same key still resolves `block` for template approval / pin
 *     re-point (the OD-3 clinical control, which owner #7 did not touch);
 *   - **keeping block available** — a platform admin who WRITES `block` gets a blocking gate on
 *     this path too.
 *
 * Written RED-first: every test in this file failed against `46c226efd`, where
 * `evaluateWorkflowPromotion` did not exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalPromotionGateService } from '../eval-promotion-gate.service';

const TENANT = 'global-tenant';

const mockWorkflowDefinitionRepository = { findActivePublishedByTenant: vi.fn() };
const mockEvalRunService = { runGoldenSet: vi.fn() };
const mockEffectiveSettings = { resolveEffective: vi.fn() };

const gatedGraph = (goldenSetId: string | null, enabled = true) => ({
  version: 1,
  nodes: [{ id: 'note_writer', type: 'generate.text', config: goldenSetId ? { evalGate: { goldenSetId, enabled } } : {} }],
  edges: [],
});

describe('EvalPromotionGateService.evaluateWorkflowPromotion (TASK-885 / owner #7)', () => {
  let service: EvalPromotionGateService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Nobody has written the key: the resolver answers the CODE DEFAULT (`block`).
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'block', sourceScope: 'code-default' });
    mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'run-1' }, passed: false, failures: ['pdsqi_mean 3.1 < 4.0'], aggregates: {} });
    service = new EvalPromotionGateService(mockWorkflowDefinitionRepository as never, mockEvalRunService as never, mockEffectiveSettings as never);
  });

  it('WARNS instead of blocking when nobody has written the key — the owner #7 relaxation', async () => {
    const verdict = await service.evaluateWorkflowPromotion({ tenantId: TENANT, definitionSlug: 'soap', graph: gatedGraph('set-1') });

    expect(verdict.mode).toBe('warn');
    expect(verdict.evaluated).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(verdict.failures).toEqual(['pdsqi_mean 3.1 < 4.0']);
  });

  it('leaves the template-approval gate at its `block` default — owner #7 relaxed ONE path', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      { id: 'd1', slug: 'soap', graph: { version: 1, nodes: [{ id: 'n', type: 'generate.text', config: { promptTemplateId: 'tpl-1', evalGate: { goldenSetId: 'set-1', enabled: true } } }], edges: [] } },
    ]);

    const verdict = await service.evaluatePromotion({ tenantId: TENANT, promptTemplateId: 'tpl-1', trigger: 'approve' });

    expect(verdict.mode).toBe('block');
    expect(verdict.blocked).toBe(true);
  });

  it('BLOCKS when a platform admin has written `block` — the escape hatch stays available', async () => {
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'block', sourceScope: 'system' });

    const verdict = await service.evaluateWorkflowPromotion({ tenantId: TENANT, definitionSlug: 'soap', graph: gatedGraph('set-1') });

    expect(verdict.mode).toBe('block');
    expect(verdict.blocked).toBe(true);
  });

  it('skips the eval entirely in `off` mode', async () => {
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'off', sourceScope: 'system' });

    const verdict = await service.evaluateWorkflowPromotion({ tenantId: TENANT, definitionSlug: 'soap', graph: gatedGraph('set-1') });

    expect(verdict.mode).toBe('off');
    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('honours an explicitly written `warn` and never blocks on it', async () => {
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: 'warn', sourceScope: 'system' });

    const verdict = await service.evaluateWorkflowPromotion({ tenantId: TENANT, definitionSlug: 'soap', graph: gatedGraph('set-1') });

    expect(verdict.mode).toBe('warn');
    expect(verdict.blocked).toBe(false);
  });

  it('proceeds ungated, with a recorded warning, when the graph attaches no enabled golden set', async () => {
    const verdict = await service.evaluateWorkflowPromotion({ tenantId: TENANT, definitionSlug: 'soap', graph: gatedGraph('set-1', false) });

    expect(verdict.evaluated).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(verdict.warning).toBeDefined();
    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
  });

  it('runs the eval in the SOURCE tenant, against the graph handed to it — never a stored definition', async () => {
    mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'run-9' }, passed: true, failures: [], aggregates: { pdsqi_mean: 4.6 } });

    const verdict = await service.evaluateWorkflowPromotion({ tenantId: TENANT, definitionSlug: 'soap', graph: gatedGraph('set-1') });

    expect(mockWorkflowDefinitionRepository.findActivePublishedByTenant).not.toHaveBeenCalled();
    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(expect.objectContaining({ goldenSetId: 'set-1', tenantId: TENANT, triggerType: 'PROMOTION' }));
    expect(verdict.runIds).toEqual(['run-9']);
    expect(verdict.passed).toBe(true);
  });
});
