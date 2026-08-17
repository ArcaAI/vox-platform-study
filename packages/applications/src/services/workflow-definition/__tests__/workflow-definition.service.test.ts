/**
 * WorkflowDefinitionService unit tests (TASK-734).
 *
 * Mirrors the WorkflowTestFixtureService/DepartmentService test convention: mock the
 * repository, EventEmitter2, ClsService, the database service (for the version-mint
 * transaction), and IEntitlementsService; assert factory usage on create,
 * `broadcastSysEvent` on every mutation, 404-over-403 cross-tenant behavior, and — the part
 * unique to this service — that `@arcaai/workflow-contract`'s `compile()`/`validate()` are
 * genuinely wired: a broken graph is rejected, a clean one is compiled and published, and the
 * DRAFT rule catalogue's findings never block a write (decision #3).
 *
 * HONESTY NOTE (see the ticket README §7): this file was authored AFTER
 * `workflow-definition.service.ts`, not strictly RED-first — designing the compile/validate
 * wiring and its tests in the same pass made a true red-first split impractical within this
 * session. The domain-layer half of Task 1 (`WorkflowDefinitionRepository.test.ts`,
 * `WorkflowDefinitionEntity.test.ts`) WAS proven RED before its implementation, in an earlier
 * pass — see the ticket README §7 for that evidence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException, QuotaExceededException } from '@arcaai/exceptions';
import { SysEventType, WorkflowDefinitionStatus } from '@arcaai/domains';
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
};

const mockDatabaseService = {
  baseClient: {
    // The version-mint transaction (create()) just needs to invoke the callback with a
    // stand-in tx object — the repository mock ignores it.
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
};

const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  // Default: allowed — matches the real service's `!isEnforcementEnabled() -> true` posture
  // (TASK-724 Task 7) so every pre-existing test above, which never mocks this, keeps passing.
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};

// TASK-724 Task 4 — `SttPipelineCompilerService` is mocked at the seam; its OWN real behavior
// (YAML emission, PipelineService create/update wiring) is covered by
// `compilers/__tests__/stt-pipeline.compiler.test.ts`. Here we only assert that `publish()`
// calls it for the `stt` palette, threads its result into the sys-event, and propagates its
// failures as a publish-blocking abort.
const mockSttPipelineCompiler = {
  compileAndPublish: vi.fn(),
};

const STT_GRAPH = {
  version: 1,
  nodes: [
    { id: 'n_audio', type: 'stt.audioInput', config: { mode: 'realtime' } },
    { id: 'n_asr', type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
    { id: 'n_out', type: 'stt.transcriptOutput', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'n_audio', fromPort: 'out', to: 'n_asr', toPort: 'in' },
    { id: 'e2', from: 'n_asr', fromPort: 'out', to: 'n_out', toPort: 'in' },
  ],
};

const VALID_GRAPH = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };
const CYCLIC_GRAPH = {
  version: 1,
  nodes: [
    { id: 'n1', type: 'noop', config: {} },
    { id: 'n2', type: 'noop', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' },
    { id: 'e2', from: 'n2', fromPort: 'out', to: 'n1', toPort: 'in' },
  ],
};
const UNREGISTERED_NODE_GRAPH = { version: 1, nodes: [{ id: 'n1', type: 'summarization.generate', config: {} }], edges: [] };

const createMockEntity = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'def-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  slug: overrides.slug ?? 'discharge_summary',
  name: overrides.name ?? 'Discharge Summary',
  description: overrides.description ?? null,
  paletteKey: overrides.paletteKey ?? 'summarization',
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
  createdAt: overrides.createdAt ?? new Date('2026-08-16T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-08-16T00:00:00Z'),
  version: overrides.version ?? 1,
  tags: overrides.tags ?? [],
  hasChanges: overrides.hasChanges ?? false,
  changes: overrides.changes ?? {},
});

describe('WorkflowDefinitionService', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    // `vi.clearAllMocks()` resets call history but NOT a previously-set `mockResolvedValue` — a
    // test elsewhere in this file that flips this to `false` would otherwise leak into every
    // later test, since this file's tests share these module-scope mocks. Re-pin the default
    // ("allowed", matching `!isEnforcementEnabled() -> true`) every test.
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({}));
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    // Default resolved value so every pre-existing `paletteKey: 'stt'` test above (none of
    // which asserted on the compiler) keeps passing without threading a bespoke pipeline
    // fixture through — the dedicated describe block below overrides/asserts on the mock.
    mockSttPipelineCompiler.compileAndPublish.mockResolvedValue({ id: 'pipe-1', slug: 'wf-stt-discharge-summary', version: 1 });
    service = new WorkflowDefinitionService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockWorkflowDefinitionRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockDatabaseService as any,
      mockEntitlements as any,
      mockSttPipelineCompiler as any,
    );
  });

  describe('create', () => {
    it('mints versionNumber = max + 1 inside the transaction, creates via the factory, and broadcasts ResourceCreated', async () => {
      mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(2);
      const saved = createMockEntity({ versionNumber: 3 });
      mockWorkflowDefinitionRepository.create.mockResolvedValue(saved);

      const result = await service.create({
        slug: 'discharge_summary',
        name: 'Discharge Summary',
        paletteKey: 'summarization',
        graph: VALID_GRAPH,
      });

      expect(mockWorkflowDefinitionRepository.findMaxVersionNumber).toHaveBeenCalledWith('tenant-1', 'discharge_summary', {});
      expect(mockWorkflowDefinitionRepository.create).toHaveBeenCalledTimes(1);
      const createdEntityArg = mockWorkflowDefinitionRepository.create.mock.calls[0][0];
      expect(createdEntityArg.tenantId).toBe('tenant-1');
      expect(createdEntityArg.versionNumber).toBe(3);
      expect(createdEntityArg.status).toBe(WorkflowDefinitionStatus.DRAFT);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: saved.id }));
      expect(result.versionNumber).toBe(3);
    });

    it('rejects (400) a graph with a structural shape problem — the engine gate — before writing anything', async () => {
      await expect(
        service.create({
          slug: 'discharge_summary',
          name: 'Discharge Summary',
          paletteKey: 'summarization',
          // Missing `edges` — workflowGraphProblems fails this before any rule/compile runs.
          graph: { version: 1, nodes: [] } as never,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects (400) a graph compile() cannot resolve — a cycle', async () => {
      mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(0);

      await expect(
        service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: CYCLIC_GRAPH }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    it('rejects (400) a graph referencing a node type WORKFLOW_NODE_REGISTRY does not resolve', async () => {
      mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(0);

      await expect(
        service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: UNREGISTERED_NODE_GRAPH }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });

    it('enforces the maxWorkflowDefinitions quota only when enforcement is enabled', async () => {
      mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
      mockWorkflowDefinitionRepository.count.mockResolvedValue(5);
      mockEntitlements.assertQuantityQuota.mockRejectedValue(new Error('QuotaExceeded'));

      await expect(
        service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: VALID_GRAPH }),
      ).rejects.toThrow('QuotaExceeded');
      expect(mockEntitlements.assertQuantityQuota).toHaveBeenCalledWith('tenant-1', 'maxWorkflowDefinitions', 5);
      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws BadRequestException (assertMutable) on a PUBLISHED row and never calls updateWithVersion', async () => {
      const published = createMockEntity({ status: WorkflowDefinitionStatus.PUBLISHED });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(published);

      await expect(service.update('def-id-1', { name: 'x', expectedVersion: 1 })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('writes a metadata-only change via updateWithVersion and broadcasts ResourceUpdated', async () => {
      const entity = createMockEntity();
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      Object.defineProperty(entity, 'name', {
        set() {
          entity.hasChanges = true;
          entity.changes = { name: 'Renamed' };
        },
        get() {
          return 'Renamed';
        },
        configurable: true,
      });
      const updated = createMockEntity({ version: 2, name: 'Renamed' });
      mockWorkflowDefinitionRepository.updateWithVersion.mockResolvedValue(updated);

      const result = await service.update('def-id-1', { name: 'Renamed', expectedVersion: 1 });

      expect(mockWorkflowDefinitionRepository.updateWithVersion).toHaveBeenCalledWith('def-id-1', entity, 1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: updated.id }));
      expect(result.version).toBe(2);
    });

    it('re-validates a graph change and resets status to DRAFT even from VALIDATED', async () => {
      const entity = createMockEntity({ status: WorkflowDefinitionStatus.VALIDATED });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      // Mirrors the real BaseEntity setter: writing `graph` marks the entity dirty (the DTO's
      // `graph` is applied by the service directly, not via `updateEntity`/`applyChangesToEntity`).
      let graphValue = entity.graph;
      Object.defineProperty(entity, 'graph', {
        set(value) {
          graphValue = value;
          entity.hasChanges = true;
        },
        get() {
          return graphValue;
        },
        configurable: true,
      });
      const updated = createMockEntity({ version: 2, status: WorkflowDefinitionStatus.DRAFT });
      mockWorkflowDefinitionRepository.updateWithVersion.mockResolvedValue(updated);

      await service.update('def-id-1', { graph: VALID_GRAPH, expectedVersion: 1 });

      expect(entity.status).toBe(WorkflowDefinitionStatus.DRAFT);
      expect(mockWorkflowDefinitionRepository.updateWithVersion).toHaveBeenCalledWith('def-id-1', entity, 1);
    });

    it('rejects (400) replacing the graph with an uncompilable one and never writes', async () => {
      const entity = createMockEntity();
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);

      await expect(service.update('def-id-1', { graph: CYCLIC_GRAPH, expectedVersion: 1 })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException on a cross-tenant id and never calls updateWithVersion', async () => {
      const foreign = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(foreign);

      await expect(service.update('def-id-1', { name: 'x', expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws ArgumentInvalidException when the request carries no actual changes', async () => {
      const entity = createMockEntity();
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);

      await expect(service.update('def-id-1', { expectedVersion: 1 })).rejects.toBeInstanceOf(ArgumentInvalidException);
      expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
    });
  });

  describe('validate', () => {
    it('advances DRAFT -> VALIDATED when the engine gate is clean, regardless of DRAFT rule-catalogue findings', async () => {
      const entity = createMockEntity({ status: WorkflowDefinitionStatus.DRAFT });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      mockWorkflowDefinitionRepository.updateWithVersion.mockImplementation((_id, e) => Promise.resolve(e));

      const result = await service.validate('def-id-1');

      expect(entity.status).toBe(WorkflowDefinitionStatus.VALIDATED);
      expect(entity.validationReport).toBeTruthy();
      expect(result.status).toBe(WorkflowDefinitionStatus.VALIDATED);
    });

    it('stays DRAFT when the engine gate is not clean (a cycle)', async () => {
      const entity = createMockEntity({ graph: CYCLIC_GRAPH });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      mockWorkflowDefinitionRepository.updateWithVersion.mockImplementation((_id, e) => Promise.resolve(e));

      const result = await service.validate('def-id-1');

      expect(result.status).toBe(WorkflowDefinitionStatus.DRAFT);
    });
  });

  describe('publish', () => {
    it('compiles the graph, stamps compiledConfig/checksum/registryChecksum, activates, and demotes the previous active version', async () => {
      const entity = createMockEntity({ status: WorkflowDefinitionStatus.VALIDATED, slug: 'discharge_summary', versionNumber: 2 });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      const previousActive = createMockEntity({ id: 'def-id-0', versionNumber: 1, isActive: true, status: WorkflowDefinitionStatus.PUBLISHED });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(previousActive);
      mockWorkflowDefinitionRepository.update.mockImplementation((_id, e) => Promise.resolve(e));

      const result = await service.publish('def-id-1', {});

      expect(entity.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
      expect(entity.compiledConfig).toBeTruthy();
      expect(entity.compiledConfigChecksum).toBeTruthy();
      expect(entity.registryChecksum).toBeTruthy();
      expect(entity.isActive).toBe(true);
      expect(previousActive.isActive).toBe(false);
      expect(mockWorkflowDefinitionRepository.update).toHaveBeenCalledWith('def-id-0', previousActive);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'def-id-1' }));
      expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    });

    it('rejects (400) publishing a graph the engine cannot compile and never writes', async () => {
      const entity = createMockEntity({ graph: UNREGISTERED_NODE_GRAPH });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);

      await expect(service.publish('def-id-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException (assertMutable) when publishing an already-DEPRECATED row', async () => {
      const entity = createMockEntity({ status: WorkflowDefinitionStatus.DEPRECATED });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);

      await expect(service.publish('def-id-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
    });

    it('does not activate when dto.activate is false, and skips the demote lookup', async () => {
      const entity = createMockEntity();
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      mockWorkflowDefinitionRepository.update.mockImplementation((_id, e) => Promise.resolve(e));

      await service.publish('def-id-1', { activate: false });

      expect(entity.isActive).toBe(false);
      expect(mockWorkflowDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
    });

    describe('featurePaletteStt entitlement gate (TASK-724 Task 7)', () => {
      it('never consults isFeatureEnabled for a non-stt palette', async () => {
        const entity = createMockEntity({ paletteKey: 'summarization' });
        mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
        mockWorkflowDefinitionRepository.update.mockImplementation((_id, e) => Promise.resolve(e));

        await service.publish('def-id-1', {});

        expect(mockEntitlements.isFeatureEnabled).not.toHaveBeenCalled();
      });

      it('publishes an stt-palette workflow when the tenant IS entitled', async () => {
        const entity = createMockEntity({ paletteKey: 'stt', graph: STT_GRAPH });
        mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
        mockWorkflowDefinitionRepository.update.mockImplementation((_id, e) => Promise.resolve(e));
        mockEntitlements.isFeatureEnabled.mockResolvedValue(true);

        const result = await service.publish('def-id-1', {});

        expect(mockEntitlements.isFeatureEnabled).toHaveBeenCalledWith('tenant-1', 'paletteStt');
        expect(mockSttPipelineCompiler.compileAndPublish).toHaveBeenCalledTimes(1);
        expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
      });

      it('blocks (does not write, does not compile an AsrPipeline) an stt-palette publish when the tenant is NOT entitled', async () => {
        const entity = createMockEntity({ paletteKey: 'stt', graph: STT_GRAPH });
        mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
        mockEntitlements.isFeatureEnabled.mockResolvedValue(false);

        await expect(service.publish('def-id-1', {})).rejects.toBeInstanceOf(QuotaExceededException);
        expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
        expect(mockSttPipelineCompiler.compileAndPublish).not.toHaveBeenCalled();
      });
    });

    describe('STT pipeline compilation on publish (TASK-724 Task 4)', () => {
      it('compiles the graph into an AsrPipeline via SttPipelineCompilerService and threads its id/slug into the sys-event', async () => {
        const entity = createMockEntity({ paletteKey: 'stt', graph: STT_GRAPH });
        mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
        mockWorkflowDefinitionRepository.update.mockImplementation((_id, e) => Promise.resolve(e));
        mockSttPipelineCompiler.compileAndPublish.mockResolvedValue({ id: 'pipe-42', slug: 'wf-stt-discharge-summary', version: 1 });

        await service.publish('def-id-1', {});

        expect(mockSttPipelineCompiler.compileAndPublish).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'def-id-1', slug: entity.slug }),
          expect.objectContaining({ paletteKey: 'stt' }),
        );
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceUpdated,
          expect.objectContaining({ data: expect.objectContaining({ asrPipelineId: 'pipe-42', asrPipelineSlug: 'wf-stt-discharge-summary' }) }),
        );
      });

      it('never calls the STT compiler for a non-stt palette', async () => {
        const entity = createMockEntity({ paletteKey: 'summarization' });
        mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
        mockWorkflowDefinitionRepository.update.mockImplementation((_id, e) => Promise.resolve(e));

        await service.publish('def-id-1', {});

        expect(mockSttPipelineCompiler.compileAndPublish).not.toHaveBeenCalled();
      });

      it('aborts the publish (never writes the WorkflowDefinition) when the compiler rejects — e.g. a graph missing stt.asrEngine', async () => {
        const entity = createMockEntity({ paletteKey: 'stt', graph: STT_GRAPH });
        mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
        mockSttPipelineCompiler.compileAndPublish.mockRejectedValue(new Error("no 'stt.asrEngine' node"));

        await expect(service.publish('def-id-1', {})).rejects.toThrow(/stt\.asrEngine/);
        expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
        expect(entity.status).not.toBe(WorkflowDefinitionStatus.PUBLISHED);
      });
    });
  });

  describe('getById', () => {
    it('throws NotFoundException on a cross-tenant id (404-over-403)', async () => {
      const foreign = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(foreign);

      await expect(service.getById('def-id-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getCompiledConfigForSandboxRun (TASK-721 Workbench)', () => {
    it('compiles a DRAFT row (no persisted compiledConfig) fresh, and never writes it back', async () => {
      const entity = createMockEntity({ status: WorkflowDefinitionStatus.DRAFT, compiledConfig: null });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);

      const result = await service.getCompiledConfigForSandboxRun('def-id-1');

      expect(result.compiledConfig).toBeTruthy();
      expect(result.workflowVersionId).toBe('def-id-1');
      expect(result.workflowSlug).toBe('discharge_summary');
      expect(result.workflowVersionNumber).toBe(1);
      expect(result.definitionName).toBe('Discharge Summary');
      // A read, never a lifecycle transition or a persisted write.
      expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
      expect(mockWorkflowDefinitionRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(entity.status).toBe(WorkflowDefinitionStatus.DRAFT);
    });

    it('rejects (400) a graph the engine cannot compile, same predicate as publish()', async () => {
      const entity = createMockEntity({ graph: UNREGISTERED_NODE_GRAPH });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);

      await expect(service.getCompiledConfigForSandboxRun('def-id-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException on a cross-tenant id (404-over-403)', async () => {
      const foreign = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(foreign);

      await expect(service.getCompiledConfigForSandboxRun('def-id-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listVersions', () => {
    it('loads the lineage by the entity’s (tenantId, slug), most recent first', async () => {
      const entity = createMockEntity({ id: 'def-id-2', versionNumber: 2 });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      mockWorkflowDefinitionRepository.findAllVersionsBySlug.mockResolvedValue([
        createMockEntity({ versionNumber: 2 }),
        createMockEntity({ versionNumber: 1 }),
      ]);

      const result = await service.listVersions('def-id-2');

      expect(mockWorkflowDefinitionRepository.findAllVersionsBySlug).toHaveBeenCalledWith('tenant-1', 'discharge_summary');
      expect(result.map((r) => r.versionNumber)).toEqual([2, 1]);
    });

    it('throws NotFoundException on a cross-tenant id', async () => {
      const foreign = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(foreign);

      await expect(service.listVersions('def-id-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowDefinitionRepository.findAllVersionsBySlug).not.toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('soft-deletes and broadcasts ResourceDeleted', async () => {
      const entity = createMockEntity();
      mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity);
      const deleted = createMockEntity({ resourceStatus: 'DELETED' });
      mockWorkflowDefinitionRepository.softDelete.mockResolvedValue(deleted);

      const result = await service.deleteById('def-id-1');

      expect(mockWorkflowDefinitionRepository.softDelete).toHaveBeenCalledWith('def-id-1', 'admin-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: deleted.id }));
      expect(result.id).toBe(deleted.id);
    });
  });

  describe('listNodes', () => {
    it('projects WORKFLOW_NODE_REGISTRY, sorted, with a registryChecksum', async () => {
      const result = await service.listNodes();

      // TASK-720 populated the five summarization-palette node types alongside the TASK-734
      // seed entries; TASK-724 added the eight STT-palette node types; TASK-731 added three
      // consultation-palette node types (consentGate/phiHop/hitlGate — the palette's other ten
      // node types are not yet registered, see that ticket's README §7) — this projection is a
      // live read of WORKFLOW_NODE_REGISTRY, so it must track that registry's real contents, not
      // a stale snapshot. (2026-08-17 close-out pass: TASK-720's five entries, briefly dropped
      // from the registry by an external tree operation, were restored — see that ticket's
      // README §7.)
      expect(result.nodes.map((n) => n.type)).toEqual([
        'consultation.consentGate',
        'consultation.hitlGate',
        'consultation.phiHop',
        'generate.text',
        'guardrail.check',
        'input.context_binding',
        'noop',
        'output.deliver',
        'passthrough',
        'prompt.template_ref',
        'stt.asrEngine',
        'stt.audioInput',
        'stt.diarization',
        'stt.languageDetection',
        'stt.noiseFilter',
        'stt.phiHop',
        'stt.transcriptOutput',
        'stt.vad',
      ]);
      expect(result.registryChecksum).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
