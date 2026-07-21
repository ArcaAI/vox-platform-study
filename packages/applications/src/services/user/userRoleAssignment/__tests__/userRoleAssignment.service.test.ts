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
import { ForbiddenException } from '@nestjs/common';
import { UserRoleAssignmentService } from '../userRoleAssignment.service';
import { SysEventType, ResourceStatusType, UserRoleAssignmentFactory } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';

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
    restore: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn()
};

// Mock CoreDatabaseService (CORE_DATABASE_SERVICE) - the service uses the
// unscoped `baseClient` for the role-tier lookup (Role is a global,
// non-tenant-scoped model) and for the existing cross-tenant identity reads.
const mockDatabaseService = {
    baseClient: {
        role: {
            findUnique: vi.fn()
        },
        userRoleAssignment: {
            findFirst: vi.fn(),
            findMany: vi.fn()
        }
    }
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
            mockClsService as any,
            mockDatabaseService as any
        );

        // Default: no soft-deleted record exists, so create proceeds normally
        mockUserRoleAssignmentRepository.findFirst.mockRejectedValue(
            new DataNotFoundException('UserRoleAssignment', 'not-found')
        );

        // Defaults: the target role is a non-elevated tenant role and the
        // target user has no prior tenant membership (clean onboarding), so the
        // privilege-escalation guard is a no-op for the existing create specs.
        mockDatabaseService.baseClient.role.findUnique.mockResolvedValue({ name: 'DOCTOR' });
        mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([]);
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

        it('should restore a soft-deleted assignment instead of creating a duplicate when (userId, roleId, tenantId) matches', async () => {
            // A previously soft-deleted assignment exists for this (user, role, tenant).
            const deletedAssignment = createMockUserRoleAssignmentEntity({
                id: 'previously-deleted-id',
                userId: 'user-id-1',
                roleId: 'role-id-1',
                tenantId: 'tenant-1',
                resourceStatus: ResourceStatusType.DELETED
            });
            const restoredAssignment = createMockUserRoleAssignmentEntity({
                id: 'previously-deleted-id',
                userId: 'user-id-1',
                roleId: 'role-id-1',
                tenantId: 'tenant-1',
                resourceStatus: ResourceStatusType.ENABLED,
                updatedBy: 'current-user-id'
            });
            mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(
                deletedAssignment
            );
            mockUserRoleAssignmentRepository.restore.mockResolvedValue(
                restoredAssignment
            );

            const result = await service.create({
                userId: 'user-id-1',
                roleId: 'role-id-1',
                tenantId: 'tenant-1'
            });

            expect(result.id).toBe('previously-deleted-id');
            expect(mockUserRoleAssignmentRepository.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        userId: 'user-id-1',
                        roleId: 'role-id-1',
                        tenantId: 'tenant-1',
                        resourceStatus: ResourceStatusType.DELETED
                    })
                })
            );
            expect(mockUserRoleAssignmentRepository.restore).toHaveBeenCalledWith(
                'previously-deleted-id',
                'current-user-id'
            );
            // Restore must not double-create.
            expect(mockUserRoleAssignmentRepository.create).not.toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'previously-deleted-id'
                })
            );
        });

        it('should fall back to CLS tenant when request omits tenantId for the soft-delete lookup', async () => {
            // findFirst stays at the default rejection (no soft-deleted record),
            // we only care about WHICH tenantId the service queries with.
            const newAssignment = createMockUserRoleAssignmentEntity({
                id: 'new-user-role-assignment-id'
            });
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                newAssignment
            );

            await service.create({
                userId: 'user-id-1',
                roleId: 'role-id-1'
                // tenantId intentionally omitted — CLS tenantId is 'tenant-1'
            });

            expect(mockUserRoleAssignmentRepository.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId: 'tenant-1',
                        resourceStatus: ResourceStatusType.DELETED
                    })
                })
            );
        });

        it('should use null tenantId in the soft-delete lookup when neither request nor CLS provide one', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') {
                    return {
                        id: 'current-user-id',
                        firstName: 'Test',
                        lastName: 'User',
                        email: 'test@example.com'
                    };
                }
                // No tenant context for this call.
                return null;
            });

            const newAssignment = createMockUserRoleAssignmentEntity({
                id: 'new-user-role-assignment-id'
            });
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                newAssignment
            );

            await service.create({
                userId: 'user-id-1',
                roleId: 'role-id-1'
            });

            expect(mockUserRoleAssignmentRepository.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId: null,
                        resourceStatus: ResourceStatusType.DELETED
                    })
                })
            );
        });

        it('should propagate non-DataNotFound errors from the soft-delete lookup without attempting a create', async () => {
            mockUserRoleAssignmentRepository.findFirst.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(
                service.create({
                    userId: 'user-id-1',
                    roleId: 'role-id-1',
                    tenantId: 'tenant-1'
                })
            ).rejects.toThrow('Database connection failed');

            expect(mockUserRoleAssignmentRepository.restore).not.toHaveBeenCalled();
            expect(mockUserRoleAssignmentRepository.create).not.toHaveBeenCalled();
        });

        // Tenant pinning on create.
        // The caller's CLS tenantId is the only trusted source; request.tenantId
        // must never be allowed to silently widen tenant scope for non-super-admins.
        describe('tenantId pinning (TASK-305 D.7)', () => {
            it('should pin tenantId to CLS context when request omits tenantId (non-super-admin caller)', async () => {
                // CLS tenantId is 'tenant-1' from default beforeEach setup.
                const newAssignment = createMockUserRoleAssignmentEntity({
                    id: 'new-user-role-assignment-id',
                    tenantId: 'tenant-1'
                });
                mockUserRoleAssignmentRepository.create.mockResolvedValue(
                    newAssignment
                );

                await service.create({
                    userId: 'user-id-1',
                    roleId: 'role-id-1'
                    // tenantId intentionally omitted
                });

                // Factory MUST receive the pinned CLS tenantId, not undefined.
                expect(
                    UserRoleAssignmentFactory.CreateUserRoleAssignment
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 'user-id-1',
                        roleId: 'role-id-1',
                        tenantId: 'tenant-1',
                        createdBy: 'current-user-id'
                    })
                );
            });

            it('should accept explicit request.tenantId when it matches CLS tenantId (non-super-admin caller)', async () => {
                const newAssignment = createMockUserRoleAssignmentEntity({
                    id: 'new-user-role-assignment-id',
                    tenantId: 'tenant-1'
                });
                mockUserRoleAssignmentRepository.create.mockResolvedValue(
                    newAssignment
                );

                await service.create({
                    userId: 'user-id-1',
                    roleId: 'role-id-1',
                    tenantId: 'tenant-1' // explicit match against CLS 'tenant-1'
                });

                expect(
                    UserRoleAssignmentFactory.CreateUserRoleAssignment
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 'user-id-1',
                        roleId: 'role-id-1',
                        tenantId: 'tenant-1'
                    })
                );
                expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
            });

            it('should throw ForbiddenException when request.tenantId differs from CLS tenantId for a non-super-admin caller (audit C-6 attack vector)', async () => {
                // CLS tenantId is 'tenant-1' (Tenant A); attacker tries to create an
                // assignment in 'tenant-2' (Tenant B). Default user mock has no roles
                // -> not a super-admin -> must be rejected.
                await expect(
                    service.create({
                        userId: 'victim-user-id',
                        roleId: 'GLOBAL_ADMIN',
                        tenantId: 'tenant-2'
                    })
                ).rejects.toBeInstanceOf(ForbiddenException);

                // Defense-in-depth: nothing on the create path may have run.
                expect(
                    UserRoleAssignmentFactory.CreateUserRoleAssignment
                ).not.toHaveBeenCalled();
                expect(mockUserRoleAssignmentRepository.create).not.toHaveBeenCalled();
                expect(mockUserRoleAssignmentRepository.restore).not.toHaveBeenCalled();
            });

            it('should allow cross-tenant create when request.tenantId differs from CLS tenantId AND caller is GLOBAL_ADMIN', async () => {
                // Super-admin escape hatch: bootstrap/onboarding flows legitimately
                // need to create assignments scoped to a tenant other than the
                // admin's own CLS context.
                mockClsService.get.mockImplementation((key: string) => {
                    switch (key) {
                        case 'user':
                            return {
                                id: 'current-user-id',
                                firstName: 'Super',
                                lastName: 'Admin',
                                email: 'super@example.com',
                                roles: ['GLOBAL_ADMIN']
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
                // Re-create the service so the new CLS impl is picked up via getters.
                service = new UserRoleAssignmentService(
                    mockUserRoleAssignmentRepository as any,
                    mockEventEmitter as any,
                    mockClsService as any,
                    mockDatabaseService as any
                );

                const newAssignment = createMockUserRoleAssignmentEntity({
                    id: 'new-user-role-assignment-id',
                    tenantId: 'tenant-2'
                });
                mockUserRoleAssignmentRepository.create.mockResolvedValue(
                    newAssignment
                );

                await service.create({
                    userId: 'user-in-tenant-2',
                    roleId: 'role-id-1',
                    tenantId: 'tenant-2'
                });

                expect(
                    UserRoleAssignmentFactory.CreateUserRoleAssignment
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 'user-in-tenant-2',
                        roleId: 'role-id-1',
                        tenantId: 'tenant-2'
                    })
                );
                expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
            });
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

    // -------------------------------------------------------------------------
    // Service-layer defense in
    // depth for POST /admin/users/:id/roles. A non-GLOBAL_ADMIN caller must
    // never be able to (a) grant the platform-wide GLOBAL_ADMIN role, nor
    // (b) assign a role to a user that lives outside the caller's tenant.
    // GLOBAL_ADMIN and system/bootstrap (no CLS user) paths stay exempt.
    // -------------------------------------------------------------------------
    describe('AC-02 — privilege-escalation guard on create', () => {
        const buildAs = (user: { id: string; roles?: string[] } | null, tenantId: string | null) => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user':
                        return user;
                    case 'tenantId':
                        return tenantId;
                    default:
                        return null;
                }
            });
            return new UserRoleAssignmentService(
                mockUserRoleAssignmentRepository as any,
                mockEventEmitter as any,
                mockClsService as any,
                mockDatabaseService as any
            );
        };

        it('rejects a non-super-admin assigning the GLOBAL_ADMIN role (ForbiddenException, no write)', async () => {
            const svc = buildAs({ id: 'tadmin', roles: ['TENANT_ADMIN'] }, 'tenant-1');
            mockDatabaseService.baseClient.role.findUnique.mockResolvedValue({ name: 'GLOBAL_ADMIN' });

            await expect(
                svc.create({ userId: 'target', roleId: 'role-super' })
            ).rejects.toBeInstanceOf(ForbiddenException);

            // Defense-in-depth: nothing on the create path may have run.
            expect(UserRoleAssignmentFactory.CreateUserRoleAssignment).not.toHaveBeenCalled();
            expect(mockUserRoleAssignmentRepository.create).not.toHaveBeenCalled();
            expect(mockUserRoleAssignmentRepository.restore).not.toHaveBeenCalled();
        });

        it('allows a GLOBAL_ADMIN to assign the GLOBAL_ADMIN role (exempt — tier lookup skipped)', async () => {
            const svc = buildAs({ id: 'root', roles: ['GLOBAL_ADMIN'] }, 'tenant-1');
            mockDatabaseService.baseClient.role.findUnique.mockResolvedValue({ name: 'GLOBAL_ADMIN' });
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                createMockUserRoleAssignmentEntity({ id: 'ok' })
            );

            const result = await svc.create({ userId: 'target', roleId: 'role-super' });

            expect(result.id).toBe('ok');
            expect(mockDatabaseService.baseClient.role.findUnique).not.toHaveBeenCalled();
            expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
        });

        it('rejects a non-super-admin assigning a role to a user in ANOTHER tenant (ForbiddenException, no write)', async () => {
            const svc = buildAs({ id: 'tadmin', roles: ['TENANT_ADMIN'] }, 'tenant-1');
            mockDatabaseService.baseClient.role.findUnique.mockResolvedValue({ name: 'DOCTOR' });
            mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([
                { tenantId: 'tenant-2' }
            ]);

            await expect(
                svc.create({ userId: 'foreign-user', roleId: 'role-doc' })
            ).rejects.toBeInstanceOf(ForbiddenException);

            expect(UserRoleAssignmentFactory.CreateUserRoleAssignment).not.toHaveBeenCalled();
            expect(mockUserRoleAssignmentRepository.create).not.toHaveBeenCalled();
        });

        it('allows onboarding a NEW user (no prior memberships) with a non-elevated role', async () => {
            const svc = buildAs({ id: 'tadmin', roles: ['TENANT_ADMIN'] }, 'tenant-1');
            mockDatabaseService.baseClient.role.findUnique.mockResolvedValue({ name: 'DOCTOR' });
            mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([]);
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                createMockUserRoleAssignmentEntity({ id: 'onboard' })
            );

            const result = await svc.create({ userId: 'new-user', roleId: 'role-doc' });

            expect(result.id).toBe('onboard');
            expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
        });

        it('allows a non-super-admin to assign a non-elevated role to a user already in their tenant', async () => {
            const svc = buildAs({ id: 'tadmin', roles: ['TENANT_ADMIN'] }, 'tenant-1');
            mockDatabaseService.baseClient.role.findUnique.mockResolvedValue({ name: 'NURSE' });
            mockDatabaseService.baseClient.userRoleAssignment.findMany.mockResolvedValue([
                { tenantId: 'tenant-1' }
            ]);
            mockUserRoleAssignmentRepository.create.mockResolvedValue(
                createMockUserRoleAssignmentEntity({ id: 'same-tenant' })
            );

            const result = await svc.create({ userId: 'member', roleId: 'role-nurse' });

            expect(result.id).toBe('same-tenant');
            expect(mockUserRoleAssignmentRepository.create).toHaveBeenCalled();
        });
    });
});
