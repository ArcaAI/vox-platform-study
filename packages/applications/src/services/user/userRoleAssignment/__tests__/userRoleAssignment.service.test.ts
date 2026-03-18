/**
 * UserRoleAssignmentService Unit Tests
 *
 * Tests for the UserRoleAssignmentService that handles user role assignment operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserRoleAssignmentService } from '../userRoleAssignment.service';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
    get: vi.fn(),
    set: vi.fn()
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
    emit: vi.fn()
};

// Mock UserRoleAssignmentRepository - simulates database operations
const mockUserRoleAssignmentRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn()
};

/**
 * Creates a complete mock user role assignment entity matching the real entity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserRoleAssignmentEntity = (
    overrides: Partial<{
        id: string;
        userId: string;
        roleId: string;
        tenantId: string | null;
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
        id: overrides.id ?? 'user-role-assignment-id-1',
        userId: overrides.userId ?? 'user-id-1',
        roleId: overrides.roleId ?? 'role-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
        createdBy: overrides.createdBy ?? null,
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        toObject: vi.fn()
    };
    // Make toObject return a complete representation
    entity.toObject.mockReturnValue({
        id: entity.id,
        userId: entity.userId,
        roleId: entity.roleId,
        tenantId: entity.tenantId,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt
    });
    return entity;
};

// Mock UserRoleAssignmentFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        UserRoleAssignmentFactory: {
            CreateUserRoleAssignment: vi.fn((data) => ({
                ...data,
                id: 'new-user-role-assignment-id',
                resourceStatus:
                    (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-user-role-assignment-id',
                    ...data,
                    resourceStatus:
                        (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED'
                })
            }))
        }
    };
});

describe('UserRoleAssignmentService', () => {
    let service: UserRoleAssignmentService;

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
                        email: 'test@example.com'
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
        service = new UserRoleAssignmentService(
            mockUserRoleAssignmentRepository as any,
            mockEventEmitter as any,
            mockClsService as any
        );
    });

    describe('create', () => {
        it('should create a new user role assignment successfully', async () => {
            const newAssignment = createMockUserRoleAssignmentEntity({
                id: 'new-user-role-assignment-id'
            });
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                newAssignment
            );

            const result = await service.create({
                userId: 'user-id-1',
                roleId: 'role-id-1'
            });

            expect(result.id).toBe('new-user-role-assignment-id');
            expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-user-role-assignment-id'
                })
            );
        });

        it('should throw InternalServerErrorException when creation fails', async () => {
            mockUserRoleAssignmentRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    userId: 'user-id-1',
                    roleId: 'role-id-1'
                })
            ).rejects.toThrow('Failed to create UserRoleAssignmentEntity');
        });

        it('should set createdBy from current user context', async () => {
            const newAssignment = createMockUserRoleAssignmentEntity({
                id: 'new-user-role-assignment-id',
                createdBy: 'current-user-id'
            });
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                newAssignment
            );

            await service.create({
                userId: 'user-id-1',
                roleId: 'role-id-1'
            });

            expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
        });
    });

    describe('fetchAll', () => {
        it('should return paginated user role assignments', async () => {
            const assignments = [
                createMockUserRoleAssignmentEntity({ id: 'assignment-1' }),
                createMockUserRoleAssignmentEntity({ id: 'assignment-2' })
            ];
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue(
                assignments
            );
            mockUserRoleAssignmentRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['assignment-1', 'assignment-2'] }
                })
            );
        });

        it('should return empty result when no assignments found', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search parameter to repository', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'admin' });

            expect(mockUserRoleAssignmentRepository.count).toHaveBeenCalledWith(
                {
                    search: 'admin'
                }
            );
        });

        it('should handle pagination correctly', async () => {
            const assignments = [
                createMockUserRoleAssignmentEntity({ id: 'assignment-21' })
            ];
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue(
                assignments
            );
            mockUserRoleAssignmentRepository.count.mockResolvedValue(100);

            const result = await service.fetchAll({ limit: 10, page: 3 });

            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(100);
            expect(result.page).toBe(3);
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return assignments filtered by tenant ID', async () => {
            const assignments = [
                createMockUserRoleAssignmentEntity({
                    id: 'assignment-1',
                    tenantId: 'tenant-1'
                })
            ];
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue(
                assignments
            );
            mockUserRoleAssignmentRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1'
            });

            expect(result.data).toHaveLength(1);
            expect(
                mockUserRoleAssignmentRepository.findAll
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'tenant-1' }
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { tenantId: 'tenant-1', items: ['assignment-1'] }
                })
            );
        });

        it('should return empty result when no assignments found for tenant', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'non-existent-tenant'
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return assignments created by specific user', async () => {
            const assignments = [
                createMockUserRoleAssignmentEntity({
                    id: 'assignment-1',
                    createdBy: 'creator-id'
                })
            ];
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue(
                assignments
            );
            mockUserRoleAssignmentRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id'
            });

            expect(result.data).toHaveLength(1);
            expect(
                mockUserRoleAssignmentRepository.findAll
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' }
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['assignment-1'] }
                })
            );
        });

        it('should return empty result when user has not created any assignments', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'user-with-no-assignments'
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchById', () => {
        it('should return user role assignment by ID', async () => {
            const assignment = createMockUserRoleAssignmentEntity({
                id: 'assignment-123'
            });
            mockUserRoleAssignmentRepository.findById.mockResolvedValue(
                assignment
            );

            const result = await service.fetchById('assignment-123');

            expect(result.id).toBe('assignment-123');
            expect(
                mockUserRoleAssignmentRepository.findById
            ).toHaveBeenCalledWith('assignment-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id'
                })
            );
        });

        it('should emit ResourceViewed event with entity data', async () => {
            const assignment = createMockUserRoleAssignmentEntity({
                id: 'assignment-123',
                userId: 'user-456'
            });
            mockUserRoleAssignmentRepository.findById.mockResolvedValue(
                assignment
            );

            await service.fetchById('assignment-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.any(Object)
            );
        });
    });

    describe('update', () => {
        it('should update user role assignment successfully', async () => {
            const existingAssignment = createMockUserRoleAssignmentEntity({
                id: 'assignment-123',
                hasChanges: true,
                changes: { userId: 'new-user-id' }
            });
            mockUserRoleAssignmentRepository.findById.mockResolvedValue(
                existingAssignment
            );
            mockUserRoleAssignmentRepository.update.mockResolvedValue(
                existingAssignment
            );

            const result = await service.update('assignment-123', {
                userId: 'new-user-id'
            });

            expect(result.id).toBe('assignment-123');
            expect(mockUserRoleAssignmentRepository.update).toHaveBeenCalledWith(
                'assignment-123',
                existingAssignment
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'assignment-123'
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingAssignment = createMockUserRoleAssignmentEntity({
                id: 'assignment-123',
                hasChanges: false
            });
            mockUserRoleAssignmentRepository.findById.mockResolvedValue(
                existingAssignment
            );

            await expect(
                service.update('assignment-123', { userId: 'same-user' })
            ).rejects.toThrow('No changes to write to');
        });
    });

    describe('deleteById', () => {
        it('should soft delete user role assignment successfully', async () => {
            const deletedAssignment = createMockUserRoleAssignmentEntity({
                id: 'assignment-123'
            });
            mockUserRoleAssignmentRepository.softDelete.mockResolvedValue(
                deletedAssignment
            );

            const result = await service.deleteById('assignment-123');

            expect(result.id).toBe('assignment-123');
            expect(
                mockUserRoleAssignmentRepository.softDelete
            ).toHaveBeenCalledWith('assignment-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'assignment-123'
                })
            );
        });

        it('should emit ResourceDeleted event with entity data', async () => {
            const deletedAssignment = createMockUserRoleAssignmentEntity({
                id: 'assignment-123',
                userId: 'user-456'
            });
            mockUserRoleAssignmentRepository.softDelete.mockResolvedValue(
                deletedAssignment
            );

            await service.deleteById('assignment-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'assignment-123',
                    responsibleEntityId: 'current-user-id',
                    data: expect.any(Object)
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockUserRoleAssignmentRepository.softDelete.mockRejectedValue(
                new Error('Delete failed')
            );

            await expect(service.deleteById('assignment-123')).rejects.toThrow(
                'Delete failed'
            );
        });
    });

    describe('fetchAllByUserId', () => {
        it('should return assignments for a specific user by userId field', async () => {
            const assignments = [
                createMockUserRoleAssignmentEntity({
                    id: 'assignment-1',
                    userId: 'target-user-id',
                    roleId: 'role-1',
                    createdBy: 'admin-who-assigned'
                })
            ];
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue(
                assignments
            );
            mockUserRoleAssignmentRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByUserId({
                limit: 10,
                page: 1,
                userId: 'target-user-id'
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].userId).toBe('target-user-id');
            expect(
                mockUserRoleAssignmentRepository.findAll
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { userId: 'target-user-id' }
                })
            );
        });

        it('should emit ResourceViewed event with userId in data', async () => {
            const assignments = [
                createMockUserRoleAssignmentEntity({
                    id: 'assignment-1',
                    userId: 'target-user-id'
                })
            ];
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue(
                assignments
            );
            mockUserRoleAssignmentRepository.count.mockResolvedValue(1);

            await service.fetchAllByUserId({
                limit: 10,
                page: 1,
                userId: 'target-user-id'
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { userId: 'target-user-id', items: ['assignment-1'] }
                })
            );
        });

        it('should return empty result when user has no role assignments', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByUserId({
                limit: 10,
                page: 1,
                userId: 'user-with-no-roles'
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should not confuse userId with createdBy', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            await service.fetchAllByUserId({
                limit: 10,
                page: 1,
                userId: 'target-user-id'
            });

            expect(
                mockUserRoleAssignmentRepository.findAll
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { userId: 'target-user-id' }
                })
            );
            expect(
                mockUserRoleAssignmentRepository.findAll
            ).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'target-user-id' }
                })
            );
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newAssignment = createMockUserRoleAssignmentEntity({
                id: 'new-user-role-assignment-id'
            });
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                newAssignment
            );

            const result = await service.create({
                userId: 'user-id-1',
                roleId: 'role-id-1'
            });

            expect(result.id).toBe('new-user-role-assignment-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockUserRoleAssignmentRepository.findAll.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });

        it('should handle repository errors gracefully', async () => {
            mockUserRoleAssignmentRepository.create.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(
                service.create({
                    userId: 'user-id-1',
                    roleId: 'role-id-1'
                })
            ).rejects.toThrow('Database connection failed');
        });
    });
});
