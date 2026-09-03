/**
 * AgentPromotionService — promoting a WORKFLOW DEFINITION version ( / OD-10).
 *
 * The promotable moved off `DepartmentAgentVersion.configSnapshot` onto a
 * `WorkflowDefinition` version row. Everything the previous suite protected is
 * re-expressed against that subject, because none of it was ever about agents:
 *
 *  - manage rights on BOTH tenants, evaluated BEFORE any read so a 403/404
 *    difference cannot be used as an existence oracle;
 *  - no `GoldenCase` — nor even the POINTER to one — crosses a tenant boundary;
 *  - the eval re-runs at the TARGET, against the target's own corpus;
 *  - the promoted artifact is the immutable VERSION, not a live head;
 *  - bound prompt templates are deep-copied so the target can actually read them;
 *  - the live-consultation alert wording;
 *  - one transaction around every target-tenant write.
 *
 * The one genuinely new rule: the promoted row lands as a DRAFT, never active.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentPromotionService, liveConsultationsWarning } from '../agentPromotion.service';

const FROM = 'tenant-source';
const TO = 'tenant-target';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPromotionRepository = { create: vi.fn(), update: vi.fn(), findById: vi.fn(), findAll: vi.fn(), count: vi.fn() };
const mockDefinitionRepository = { findPublishedBySlug: vi.fn(), findAllVersionsBySlug: vi.fn(), findById: vi.fn(), create: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockDocumentTemplateRepository = { findById: vi.fn() };
const mockPromptVersionRepository = { create: vi.fn() };
const mockConsultationRepository = { count: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };
const mockEvalRunService = { runGoldenSet: vi.fn() };
const mockUnitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ TX: true })) };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    WorkflowDefinitionFactory: {
      CreateDefinition: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-target-definition', createdAt: new Date(), version: 1 })),
    },
    PromptTemplateFactory: {
      CreatePromptTemplate: vi.fn((data: Record<string, unknown>) => ({ ...data, id: `copied-${String(data.name)}` })),
    },
    PromptVersionFactory: { CreatePromptVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'copied-v1' })) },
    AgentPromotionFactory: {
      CreateAgentPromotion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'promotion-1',
        tenantId: data.toTenantId,
        createdAt: new Date(),
        version: 1,
        validate: vi.fn(),
      })),
    },
  };
});

function node(id: string, config: Record<string, unknown>, type = 'generate.text') {
  return { id, type, config };
}

const sourceGraph = (nodes: unknown[] = [node('note_writer', { taskKey: 'text.finalize', promptTemplateId: 'src-tpl', promptVersionNumber: 4 })]) => ({
  version: 1,
  nodes,
  edges: [],
});

const sourceDefinition = (overrides: Record<string, unknown> = {}) => ({
  id: 'source-definition-v3',
  tenantId: FROM,
  slug: 'cardiology-soap',
  name: 'Cardiology SOAP',
  description: 'desc',
  paletteKey: 'consultation',
  versionNumber: 3,
  status: 'PUBLISHED',
  isActive: true,
  graph: sourceGraph(),
  graphChecksum: 'source-checksum',
  tags: ['cardio'],
  ...overrides,
});

function buildService() {
  return new AgentPromotionService(
    mockPromotionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDefinitionRepository as never,
    mockPromptTemplateRepository as never,
    mockDocumentTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockConsultationRepository as never,
    mockPolicyEngine as never,
    mockUnitOfWork as never,
    mockEvalRunService as never,
  );
}

/** An elevated tenant-less super admin — the only context `promote` accepts. */
function superAdminTenantless() {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return undefined;
    if (key === 'user') return { id: 'user-1', roles: ['SUPER_ADMIN'] };
    return undefined;
  });
}

/** The happy-path wiring, restated so a test can reset mid-case. */
function wireHappyPath() {
  superAdminTenantless();
  mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => true });
  mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(sourceDefinition());
  mockDefinitionRepository.findAllVersionsBySlug.mockResolvedValue([]);
  mockDefinitionRepository.create.mockImplementation(async (entity: unknown) => entity);
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'src-tpl', tenantId: FROM, content: 'BODY', variables: null, tags: [] });
  mockPromptTemplateRepository.create.mockImplementation(async (entity: unknown) => entity);
  mockPromptVersionRepository.create.mockImplementation(async (entity: unknown) => entity);
  mockDocumentTemplateRepository.findById.mockResolvedValue(null);
  mockConsultationRepository.count.mockResolvedValue(0);
  mockPromotionRepository.create.mockImplementation(async (entity: unknown) => entity);
  mockPromotionRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'eval-run-1' }, passed: true, failures: [], aggregates: {} });
  mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({ TX: true }));
}

