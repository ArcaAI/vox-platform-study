/**
 * UserDepartmentService Unit Tests (TASK-328 A1)
 *
 * Behavioral coverage:
 * - assign creates a tenant-scoped assignment and broadcasts ResourceCreated
 * - isPrimary uniqueness: assigning/updating a primary demotes the others
 * - duplicate guard + soft-deleted reactivation
 * - update enforces optimistic concurrency (updateWithVersion + expectedVersion)
 * - unassign soft-deletes and broadcasts ResourceDeleted
 * - tenant scoping: a foreign / missing assignment is a 404; missing tenant is 400
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';
import { UserDepartmentService } from '../user-department.service';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockRepo = {
  findAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
};

interface MockEntityOverrides {
  id?: string;
  userId?: string;
  departmentId?: string;
  isPrimary?: boolean;
  tenantId?: string;
  version?: number;
  resourceStatus?: ResourceStatusType;
  hasChanges?: boolean;
  changes?: Record<string, unknown>;
}

const makeEntity = (overrides: MockEntityOverrides = {}) => ({
  id: overrides.id ?? 'ud-1',
  userId: overrides.userId ?? 'user-1',
  departmentId: overrides.departmentId ?? 'dept-1',
  isPrimary: overrides.isPrimary ?? false,
  tenantId: overrides.tenantId ?? 'tenant-1',
  version: overrides.version ?? 1,
  resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
  hasChanges: overrides.hasChanges ?? false,
  changes: overrides.changes ?? {},
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
});

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    UserDepartmentFactory: {
      CreateUserDepartment: vi.fn((data) => ({
        id: 'ud-new',
        isPrimary: data.isPrimary ?? false,
        userId: data.userId,
        departmentId: data.departmentId,
        tenantId: data.tenantId,
        version: 1,
        resourceStatus: (actual as { ResourceStatusType: typeof ResourceStatusType }).ResourceStatusType.ENABLED,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      })),
    },
  };
});

describe('UserDepartmentService', () => {
  let service: UserDepartmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'current-user-id' };
        case 'tenantId':
          return 'tenant-1';
        case 'correlationId':
          return 'corr-1';
        case 'requestIp':
          return '127.0.0.1';
        default:
          return null;
      }
    });

    service = new UserDepartmentService(mockRepo as never, mockEventEmitter as never, mockClsService as never);
  });

  describe('assign', () => {
    it('creates a new assignment scoped to the active tenant', async () => {
      mockRepo.findAll
        .mockResolvedValueOnce([]) // active duplicate check
        .mockResolvedValueOnce([]); // soft-deleted duplicate check
      mockRepo.create.mockResolvedValue(makeEntity({ id: 'ud-new', departmentId: 'dept-1' }));

      const result = await service.assign('user-1', { departmentId: 'dept-1' });

      expect(result.id).toBe('ud-new');
      expect(result.userId).toBe('user-1');
      expect(result.departmentId).toBe('dept-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(mockRepo.create).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ resourceId: 'ud-new', tenantId: 'tenant-1' }),
      );
    });

    it('demotes the existing primary when assigning a new primary', async () => {
      const existingPrimary = makeEntity({ id: 'ud-old', departmentId: 'dept-9', isPrimary: true });
      mockRepo.findAll
        .mockResolvedValueOnce([]) // active duplicate check
        .mockResolvedValueOnce([existingPrimary]) // demoteExistingPrimaries
        .mockResolvedValueOnce([]); // soft-deleted duplicate check
      mockRepo.update.mockResolvedValue({ ...existingPrimary, isPrimary: false });
      mockRepo.create.mockResolvedValue(makeEntity({ id: 'ud-new', departmentId: 'dept-1', isPrimary: true }));

      const result = await service.assign('user-1', { departmentId: 'dept-1', isPrimary: true });

      expect(result.isPrimary).toBe(true);
      expect(existingPrimary.isPrimary).toBe(false);
      expect(mockRepo.update).toHaveBeenCalledWith('ud-old', existingPrimary);
    });

    it('rejects assigning a department the user already has', async () => {
      mockRepo.findAll.mockResolvedValueOnce([makeEntity({ id: 'ud-existing', departmentId: 'dept-1' })]);

      await expect(service.assign('user-1', { departmentId: 'dept-1' })).rejects.toThrow(BadRequestException);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('reactivates a soft-deleted assignment instead of creating a duplicate', async () => {
      const softDeleted = makeEntity({ id: 'ud-deleted', departmentId: 'dept-1', resourceStatus: ResourceStatusType.DELETED });
      mockRepo.findAll
        .mockResolvedValueOnce([]) // active duplicate check
        .mockResolvedValueOnce([softDeleted]); // soft-deleted duplicate check
      mockRepo.restore.mockResolvedValue(makeEntity({ id: 'ud-deleted', departmentId: 'dept-1' }));

      const result = await service.assign('user-1', { departmentId: 'dept-1' });

      expect(result.id).toBe('ud-deleted');
      expect(mockRepo.restore).toHaveBeenCalledWith('ud-deleted', 'current-user-id');
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('requires a tenant context', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : { id: 'current-user-id' }));

      await expect(service.assign('user-1', { departmentId: 'dept-1' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('getByUser', () => {
    it('returns the tenant-scoped assignments for a user', async () => {
      mockRepo.findAll.mockResolvedValueOnce([
        makeEntity({ id: 'ud-1', departmentId: 'dept-1', isPrimary: true }),
        makeEntity({ id: 'ud-2', departmentId: 'dept-2' }),
      ]);

      const result = await service.getByUser('user-1');

      expect(result).toHaveLength(2);
      expect(result[0].isPrimary).toBe(true);
      expect(mockRepo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-1', userId: 'user-1' } }),
      );
    });
  });

  describe('update', () => {
    it('sets primary under optimistic concurrency and demotes others', async () => {
      const target = makeEntity({ id: 'ud-1', userId: 'user-1', isPrimary: false, version: 3, hasChanges: true, changes: { isPrimary: true } });
      const otherPrimary = makeEntity({ id: 'ud-2', userId: 'user-1', isPrimary: true });
      mockRepo.findAll
        .mockResolvedValueOnce([target]) // findScoped
        .mockResolvedValueOnce([otherPrimary]); // demoteExistingPrimaries
      mockRepo.update.mockResolvedValue({ ...otherPrimary, isPrimary: false });
      mockRepo.updateWithVersion.mockResolvedValue(makeEntity({ id: 'ud-1', isPrimary: true, version: 4 }));

      const result = await service.update('ud-1', { isPrimary: true, expectedVersion: 3 });

      expect(result.version).toBe(4);
      expect(mockRepo.update).toHaveBeenCalledWith('ud-2', otherPrimary);
      expect(mockRepo.updateWithVersion).toHaveBeenCalledWith('ud-1', target, 3);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'ud-1' }));
    });

    it('throws when there are no changes to write', async () => {
      const target = makeEntity({ id: 'ud-1', isPrimary: false, hasChanges: false });
      mockRepo.findAll.mockResolvedValueOnce([target]);

      await expect(service.update('ud-1', { isPrimary: false, expectedVersion: 1 })).rejects.toThrow('No changes to write to');
    });

    it('throws 404 when the assignment is missing or in another tenant', async () => {
      mockRepo.findAll.mockResolvedValueOnce([]);

      await expect(service.update('ud-x', { isPrimary: true, expectedVersion: 1 })).rejects.toThrow(NotFoundException);
    });
  });

  describe('unassign', () => {
    it('soft-deletes the assignment and broadcasts ResourceDeleted', async () => {
      mockRepo.findAll.mockResolvedValueOnce([makeEntity({ id: 'ud-1', userId: 'user-1', departmentId: 'dept-1' })]);
      mockRepo.softDelete.mockResolvedValue(makeEntity({ id: 'ud-1', resourceStatus: ResourceStatusType.DELETED }));

      const result = await service.unassign('ud-1');

      expect(result.id).toBe('ud-1');
      expect(mockRepo.softDelete).toHaveBeenCalledWith('ud-1', 'current-user-id');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: 'ud-1' }));
    });

    it('throws 404 for a foreign / missing assignment', async () => {
      mockRepo.findAll.mockResolvedValueOnce([]);

      await expect(service.unassign('ud-x')).rejects.toThrow(NotFoundException);
    });
  });
});
