/**
 * DepartmentService Unit Tests
 *
 * Tests for the DepartmentService that handles department management operations.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DepartmentService } from '../department.service';
import { SysEventType, DepartmentFactory } from '@arcaai/domains';

// Mock ClsService
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock DepartmentRepository
const mockDepartmentRepository = {
  findAllByTenant: vi.fn(),
  findById: vi.fn(),
  findByCode: vi.fn(),
  findRootDepartments: vi.fn(),
  findChildren: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // `update()` and `updatePromptConfig()` now
  // write via Compare-And-Set (`updateWithVersion`). The legacy `.update()`
  // remains on the mock for assertions that confirm it is NOT called.
  updateWithVersion: vi.fn(),
};

// Helper to create mock department entity
const createMockDepartmentEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    code: string | null;
    name: string | null;
    description: string | null;
    parentDepartmentId: string | null;
    isRootDepartment: boolean;
    resourceStatus: string;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  }> = {},
) => ({
  id: overrides.id ?? 'department-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  code: overrides.code ?? 'CARDIO',
  name: overrides.name ?? 'Cardiology',
  description: overrides.description ?? 'Cardiology Department',
  parentDepartmentId: overrides.parentDepartmentId ?? null,
  isRootDepartment: overrides.isRootDepartment ?? true,
  resourceStatus: overrides.resourceStatus ?? 'ENABLED',
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
  // Every Department row carries a
  // server-owned `_version` after the B.5 BaseEntity getter + E.2.1 mapper.
  version: overrides.version ?? 1,
});

// Mock DepartmentFactory
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentFactory: {
      CreateDepartment: vi.fn((data) => ({
        ...data,
        id: 'new-department-id',
        isRootDepartment: !data.parentDepartmentId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
  };
});

describe('DepartmentService', () => {
  let service: DepartmentService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: return valid user and tenant from CLS
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'user-id-1' };
        case 'tenantId':
          return 'tenant-1';
        case 'correlationId':
          return 'corr-123';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });

    // Create service instance with mocks
    service = new DepartmentService(mockDepartmentRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('getAll', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'user-id-1' };
        return null;
      });

      await expect(service.getAll()).rejects.toThrow(BadRequestException);
      await expect(service.getAll()).rejects.toThrow('Tenant ID is required');
    });

    it('should return empty array when no departments exist', async () => {
      mockDepartmentRepository.findAllByTenant.mockResolvedValue([]);

      const result = await service.getAll();

      expect(result).toEqual([]);
      expect(mockDepartmentRepository.findAllByTenant).toHaveBeenCalledWith('tenant-1', {
        includeDisabled: undefined,
      });
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { count: 0 },
        }),
      );
    });

    it('should return all departments for tenant', async () => {
      const departments = [
        createMockDepartmentEntity({ id: 'dept-1', code: 'CARDIO', name: 'Cardiology' }),
        createMockDepartmentEntity({ id: 'dept-2', code: 'NEURO', name: 'Neurology' }),
        createMockDepartmentEntity({ id: 'dept-3', code: 'ORTHO', name: 'Orthopedics' }),
      ];
      mockDepartmentRepository.findAllByTenant.mockResolvedValue(departments);

      const result = await service.getAll();

      expect(result).toHaveLength(3);
      expect(result[0].code).toBe('CARDIO');
      expect(result[1].code).toBe('NEURO');
      expect(result[2].code).toBe('ORTHO');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { count: 3 },
        }),
      );
    });

    it('should pass includeDisabled: true to repository when option is set', async () => {
      mockDepartmentRepository.findAllByTenant.mockResolvedValue([]);

      await service.getAll({ includeDisabled: true });

      expect(mockDepartmentRepository.findAllByTenant).toHaveBeenCalledWith('tenant-1', {
        includeDisabled: true,
      });
    });

    it('should pass includeDisabled: false to repository when option is explicitly false', async () => {
      mockDepartmentRepository.findAllByTenant.mockResolvedValue([]);

      await service.getAll({ includeDisabled: false });

      expect(mockDepartmentRepository.findAllByTenant).toHaveBeenCalledWith('tenant-1', {
        includeDisabled: false,
      });
    });

    it('should return mixed ENABLED and DISABLED departments when includeDisabled is true', async () => {
      const departments = [
        createMockDepartmentEntity({ id: 'dept-1', name: 'Cardiology', resourceStatus: 'ENABLED' }),
        createMockDepartmentEntity({ id: 'dept-2', name: 'Neurology', resourceStatus: 'DISABLED' }),
        createMockDepartmentEntity({ id: 'dept-3', name: 'Orthopedics', resourceStatus: 'ENABLED' }),
      ];
      mockDepartmentRepository.findAllByTenant.mockResolvedValue(departments);

      const result = await service.getAll({ includeDisabled: true });

      expect(result).toHaveLength(3);
      expect(result[0].resourceStatus).toBe('ENABLED');
      expect(result[1].resourceStatus).toBe('DISABLED');
      expect(result[2].resourceStatus).toBe('ENABLED');
    });

    it('should include resourceStatus in every response DTO', async () => {
      const departments = [createMockDepartmentEntity({ id: 'dept-1', resourceStatus: 'DISABLED' })];
      mockDepartmentRepository.findAllByTenant.mockResolvedValue(departments);

      const result = await service.getAll({ includeDisabled: true });

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('resourceStatus');
      expect(result[0].resourceStatus).toBe('DISABLED');
    });

    it('should treat empty options object same as no options (includeDisabled defaults to undefined)', async () => {
      mockDepartmentRepository.findAllByTenant.mockResolvedValue([]);

      await service.getAll({});

      expect(mockDepartmentRepository.findAllByTenant).toHaveBeenCalledWith('tenant-1', {
        includeDisabled: undefined,
      });
    });

    it('should not filter out DISABLED departments when repository returns them with includeDisabled: true', async () => {
      const allDisabled = [
        createMockDepartmentEntity({ id: 'dept-1', name: 'Dept A', resourceStatus: 'DISABLED' }),
        createMockDepartmentEntity({ id: 'dept-2', name: 'Dept B', resourceStatus: 'DISABLED' }),
      ];
      mockDepartmentRepository.findAllByTenant.mockResolvedValue(allDisabled);

      const result = await service.getAll({ includeDisabled: true });

      expect(result).toHaveLength(2);
      expect(result.every((d) => d.resourceStatus === 'DISABLED')).toBe(true);
    });
  });

  describe('getById', () => {
    it('should return null when department not found', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(null);

      const result = await service.getById('non-existent-id');

      expect(result).toBeNull();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return department when found', async () => {
      const department = createMockDepartmentEntity();
      mockDepartmentRepository.findById.mockResolvedValue(department);

      const result = await service.getById('department-id-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('department-id-1');
      expect(result?.code).toBe('CARDIO');
      expect(result?.name).toBe('Cardiology');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          resourceId: 'department-id-1',
        }),
      );
    });
  });

  describe('getByCode', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'user-id-1' };
        return null;
      });

      await expect(service.getByCode('CARDIO')).rejects.toThrow(BadRequestException);
    });

    it('should return null when department with code not found', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);

      const result = await service.getByCode('NON_EXISTENT');

      expect(result).toBeNull();
      expect(mockDepartmentRepository.findByCode).toHaveBeenCalledWith('tenant-1', 'NON_EXISTENT');
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return department when found by code', async () => {
      const department = createMockDepartmentEntity();
      mockDepartmentRepository.findByCode.mockResolvedValue(department);

      const result = await service.getByCode('CARDIO');

      expect(result).not.toBeNull();
      expect(result?.code).toBe('CARDIO');
      expect(mockDepartmentRepository.findByCode).toHaveBeenCalledWith('tenant-1', 'CARDIO');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          resourceId: 'department-id-1',
        }),
      );
    });
  });

  describe('getRootDepartments', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'user-id-1' };
        return null;
      });

      await expect(service.getRootDepartments()).rejects.toThrow(BadRequestException);
    });

    it('should return empty array when no root departments exist', async () => {
      mockDepartmentRepository.findRootDepartments.mockResolvedValue([]);

      const result = await service.getRootDepartments();

      expect(result).toEqual([]);
      expect(mockDepartmentRepository.findRootDepartments).toHaveBeenCalledWith('tenant-1');
    });

    it('should return only root departments (no parent)', async () => {
      const rootDepartments = [
        createMockDepartmentEntity({ id: 'root-1', isRootDepartment: true }),
        createMockDepartmentEntity({ id: 'root-2', isRootDepartment: true }),
      ];
      mockDepartmentRepository.findRootDepartments.mockResolvedValue(rootDepartments);

      const result = await service.getRootDepartments();

      expect(result).toHaveLength(2);
      expect(result[0].isRootDepartment).toBe(true);
      expect(result[1].isRootDepartment).toBe(true);
    });
  });

  describe('getChildren', () => {
    it('should return empty array when no children exist', async () => {
      mockDepartmentRepository.findChildren.mockResolvedValue([]);

      const result = await service.getChildren('parent-id');

      expect(result).toEqual([]);
      expect(mockDepartmentRepository.findChildren).toHaveBeenCalledWith('parent-id');
    });

    it('should return child departments', async () => {
      const children = [
        createMockDepartmentEntity({
          id: 'child-1',
          parentDepartmentId: 'parent-id',
          isRootDepartment: false,
        }),
        createMockDepartmentEntity({
          id: 'child-2',
          parentDepartmentId: 'parent-id',
          isRootDepartment: false,
        }),
      ];
      mockDepartmentRepository.findChildren.mockResolvedValue(children);

      const result = await service.getChildren('parent-id');

      expect(result).toHaveLength(2);
      expect(result[0].parentDepartmentId).toBe('parent-id');
      expect(result[1].parentDepartmentId).toBe('parent-id');
    });
  });

  describe('create', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'user-id-1' };
        return null;
      });

      await expect(service.create({ name: 'New Department' })).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when code already exists', async () => {
      const existingDepartment = createMockDepartmentEntity({ code: 'EXISTING' });
      mockDepartmentRepository.findByCode.mockResolvedValue(existingDepartment);

      await expect(service.create({ code: 'EXISTING', name: 'New Department' })).rejects.toThrow(BadRequestException);
      await expect(service.create({ code: 'EXISTING', name: 'New Department' })).rejects.toThrow("Department with code 'EXISTING' already exists");
    });

    it('should throw NotFoundException when parent department not found', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);
      mockDepartmentRepository.findById.mockResolvedValue(null);

      await expect(
        service.create({
          name: 'Child Department',
          parentDepartmentId: 'non-existent-parent',
        }),
      ).rejects.toThrow(NotFoundException);
      // The `assertParentInScope` helper deliberately
      // emits a generic message so the caller cannot distinguish
      // "parent missing" from "parent in another tenant" (no
      // existence leak across tenant boundaries).
      await expect(
        service.create({
          name: 'Child Department',
          parentDepartmentId: 'non-existent-parent',
        }),
      ).rejects.toThrow('Resource not found');
    });

    it('should create root department without code', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);
      const newDepartment = createMockDepartmentEntity({
        id: 'new-department-id',
        code: null,
        name: 'New Department',
      });
      mockDepartmentRepository.create.mockResolvedValue(newDepartment);

      const result = await service.create({ name: 'New Department' });

      expect(result.id).toBe('new-department-id');
      expect(result.name).toBe('New Department');
      expect(mockDepartmentRepository.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-department-id',
          data: { code: undefined, name: 'New Department' },
        }),
      );
    });

    // CC-04 — the create modal collects `defaultSummaryTemplate`,
    // so `create` must forward it into department creation (the factory).
    // Previously it was dropped, so a template typed at create-time was lost.
    it('forwards defaultSummaryTemplate from the DTO into department creation', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);
      mockDepartmentRepository.create.mockResolvedValue(createMockDepartmentEntity({ id: 'new-department-id', name: 'New Department' }));

      await service.create({
        name: 'New Department',
        defaultSummaryTemplate: 'Default discharge summary template',
      });

      expect(DepartmentFactory.CreateDepartment as Mock).toHaveBeenCalledWith(
        expect.objectContaining({ defaultSummaryTemplate: 'Default discharge summary template' }),
      );
    });

    it('should create department with code', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);
      const newDepartment = createMockDepartmentEntity({
        id: 'new-department-id',
        code: 'NEW_DEPT',
        name: 'New Department',
      });
      mockDepartmentRepository.create.mockResolvedValue(newDepartment);

      const result = await service.create({
        code: 'NEW_DEPT',
        name: 'New Department',
        description: 'A new department',
      });

      expect(result.id).toBe('new-department-id');
      expect(result.code).toBe('NEW_DEPT');
      expect(mockDepartmentRepository.findByCode).toHaveBeenCalledWith('tenant-1', 'NEW_DEPT');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          data: { code: 'NEW_DEPT', name: 'New Department' },
        }),
      );
    });

    it('should create child department with valid parent', async () => {
      mockDepartmentRepository.findByCode.mockResolvedValue(null);
      const parentDepartment = createMockDepartmentEntity({ id: 'parent-id' });
      mockDepartmentRepository.findById.mockResolvedValue(parentDepartment);
      const newDepartment = createMockDepartmentEntity({
        id: 'new-department-id',
        name: 'Child Department',
        parentDepartmentId: 'parent-id',
        isRootDepartment: false,
      });
      mockDepartmentRepository.create.mockResolvedValue(newDepartment);

      const result = await service.create({
        name: 'Child Department',
        parentDepartmentId: 'parent-id',
      });

      expect(result.id).toBe('new-department-id');
      expect(result.parentDepartmentId).toBe('parent-id');
      expect(result.isRootDepartment).toBe(false);
      expect(mockDepartmentRepository.findById).toHaveBeenCalledWith('parent-id');
    });

    it('should skip code uniqueness check when code is not provided', async () => {
      const newDepartment = createMockDepartmentEntity({
        id: 'new-department-id',
        code: null,
      });
      mockDepartmentRepository.create.mockResolvedValue(newDepartment);

      await service.create({ name: 'No Code Department' });

      expect(mockDepartmentRepository.findByCode).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('routes through updateWithVersion using request.expectedVersion (Stream D Phase)', async () => {
      const department = createMockDepartmentEntityWithChanges({
        id: 'dept-1',
        hasChanges: true,
        changes: { name: 'Renamed' },
        version: 4,
      });
      mockDepartmentRepository.findById.mockResolvedValue(department);
      mockDepartmentRepository.updateWithVersion.mockResolvedValue({ ...department, version: 5 });

      const result = await service.update('dept-1', { name: 'Renamed', expectedVersion: 4 } as any);

      expect(result.id).toBe('dept-1');
      expect(mockDepartmentRepository.updateWithVersion).toHaveBeenCalledWith('dept-1', department, 4);
      // CAS-only — the legacy non-versioned write MUST NOT fire.
      expect(mockDepartmentRepository.update).not.toHaveBeenCalled();
    });

    it('emits ResourceUpdated SysEvent with previousVersion + newVersion (Stream D Phase)', async () => {
      const department = createMockDepartmentEntityWithChanges({
        id: 'dept-1',
        hasChanges: true,
        changes: { name: 'Renamed' },
        version: 9,
      });
      mockDepartmentRepository.findById.mockResolvedValue(department);
      mockDepartmentRepository.updateWithVersion.mockResolvedValue({ ...department, version: 10 });

      await service.update('dept-1', { name: 'Renamed', expectedVersion: 9 } as any);

      // The SysEvent carries the
      // pre- and post-write versions so downstream observers can
      // correlate the change with the row's prior state.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'dept-1',
          data: expect.objectContaining({
            previousVersion: 9,
            newVersion: 10,
          }),
        }),
      );
    });

    it('propagates OptimisticConcurrencyException on version drift (Stream D Phase)', async () => {
      const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
      const department = createMockDepartmentEntityWithChanges({
        id: 'dept-1',
        hasChanges: true,
        changes: { name: 'X' },
        version: 4,
      });
      mockDepartmentRepository.findById.mockResolvedValue(department);
      const occErr = new OptimisticConcurrencyException('Department', 'dept-1', {
        expectedVersion: 4,
        currentVersion: 5,
      });
      mockDepartmentRepository.updateWithVersion.mockRejectedValue(occErr);

      await expect(service.update('dept-1', { name: 'X', expectedVersion: 4 } as any)).rejects.toBe(occErr);
      // Failed CAS — no audit event emitted (only successful writes
      // make it into the audit log).
      const updatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(([eventName]: [string]) => eventName === SysEventType.ResourceUpdated);
      expect(updatedBroadcasts).toHaveLength(0);
    });
  });

  describe('updatePromptConfig', () => {
    it('should throw NotFoundException when department not found', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(null);

      await expect(
        service.updatePromptConfig('non-existent-id', {
          preSummaryPromptId: 'prompt-1',
          expectedVersion: 1,
        } as any),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.updatePromptConfig('non-existent-id', {
          preSummaryPromptId: 'prompt-1',
          expectedVersion: 1,
        } as any),
      ).rejects.toThrow('Department non-existent-id not found');
    });

    it('should throw ArgumentInvalidException when no changes provided', async () => {
      const department = createMockDepartmentEntityWithChanges({ hasChanges: false });
      mockDepartmentRepository.findById.mockResolvedValue(department);

      const { ArgumentInvalidException } = await import('@arcaai/exceptions');

      await expect(service.updatePromptConfig('dept-1', { expectedVersion: 1 } as any)).rejects.toThrow(ArgumentInvalidException);
      await expect(service.updatePromptConfig('dept-1', { expectedVersion: 1 } as any)).rejects.toThrow('No changes to write to.');
    });

    it('should update prompt config via updateWithVersion (Stream D Phase)', async () => {
      const department = createMockDepartmentEntityWithChanges({
        hasChanges: true,
        changes: { preSummaryPromptId: 'pre-1', newPatientPromptId: 'np-1' },
        version: 7,
      });
      mockDepartmentRepository.findById.mockResolvedValue(department);
      const updatedDept = createMockDepartmentEntity({
        id: 'dept-1',
        code: 'CARD',
        name: 'Cardiology',
        version: 8,
      });
      mockDepartmentRepository.updateWithVersion.mockResolvedValue(updatedDept);

      const result = await service.updatePromptConfig('dept-1', {
        preSummaryPromptId: 'pre-1',
        newPatientPromptId: 'np-1',
        expectedVersion: 7,
      } as any);

      expect(result).toBeDefined();
      expect(result.id).toBe('dept-1');
      // CAS path with the version snapshot from the request.
      expect(mockDepartmentRepository.updateWithVersion).toHaveBeenCalledWith('dept-1', department, 7);
      expect(mockDepartmentRepository.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'dept-1',
          data: expect.objectContaining({
            preSummaryPromptId: 'pre-1',
            newPatientPromptId: 'np-1',
            previousVersion: 7,
            newVersion: 8,
          }),
        }),
      );
    });
  });

  /**
   * Department parent must live in the caller's tenant.
   *
   * Audit C-7: without this check a tenant can chain a department
   * under a parent owned by a different tenant, building a malformed
   * cross-tenant tree. Both `create` and `update` now route the
   * parent lookup through `assertParentInScope`, which throws
   * `NotFoundException` (not `ForbiddenException`) on tenant mismatch
   * to avoid leaking the parent's existence.
   *
   * GLOBAL_ADMIN is intentionally NOT bypassed here (unlike D.7's
   * cross-tenant role assignment): a cross-tenant parent would
   * produce a malformed tree regardless of the caller's role, so the
   * guard is unconditional.
   */
  describe('cross-tenant parent check', () => {
    describe('create', () => {
      it('rejects parent owned by another tenant with NotFoundException (no existence leak)', async () => {
        mockDepartmentRepository.findByCode.mockResolvedValue(null);
        const foreignParent = createMockDepartmentEntity({
          id: 'parent-other-tenant',
          tenantId: 'tenant-2', // caller's CLS tenant is 'tenant-1'
        });
        mockDepartmentRepository.findById.mockResolvedValue(foreignParent);

        await expect(
          service.create({
            name: 'Child Department',
            parentDepartmentId: 'parent-other-tenant',
          }),
        ).rejects.toThrow(NotFoundException);
        await expect(
          service.create({
            name: 'Child Department',
            parentDepartmentId: 'parent-other-tenant',
          }),
        ).rejects.toThrow('Resource not found');

        expect(mockDepartmentRepository.create).not.toHaveBeenCalled();
      });

      it('rejects cross-tenant parent even when caller is GLOBAL_ADMIN (no bypass)', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          switch (key) {
            case 'user':
              return { id: 'super-1', roles: ['GLOBAL_ADMIN'] };
            case 'tenantId':
              return 'tenant-1';
            default:
              return null;
          }
        });
        mockDepartmentRepository.findByCode.mockResolvedValue(null);
        const foreignParent = createMockDepartmentEntity({
          id: 'parent-other-tenant',
          tenantId: 'tenant-2',
        });
        mockDepartmentRepository.findById.mockResolvedValue(foreignParent);

        await expect(
          service.create({
            name: 'Child Department',
            parentDepartmentId: 'parent-other-tenant',
          }),
        ).rejects.toThrow(NotFoundException);
        expect(mockDepartmentRepository.create).not.toHaveBeenCalled();
      });

      it('accepts parent owned by the same tenant', async () => {
        mockDepartmentRepository.findByCode.mockResolvedValue(null);
        const sameTenantParent = createMockDepartmentEntity({
          id: 'parent-same-tenant',
          tenantId: 'tenant-1',
        });
        mockDepartmentRepository.findById.mockResolvedValue(sameTenantParent);
        const newDepartment = createMockDepartmentEntity({
          id: 'new-department-id',
          name: 'Child Department',
          parentDepartmentId: 'parent-same-tenant',
          isRootDepartment: false,
        });
        mockDepartmentRepository.create.mockResolvedValue(newDepartment);

        const result = await service.create({
          name: 'Child Department',
          parentDepartmentId: 'parent-same-tenant',
        });

        expect(result.id).toBe('new-department-id');
        expect(mockDepartmentRepository.findById).toHaveBeenCalledWith('parent-same-tenant');
        expect(mockDepartmentRepository.create).toHaveBeenCalled();
      });

      it('does not look up a parent when parentDepartmentId is omitted', async () => {
        mockDepartmentRepository.findByCode.mockResolvedValue(null);
        const newDepartment = createMockDepartmentEntity({
          id: 'new-department-id',
          name: 'Root Department',
        });
        mockDepartmentRepository.create.mockResolvedValue(newDepartment);

        await service.create({ name: 'Root Department' });

        expect(mockDepartmentRepository.findById).not.toHaveBeenCalled();
      });
    });

    describe('update', () => {
      it('rejects a new parent owned by another tenant with NotFoundException', async () => {
        const department = createMockDepartmentEntityWithChanges({
          id: 'dept-1',
          hasChanges: true,
          changes: { parentDepartmentId: 'parent-other-tenant' },
          version: 3,
        });
        const foreignParent = createMockDepartmentEntity({
          id: 'parent-other-tenant',
          tenantId: 'tenant-2',
        });
        // First findById -> the target department itself (in tenant-1).
        // Second findById -> the requested parent (in tenant-2).
        mockDepartmentRepository.findById.mockResolvedValueOnce(department).mockResolvedValueOnce(foreignParent);

        await expect(
          service.update('dept-1', {
            parentDepartmentId: 'parent-other-tenant',
            expectedVersion: 3,
          } as any),
        ).rejects.toThrow(NotFoundException);
        expect(mockDepartmentRepository.updateWithVersion).not.toHaveBeenCalled();
      });

      it('accepts a new parent owned by the same tenant', async () => {
        const department = createMockDepartmentEntityWithChanges({
          id: 'dept-1',
          hasChanges: true,
          changes: { parentDepartmentId: 'parent-same-tenant' },
          version: 3,
        });
        const sameTenantParent = createMockDepartmentEntity({
          id: 'parent-same-tenant',
          tenantId: 'tenant-1',
        });
        mockDepartmentRepository.findById.mockResolvedValueOnce(department).mockResolvedValueOnce(sameTenantParent);
        mockDepartmentRepository.updateWithVersion.mockResolvedValue({
          ...department,
          version: 4,
        });

        const result = await service.update('dept-1', {
          parentDepartmentId: 'parent-same-tenant',
          expectedVersion: 3,
        } as any);

        expect(result.id).toBe('dept-1');
        expect(mockDepartmentRepository.updateWithVersion).toHaveBeenCalled();
      });
    });
  });
});

// Helper for update / updatePromptConfig tests — entity with change
// tracking, version, and the BaseEntity-style `toObject()` shim the
// service depends on for audit logging.
function createMockDepartmentEntityWithChanges(
  overrides: {
    id?: string;
    hasChanges?: boolean;
    changes?: Record<string, unknown>;
    version?: number;
  } = {},
) {
  const base = createMockDepartmentEntity({ id: overrides.id, version: overrides.version });
  const entity = {
    ...base,
    hasChanges: overrides.hasChanges ?? true,
    changes: overrides.changes ?? {},
    toObject() {
      return { ...base, hasChanges: this.hasChanges, changes: this.changes };
    },
  };
  return entity;
}
