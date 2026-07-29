/**
 * PermissionService Unit Tests
 *
 * Tests for the PermissionService that handles permission management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { PermissionService } from '../permission.service';
import { SysEventType, PermissionAction, ResourceStatusType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock PermissionRepository - simulates database operations
const mockPermissionRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};

/**
 * Creates a complete mock permission entity matching the real PermissionEntity structure.
 * This ensures tests don't pass due to incomplete mock data (Anti-Pattern #4).
 */
const createMockPermissionEntity = (
  overrides: Partial<{
    id: string;
    name: string;
    description: string | null;
    permissionAction: PermissionAction;
    resourceTypeName: string;
    conditions: object | null;
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
    id: overrides.id ?? 'permission-id-1',
    name: overrides.name ?? 'Test Permission',
    description: overrides.description ?? null,
    permissionAction: overrides.permissionAction ?? PermissionAction.READ,
    resourceTypeName: overrides.resourceTypeName ?? 'User',
    conditions: overrides.conditions ?? null,
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
    permissionAction: entity.permissionAction,
    resourceTypeName: entity.resourceTypeName,
    conditions: entity.conditions,
    resourceStatus: entity.resourceStatus,
    createdBy: entity.createdBy,
    updatedBy: entity.updatedBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt,
  });
  return entity;
};

// Mock PermissionFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    PermissionFactory: {
      CreatePermission: vi.fn((data) => ({
        ...data,
        id: 'new-permission-id',
        resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        toObject: vi.fn().mockReturnValue({
          id: 'new-permission-id',
          ...data,
          resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
        }),
      })),
    },
  };
});

