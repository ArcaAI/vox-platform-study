/**
 * TASK-790 W3(a) — `WorkflowValidatorService` is actually wired (TASK-789 finding H-1).
 *
 * `WorkflowDefinitionService.validateGraph()` called `@arcaai/workflow-contract`'s `validate()`
 * directly against the bundled, code-owned DRAFT catalogue. `WorkflowValidatorService` — 169
 * lines of real SYSTEM-∪-tenant resolution and one-way-strictness merge logic, with its own
 * passing tests — was imported nowhere outside its own module. So the capability
 * `workflow-invariant-rule.prisma`'s header documents ("a tenant row may only ADD strictness")
 * could not affect a single validation, no matter what rows existed.
 *
 * Wiring it here is what makes a `WorkflowInvariantRule` row mean something. The validator is
 * TOTAL by contract — every failure path inside it resolves to a `WF-INTERNAL` ERROR finding and
 * never throws — so delegating to it cannot turn a validation into an exception.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = {
  findById: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};
const mockSttPipelineCompiler = { compileAndPublish: vi.fn() };

/** Stands in for the real `WorkflowValidatorService` at the seam — its own resolution/merge
 *  behaviour is covered by `workflow-validator/__tests__/workflow-validator.service.test.ts`. */
const mockWorkflowValidator = { validateGraph: vi.fn(), resolveRuleSetVersion: vi.fn() };

const VALID_GRAPH = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };

/** A report carrying a TENANT-authored ERROR — something the bundled code catalogue cannot produce. */
const TENANT_RULE_REPORT = {
  ok: false,
  ruleSetVersion: 42,
  registryChecksum: 'rc',
  findings: [{ ruleId: 'WF-I-900', ruleClass: 'invariant', severity: 'ERROR', nodeId: 'n1', message: 'tenant strictness rule fired' }],
};

const savedEntity = {
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: null,
  paletteKey: 'summarization',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: VALID_GRAPH,
  graphChecksum: 'c',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-08-22T00:00:00Z'),
  updatedAt: new Date('2026-08-22T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
};

function build(withValidator: boolean) {
  return new WorkflowDefinitionService(
    mockWorkflowDefinitionRepository as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockDatabaseService as any,
    mockEntitlements as any,
    mockSttPipelineCompiler as any,
    withValidator ? (mockWorkflowValidator as any) : undefined,
  );
}

describe('TASK-790 W3(a) — WorkflowValidatorService is wired into the definition lifecycle (H-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockWorkflowDefinitionRepository.create.mockResolvedValue(savedEntity);
    mockWorkflowValidator.validateGraph.mockResolvedValue(TENANT_RULE_REPORT);
  });

  it('create() resolves the rule set through the validator, with the tenant and palette', async () => {
    await build(true).create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: VALID_GRAPH });

    expect(mockWorkflowValidator.validateGraph).toHaveBeenCalledWith('tenant-1', 'summarization', VALID_GRAPH);
  });

  it("stores the validator's report — including a tenant rule's findings the code catalogue cannot produce", async () => {
    await build(true).create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: VALID_GRAPH });

    const created = mockWorkflowDefinitionRepository.create.mock.calls[0][0];
    expect(created.validationReport.ruleSetVersion).toBe(42);
    expect(created.validationReport.findings[0].ruleId).toBe('WF-I-900');
  });

  it('publish() resolves through the validator too — a tenant rule cannot be skipped by publishing', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue({ ...savedEntity, status: WorkflowDefinitionStatus.VALIDATED });
    mockWorkflowDefinitionRepository.update.mockResolvedValue(savedEntity);
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);

    await build(true).publish('def-1', { activate: true });

    expect(mockWorkflowValidator.validateGraph).toHaveBeenCalledWith('tenant-1', 'summarization', VALID_GRAPH);
  });

  it('falls back to the bundled catalogue when no validator is wired (unit fixtures)', async () => {
    await build(false).create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: VALID_GRAPH });

    expect(mockWorkflowValidator.validateGraph).not.toHaveBeenCalled();
    expect(mockWorkflowDefinitionRepository.create).toHaveBeenCalledTimes(1);
  });
});
