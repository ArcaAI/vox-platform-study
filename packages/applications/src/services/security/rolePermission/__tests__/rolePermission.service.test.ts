/**
 * RolePermissionService Unit Tests
 *
 * Tests for the RolePermissionService that handles role-permission assignment operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RolePermissionService } from '../rolePermission.service';
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

// Mock RolePermissionRepository - simulates database operations
const mockRolePermissionRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Creates a complete mock role permission entity matching the real RolePermissionEntity structure.
 * This ensures tests don't pass due to incomplete mock data (Anti-Pattern #4).
 */
const createMockRolePermissionEntity = (
    overrides: Partial<{
        id: string;
        roleId: string;
        permissionId: string;
        resourceStatus: ResourceStatusType;
        createdBy: string | null;
        updatedBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        hasChanges: boolean;
        changes: Record<string, unknown>;
    }> = {}
) => {
    const entity = {
        id: overrides.id ?? 'role-permission-id-1',
        roleId: overrides.roleId ?? 'role-id-1',
        permissionId: overrides.permissionId ?? 'permission-id-1',
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
        roleId: entity.roleId,
        permissionId: entity.permissionId,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

// Mock RolePermissionFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        RolePermissionFactory: {
            CreateRolePermission: vi.fn((data) => ({
                ...data,
                id: 'new-role-permission-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-role-permission-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
    };
});

describe('RolePermissionService', () => {
    let service: RolePermissionService;

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
        service = new RolePermissionService(
            mockRolePermissionRepository as any,
            mockEventEmitter as any,
            mockClsService as any
        );
    });

    describe('createRoleAssignment', () => {
        it('should create a new role-permission assignment with all required fields', async () => {
            const newRolePermission = createMockRolePermissionEntity({
                id: 'new-role-permission-id',
                roleId: 'role-123',
                permissionId: 'permission-456',
                createdBy: 'current-user-id',
            });
            mockRolePermissionRepository.create.mockResolvedValue(newRolePermission);

            const result = await service.createRoleAssignment({
                roleId: 'role-123',
                permissionId: 'permission-456',
            });

            // Verify the returned entity has correct data (testing behavior, not mock calls)
            expect(result.id).toBe('new-role-permission-id');
            expect(result.roleId).toBe('role-123');
            expect(result.permissionId).toBe('permission-456');
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newRolePermission = createMockRolePermissionEntity({
                id: 'new-role-permission-id',
                roleId: 'role-123',
                permissionId: 'permission-456',
                createdBy: 'current-user-id',
            });
            mockRolePermissionRepository.create.mockResolvedValue(newRolePermission);

            await service.createRoleAssignment({
                roleId: 'role-123',
                permissionId: 'permission-456',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-role-permission-id',
                    createdAt: newRolePermission.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockRolePermissionRepository.create.mockResolvedValue(null);

            await expect(
                service.createRoleAssignment({
                    roleId: 'role-123',
                    permissionId: 'permission-456',
                })
            ).rejects.toThrow('Failed to create RolePermissionEntity');
        });

        it('should handle repository errors gracefully', async () => {
            mockRolePermissionRepository.create.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(
                service.createRoleAssignment({
                    roleId: 'role-123',
                    permissionId: 'permission-456',
                })
            ).rejects.toThrow('Database connection failed');
        });

        it('should create assignment with different role and permission combinations', async () => {
            const combinations = [
                { roleId: 'admin-role', permissionId: 'read-users' },
                { roleId: 'user-role', permissionId: 'read-self' },
                { roleId: 'manager-role', permissionId: 'manage-team' },
            ];

            for (const combo of combinations) {
                const newRolePermission = createMockRolePermissionEntity({
                    id: `rp-${combo.roleId}-${combo.permissionId}`,
                    roleId: combo.roleId,
                    permissionId: combo.permissionId,
                });
                mockRolePermissionRepository.create.mockResolvedValue(newRolePermission);

                const result = await service.createRoleAssignment(combo);

                expect(result.roleId).toBe(combo.roleId);
                expect(result.permissionId).toBe(combo.permissionId);
            }
        });
    });

    describe('fetchAll', () => {
        it('should return paginated role-permissions with correct pagination metadata', async () => {
            const rolePermissions = [
                createMockRolePermissionEntity({
                    id: 'rp-1',
                    roleId: 'role-1',
                    permissionId: 'perm-1',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-2',
                    roleId: 'role-2',
                    permissionId: 'perm-2',
                }),
            ];
            mockRolePermissionRepository.findAll.mockResolvedValue(rolePermissions);
            mockRolePermissionRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual data is returned
            expect(result.data[0].roleId).toBe('role-1');
            expect(result.data[1].roleId).toBe('role-2');
        });

        it('should return empty result when no role-permissions exist', async () => {
            mockRolePermissionRepository.findAll.mockResolvedValue([]);
            mockRolePermissionRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should emit ResourceViewed event with role-permission IDs', async () => {
            const rolePermissions = [
                createMockRolePermissionEntity({ id: 'rp-1' }),
                createMockRolePermissionEntity({ id: 'rp-2' }),
            ];
            mockRolePermissionRepository.findAll.mockResolvedValue(rolePermissions);
            mockRolePermissionRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['rp-1', 'rp-2'] },
                })
            );
        });

        it('should pass search parameter to repository', async () => {
            mockRolePermissionRepository.findAll.mockResolvedValue([]);
            mockRolePermissionRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'admin' });

            expect(mockRolePermissionRepository.count).toHaveBeenCalledWith({
                search: 'admin',
            });
        });

        it('should handle pagination correctly for middle pages', async () => {
            const rolePermissions = [createMockRolePermissionEntity({ id: 'rp-21' })];
            mockRolePermissionRepository.findAll.mockResolvedValue(rolePermissions);
            mockRolePermissionRepository.count.mockResolvedValue(25);

            const result = await service.fetchAll({ limit: 10, page: 3 });

            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(25);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(3);
        });

        it('should handle large pagination values', async () => {
            mockRolePermissionRepository.findAll.mockResolvedValue([]);
            mockRolePermissionRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });
    });

    describe('fetchAllByRoleId', () => {
        it('should return role-permissions for specific role', async () => {
            const rolePermissions = [
                createMockRolePermissionEntity({ id: 'rp-1', roleId: 'role-123' }),
                createMockRolePermissionEntity({ id: 'rp-2', roleId: 'role-123' }),
            ];
            mockRolePermissionRepository.findAll.mockResolvedValue(rolePermissions);
            mockRolePermissionRepository.count.mockResolvedValue(2);

            const result = await service.fetchAllByRoleId({
                limit: 10,
                page: 1,
                roleId: 'role-123',
            });

            expect(result.data).toHaveLength(2);
            expect(mockRolePermissionRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { roleId: 'role-123' },
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { roleId: 'role-123', items: ['rp-1', 'rp-2'] },
                })
            );
        });

        it('should return empty result when role has no permissions', async () => {
            mockRolePermissionRepository.findAll.mockResolvedValue([]);
            mockRolePermissionRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByRoleId({
                limit: 10,
                page: 1,
                roleId: 'non-existent-role',
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search parameter with role filter', async () => {
            mockRolePermissionRepository.findAll.mockResolvedValue([]);
            mockRolePermissionRepository.count.mockResolvedValue(0);

            await service.fetchAllByRoleId({
                limit: 10,
                page: 1,
                roleId: 'role-123',
                search: 'read',
            });

            expect(mockRolePermissionRepository.count).toHaveBeenCalledWith({
                search: 'read',
                where: { roleId: 'role-123' },
            });
        });

        it('should handle multiple permissions for same role', async () => {
            const rolePermissions = [
                createMockRolePermissionEntity({
                    id: 'rp-1',
                    roleId: 'role-123',
                    permissionId: 'perm-1',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-2',
                    roleId: 'role-123',
                    permissionId: 'perm-2',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-3',
                    roleId: 'role-123',
                    permissionId: 'perm-3',
                }),
            ];
            mockRolePermissionRepository.findAll.mockResolvedValue(rolePermissions);
            mockRolePermissionRepository.count.mockResolvedValue(3);

            const result = await service.fetchAllByRoleId({
                limit: 10,
                page: 1,
                roleId: 'role-123',
            });

            expect(result.data).toHaveLength(3);
            expect(result.count).toBe(3);
        });
    });

    describe('fetchById', () => {
        it('should return role-permission by ID with complete data', async () => {
            const rolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                roleId: 'role-456',
                permissionId: 'perm-789',
            });
            mockRolePermissionRepository.findById.mockResolvedValue(rolePermission);

            const result = await service.fetchById('rp-123');

            expect(result.id).toBe('rp-123');
            expect(result.roleId).toBe('role-456');
            expect(result.permissionId).toBe('perm-789');
        });

        it('should emit ResourceViewed event with role-permission data', async () => {
            const rolePermission = createMockRolePermissionEntity({ id: 'rp-123' });
            mockRolePermissionRepository.findById.mockResolvedValue(rolePermission);

            await service.fetchById('rp-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockRolePermissionRepository.findById.mockRejectedValue(
                new Error('Role permission not found')
            );

            await expect(service.fetchById('non-existent')).rejects.toThrow(
                'Role permission not found'
            );
        });
    });

    describe('update', () => {
        it('should update role-permission successfully', async () => {
            const existingRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                hasChanges: true,
                changes: { roleId: 'new-role-id' },
            });
            mockRolePermissionRepository.findById.mockResolvedValue(
                existingRolePermission
            );
            mockRolePermissionRepository.update.mockResolvedValue(
                existingRolePermission
            );

            const result = await service.update('rp-123', { roleId: 'new-role-id' });

            expect(result.id).toBe('rp-123');
            expect(mockRolePermissionRepository.update).toHaveBeenCalledWith(
                'rp-123',
                existingRolePermission
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'rp-123',
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                hasChanges: false,
            });
            mockRolePermissionRepository.findById.mockResolvedValue(
                existingRolePermission
            );

            await expect(
                service.update('rp-123', { roleId: 'same-role-id' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update roleId', async () => {
            const existingRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                hasChanges: true,
                changes: { roleId: 'updated-role-id' },
            });
            mockRolePermissionRepository.findById.mockResolvedValue(
                existingRolePermission
            );
            mockRolePermissionRepository.update.mockResolvedValue(
                existingRolePermission
            );

            const result = await service.update('rp-123', {
                roleId: 'updated-role-id',
            });

            expect(result.id).toBe('rp-123');
        });

        it('should update permissionId', async () => {
            const existingRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                hasChanges: true,
                changes: { permissionId: 'updated-permission-id' },
            });
            mockRolePermissionRepository.findById.mockResolvedValue(
                existingRolePermission
            );
            mockRolePermissionRepository.update.mockResolvedValue(
                existingRolePermission
            );

            const result = await service.update('rp-123', {
                permissionId: 'updated-permission-id',
            });

            expect(result.id).toBe('rp-123');
        });

        it('should emit ResourceUpdated event with changes and previousData', async () => {
            const existingRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                hasChanges: true,
                changes: { roleId: 'new-role-id' },
            });
            mockRolePermissionRepository.findById.mockResolvedValue(
                existingRolePermission
            );
            mockRolePermissionRepository.update.mockResolvedValue(
                existingRolePermission
            );

            await service.update('rp-123', { roleId: 'new-role-id' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'rp-123',
                    data: { roleId: 'new-role-id' },
                    previousData: expect.any(Object),
                })
            );
        });
    });

    describe('deleteById', () => {
        it('should soft delete role-permission and return deleted entity', async () => {
            const deletedRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                deletedAt: new Date(),
            });
            mockRolePermissionRepository.softDelete.mockResolvedValue(
                deletedRolePermission
            );

            const result = await service.deleteById('rp-123');

            expect(result.id).toBe('rp-123');
            expect(mockRolePermissionRepository.softDelete).toHaveBeenCalledWith(
                'rp-123'
            );
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedRolePermission = createMockRolePermissionEntity({
                id: 'rp-123',
                roleId: 'role-456',
                permissionId: 'perm-789',
            });
            mockRolePermissionRepository.softDelete.mockResolvedValue(
                deletedRolePermission
            );

            await service.deleteById('rp-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'rp-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockRolePermissionRepository.softDelete.mockRejectedValue(
                new Error('Delete failed')
            );

            await expect(service.deleteById('rp-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newRolePermission = createMockRolePermissionEntity({
                id: 'new-role-permission-id',
            });
            mockRolePermissionRepository.create.mockResolvedValue(newRolePermission);

            const result = await service.createRoleAssignment({
                roleId: 'role-123',
                permissionId: 'permission-456',
            });

            expect(result.id).toBe('new-role-permission-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockRolePermissionRepository.findAll.mockResolvedValue([]);
            mockRolePermissionRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle fetching by role ID with multiple permissions', async () => {
            const rolePermissions = [
                createMockRolePermissionEntity({
                    id: 'rp-1',
                    roleId: 'admin-role',
                    permissionId: 'read-users',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-2',
                    roleId: 'admin-role',
                    permissionId: 'write-users',
                }),
                createMockRolePermissionEntity({
                    id: 'rp-3',
                    roleId: 'admin-role',
                    permissionId: 'delete-users',
                }),
            ];
            mockRolePermissionRepository.findAll.mockResolvedValue(rolePermissions);
            mockRolePermissionRepository.count.mockResolvedValue(3);

            const result = await service.fetchAllByRoleId({
                limit: 10,
                page: 1,
                roleId: 'admin-role',
            });

            expect(result.data).toHaveLength(3);
            expect(result.data.every((rp) => rp.roleId === 'admin-role')).toBe(true);
        });
    });
});
