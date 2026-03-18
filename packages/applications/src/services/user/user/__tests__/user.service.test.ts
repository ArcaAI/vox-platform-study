/**
 * UserService Unit Tests
 *
 * Tests for the UserService that handles user management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserService } from '../user.service';
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

// Mock UserRepository - simulates database operations
const mockUserRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Creates a complete mock user entity matching the real UserEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserEntity = (overrides: Partial<{
    id: string;
    username: string;
    password: string;
    externalId: string | null;
    isServiceAccount: boolean;
    lastLoginAt: Date | null;
    lastActiveAt: Date | null;
    secret1: string | null;
    secret1Expiry: Date | null;
    secret2: string | null;
    secret2Expiry: Date | null;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
}> = {}) => {
    const entity = {
        id: overrides.id ?? 'user-id-1',
        username: overrides.username ?? 'testuser',
        password: overrides.password ?? 'hashedpassword',
        externalId: overrides.externalId ?? null,
        isServiceAccount: overrides.isServiceAccount ?? false,
        lastLoginAt: overrides.lastLoginAt ?? null,
        lastActiveAt: overrides.lastActiveAt ?? null,
        secret1: overrides.secret1 ?? null,
        secret1Expiry: overrides.secret1Expiry ?? null,
        secret2: overrides.secret2 ?? null,
        secret2Expiry: overrides.secret2Expiry ?? null,
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
        username: entity.username,
        externalId: entity.externalId,
        isServiceAccount: entity.isServiceAccount,
        lastLoginAt: entity.lastLoginAt,
        lastActiveAt: entity.lastActiveAt,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

// Mock UserFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        UserFactory: {
            CreateUser: vi.fn((data) => ({
                ...data,
                id: 'new-user-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-user-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
    };
});

describe('UserService', () => {
    let service: UserService;

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
        service = new UserService(
            mockUserRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new user with all required fields', async () => {
            const newUser = createMockUserEntity({
                id: 'new-user-id',
                username: 'newuser',
                isServiceAccount: false,
                createdBy: 'current-user-id',
            });
            mockUserRepository.create.mockResolvedValue(newUser);

            const result = await service.create({
                username: 'newuser',
                password: 'password123',
                isServiceAccount: false,
            });

            // Verify the returned entity has correct data
            expect(result.id).toBe('new-user-id');
            expect(result.username).toBe('newuser');
            expect(result.isServiceAccount).toBe(false);
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newUser = createMockUserEntity({ id: 'new-user-id' });
            mockUserRepository.create.mockResolvedValue(newUser);

            await service.create({
                username: 'newuser',
                password: 'password123',
                isServiceAccount: false,
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-user-id',
                    createdAt: newUser.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockUserRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    username: 'newuser',
                    password: 'password123',
                    isServiceAccount: false,
                })
            ).rejects.toThrow('Failed to create UserEntity');
        });

        it('should create service account user', async () => {
            const newUser = createMockUserEntity({
                id: 'new-service-user-id',
                username: 'api-service',
                isServiceAccount: true,
            });
            mockUserRepository.create.mockResolvedValue(newUser);

            const result = await service.create({
                username: 'api-service',
                password: 'service-password',
                isServiceAccount: true,
            });

            expect(result.isServiceAccount).toBe(true);
        });

        it('should handle repository errors gracefully', async () => {
            mockUserRepository.create.mockRejectedValue(new Error('Database connection failed'));

            await expect(
                service.create({
                    username: 'newuser',
                    password: 'password123',
                    isServiceAccount: false,
                })
            ).rejects.toThrow('Database connection failed');
        });
    });

    describe('createExternalUser', () => {
        it('should create an external user with externalId as username', async () => {
            const newUser = createMockUserEntity({
                id: 'new-external-user-id',
                externalId: 'google-oauth-123456',
                username: 'google-oauth-123456',
                isServiceAccount: false,
            });
            mockUserRepository.create.mockResolvedValue(newUser);

            const result = await service.createExternalUser({
                externalId: 'google-oauth-123456',
            });

            // Verify the returned entity has correct data
            expect(result.id).toBe('new-external-user-id');
            expect(result.externalId).toBe('google-oauth-123456');
            expect(result.username).toBe('google-oauth-123456');
        });

        it('should emit ResourceCreated event for external user', async () => {
            const newUser = createMockUserEntity({
                id: 'new-external-user-id',
                externalId: 'external-123',
            });
            mockUserRepository.create.mockResolvedValue(newUser);

            await service.createExternalUser({
                externalId: 'external-123',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-external-user-id',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should throw InternalServerErrorException when external user creation fails', async () => {
            mockUserRepository.create.mockResolvedValue(null);

            await expect(
                service.createExternalUser({ externalId: 'external-123' })
            ).rejects.toThrow('Failed to create external UserEntity');
        });

        it('should handle repository errors for external user creation', async () => {
            mockUserRepository.create.mockRejectedValue(new Error('OAuth provider error'));

            await expect(
                service.createExternalUser({ externalId: 'external-123' })
            ).rejects.toThrow('OAuth provider error');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated users with correct pagination metadata', async () => {
            const users = [
                createMockUserEntity({ id: 'user-1', username: 'user1' }),
                createMockUserEntity({ id: 'user-2', username: 'user2' }),
            ];
            mockUserRepository.findAll.mockResolvedValue(users);
            mockUserRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual user data is returned
            expect(result.data[0].username).toBe('user1');
            expect(result.data[1].username).toBe('user2');
        });

        it('should emit ResourceViewed event with user IDs', async () => {
            const users = [
                createMockUserEntity({ id: 'user-1' }),
                createMockUserEntity({ id: 'user-2' }),
            ];
            mockUserRepository.findAll.mockResolvedValue(users);
            mockUserRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['user-1', 'user-2'] },
                })
            );
        });

        it('should return empty result when no users exist', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search and searchFields to count matching findAll', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

            expect(mockUserRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test-search',
                })
            );
        });

        it('should pass searchFields to count when provided', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            await service.fetchAll({
                limit: 10,
                page: 1,
                search: 'test-search',
                searchFields: 'username,externalId',
            });

            expect(mockUserRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test-search',
                    searchFields: ['username', 'externalId'],
                })
            );
        });

        it('should handle large pagination values', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return users filtered by tenantId', async () => {
            const users = [createMockUserEntity({ id: 'user-1' })];
            mockUserRepository.findAll.mockResolvedValue(users);
            mockUserRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-1' });

            expect(result.data).toEqual(users);
            expect(result.count).toBe(1);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should filter by UserRoleAssignments with tenantId', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-1' });

            expect(mockUserRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { UserRoleAssignments: { some: { tenantId: 'tenant-1' } } },
                })
            );
            expect(mockUserRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { UserRoleAssignments: { some: { tenantId: 'tenant-1' } } },
                })
            );
        });

        it('should broadcast ResourceViewed sys event with tenantId', async () => {
            const users = [createMockUserEntity({ id: 'user-1' }), createMockUserEntity({ id: 'user-2' })];
            mockUserRepository.findAll.mockResolvedValue(users);
            mockUserRepository.count.mockResolvedValue(2);

            await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-1' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: {
                        tenantId: 'tenant-1',
                        items: ['user-1', 'user-2'],
                    },
                })
            );
        });

        it('should return empty data when no users belong to tenant', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'no-users-tenant' });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return users created by specific user', async () => {
            const users = [createMockUserEntity({ id: 'user-1', createdBy: 'creator-id' })];
            mockUserRepository.findAll.mockResolvedValue(users);
            mockUserRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].createdBy).toBe('creator-id');
            expect(mockUserRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
        });

        it('should emit event with createdBy in data', async () => {
            const users = [createMockUserEntity({ id: 'user-1', createdBy: 'creator-id' })];
            mockUserRepository.findAll.mockResolvedValue(users);
            mockUserRepository.count.mockResolvedValue(1);

            await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['user-1'] },
                })
            );
        });

        it('should return empty result when user has not created any users', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'user-with-no-creations',
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchById', () => {
        it('should return user by ID with complete data', async () => {
            const user = createMockUserEntity({
                id: 'user-123',
                username: 'testuser',
                isServiceAccount: false,
            });
            mockUserRepository.findById.mockResolvedValue(user);

            const result = await service.fetchById('user-123');

            expect(result.id).toBe('user-123');
            expect(result.username).toBe('testuser');
            expect(result.isServiceAccount).toBe(false);
        });

        it('should emit ResourceViewed event with user data', async () => {
            const user = createMockUserEntity({ id: 'user-123' });
            mockUserRepository.findById.mockResolvedValue(user);

            await service.fetchById('user-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockUserRepository.findById.mockRejectedValue(new Error('User not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('User not found');
        });
    });

    describe('fetchByExternalId', () => {
        it('should return user by external ID with complete data', async () => {
            const user = createMockUserEntity({
                id: 'user-123',
                externalId: 'google-oauth-456',
                username: 'google-oauth-456',
            });
            mockUserRepository.findFirst.mockResolvedValue(user);

            const result = await service.fetchByExternalId('google-oauth-456');

            expect(result.id).toBe('user-123');
            expect(result.externalId).toBe('google-oauth-456');
            expect(mockUserRepository.findFirst).toHaveBeenCalledWith({
                where: { externalId: 'google-oauth-456' },
            });
        });

        it('should emit ResourceViewed event with external ID', async () => {
            const user = createMockUserEntity({
                id: 'user-123',
                externalId: 'external-456',
            });
            mockUserRepository.findFirst.mockResolvedValue(user);

            await service.fetchByExternalId('external-456');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should throw NotFoundException when user not found', async () => {
            mockUserRepository.findFirst.mockResolvedValue(null);

            await expect(
                service.fetchByExternalId('non-existent')
            ).rejects.toThrow('User with external ID non-existent not found');
        });

        it('should propagate repository errors', async () => {
            mockUserRepository.findFirst.mockRejectedValue(new Error('Database error'));

            await expect(
                service.fetchByExternalId('external-123')
            ).rejects.toThrow('Database error');
        });
    });

    describe('update', () => {
        it('should update user successfully and return updated entity', async () => {
            const existingUser = createMockUserEntity({
                id: 'user-123',
                username: 'oldusername',
                hasChanges: true,
                changes: { username: 'updateduser' },
            });
            mockUserRepository.findById.mockResolvedValue(existingUser);
            mockUserRepository.update.mockResolvedValue(existingUser);

            const result = await service.update('user-123', { username: 'updateduser' });

            expect(result.id).toBe('user-123');
            expect(mockUserRepository.update).toHaveBeenCalledWith('user-123', existingUser);
        });

        it('should emit ResourceUpdated event with changes and previous data', async () => {
            const existingUser = createMockUserEntity({
                id: 'user-123',
                hasChanges: true,
                changes: { username: 'updateduser' },
            });
            mockUserRepository.findById.mockResolvedValue(existingUser);
            mockUserRepository.update.mockResolvedValue(existingUser);

            await service.update('user-123', { username: 'updateduser' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'user-123',
                    data: { username: 'updateduser' },
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingUser = createMockUserEntity({
                id: 'user-123',
                hasChanges: false,
            });
            mockUserRepository.findById.mockResolvedValue(existingUser);

            await expect(
                service.update('user-123', { username: 'sameuser' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should propagate repository errors on update', async () => {
            const existingUser = createMockUserEntity({
                id: 'user-123',
                hasChanges: true,
                changes: { username: 'newuser' },
            });
            mockUserRepository.findById.mockResolvedValue(existingUser);
            mockUserRepository.update.mockRejectedValue(new Error('Update failed'));

            await expect(
                service.update('user-123', { username: 'newuser' })
            ).rejects.toThrow('Update failed');
        });
    });

    describe('deleteById', () => {
        it('should soft delete user and return deleted entity', async () => {
            const deletedUser = createMockUserEntity({
                id: 'user-123',
                deletedAt: new Date(),
            });
            mockUserRepository.softDelete.mockResolvedValue(deletedUser);

            const result = await service.deleteById('user-123');

            expect(result.id).toBe('user-123');
            expect(mockUserRepository.softDelete).toHaveBeenCalledWith('user-123');
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedUser = createMockUserEntity({ id: 'user-123' });
            mockUserRepository.softDelete.mockResolvedValue(deletedUser);

            await service.deleteById('user-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'user-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockUserRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('user-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newUser = createMockUserEntity({ id: 'new-user-id' });
            mockUserRepository.create.mockResolvedValue(newUser);

            const result = await service.create({
                username: 'newuser',
                password: 'password123',
                isServiceAccount: false,
            });

            expect(result.id).toBe('new-user-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockUserRepository.findAll.mockResolvedValue([]);
            mockUserRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });
    });
});