const REQUEST = { sourceDefinitionSlug: 'cardiology-soap', fromTenantId: FROM, toTenantId: TO };

/** The graph as it was written into the target. */
function promotedGraph(): { nodes: { id: string; config: Record<string, unknown> }[] } {
  const created = mockDefinitionRepository.create.mock.calls[0]![0] as Record<string, unknown>;
  return created.graph as { nodes: { id: string; config: Record<string, unknown> }[] };
}

describe('AgentPromotionService.promote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireHappyPath();
  });

  // =======================================================================
  // Authorization
  // =======================================================================

  it('refuses a pinned working tenant — promotion needs the elevated tenant-less context', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TO : { id: 'user-1', roles: ['SUPER_ADMIN'] }));

    await expect(buildService().promote(REQUEST)).rejects.toThrow(ForbiddenException);
    expect(mockDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
  });

  it('refuses a non-super-admin', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : { id: 'user-1', roles: ['TENANT_ADMIN'] }));

    await expect(buildService().promote(REQUEST)).rejects.toThrow(ForbiddenException);
  });

  it('requires manage:WorkflowDefinition in BOTH tenants, and names the side that failed', async () => {
    mockPolicyEngine.buildAbility.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({ can: () => tenantId === FROM }));

    await expect(buildService().promote(REQUEST)).rejects.toThrow(/target tenant/);
  });

  it('authorizes BEFORE any read, so a 403/404 difference is not an existence oracle', async () => {
    mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => false });

    await expect(buildService().promote(REQUEST)).rejects.toThrow(ForbiddenException);
    expect(mockDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
    expect(mockDefinitionRepository.findAllVersionsBySlug).not.toHaveBeenCalled();
  });

  it('refuses a same-tenant promotion', async () => {
    await expect(buildService().promote({ ...REQUEST, toTenantId: FROM })).rejects.toThrow(BadRequestException);
  });

  // =======================================================================
  // Which version travels
  // =======================================================================

  it('defaults to the source tenant’s ACTIVE PUBLISHED version, never simply the newest', async () => {
    await buildService().promote(REQUEST);

    expect(mockDefinitionRepository.findPublishedBySlug).toHaveBeenCalledWith(FROM, 'cardiology-soap');
    const promotion = mockPromotionRepository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(promotion.agentVersionId).toBe('source-definition-v3');
    expect(promotion.sourceAgentId).toBe('cardiology-soap');
  });

  it('promotes an explicitly named version, including an unpublished draft', async () => {
    mockDefinitionRepository.findAllVersionsBySlug.mockImplementation(async (tenantId: string) =>
      tenantId === FROM ? [sourceDefinition({ id: 'draft-v5', versionNumber: 5, status: 'DRAFT', isActive: false })] : [],
    );

    await buildService().promote({ ...REQUEST, definitionVersionNumber: 5 });

    expect(mockDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
    const promotion = mockPromotionRepository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(promotion.agentVersionId).toBe('draft-v5');
  });

  it('404s a version the source tenant does not have', async () => {
    mockDefinitionRepository.findAllVersionsBySlug.mockResolvedValue([]);
    await expect(buildService().promote({ ...REQUEST, definitionVersionNumber: 9 })).rejects.toThrow(NotFoundException);
  });

  it('refuses when the source slug has no ACTIVE PUBLISHED version and none was named', async () => {
    mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
    await expect(buildService().promote(REQUEST)).rejects.toThrow(/no ACTIVE PUBLISHED version/);
  });

  // =======================================================================
  // The copy
  // =======================================================================

  it('lands in the target as a DRAFT that is never active', async () => {
    await buildService().promote(REQUEST);

    const created = mockDefinitionRepository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.tenantId).toBe(TO);
    expect(created.slug).toBe('cardiology-soap');
    expect(created.status).toBe('DRAFT');
    expect(created.isActive).toBe(false);
    // Every server-owned publish artifact stays unset — a compiledConfig
    // carrying the SOURCE's template ids would be worse than none.
    expect(created.compiledConfig).toBeUndefined();
    expect(created.publishedAt).toBeUndefined();
  });

  it('continues the TARGET’s own version lineage rather than copying the source number', async () => {
    mockDefinitionRepository.findAllVersionsBySlug.mockResolvedValue([
      sourceDefinition({ id: 't1', tenantId: TO, versionNumber: 1 }),
      sourceDefinition({ id: 't2', tenantId: TO, versionNumber: 2 }),
    ]);

    await buildService().promote(REQUEST);

    const created = mockDefinitionRepository.create.mock.calls[0]![0] as Record<string, unknown>;
    // Source was version 3; the target's lineage was at 2.
    expect(created.versionNumber).toBe(3);
    expect(created.parentVersionId).toBeNull();
  });

  it('deep-copies a tenant-owned prompt template and rewrites the node binding', async () => {
    await buildService().promote(REQUEST);

    expect(mockPromptTemplateRepository.create).toHaveBeenCalledTimes(1);
    const copiedTemplate = mockPromptTemplateRepository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(copiedTemplate.tenantId).toBe(TO);
    // APPROVED, not DRAFT: promotion moves a configuration that was already
    // governed in the source; a DRAFT copy would fall through the resolver.
    expect(copiedTemplate.status).toBe('APPROVED');

    const graphNode = promotedGraph().nodes[0]!;
    expect(graphNode.config.promptTemplateId).toBe(copiedTemplate.id);
    expect(graphNode.config.promptTemplateId).not.toBe('src-tpl');
    // The source pin numbers a version of a template that does not exist here;
    // the copy starts at v1, so the node follows it.
    expect(graphNode.config.promptVersionNumber).toBeUndefined();
  });

  it('does NOT copy a SYSTEM-owned template — it is readable cross-tenant', async () => {
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'src-tpl', tenantId: SYSTEM, content: 'BODY', variables: null, tags: [] });

    await buildService().promote(REQUEST);

    expect(mockPromptTemplateRepository.create).not.toHaveBeenCalled();
    const graphNode = promotedGraph().nodes[0]!;
    expect(graphNode.config.promptTemplateId).toBe('src-tpl');
    // The pin survives: it numbers a version of a template that still exists.
    expect(graphNode.config.promptVersionNumber).toBe(4);
  });

  it('copies a template shared by two nodes ONCE, and points both at the same target row', async () => {
    // Copying it twice would silently fork one prompt into two the target has
    // to maintain apart.
    mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      sourceDefinition({
        graph: sourceGraph([
          node('a', { taskKey: 'text.finalize', promptTemplateId: 'src-tpl' }),
          node('b', { taskKey: 'text.live', promptTemplateId: 'src-tpl' }),
        ]),
      }),
    );

    await buildService().promote(REQUEST);

    expect(mockPromptTemplateRepository.create).toHaveBeenCalledTimes(1);
    const nodes = promotedGraph().nodes;
    expect(nodes[0]!.config.promptTemplateId).toBe(nodes[1]!.config.promptTemplateId);
  });

  it('never mutates the SOURCE definition’s own graph', async () => {
    const source = sourceDefinition();
    mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(source);

    await buildService().promote(REQUEST);

    expect((source.graph as { nodes: { config: Record<string, unknown> }[] }).nodes[0]!.config.promptTemplateId).toBe('src-tpl');
  });

  // =======================================================================
  // No corpus crosses a tenant boundary
  // =======================================================================

  it('STRIPS every evalGate from the promoted graph — not even the goldenSet POINTER travels', async () => {
    mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      sourceDefinition({
        graph: sourceGraph([
          node('note_writer', {
            taskKey: 'text.finalize',
            promptTemplateId: 'src-tpl',
            evalGate: { goldenSetId: 'source-golden-set', enabled: true },
          }),
        ]),
      }),
    );

    await buildService().promote(REQUEST);

    const created = mockDefinitionRepository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(promotedGraph().nodes[0]!.config.evalGate).toBeUndefined();
    expect(JSON.stringify(created.graph)).not.toContain('source-golden-set');
  });

  it('runs the eval at the TARGET, against a golden set the caller named in the TARGET', async () => {
    await buildService().promote({ ...REQUEST, targetGoldenSetId: 'target-golden-set' });

    expect(mockEvalRunService.runGoldenSet).toHaveBeenCalledWith(
      expect.objectContaining({ goldenSetId: 'target-golden-set', tenantId: TO, triggerType: 'PROMOTION' }),
    );
  });

  it('records a warning, not a failure, when no target golden set was named', async () => {
    const result = await buildService().promote(REQUEST);

    expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
    expect(result.warnings.join(' ')).toMatch(/no target golden set was named/i);
  });

  it('never loses a promotion to an eval failure', async () => {
    mockEvalRunService.runGoldenSet.mockRejectedValue(new Error('eval backend down'));

    const result = await buildService().promote({ ...REQUEST, targetGoldenSetId: 'target-golden-set' });

    expect(result.id).toBe('promotion-1');
    expect(result.warnings.join(' ')).toMatch(/could not be completed/i);
  });

  // =======================================================================
  // Gates and alerts
  // =======================================================================

  it('BLOCKS when a node binds a document template that is not SYSTEM-owned', async () => {
    mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      sourceDefinition({
        graph: sourceGraph([node('note_writer', { taskKey: 'text.finalize', promptTemplateId: 'src-tpl', documentTemplateId: 'tenant-doc-tpl' })]),
      }),
    );
    mockDocumentTemplateRepository.findById.mockResolvedValue({ id: 'tenant-doc-tpl', tenantId: FROM });

    await expect(buildService().promote(REQUEST)).rejects.toThrow(/document template/i);
    expect(mockDefinitionRepository.create).not.toHaveBeenCalled();
  });

  it('allows a SYSTEM-owned document template through', async () => {
    mockDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      sourceDefinition({
        graph: sourceGraph([node('note_writer', { taskKey: 'text.finalize', promptTemplateId: 'src-tpl', documentTemplateId: 'system-doc-tpl' })]),
      }),
    );
    mockDocumentTemplateRepository.findById.mockResolvedValue({ id: 'system-doc-tpl', tenantId: SYSTEM });

    await expect(buildService().promote(REQUEST)).resolves.toBeDefined();
  });

  it('alerts on live consultations when the target already has a version of this workflow', async () => {
    mockConsultationRepository.count.mockResolvedValue(2);
    mockDefinitionRepository.findAllVersionsBySlug.mockResolvedValue([sourceDefinition({ id: 't1', tenantId: TO, versionNumber: 1 })]);

    const result = await buildService().promote(REQUEST);
    expect(result.warnings).toContain(liveConsultationsWarning(2));
  });

  it('does NOT alert on a FIRST promotion — there is nothing to "complete on"', async () => {
    mockConsultationRepository.count.mockResolvedValue(2);
    mockDefinitionRepository.findAllVersionsBySlug.mockResolvedValue([]);

    const result = await buildService().promote(REQUEST);
    expect(result.warnings).not.toContain(liveConsultationsWarning(2));
  });

  // =======================================================================
  // Atomicity
  // =======================================================================

  it('writes every target-tenant row inside ONE transaction, threading tx explicitly', async () => {
    await buildService().promote(REQUEST);

    expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    // A repository caches its database context at construction, so CLS
    // propagation inside `runInTransaction` would NOT reach these singletons —
    // passing `tx` is what actually enrols each write.
    for (const repo of [mockPromptTemplateRepository, mockPromptVersionRepository, mockDefinitionRepository, mockPromotionRepository]) {
      expect(repo.create).toHaveBeenCalledWith(expect.anything(), { TX: true });
    }
  });

  it('announces the sys-event only AFTER the commit', async () => {
    const order: string[] = [];
    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const out = await work({ TX: true });
      order.push('commit');
      return out;
    });
    mockEventEmitter.emit.mockImplementation(() => {
      order.push('event');
      return true;
    });

    await buildService().promote(REQUEST);

    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('event'));
  });

  it('rolls the whole promotion back when the audit record cannot be written', async () => {
    mockUnitOfWork.runInTransaction.mockRejectedValue(new Error('rolled back'));

    await expect(buildService().promote(REQUEST)).rejects.toThrow('rolled back');
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });
});