describe('PermissionService', () => {
  let service: PermissionService;

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
    service = new PermissionService(mockPermissionRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('create', () => {
    it('should create a new permission with all required fields', async () => {
      const newPermission = createMockPermissionEntity({
        id: 'new-permission-id',
        name: 'New Permission',
        description: 'A new permission',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
        createdBy: 'current-user-id',
      });
      mockPermissionRepository.create.mockResolvedValue(newPermission);

      const result = await service.create({
        name: 'New Permission',
        description: 'A new permission',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
      });

      // Verify the returned entity has correct data (testing behavior, not mock calls)
      expect(result.id).toBe('new-permission-id');
      expect(result.name).toBe('New Permission');
      expect(result.description).toBe('A new permission');
      expect(result.permissionAction).toBe(PermissionAction.READ);
      expect(result.resourceTypeName).toBe('User');
    });

    it('should emit ResourceCreated event with complete event data', async () => {
      const newPermission = createMockPermissionEntity({
        id: 'new-permission-id',
        createdBy: 'current-user-id',
      });
      mockPermissionRepository.create.mockResolvedValue(newPermission);

      await service.create({
        name: 'New Permission',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-permission-id',
          createdAt: newPermission.createdAt,
          responsibleEntityId: 'current-user-id',
          responsibleIp: '192.168.1.1',
          correlationId: 'corr-123',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should throw InternalServerErrorException when repository returns null', async () => {
      mockPermissionRepository.create.mockResolvedValue(null);

      await expect(
        service.create({
          name: 'New Permission',
          permissionAction: PermissionAction.READ,
          resourceTypeName: 'User',
        }),
      ).rejects.toThrow('Failed to create PermissionEntity');
    });

    it('should create permission with optional description field', async () => {
      const newPermission = createMockPermissionEntity({
        id: 'new-permission-id',
        description: 'Test description',
      });
      mockPermissionRepository.create.mockResolvedValue(newPermission);

      const result = await service.create({
        name: 'New Permission',
        description: 'Test description',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
      });

      expect(result.description).toBe('Test description');
    });

    it('should create permission with conditions', async () => {
      const conditions = { field: 'status', operator: 'eq', value: 'active' };
      const newPermission = createMockPermissionEntity({
        id: 'new-permission-id',
        conditions,
      });
      mockPermissionRepository.create.mockResolvedValue(newPermission);

      const result = await service.create({
        name: 'New Permission',
        permissionAction: PermissionAction.CREATE,
        resourceTypeName: 'Role',
        conditions,
      });

      expect(result.conditions).toEqual(conditions);
    });

    it('should create permission with different permission actions', async () => {
      const actions = [PermissionAction.CREATE, PermissionAction.READ, PermissionAction.UPDATE, PermissionAction.DELETE];

      for (const action of actions) {
        const newPermission = createMockPermissionEntity({
          id: `permission-${action}`,
          permissionAction: action,
        });
        mockPermissionRepository.create.mockResolvedValue(newPermission);

        const result = await service.create({
          name: `Permission ${action}`,
          permissionAction: action,
          resourceTypeName: 'User',
        });

        expect(result.id).toBe(`permission-${action}`);
        expect(result.permissionAction).toBe(action);
      }
    });

    it('should handle repository errors gracefully', async () => {
      mockPermissionRepository.create.mockRejectedValue(new Error('Database connection failed'));

      await expect(
        service.create({
          name: 'New Permission',
          permissionAction: PermissionAction.READ,
          resourceTypeName: 'User',
        }),
      ).rejects.toThrow('Database connection failed');
    });
  });

  describe('fetchAll', () => {
    it('should return paginated permissions with correct pagination metadata', async () => {
      const permissions = [
        createMockPermissionEntity({ id: 'permission-1', name: 'Permission 1' }),
        createMockPermissionEntity({ id: 'permission-2', name: 'Permission 2' }),
      ];
      mockPermissionRepository.findAll.mockResolvedValue(permissions);
      mockPermissionRepository.count.mockResolvedValue(2);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
      // Verify actual permission data is returned
      expect(result.data[0].name).toBe('Permission 1');
      expect(result.data[1].name).toBe('Permission 2');
    });

    it('should return empty result when no permissions exist', async () => {
      mockPermissionRepository.findAll.mockResolvedValue([]);
      mockPermissionRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should emit ResourceViewed event with permission IDs', async () => {
      const permissions = [createMockPermissionEntity({ id: 'permission-1' }), createMockPermissionEntity({ id: 'permission-2' })];
      mockPermissionRepository.findAll.mockResolvedValue(permissions);
      mockPermissionRepository.count.mockResolvedValue(2);

      await service.fetchAll({ limit: 10, page: 1 });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { items: ['permission-1', 'permission-2'] },
        }),
      );
    });

    it('should pass search parameter to repository', async () => {
      mockPermissionRepository.findAll.mockResolvedValue([]);
      mockPermissionRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, search: 'admin' });

      expect(mockPermissionRepository.count).toHaveBeenCalledWith({
        search: 'admin',
      });
    });

    it('should handle pagination correctly for middle pages', async () => {
      const permissions = [createMockPermissionEntity({ id: 'permission-21' })];
      mockPermissionRepository.findAll.mockResolvedValue(permissions);
      mockPermissionRepository.count.mockResolvedValue(25);

      const result = await service.fetchAll({ limit: 10, page: 3 });

      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(25);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(3);
    });

    it('should handle large pagination values', async () => {
      mockPermissionRepository.findAll.mockResolvedValue([]);
      mockPermissionRepository.count.mockResolvedValue(1000);

      const result = await service.fetchAll({ limit: 100, page: 10 });

      expect(result.limit).toBe(100);
      expect(result.page).toBe(10);
      expect(result.count).toBe(1000);
    });
  });

  describe('fetchAllByTenantId', () => {
    it('should throw NotImplementedException', async () => {
      await expect(
        service.fetchAllByTenantId({
          limit: 10,
          page: 1,
          tenantId: 'tenant-1',
        }),
      ).rejects.toThrow(NotImplementedException);
    });
  });

  describe('fetchAllCreatedByUser', () => {
    it('should return permissions created by specific user', async () => {
      const permissions = [
        createMockPermissionEntity({
          id: 'permission-1',
          name: 'User Permission',
          createdBy: 'creator-id',
        }),
      ];
      mockPermissionRepository.findAll.mockResolvedValue(permissions);
      mockPermissionRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].createdBy).toBe('creator-id');
      expect(mockPermissionRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdBy: 'creator-id' },
        }),
      );
    });

    it('should emit event with createdBy in data', async () => {
      const permissions = [createMockPermissionEntity({ id: 'permission-1', createdBy: 'creator-id' })];
      mockPermissionRepository.findAll.mockResolvedValue(permissions);
      mockPermissionRepository.count.mockResolvedValue(1);

      await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { createdBy: 'creator-id', items: ['permission-1'] },
        }),
      );
    });

    it('should return empty result when user has no permissions', async () => {
      mockPermissionRepository.findAll.mockResolvedValue([]);
      mockPermissionRepository.count.mockResolvedValue(0);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'non-existent-user',
      });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should pass search parameter with user filter', async () => {
      mockPermissionRepository.findAll.mockResolvedValue([]);
      mockPermissionRepository.count.mockResolvedValue(0);

      await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
        search: 'admin',
      });

      expect(mockPermissionRepository.count).toHaveBeenCalledWith({
        search: 'admin',
        where: { createdBy: 'creator-id' },
      });
    });
  });

  describe('fetchById', () => {
    it('should return permission by ID with complete data', async () => {
      const permission = createMockPermissionEntity({
        id: 'permission-123',
        name: 'Test Permission',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
      });
      mockPermissionRepository.findById.mockResolvedValue(permission);

      const result = await service.fetchById('permission-123');

      expect(result.id).toBe('permission-123');
      expect(result.name).toBe('Test Permission');
      expect(result.permissionAction).toBe(PermissionAction.READ);
      expect(result.resourceTypeName).toBe('User');
    });

    it('should emit ResourceViewed event with permission data', async () => {
      const permission = createMockPermissionEntity({
        id: 'permission-123',
        name: 'Test Permission',
      });
      mockPermissionRepository.findById.mockResolvedValue(permission);

      await service.fetchById('permission-123');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should propagate repository errors', async () => {
      mockPermissionRepository.findById.mockRejectedValue(new Error('Permission not found'));

      await expect(service.fetchById('non-existent')).rejects.toThrow('Permission not found');
    });
  });

  describe('update', () => {
    it('should update permission successfully and return updated entity', async () => {
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        name: 'Old Name',
        hasChanges: true,
        changes: { name: 'Updated Permission' },
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);
      mockPermissionRepository.update.mockResolvedValue(existingPermission);

      const result = await service.update('permission-123', {
        name: 'Updated Permission',
      });

      expect(result.id).toBe('permission-123');
      expect(mockPermissionRepository.update).toHaveBeenCalledWith('permission-123', existingPermission);
    });

    it('should emit ResourceUpdated event with changes and previous data', async () => {
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        hasChanges: true,
        changes: { name: 'Updated Permission' },
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);
      mockPermissionRepository.update.mockResolvedValue(existingPermission);

      await service.update('permission-123', { name: 'Updated Permission' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'permission-123',
          data: { name: 'Updated Permission' },
        }),
      );
    });

    it('should throw ArgumentInvalidException when no changes detected', async () => {
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        hasChanges: false,
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);

      await expect(service.update('permission-123', { name: 'Same Name' })).rejects.toThrow('No changes to write to');
    });

    it('should update permission description', async () => {
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        description: 'Old description',
        hasChanges: true,
        changes: { description: 'New description' },
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);
      mockPermissionRepository.update.mockResolvedValue(existingPermission);

      const result = await service.update('permission-123', {
        description: 'New description',
      });

      expect(result.id).toBe('permission-123');
    });

    it('should update permission action', async () => {
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        permissionAction: PermissionAction.READ,
        hasChanges: true,
        changes: { permissionAction: PermissionAction.DELETE },
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);
      mockPermissionRepository.update.mockResolvedValue(existingPermission);

      const result = await service.update('permission-123', {
        permissionAction: PermissionAction.DELETE,
      });

      expect(result.id).toBe('permission-123');
    });

    it('should update permission conditions', async () => {
      const newConditions = { newField: 'newValue' };
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        hasChanges: true,
        changes: { conditions: newConditions },
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);
      mockPermissionRepository.update.mockResolvedValue(existingPermission);

      const result = await service.update('permission-123', {
        conditions: newConditions,
      });

      expect(result.id).toBe('permission-123');
    });

    it('should update multiple fields at once', async () => {
      const existingPermission = createMockPermissionEntity({
        id: 'permission-123',
        hasChanges: true,
        changes: { name: 'New Name', description: 'New Description' },
      });
      mockPermissionRepository.findById.mockResolvedValue(existingPermission);
      mockPermissionRepository.update.mockResolvedValue(existingPermission);

      await service.update('permission-123', {
        name: 'New Name',
        description: 'New Description',
      });

      expect(mockPermissionRepository.update).toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('should soft delete permission and return deleted entity', async () => {
      const deletedPermission = createMockPermissionEntity({
        id: 'permission-123',
        deletedAt: new Date(),
      });
      mockPermissionRepository.softDelete.mockResolvedValue(deletedPermission);

      const result = await service.deleteById('permission-123');

      expect(result.id).toBe('permission-123');
      expect(mockPermissionRepository.softDelete).toHaveBeenCalledWith('permission-123');
    });

    it('should emit ResourceDeleted event with complete data', async () => {
      const deletedPermission = createMockPermissionEntity({
        id: 'permission-123',
        name: 'Deleted Permission',
      });
      mockPermissionRepository.softDelete.mockResolvedValue(deletedPermission);

      await service.deleteById('permission-123');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'permission-123',
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should propagate repository errors on delete', async () => {
      mockPermissionRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

      await expect(service.deleteById('permission-123')).rejects.toThrow('Delete failed');
    });
  });

  describe('edge cases', () => {
    it('should handle service creation without user context', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return null;
        return null;
      });

      const newPermission = createMockPermissionEntity({ id: 'new-permission-id' });
      mockPermissionRepository.create.mockResolvedValue(newPermission);

      const result = await service.create({
        name: 'New Permission',
        permissionAction: PermissionAction.READ,
        resourceTypeName: 'User',
      });

      expect(result.id).toBe('new-permission-id');
    });

    it('should handle empty search results gracefully', async () => {
      mockPermissionRepository.findAll.mockResolvedValue([]);
      mockPermissionRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should handle permissions with complex conditions', async () => {
      const complexConditions = {
        and: [
          { field: 'status', operator: 'eq', value: 'active' },
          { field: 'role', operator: 'in', value: ['admin', 'manager'] },
        ],
      };
      const permission = createMockPermissionEntity({
        id: 'permission-123',
        conditions: complexConditions,
      });
      mockPermissionRepository.findById.mockResolvedValue(permission);

      const result = await service.fetchById('permission-123');

      expect(result.conditions).toEqual(complexConditions);
    });
  });
});
