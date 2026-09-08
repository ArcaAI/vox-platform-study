/**
 * `WorkflowDefinitionService.clone` / `.listTemplates`.
 *
 * A CLONE is a NEW workflow (new `(tenantId, slug)` lineage, `versionNumber` 1, DRAFT) seeded
 * from an existing definition's graph. It is categorically NOT a new VERSION — `create` with
 * `parentVersionId` is that, and it stays inside the SAME slug. The tests below lock that
 * distinction down from both ends: the clone must land in a slug the tenant does not already
 * use (T-5), and it must never carry the source's publish artifacts (T-2).
 *
 * Mirrors the `workflow-definition.service.test.ts` harness exactly (same repository /
 * EventEmitter2 / ClsService / database-service / entitlements mocks) — this file adds only the
 * two clone-specific repository seams.
 *
 * Written RED-first: every test in this file failed against `80988d35a`, where
 * `service.clone` / `service.listTemplates` / `repository.findCloneSource` /
 * `repository.findSystemTemplates` did not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SysEventType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockWorkflowDefinitionRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
  // seams.
  findCloneSource: vi.fn(),
  findSystemTemplates: vi.fn(),
};

const BASE_CLIENT = { __unscoped: true };

const mockDatabaseService = {
  baseClient: {
    ...BASE_CLIENT,
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
};

const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};

/** A graph the shape gate and `compile()` both accept. */
/** TASK-893 — the only vocabulary left is `core`; `noop` and the `summarization` palette are gone. */
const VALID_GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
};

/** A graph whose generation node pins a PROMPT TEMPLATE by row id — the binding class that
 *  cannot survive a SYSTEM -> tenant copy (D-2), because `PromptTemplate` is not a
 *  SYSTEM-shared read and reaches a tenant as a per-tenant clone with a DIFFERENT id. */
const PROMPT_BOUND_GRAPH = {
  version: 1,
  nodes: [{ id: 'n_gen', type: 'noop', config: { promptTemplateId: 'tpl-system-1', promptVersionNumber: 3 } }],
  edges: [],
};

/** Missing `edges` — `workflowGraphProblems` short-circuits before any rule or compile runs. */
const SHAPE_BROKEN_GRAPH = { version: 1, nodes: [] } as unknown as Record<string, unknown>;

const createMockEntity = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'def-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  slug: overrides.slug ?? 'discharge_summary',
  name: overrides.name ?? 'Discharge Summary',
  description: overrides.description ?? null,
  paletteKey: overrides.paletteKey ?? 'core',
  versionNumber: overrides.versionNumber ?? 1,
  parentVersionId: overrides.parentVersionId ?? null,
  status: overrides.status ?? WorkflowDefinitionStatus.DRAFT,
  graph: overrides.graph ?? VALID_GRAPH,
  graphChecksum: overrides.graphChecksum ?? 'checksum-1',
  compiledConfig: overrides.compiledConfig ?? null,
  compiledConfigChecksum: overrides.compiledConfigChecksum ?? null,
  registryChecksum: overrides.registryChecksum ?? null,
  validationReport: overrides.validationReport ?? null,
  needsReview: overrides.needsReview ?? false,
  validatedAt: overrides.validatedAt ?? null,
  publishedAt: overrides.publishedAt ?? null,
  deprecatedAt: overrides.deprecatedAt ?? null,
  isActive: overrides.isActive ?? false,
  resourceStatus: overrides.resourceStatus ?? 'ENABLED',
  createdAt: overrides.createdAt ?? new Date('2026-09-02T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-09-02T00:00:00Z'),
  version: overrides.version ?? 1,
  tags: overrides.tags ?? [],
  hasChanges: overrides.hasChanges ?? false,
  changes: overrides.changes ?? {},
});

/** A PUBLISHED SYSTEM-tenant row — the platform template library (`seed/21-workflow-definition.ts`). */
const systemTemplate = (overrides: Record<string, unknown> = {}) =>
  createMockEntity({
    id: 'sys-template-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'platform_default_summarization',
    name: 'Platform Default — Summarization',
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    compiledConfig: { formatVersion: 1 },
    compiledConfigChecksum: 'compiled-checksum',
    registryChecksum: 'registry-checksum',
    publishedAt: new Date('2026-08-16T00:00:00Z'),
    validatedAt: new Date('2026-08-16T00:00:00Z'),
    tags: ['platform-default', 'core'],
    ...overrides,
  });