describe('AgentPromotionService reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TO : { id: 'user-1' }));
  });

  it('404s a cross-tenant promotion id rather than 403ing it', async () => {
    mockPromotionRepository.findById.mockResolvedValue({ id: 'p-1', tenantId: 'someone-else' });
    await expect(buildService().getById('p-1')).rejects.toThrow(NotFoundException);
  });

  it('reports drift when the target definition’s graph no longer matches what was promoted', async () => {
    mockPromotionRepository.findById.mockResolvedValue({
      id: 'p-1',
      tenantId: TO,
      toTenantId: TO,
      fromTenantId: FROM,
      agentVersionId: 'source-definition-v3',
      sourceAgentId: 'cardiology-soap',
      targetAgentId: 'cardiology-soap',
      targetAgentVersionId: 'target-definition-v1',
      configSnapshot: {},
      checksum: 'checksum-at-promotion-time',
      warnings: [],
      createdAt: new Date(),
      version: 1,
    });
    mockDefinitionRepository.findById.mockResolvedValue({
      id: 'target-definition-v1',
      tenantId: TO,
      graph: sourceGraph([node('edited', { taskKey: 'text.finalize', promptTemplateId: 'edited-tpl' })]),
    });

    const result = await buildService().getById('p-1');
    expect(result.drifted).toBe(true);
  });
});
