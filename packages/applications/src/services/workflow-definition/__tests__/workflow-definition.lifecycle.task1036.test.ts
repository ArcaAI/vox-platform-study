/**
 * TASK-1036 lane A3 — workflow lifecycle fixes (R18, §3.4, owner directive W1).
 *
 *  1. `create` on a slug that already has rows, without `parentVersionId`  -> 409 WORKFLOW_SLUG_TAKEN
 *  2. `createDraft` (edit-as-new-draft) — server-side copy of a PUBLISHED / DEPRECATED version
 *  3. `update` resets to DRAFT on ANY change and records the publish gate in the report
 *  4. `clone` and `importDefinition` record the publish gate in the report
 *  5. `activate` demotes + sets in ONE transaction
 *  6. W1 — an empty create graph is seeded with `core.trigger` + `core.output`
 *
 * Harness mirrors `workflow-definition.service.test.ts` (same mocks, same positional constructor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SysEventType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { workflowGraphProblems } from '@arcaai/workflow-contract';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import { seedBoundaryNodes } from '../workflow-boundary-seed';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
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
  findCloneSource: vi.fn(),
};
const TX = { __tx: true };
const mockDatabaseService = {
  baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(TX)) },
};
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};

const VALID_GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', fromPort: 'out', to: 'a1', toPort: 'context' },
    { id: 'e2', from: 'a1', fromPort: 'out', to: 'o1', toPort: 'in' },
  ],
};

/** Shape-valid and compilable, but `core.agent` names no agent -> publish-gate ERROR AGENT_REF_MISSING. */
const AGENT_REF_MISSING_GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: {}, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', fromPort: 'out', to: 'a1', toPort: 'context' },
    { id: 'e2', from: 'a1', fromPort: 'out', to: 'o1', toPort: 'in' },
  ],
};

const EMPTY_GRAPH = { version: 1, nodes: [], edges: [] };

const mockEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: 'desc',
  paletteKey: 'core',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: VALID_GRAPH,
  graphChecksum: 'checksum-1',
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
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
  ...overrides,
});

const reportOf = (entityLike: { validationReport?: unknown }) =>
  entityLike.validationReport as unknown as { ok: boolean; findings: Array<{ code?: string }> };

