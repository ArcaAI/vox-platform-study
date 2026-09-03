/**
 * WorkflowTestFixtureService unit tests.
 *
 * Mirrors the ConsentGrantService/WebhookService/DepartmentService test
 * convention: mock the repository, EventEmitter2, and ClsService; assert
 * factory usage on create, `broadcastSysEvent` on every mutation, and
 * 404-over-403 cross-tenant behavior
 * (.claude/rules/04-application-services.md §Testing Requirements).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { WorkflowTestFixtureService } from '../workflow-test-fixture.service';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockWorkflowTestFixtureRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};

const createMockEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    paletteId: string | null;
    workflowDefinitionId: string | null;
    input: Record<string, unknown>;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) => ({
  id: overrides.id ?? 'fixture-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  name: overrides.name ?? 'Two-speaker follow-up visit',
  description: overrides.description ?? null,
  paletteId: overrides.paletteId ?? null,
  workflowDefinitionId: overrides.workflowDefinitionId ?? null,
  input: overrides.input ?? { transcript: 'synthetic sample only' },
  resourceStatus: ResourceStatusType.ENABLED,
  createdAt: overrides.createdAt ?? new Date('2026-08-16T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-08-16T00:00:00Z'),
  version: overrides.version ?? 1,
  hasChanges: overrides.hasChanges ?? false,
  changes: overrides.changes ?? {},
});

describe('WorkflowTestFixtureService', () => {
  let service: WorkflowTestFixtureService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new WorkflowTestFixtureService(mockWorkflowTestFixtureRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('create', () => {
    it('creates via WorkflowTestFixtureFactory, persists, and broadcasts ResourceCreated', async () => {
      const saved = createMockEntity();
      mockWorkflowTestFixtureRepository.create.mockResolvedValue(saved);

      const result = await service.create({ name: 'Two-speaker follow-up visit', input: { transcript: 'synthetic sample only' } });

      expect(mockWorkflowTestFixtureRepository.create).toHaveBeenCalledTimes(1);
      const createdEntityArg = mockWorkflowTestFixtureRepository.create.mock.calls[0][0];
      expect(createdEntityArg.tenantId).toBe('tenant-1');
      expect(createdEntityArg.name).toBe('Two-speaker follow-up visit');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: saved.id }));
      expect(result.id).toBe(saved.id);
    });
  });

  describe('findAll', () => {
    it('lists tenant fixtures and broadcasts ResourceViewed', async () => {
      const entity = createMockEntity();
      mockWorkflowTestFixtureRepository.findAll.mockResolvedValue([entity]);
      mockWorkflowTestFixtureRepository.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 0, limit: 10 });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns the fixture and broadcasts ResourceViewed', async () => {
      const entity = createMockEntity();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(entity);

      const result = await service.findById('fixture-id-1');

      expect(result.id).toBe('fixture-id-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: 'fixture-id-1' }));
    });

    it('throws NotFoundException — never a tenant-leaking error — on a cross-tenant fixture id', async () => {
      const foreignEntity = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(foreignEntity);

      await expect(service.findById('fixture-id-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('writes via updateWithVersion (never a plain update) and broadcasts ResourceUpdated', async () => {
      const entity = createMockEntity();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(entity);
      const updated = createMockEntity({ version: 2, name: 'Renamed fixture' });
      mockWorkflowTestFixtureRepository.updateWithVersion.mockResolvedValue(updated);
      // Simulate setProperty flipping hasChanges, mirroring BaseEntity's real behavior.
      Object.defineProperty(entity, 'name', {
        set() {
          entity.hasChanges = true;
          entity.changes = { name: 'Renamed fixture' };
        },
        get() {
          return 'Renamed fixture';
        },
        configurable: true,
      });

      const result = await service.update('fixture-id-1', { name: 'Renamed fixture', expectedVersion: 1 });

      expect(mockWorkflowTestFixtureRepository.updateWithVersion).toHaveBeenCalledWith('fixture-id-1', entity, 1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: updated.id }));
      expect(result.version).toBe(2);
    });

    it('throws NotFoundException on a cross-tenant fixture id and never calls updateWithVersion', async () => {
      const foreignEntity = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(foreignEntity);

      await expect(service.update('fixture-id-1', { name: 'x', expectedVersion: 1 })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowTestFixtureRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws ArgumentInvalidException when the request carries no actual changes', async () => {
      const entity = createMockEntity();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(entity);

      await expect(service.update('fixture-id-1', { expectedVersion: 1 })).rejects.toBeInstanceOf(ArgumentInvalidException);
      expect(mockWorkflowTestFixtureRepository.updateWithVersion).not.toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('soft-deletes and broadcasts ResourceDeleted', async () => {
      const entity = createMockEntity();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(entity);
      const deleted = createMockEntity({ resourceStatus: 'DELETED' as never });
      mockWorkflowTestFixtureRepository.softDelete.mockResolvedValue(deleted);

      const result = await service.deleteById('fixture-id-1');

      expect(mockWorkflowTestFixtureRepository.softDelete).toHaveBeenCalledWith('fixture-id-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: deleted.id }));
      expect(result.id).toBe(deleted.id);
    });

    it('throws NotFoundException on a cross-tenant fixture id and never calls softDelete', async () => {
      const foreignEntity = createMockEntity({ tenantId: 'tenant-OTHER' });
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(foreignEntity);

      await expect(service.deleteById('fixture-id-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowTestFixtureRepository.softDelete).not.toHaveBeenCalled();
    });
  });
});
