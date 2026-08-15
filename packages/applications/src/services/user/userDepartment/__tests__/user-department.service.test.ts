/**
 * UserDepartmentService Unit Tests
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

// Assign() must verify the target department belongs to the
// caller's tenant (cross-tenant referential integrity), so the service now
// depends on the DepartmentRepository.
const mockDepartmentRepo = {
  findById: vi.fn(),
  findAll: vi.fn(),
};

// `findActiveDepartmentForUserInTenant` reads via the
// tenant-scope-bypassing baseClient (pre-auth login lookup).
const mockDatabaseService = {
  baseClient: {
    userDepartment: {
      findFirst: vi.fn(),
    },
  },
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

    // Default to an in-tenant department so the integrity
    // check passes for the happy-path tests. Cross-tenant tests override this.
    mockDepartmentRepo.findById.mockResolvedValue({ id: 'dept-1', tenantId: 'tenant-1' });
    // GetByUser batch-resolves department labels; default to none so
    // pre-existing tests keep the fields undefined unless they opt in.
    mockDepartmentRepo.findAll.mockResolvedValue([]);

    service = new UserDepartmentService(
      mockRepo as never,
      mockDepartmentRepo as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
    );
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

    it('rejects a department that belongs to another tenant (NotFound, no create)', async () => {
      // Department exists, but in tenant-2 while the caller is in tenant-1.
      mockDepartmentRepo.findById.mockResolvedValue({ id: 'dept-foreign', tenantId: 'tenant-2' });

      await expect(service.assign('user-1', { departmentId: 'dept-foreign' })).rejects.toThrow(NotFoundException);
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockRepo.findAll).not.toHaveBeenCalled();
    });

    it('rejects a missing department (NotFound, no create)', async () => {
      mockDepartmentRepo.findById.mockResolvedValue(null);

      await expect(service.assign('user-1', { departmentId: 'dept-missing' })).rejects.toThrow(NotFoundException);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('verifies the department is in the caller tenant before assigning', async () => {
      mockRepo.findAll
        .mockResolvedValueOnce([]) // active duplicate check
        .mockResolvedValueOnce([]); // soft-deleted duplicate check
      mockRepo.create.mockResolvedValue(makeEntity({ id: 'ud-new', departmentId: 'dept-1' }));

      await service.assign('user-1', { departmentId: 'dept-1' });

      expect(mockDepartmentRepo.findById).toHaveBeenCalledWith('dept-1');
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
      expect(mockRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1', userId: 'user-1' } }));
    });

    // The admin console renders department NAMES/CODES, not raw UUIDs.
    // getByUser batch-resolves the distinct departmentIds in ONE query.
    it('resolves departmentName/departmentCode from a single batch lookup', async () => {
      mockRepo.findAll.mockResolvedValueOnce([
        makeEntity({ id: 'ud-1', departmentId: 'dept-1', isPrimary: true }),
        makeEntity({ id: 'ud-2', departmentId: 'dept-2' }),
      ]);
      mockDepartmentRepo.findAll.mockResolvedValueOnce([
        { id: 'dept-1', name: 'Cardiology', code: 'CARD' },
        { id: 'dept-2', name: 'Neurology', code: 'NEURO' },
      ]);

      const result = await service.getByUser('user-1');

      expect(result[0].departmentName).toBe('Cardiology');
      expect(result[0].departmentCode).toBe('CARD');
      expect(result[1].departmentName).toBe('Neurology');
      expect(result[1].departmentCode).toBe('NEURO');
      // ONE batch query for the distinct department ids (no N+1).
      expect(mockDepartmentRepo.findAll).toHaveBeenCalledTimes(1);
      expect(mockDepartmentRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['dept-1', 'dept-2'] } } }));
    });

    it('leaves the label fields undefined when a department is missing (deleted) without throwing', async () => {
      mockRepo.findAll.mockResolvedValueOnce([makeEntity({ id: 'ud-1', departmentId: 'dept-gone' })]);
      mockDepartmentRepo.findAll.mockResolvedValueOnce([]); // department no longer resolvable

      const result = await service.getByUser('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].departmentName).toBeUndefined();
      expect(result[0].departmentCode).toBeUndefined();
    });

    it('does not query departments when the user has no assignments', async () => {
      mockRepo.findAll.mockResolvedValueOnce([]);

      const result = await service.getByUser('user-1');

      expect(result).toHaveLength(0);
      expect(mockDepartmentRepo.findAll).not.toHaveBeenCalled();
    });

    // An unscoped SUPER_ADMIN (no working tenant) reads the user's
    // memberships CROSS-TENANT instead of failing with "Tenant ID is required".
    it('lists cross-tenant assignments for a SUPER_ADMIN with no tenant context', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-id', roles: ['SUPER_ADMIN'] } : null));
      mockRepo.findAll.mockResolvedValueOnce([
        makeEntity({ id: 'ud-1', departmentId: 'dept-1', tenantId: 'tenant-1' }),
        makeEntity({ id: 'ud-2', departmentId: 'dept-2', tenantId: 'tenant-2' }),
      ]);

      const result = await service.getByUser('user-1');

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.tenantId)).toEqual(['tenant-1', 'tenant-2']);
      // No tenant predicate — the read spans tenants.
      expect(mockRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
    });

    it('still requires a tenant context for non-elevated callers', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'tenant-admin-id', roles: ['TENANT_ADMIN'] } : null));

      await expect(service.getByUser('user-1')).rejects.toThrow(BadRequestException);
      expect(mockRepo.findAll).not.toHaveBeenCalled();
    });
  });

  // Bulk reconcile a user's memberships to EXACTLY the target set.
  describe('setDepartments', () => {
    it('reconciles to exactly the target set — adds missing, soft-deletes extras, leaves matches', async () => {
      mockRepo.findAll
        .mockResolvedValueOnce([makeEntity({ id: 'ud-1', departmentId: 'dept-1' }), makeEntity({ id: 'ud-2', departmentId: 'dept-2' })]) // current active set
        .mockResolvedValueOnce([]) // soft-deleted dup check for the added dept-3
        .mockResolvedValueOnce([]) // demoteExistingPrimaries (no primary requested)
        .mockResolvedValueOnce([makeEntity({ id: 'ud-1', departmentId: 'dept-1' }), makeEntity({ id: 'ud-new', departmentId: 'dept-3' })]); // final read-back
      mockRepo.softDelete.mockResolvedValue(makeEntity({ id: 'ud-2', departmentId: 'dept-2', resourceStatus: ResourceStatusType.DELETED }));
      mockRepo.create.mockResolvedValue(makeEntity({ id: 'ud-new', departmentId: 'dept-3' }));

      const result = await service.setDepartments('user-1', { departmentIds: ['dept-1', 'dept-3'] });

      // dept-2 removed, dept-3 added, dept-1 untouched (no create/delete for it).
      expect(mockRepo.softDelete).toHaveBeenCalledWith('ud-2', 'current-user-id');
      expect(mockRepo.create).toHaveBeenCalledTimes(1);
      expect(result.map((r) => r.departmentId)).toEqual(['dept-1', 'dept-3']);
    });

    it('restores a soft-deleted row rather than creating a duplicate when re-adding', async () => {
      const softDeleted = makeEntity({ id: 'ud-del', departmentId: 'dept-7', resourceStatus: ResourceStatusType.DELETED });
      mockRepo.findAll
        .mockResolvedValueOnce([]) // current active set (empty)
        .mockResolvedValueOnce([softDeleted]) // soft-deleted dup check for dept-7 → reactivate
        .mockResolvedValueOnce([]) // demoteExistingPrimaries
        .mockResolvedValueOnce([makeEntity({ id: 'ud-del', departmentId: 'dept-7' })]); // final
      mockRepo.restore.mockResolvedValue(makeEntity({ id: 'ud-del', departmentId: 'dept-7' }));

      await service.setDepartments('user-1', { departmentIds: ['dept-7'] });

      expect(mockRepo.restore).toHaveBeenCalledWith('ud-del', 'current-user-id');
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('enforces the single-primary invariant — demotes existing primaries then promotes the requested one', async () => {
      mockRepo.findAll
        .mockResolvedValueOnce([makeEntity({ id: 'ud-1', departmentId: 'dept-1', isPrimary: true })]) // current
        .mockResolvedValueOnce([]) // soft-deleted dup check for added dept-2
        .mockResolvedValueOnce([makeEntity({ id: 'ud-1', departmentId: 'dept-1', isPrimary: true })]) // demoteExistingPrimaries
        .mockResolvedValueOnce([makeEntity({ id: 'ud-2', departmentId: 'dept-2', isPrimary: false })]) // set-primary lookup
        .mockResolvedValueOnce([
          makeEntity({ id: 'ud-1', departmentId: 'dept-1', isPrimary: false }),
          makeEntity({ id: 'ud-2', departmentId: 'dept-2', isPrimary: true }),
        ]); // final
      mockRepo.create.mockResolvedValue(makeEntity({ id: 'ud-2', departmentId: 'dept-2' }));
      mockRepo.update.mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity));

      await service.setDepartments('user-1', { departmentIds: ['dept-1', 'dept-2'], primaryDepartmentId: 'dept-2' });

      // Existing dept-1 primary demoted (update to isPrimary:false) AND dept-2 promoted.
      expect(mockRepo.update).toHaveBeenCalledWith('ud-1', expect.objectContaining({ isPrimary: false }));
      expect(mockRepo.update).toHaveBeenCalledWith('ud-2', expect.objectContaining({ isPrimary: true }));
    });

    it('verifies EVERY target department is in the caller tenant FIRST — a foreign one is a 404 with no writes', async () => {
      mockDepartmentRepo.findById.mockImplementation((id: string) =>
        Promise.resolve(id === 'dept-foreign' ? { id, tenantId: 'tenant-2' } : { id, tenantId: 'tenant-1' }),
      );

      await expect(service.setDepartments('user-1', { departmentIds: ['dept-1', 'dept-foreign'] })).rejects.toThrow(NotFoundException);
      expect(mockRepo.softDelete).not.toHaveBeenCalled();
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockRepo.findAll).not.toHaveBeenCalled();
    });

    it('requires a tenant context', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : { id: 'current-user-id' }));

      await expect(service.setDepartments('user-1', { departmentIds: ['dept-1'] })).rejects.toThrow(BadRequestException);
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

  // Pre-auth (baseClient) membership lookup for the login flow.
  describe('findActiveDepartmentForUserInTenant', () => {
    it('returns the row when an enabled department exists for (userId, tenantId)', async () => {
      mockDatabaseService.baseClient.userDepartment.findFirst.mockResolvedValue({ id: 'ud-7' });

      const result = await service.findActiveDepartmentForUserInTenant('user-1', 'tenant-1');

      expect(result).toEqual({ id: 'ud-7' });
    });

    it('returns null when the user has no enabled department in the tenant', async () => {
      mockDatabaseService.baseClient.userDepartment.findFirst.mockResolvedValue(null);

      const result = await service.findActiveDepartmentForUserInTenant('user-1', 'tenant-1');

      expect(result).toBeNull();
    });

    it('queries the baseClient (tenant-scope bypass) with userId + tenantId + ENABLED', async () => {
      mockDatabaseService.baseClient.userDepartment.findFirst.mockResolvedValue({ id: 'ud-7' });

      await service.findActiveDepartmentForUserInTenant('user-1', 'tenant-1');

      expect(mockDatabaseService.baseClient.userDepartment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED },
        }),
      );
    });
  });
});