describe('WorkflowDefinitionService — lifecycle fixes (TASK-1036 A3)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(TX));
    mockRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockRepository.findAllVersionsBySlug.mockResolvedValue([]);
    mockRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));
    mockRepository.update.mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity));
    mockRepository.updateWithVersion.mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity));
    mockRepository.findPublishedBySlug.mockResolvedValue(null);
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    service = new WorkflowDefinitionService(
      mockRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      mockEntitlements as never,
    );
  });

  // ------------------------------------------------------------------------------------------
  describe('create — slug collision', () => {
    it('refuses (409 WORKFLOW_SLUG_TAKEN) a create without parentVersionId on a slug that already has rows', async () => {
      mockRepository.findMaxVersionNumber.mockResolvedValue(2);

      const error = await service.create({ slug: 'discharge_summary', name: 'x', paletteKey: 'core', graph: VALID_GRAPH }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(((error as ConflictException).getResponse() as { code?: string }).code).toBe('WORKFLOW_SLUG_TAKEN');
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('still mints max+1 when parentVersionId names a row of the same slug', async () => {
      mockRepository.findMaxVersionNumber.mockResolvedValue(2);
      mockRepository.findById.mockResolvedValue(mockEntity({ id: 'parent-1' }));

      await service.create({ slug: 'discharge_summary', name: 'x', paletteKey: 'core', graph: VALID_GRAPH, parentVersionId: 'parent-1' });

      expect(mockRepository.create.mock.calls[0][0].versionNumber).toBe(3);
    });

    it('creates version 1 of a brand-new slug', async () => {
      await service.create({ slug: 'fresh', name: 'x', paletteKey: 'core', graph: VALID_GRAPH });
      expect(mockRepository.create.mock.calls[0][0].versionNumber).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('create — records the publish gate (existing behaviour, pinned)', () => {
    it('stores AGENT_REF_MISSING on the report', async () => {
      await service.create({ slug: 'fresh', name: 'x', paletteKey: 'core', graph: AGENT_REF_MISSING_GRAPH });
      const report = reportOf(mockRepository.create.mock.calls[0][0]);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === 'AGENT_REF_MISSING')).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('createDraft — edit as new draft', () => {
    beforeEach(() => {
      mockRepository.findById.mockResolvedValue(mockEntity({ id: 'pub-1', versionNumber: 2 }));
      mockRepository.findMaxVersionNumber.mockResolvedValue(2);
      mockRepository.findAllVersionsBySlug.mockResolvedValue([
        mockEntity({ id: 'pub-1', versionNumber: 2 }),
        mockEntity({ id: 'old-1', versionNumber: 1, status: WorkflowDefinitionStatus.DEPRECATED }),
      ]);
    });

    it('copies the graph server-side into a new DRAFT of the same slug with parentVersionId and versionNumber = max + 1', async () => {
      const result = await service.createDraft('pub-1');

      expect(mockRepository.findMaxVersionNumber).toHaveBeenCalledWith('tenant-1', 'discharge_summary', TX);
      const created = mockRepository.create.mock.calls[0][0];
      expect(created.tenantId).toBe('tenant-1');
      expect(created.slug).toBe('discharge_summary');
      expect(created.name).toBe('Discharge Summary');
      expect(created.paletteKey).toBe('core');
      expect(created.parentVersionId).toBe('pub-1');
      expect(created.versionNumber).toBe(3);
      expect(created.status).toBe(WorkflowDefinitionStatus.DRAFT);
      expect(created.isActive).toBe(false);
      expect(created.graph).toEqual(VALID_GRAPH);
      expect(created.compiledConfig).toBeNull();
      expect(result.versionNumber).toBe(3);
    });

    it('records the publish gate on the new draft report', async () => {
      mockRepository.findById.mockResolvedValue(mockEntity({ id: 'pub-1', graph: AGENT_REF_MISSING_GRAPH }));
      await service.createDraft('pub-1');
      const report = reportOf(mockRepository.create.mock.calls[0][0]);
      expect(report.findings.some((f) => f.code === 'AGENT_REF_MISSING')).toBe(true);
    });

    it('accepts a DEPRECATED source', async () => {
      mockRepository.findById.mockResolvedValue(mockEntity({ id: 'dep-1', status: WorkflowDefinitionStatus.DEPRECATED }));
      await service.createDraft('dep-1');
      expect(mockRepository.create.mock.calls[0][0].parentVersionId).toBe('dep-1');
    });

    it.each([WorkflowDefinitionStatus.DRAFT, WorkflowDefinitionStatus.VALIDATED])('refuses (400) a %s source', async (status) => {
      mockRepository.findById.mockResolvedValue(mockEntity({ status }));
      await expect(service.createDraft('pub-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it.each([WorkflowDefinitionStatus.DRAFT, WorkflowDefinitionStatus.VALIDATED])(
      'refuses (409 OPEN_DRAFT_EXISTS, carrying draftId) when the lineage already has an open %s row',
      async (status) => {
        mockRepository.findAllVersionsBySlug.mockResolvedValue([
          mockEntity({ id: 'open-9', versionNumber: 3, status }),
          mockEntity({ id: 'pub-1', versionNumber: 2 }),
        ]);

        const error = await service.createDraft('pub-1').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        const body = (error as ConflictException).getResponse() as { code?: string; draftId?: string };
        expect(body.code).toBe('OPEN_DRAFT_EXISTS');
        expect(body.draftId).toBe('open-9');
        expect(mockRepository.create).not.toHaveBeenCalled();
      },
    );

    it('answers 404 for another tenant id and writes nothing', async () => {
      mockRepository.findById.mockResolvedValue(mockEntity({ tenantId: 'tenant-OTHER' }));
      await expect(service.createDraft('pub-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('applies the maxWorkflowDefinitions quota like create', async () => {
      mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
      mockRepository.count.mockResolvedValue(9);
      mockEntitlements.assertQuantityQuota.mockRejectedValue(new Error('QuotaExceeded'));

      await expect(service.createDraft('pub-1')).rejects.toBeDefined();
      expect(mockEntitlements.assertQuantityQuota).toHaveBeenCalledWith('tenant-1', 'maxWorkflowDefinitions', 9);
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('broadcasts ResourceCreated naming the version it was drafted from', async () => {
      await service.createDraft('pub-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ data: expect.objectContaining({ slug: 'discharge_summary', draftFromId: 'pub-1', versionNumber: 3 }) }),
      );
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('update — status and report', () => {
    /** Mirrors the BaseEntity setter: writing a tracked field marks the entity dirty. */
    const trackWrites = (entity: Record<string, unknown>, fields: string[]) => {
      for (const field of fields) {
        let value = entity[field];
        Object.defineProperty(entity, field, {
          get: () => value,
          set: (next) => {
            value = next;
            entity.hasChanges = true;
          },
          configurable: true,
        });
      }
    };

    it('resets a VALIDATED row to DRAFT on a metadata-only change', async () => {
      const entity = mockEntity({ status: WorkflowDefinitionStatus.VALIDATED });
      trackWrites(entity, ['name']);
      mockRepository.findById.mockResolvedValue(entity);

      await service.update('def-1', { name: 'Renamed', expectedVersion: 1 });

      expect(entity.status).toBe(WorkflowDefinitionStatus.DRAFT);
    });

    it('leaves status alone when nothing changed (still the empty-patch 400)', async () => {
      const entity = mockEntity({ status: WorkflowDefinitionStatus.VALIDATED });
      mockRepository.findById.mockResolvedValue(entity);

      await expect(service.update('def-1', { expectedVersion: 1 })).rejects.toBeDefined();
      expect(entity.status).toBe(WorkflowDefinitionStatus.VALIDATED);
    });

    it('records the publish gate on the stored report when the graph is saved', async () => {
      const entity = mockEntity({ status: WorkflowDefinitionStatus.DRAFT });
      trackWrites(entity, ['graph']);
      mockRepository.findById.mockResolvedValue(entity);

      await service.update('def-1', { graph: AGENT_REF_MISSING_GRAPH, expectedVersion: 1 } as never);

      const report = reportOf(entity);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === 'AGENT_REF_MISSING')).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('clone and import — record the publish gate', () => {
    it('clone stores AGENT_REF_MISSING on the new draft report', async () => {
      mockRepository.findCloneSource.mockResolvedValue(mockEntity({ graph: AGENT_REF_MISSING_GRAPH }));

      await service.clone('def-1', { targetSlug: 'copy_slug' });

      const report = reportOf(mockRepository.create.mock.calls[0][0]);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === 'AGENT_REF_MISSING')).toBe(true);
    });

    it('import stores AGENT_REF_MISSING on the new draft report', async () => {
      await service.importDefinition({
        targetSlug: 'imported_slug',
        bundle: {
          kind: 'workflow',
          schemaVersion: 1,
          exportedAt: '2026-10-04T00:00:00.000Z',
          source: { tenantKind: 'tenant', slug: 'discharge_summary', version: 1 },
          payload: { name: 'Imported', description: null, paletteKey: 'core', graph: AGENT_REF_MISSING_GRAPH, references: [] },
        },
      } as never);

      const report = reportOf(mockRepository.create.mock.calls[0][0]);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === 'AGENT_REF_MISSING')).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('activate — one transaction', () => {
    it('demotes the current active version and activates the target inside ONE $transaction, both writes on the tx client', async () => {
      const target = mockEntity({ id: 'v2', versionNumber: 2, status: WorkflowDefinitionStatus.PUBLISHED });
      const current = mockEntity({ id: 'v1', versionNumber: 1, status: WorkflowDefinitionStatus.PUBLISHED, isActive: true });
      mockRepository.findById.mockResolvedValue(target);
      mockRepository.findPublishedBySlug.mockResolvedValue(current);

      await service.activate('v2');

      expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
      expect(mockRepository.update).toHaveBeenCalledTimes(2);
      for (const call of mockRepository.update.mock.calls) expect(call[2]).toBe(TX);
      expect(current.isActive).toBe(false);
      expect(target.isActive).toBe(true);
    });

    it('performs no write outside the transaction when it rolls back', async () => {
      const target = mockEntity({ id: 'v2', versionNumber: 2 });
      mockRepository.findById.mockResolvedValue(target);
      mockDatabaseService.baseClient.$transaction.mockRejectedValue(new Error('tx failed'));

      await expect(service.activate('v2')).rejects.toThrow('tx failed');
      expect(mockRepository.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('W1 — boundary nodes are seeded', () => {
    it('seeds core.trigger + core.output (connected) on an empty graph, and the result is shape-valid', () => {
      const seeded = seedBoundaryNodes(EMPTY_GRAPH as never);
      expect(seeded.nodes.map((n) => n.type).sort()).toEqual(['core.output', 'core.trigger']);
      expect(seeded.edges).toHaveLength(1);
      expect(workflowGraphProblems(seeded)).toEqual([]);
    });

    it('leaves a non-empty graph untouched', () => {
      expect(seedBoundaryNodes(VALID_GRAPH as never)).toBe(VALID_GRAPH);
    });

    it('create seeds an empty graph, stores it, and does not reject', async () => {
      await service.create({ slug: 'blank', name: 'Blank', paletteKey: 'core', graph: EMPTY_GRAPH });

      const created = mockRepository.create.mock.calls[0][0];
      const types = (created.graph as { nodes: Array<{ type: string }> }).nodes.map((n) => n.type).sort();
      expect(types).toEqual(['core.output', 'core.trigger']);
      expect(created.status).toBe(WorkflowDefinitionStatus.DRAFT);
    });
  });
});
