/**
 * RoleService Unit Tests
 *
 * Tests for the RoleService that handles role management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { RoleService } from '../role.service';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock RoleRepository - simulates database operations
const mockRoleRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};

/**
 * Creates a complete mock role entity matching the real RoleEntity structure.
 * This ensures tests don't pass due to incomplete mock data (Anti-Pattern #4).
 */
const createMockRoleEntity = (
  overrides: Partial<{
    id: string;
    name: string;
    description: string | null;
    externalName: string | null;
    externalId: string | null;
    isSystemRole: boolean;
    parentRoleId: string | null;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
  }> = {},
) => {
  const entity = {
    id: overrides.id ?? 'role-id-1',
    name: overrides.name ?? 'Test Role',
    description: overrides.description ?? null,
    externalName: overrides.externalName ?? null,
    externalId: overrides.externalId ?? null,
    isSystemRole: overrides.isSystemRole ?? false,
    parentRoleId: overrides.parentRoleId ?? null,
    resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
    createdBy: overrides.createdBy ?? null,
    updatedBy: overrides.updatedBy ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
    deletedAt: overrides.deletedAt ?? null,
    hasChanges: overrides.hasChanges ?? false,
    changes: overrides.changes ?? {},
    toObject: vi.fn(),
  };
  // Make toObject return a complete representation
  entity.toObject.mockReturnValue({
    id: entity.id,
    name: entity.name,
    description: entity.description,
    externalName: entity.externalName,
    externalId: entity.externalId,
    isSystemRole: entity.isSystemRole,
    parentRoleId: entity.parentRoleId,
    resourceStatus: entity.resourceStatus,
    createdBy: entity.createdBy,
    updatedBy: entity.updatedBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt,
  });
  return entity;
};

// Mock RoleFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    RoleFactory: {
      CreateRole: vi.fn((data) => ({
        ...data,
        id: 'new-role-id',
        resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        toObject: vi.fn().mockReturnValue({
          id: 'new-role-id',
          ...data,
          resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
        }),
      })),
    },
  };
});