describe('WorkflowDefinitionService — cloning ', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({}));
    // A brand-new slug: no existing version for the target lineage.
    mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    service = new WorkflowDefinitionService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockWorkflowDefinitionRepository as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockEventEmitter as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClsService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockDatabaseService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockEntitlements as any,
    );
  });

  describe('clone', () => {
    // T-1
    it('clones an own-tenant definition into a NEW lineage: DRAFT, versionNumber 1, inactive, graph copied', async () => {
      const source = createMockEntity({ id: 'src-1', slug: 'discharge_summary', name: 'Discharge Summary', graph: VALID_GRAPH });
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(source);
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      const result = await service.clone('src-1', { targetSlug: 'discharge_summary_v2', name: 'Discharge Summary (variant)' });

      // The source lookup is tenant-pinned and runs on the UNSCOPED client (the SYSTEM lane).
      expect(mockWorkflowDefinitionRepository.findCloneSource).toHaveBeenCalledWith('src-1', 'tenant-1', mockDatabaseService.baseClient);

      expect(mockWorkflowDefinitionRepository.create).toHaveBeenCalledTimes(1);
      const created = mockWorkflowDefinitionRepository.create.mock.calls[0][0];
      expect(created.tenantId).toBe('tenant-1');
      expect(created.slug).toBe('discharge_summary_v2');
      expect(created.name).toBe('Discharge Summary (variant)');
      expect(created.versionNumber).toBe(1);
      expect(created.status).toBe(WorkflowDefinitionStatus.DRAFT);
      expect(created.isActive).toBe(false);
      // A clone is a new lineage, never a branch inside the source's slug.
      expect(created.parentVersionId).toBeNull();
      expect(created.graph).toEqual(VALID_GRAPH);
      expect(created.paletteKey).toBe('core');

      expect(result.slug).toBe('discharge_summary_v2');
    });

    // T-1 (event half)
    it('broadcasts ResourceCreated carrying the source id as provenance', async () => {
      const source = createMockEntity({ id: 'src-1' });
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(source);
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      await service.clone('src-1', { targetSlug: 'discharge_summary_v2' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ data: expect.objectContaining({ clonedFromId: 'src-1', clonedFromSystemTemplate: false }) }),
      );
    });

    // T-1 (name default)
    it('defaults the clone name to "<source name> (copy)" when the caller supplies none', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(createMockEntity({ name: 'Discharge Summary' }));
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      await service.clone('src-1', { targetSlug: 'discharge_summary_v2' });

      expect(mockWorkflowDefinitionRepository.create.mock.calls[0][0].name).toBe('Discharge Summary (copy)');
    });

    // T-2
    it('drops every publish artifact and tag from the source — a clone has been reviewed by nobody', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(systemTemplate());
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      await service.clone('sys-template-1', { targetSlug: 'my_summary' });

      const created = mockWorkflowDefinitionRepository.create.mock.calls[0][0];
      expect(created.compiledConfig).toBeNull();
      expect(created.compiledConfigChecksum).toBeNull();
      expect(created.registryChecksum).toBeNull();
      expect(created.publishedAt).toBeNull();
      expect(created.deprecatedAt).toBeNull();
      expect(created.needsReview).toBe(false);
      expect(created.tags).toEqual([]);
      // The report is recomputed for THIS tenant, never copied from the source row.
      expect(created.validationReport).not.toBeNull();
      expect(created.validatedAt).toBeInstanceOf(Date);
    });

    // T-3
    it('clones a SYSTEM PUBLISHED template into the CALLER tenant, not the source tenant', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(systemTemplate());
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      await service.clone('sys-template-1', { targetSlug: 'my_summary' });

      const created = mockWorkflowDefinitionRepository.create.mock.calls[0][0];
      expect(created.tenantId).toBe('tenant-1');
      expect(created.tenantId).not.toBe(SYSTEM_TENANT_ID);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ data: expect.objectContaining({ clonedFromSystemTemplate: true }) }),
      );
    });

    // T-4
    it('404s an id the tenant-pinned lookup does not resolve (a foreign tenant is indistinguishable from a miss)', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(null);

      await expect(service.clone('other-tenant-def', { targetSlug: 'stolen' })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    // T-5
    it('409s a target slug the tenant already uses — a clone must never become version N+1 of a live lineage', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(createMockEntity());
      mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(3);

      await expect(service.clone('src-1', { targetSlug: 'discharge_summary' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    // T-6
    it('enforces the maxWorkflowDefinitions quota when enforcement is on, and skips the count when it is off', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(createMockEntity());
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      await service.clone('src-1', { targetSlug: 'copy_a' });
      expect(mockEntitlements.assertQuantityQuota).not.toHaveBeenCalled();
      expect(mockWorkflowDefinitionRepository.count).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({}));
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(createMockEntity());
      mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
      mockWorkflowDefinitionRepository.count.mockResolvedValue(5);
      mockEntitlements.assertQuantityQuota.mockRejectedValue(new Error('QuotaExceeded'));

      await expect(service.clone('src-1', { targetSlug: 'copy_b' })).rejects.toThrow('QuotaExceeded');
      expect(mockEntitlements.assertQuantityQuota).toHaveBeenCalledWith('tenant-1', 'maxWorkflowDefinitions', 5);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    // T-7
    it('refuses (400) a SYSTEM template whose graph pins a prompt template by row id, naming the node', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(systemTemplate({ graph: PROMPT_BOUND_GRAPH }));

      await expect(service.clone('sys-template-1', { targetSlug: 'my_summary' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.clone('sys-template-1', { targetSlug: 'my_summary' })).rejects.toThrow(/n_gen/);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    // T-7 (the other half — the same graph from the tenant's OWN row is fine)
    it('allows the same prompt-bound graph when the source is the tenant’s own row', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(createMockEntity({ graph: PROMPT_BOUND_GRAPH }));
      mockWorkflowDefinitionRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));

      await expect(service.clone('src-1', { targetSlug: 'my_variant' })).resolves.toBeDefined();
      expect(mockWorkflowDefinitionRepository.create.mock.calls[0][0].graph).toEqual(PROMPT_BOUND_GRAPH);
    });

    // T-8
    it('rejects (400) a source graph that fails the shape gate, before writing anything', async () => {
      mockWorkflowDefinitionRepository.findCloneSource.mockResolvedValue(createMockEntity({ graph: SHAPE_BROKEN_GRAPH }));

      await expect(service.clone('src-1', { targetSlug: 'broken_copy' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('listTemplates', () => {
    // T-9
    it('reads the SYSTEM template library through the unscoped client and maps it to responses', async () => {
      mockWorkflowDefinitionRepository.findSystemTemplates.mockResolvedValue([systemTemplate()]);

      const result = await service.listTemplates();

      expect(mockWorkflowDefinitionRepository.findSystemTemplates).toHaveBeenCalledWith(mockDatabaseService.baseClient);
      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe(SYSTEM_TENANT_ID);
      expect(result[0].status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    });
  });
});