describe('RoleService', () => {
  let service: RoleService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: return valid user from CLS - complete user context
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return {
            id: 'current-user-id',
            firstName: 'Test',
            lastName: 'User',
            email: 'test@example.com',
          };
        case 'tenantId':
          return 'tenant-1';
        case 'tenantCode':
          return 'TENANT_1';
        case 'correlationId':
          return 'corr-123';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });

    // Create service instance with mocks
    service = new RoleService(mockRoleRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('create', () => {
    it('should create a new role with all required fields', async () => {
      const newRole = createMockRoleEntity({
        id: 'new-role-id',
        name: 'New Role',
        description: 'A new role',
        createdBy: 'current-user-id',
      });
      mockRoleRepository.create.mockResolvedValue(newRole);

      const result = await service.create({
        name: 'New Role',
        description: 'A new role',
      });

      // Verify the returned entity has correct data (testing behavior, not mock calls)
      expect(result.id).toBe('new-role-id');
      expect(result.name).toBe('New Role');
      expect(result.description).toBe('A new role');
    });

    it('should emit ResourceCreated event with complete event data', async () => {
      const newRole = createMockRoleEntity({
        id: 'new-role-id',
        createdBy: 'current-user-id',
      });
      mockRoleRepository.create.mockResolvedValue(newRole);

      await service.create({
        name: 'New Role',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-role-id',
          createdAt: newRole.createdAt,
          responsibleEntityId: 'current-user-id',
          responsibleIp: '192.168.1.1',
          correlationId: 'corr-123',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should throw InternalServerErrorException when repository returns null', async () => {
      mockRoleRepository.create.mockResolvedValue(null);

      await expect(
        service.create({
          name: 'New Role',
        }),
      ).rejects.toThrow('Failed to create RoleEntity');
    });

    it('should create role with optional description field', async () => {
      const newRole = createMockRoleEntity({
        id: 'new-role-id',
        description: 'Test description',
      });
      mockRoleRepository.create.mockResolvedValue(newRole);

      const result = await service.create({
        name: 'New Role',
        description: 'Test description',
      });

      expect(result.description).toBe('Test description');
    });

    it('should handle repository errors gracefully', async () => {
      mockRoleRepository.create.mockRejectedValue(new Error('Database connection failed'));

      await expect(
        service.create({
          name: 'New Role',
        }),
      ).rejects.toThrow('Database connection failed');
    });

    it('should create role without description', async () => {
      const newRole = createMockRoleEntity({
        id: 'new-role-id',
        name: 'Minimal Role',
        description: null,
      });
      mockRoleRepository.create.mockResolvedValue(newRole);

      const result = await service.create({
        name: 'Minimal Role',
      });

      expect(result.id).toBe('new-role-id');
      expect(result.name).toBe('Minimal Role');
      expect(result.description).toBeNull();
    });
  });

  describe('fetchAll', () => {
    it('should return paginated roles with correct pagination metadata', async () => {
      const roles = [createMockRoleEntity({ id: 'role-1', name: 'Role 1' }), createMockRoleEntity({ id: 'role-2', name: 'Role 2' })];
      mockRoleRepository.findAll.mockResolvedValue(roles);
      mockRoleRepository.count.mockResolvedValue(2);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
      // Verify actual role data is returned
      expect(result.data[0].name).toBe('Role 1');
      expect(result.data[1].name).toBe('Role 2');
    });

    it('coerces Role-typed filter values via the model registry', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, filters: 'isSystemRole[equals]:true;version[gte]:2' });

      const expectedFilters = { isSystemRole: { equals: true }, version: { gte: 2 } };
      expect(mockRoleRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ filters: expectedFilters }));
      expect(mockRoleRepository.count).toHaveBeenCalledWith(expect.objectContaining({ filters: expectedFilters }));
    });

    it('should return empty result when no roles exist', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should emit ResourceViewed event with role IDs', async () => {
      const roles = [createMockRoleEntity({ id: 'role-1' }), createMockRoleEntity({ id: 'role-2' })];
      mockRoleRepository.findAll.mockResolvedValue(roles);
      mockRoleRepository.count.mockResolvedValue(2);

      await service.fetchAll({ limit: 10, page: 1 });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { items: ['role-1', 'role-2'] },
        }),
      );
    });

    it('should pass search parameter to repository', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, search: 'admin' });

      expect(mockRoleRepository.count).toHaveBeenCalledWith({ search: 'admin' });
    });

    it('should handle pagination correctly for middle pages', async () => {
      const roles = [createMockRoleEntity({ id: 'role-21' })];
      mockRoleRepository.findAll.mockResolvedValue(roles);
      mockRoleRepository.count.mockResolvedValue(25);

      const result = await service.fetchAll({ limit: 10, page: 3 });

      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(25);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(3);
    });

    it('should handle large pagination values', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(1000);

      const result = await service.fetchAll({ limit: 100, page: 10 });

      expect(result.limit).toBe(100);
      expect(result.page).toBe(10);
      expect(result.count).toBe(1000);
    });
  });

  describe('fetchAllByTenantId', () => {
    it('should throw NotImplementedException', async () => {
      await expect(service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-1' })).rejects.toThrow(NotImplementedException);
    });
  });

  describe('fetchAllCreatedByUser', () => {
    it('should return roles created by specific user', async () => {
      const roles = [
        createMockRoleEntity({
          id: 'role-1',
          name: 'User Role',
          createdBy: 'creator-id',
        }),
      ];
      mockRoleRepository.findAll.mockResolvedValue(roles);
      mockRoleRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].createdBy).toBe('creator-id');
      expect(mockRoleRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdBy: 'creator-id' },
        }),
      );
    });

    it('should emit event with createdBy in data', async () => {
      const roles = [createMockRoleEntity({ id: 'role-1', createdBy: 'creator-id' })];
      mockRoleRepository.findAll.mockResolvedValue(roles);
      mockRoleRepository.count.mockResolvedValue(1);

      await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { createdBy: 'creator-id', items: ['role-1'] },
        }),
      );
    });

    it('should return empty result when user has no roles', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(0);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'non-existent-user',
      });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should pass search parameter with user filter', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(0);

      await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
        search: 'admin',
      });

      expect(mockRoleRepository.count).toHaveBeenCalledWith({
        search: 'admin',
        where: { createdBy: 'creator-id' },
      });
    });
  });

  describe('fetchById', () => {
    it('should return role by ID with complete data', async () => {
      const role = createMockRoleEntity({
        id: 'role-123',
        name: 'Test Role',
        description: 'Test description',
      });
      mockRoleRepository.findById.mockResolvedValue(role);

      const result = await service.fetchById('role-123');

      expect(result.id).toBe('role-123');
      expect(result.name).toBe('Test Role');
      expect(result.description).toBe('Test description');
    });

    it('should emit ResourceViewed event with role data', async () => {
      const role = createMockRoleEntity({ id: 'role-123' });
      mockRoleRepository.findById.mockResolvedValue(role);

      await service.fetchById('role-123');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should propagate repository errors', async () => {
      mockRoleRepository.findById.mockRejectedValue(new Error('Role not found'));

      await expect(service.fetchById('non-existent')).rejects.toThrow('Role not found');
    });
  });

  describe('update', () => {
    it('should update role successfully and return updated entity', async () => {
      const existingRole = createMockRoleEntity({
        id: 'role-123',
        name: 'Old Name',
        hasChanges: true,
        changes: { name: 'Updated Role' },
      });
      mockRoleRepository.findById.mockResolvedValue(existingRole);
      mockRoleRepository.update.mockResolvedValue(existingRole);

      const result = await service.update('role-123', { name: 'Updated Role' });

      expect(result.id).toBe('role-123');
      expect(mockRoleRepository.update).toHaveBeenCalledWith('role-123', existingRole);
    });

    it('should emit ResourceUpdated event with changes and previous data', async () => {
      const existingRole = createMockRoleEntity({
        id: 'role-123',
        hasChanges: true,
        changes: { name: 'Updated Role' },
      });
      mockRoleRepository.findById.mockResolvedValue(existingRole);
      mockRoleRepository.update.mockResolvedValue(existingRole);

      await service.update('role-123', { name: 'Updated Role' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'role-123',
          data: { name: 'Updated Role' },
        }),
      );
    });

    it('should throw ArgumentInvalidException when no changes detected', async () => {
      const existingRole = createMockRoleEntity({
        id: 'role-123',
        hasChanges: false,
      });
      mockRoleRepository.findById.mockResolvedValue(existingRole);

      await expect(service.update('role-123', { name: 'Same Name' })).rejects.toThrow('No changes to write to');
    });

    it('should update role description', async () => {
      const existingRole = createMockRoleEntity({
        id: 'role-123',
        description: 'Old description',
        hasChanges: true,
        changes: { description: 'New description' },
      });
      mockRoleRepository.findById.mockResolvedValue(existingRole);
      mockRoleRepository.update.mockResolvedValue(existingRole);

      const result = await service.update('role-123', {
        description: 'New description',
      });

      expect(result.id).toBe('role-123');
    });

    it('should update multiple fields at once', async () => {
      const existingRole = createMockRoleEntity({
        id: 'role-123',
        hasChanges: true,
        changes: { name: 'New Name', description: 'New Description' },
      });
      mockRoleRepository.findById.mockResolvedValue(existingRole);
      mockRoleRepository.update.mockResolvedValue(existingRole);

      await service.update('role-123', {
        name: 'New Name',
        description: 'New Description',
      });

      expect(mockRoleRepository.update).toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('should soft delete role and return deleted entity', async () => {
      const deletedRole = createMockRoleEntity({
        id: 'role-123',
        deletedAt: new Date(),
      });
      mockRoleRepository.softDelete.mockResolvedValue(deletedRole);

      const result = await service.deleteById('role-123');

      expect(result.id).toBe('role-123');
      expect(mockRoleRepository.softDelete).toHaveBeenCalledWith('role-123');
    });

    it('should emit ResourceDeleted event with complete data', async () => {
      const deletedRole = createMockRoleEntity({
        id: 'role-123',
        name: 'Deleted Role',
      });
      mockRoleRepository.softDelete.mockResolvedValue(deletedRole);

      await service.deleteById('role-123');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'role-123',
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should propagate repository errors on delete', async () => {
      mockRoleRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

      await expect(service.deleteById('role-123')).rejects.toThrow('Delete failed');
    });
  });

  describe('edge cases', () => {
    it('should handle service creation without user context', async () => {
      // No USER (so `createdBy` is undefined) but the tenant context stands —
      // TASK-766 OD-1 made `Role` tenant-scoped, and the two are separate axes.
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : null));

      const newRole = createMockRoleEntity({ id: 'new-role-id' });
      mockRoleRepository.create.mockResolvedValue(newRole);

      const result = await service.create({
        name: 'New Role',
      });

      expect(result.id).toBe('new-role-id');
    });

    it('refuses to create a role with no tenant context at all (TASK-766 OD-1)', async () => {
      // `Role` is tenant-scoped and `tenantId` has no default, so a create with
      // neither an explicit tenant nor a CLS tenant must fail loudly here
      // rather than reaching Prisma and dying on the NOT NULL.
      mockClsService.get.mockImplementation(() => null);

      await expect(service.create({ name: 'New Role' })).rejects.toThrow(/Tenant context is required/);
      expect(mockRoleRepository.create).not.toHaveBeenCalled();
    });

    it('should handle empty search results gracefully', async () => {
      mockRoleRepository.findAll.mockResolvedValue([]);
      mockRoleRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should handle roles with external identifiers', async () => {
      const role = createMockRoleEntity({
        id: 'role-123',
        externalName: 'External Role Name',
        externalId: 'ext-role-123',
      });
      mockRoleRepository.findById.mockResolvedValue(role);

      const result = await service.fetchById('role-123');

      expect(result.externalName).toBe('External Role Name');
      expect(result.externalId).toBe('ext-role-123');
    });

    it('should handle system roles', async () => {
      const systemRole = createMockRoleEntity({
        id: 'system-role-123',
        name: 'System Admin',
        isSystemRole: true,
      });
      mockRoleRepository.findById.mockResolvedValue(systemRole);

      const result = await service.fetchById('system-role-123');

      expect(result.isSystemRole).toBe(true);
    });
  });
});
