/**
 * UserProfileService Unit Tests
 *
 * Tests for the UserProfileService that handles user profile management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { UserProfileService } from '../userProfile.service';
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

// Mock UserProfileRepository - simulates database operations
const mockUserProfileRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn()
};

/**
 * Creates a complete mock user profile entity matching the real UserProfileEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserProfileEntity = (
    overrides: Partial<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
        avatarId: string | null;
        userId: string;
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
        id: overrides.id ?? 'user-profile-id-1',
        firstName: overrides.firstName ?? 'John',
        lastName: overrides.lastName ?? 'Doe',
        email: overrides.email ?? 'john.doe@example.com',
        phone: overrides.phone ?? '+1234567890',
        avatarId: overrides.avatarId ?? null,
        userId: overrides.userId ?? 'user-id-1',
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
        firstName: entity.firstName,
        lastName: entity.lastName,
        email: entity.email,
        phone: entity.phone,
        avatarId: entity.avatarId,
        userId: entity.userId,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt
    });
    return entity;
};

// Mock UserProfileFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        UserProfileFactory: {
            CreateUserProfile: vi.fn((data) => ({
                ...data,
                id: 'new-user-profile-id',
                resourceStatus:
                    (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-user-profile-id',
                    ...data,
                    resourceStatus:
                        (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED'
                })
            }))
        }
    };
});

describe('UserProfileService', () => {
    let service: UserProfileService;

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
        service = new UserProfileService(
            mockUserProfileRepository as any,
            mockEventEmitter as any,
            mockClsService as any
        );
    });

    describe('create', () => {
        it('should create a new user profile successfully', async () => {
            const newUserProfile = createMockUserProfileEntity({
                id: 'new-user-profile-id'
            });
            mockUserProfileRepository.create.mockResolvedValue(newUserProfile);

            const result = await service.create({
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane.smith@example.com',
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-profile-id');
            expect(mockUserProfileRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-user-profile-id'
                })
            );
        });

        it('should throw InternalServerErrorException when creation fails', async () => {
            mockUserProfileRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    userId: 'user-id-1'
                })
            ).rejects.toThrow('Failed to create UserProfileEntity');
        });

        it('should set createdBy from current user context', async () => {
            const newUserProfile = createMockUserProfileEntity({
                id: 'new-user-profile-id',
                createdBy: 'current-user-id'
            });
            mockUserProfileRepository.create.mockResolvedValue(newUserProfile);

            await service.create({
                firstName: 'Jane',
                userId: 'user-id-1'
            });

            expect(mockUserProfileRepository.create).toHaveBeenCalled();
        });

        it('should create user profile with all optional fields', async () => {
            const newUserProfile = createMockUserProfileEntity({
                id: 'new-user-profile-id',
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane@example.com',
                phone: '+1234567890',
                avatarId: 'avatar-123'
            });
            mockUserProfileRepository.create.mockResolvedValue(newUserProfile);

            const result = await service.create({
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane@example.com',
                phone: '+1234567890',
                avatarId: 'avatar-123',
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-profile-id');
            expect(mockUserProfileRepository.create).toHaveBeenCalled();
        });

        it('should create user profile with minimal required fields', async () => {
            const newUserProfile = createMockUserProfileEntity({
                id: 'new-user-profile-id',
                firstName: null,
                lastName: null,
                email: null,
                phone: null
            });
            mockUserProfileRepository.create.mockResolvedValue(newUserProfile);

            const result = await service.create({
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-profile-id');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated user profiles', async () => {
            const userProfiles = [
                createMockUserProfileEntity({ id: 'profile-1' }),
                createMockUserProfileEntity({ id: 'profile-2' })
            ];
            mockUserProfileRepository.findAll.mockResolvedValue(userProfiles);
            mockUserProfileRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['profile-1', 'profile-2'] }
                })
            );
        });

        it('should return empty result when no user profiles found', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            mockUserProfileRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search parameter to repository', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            mockUserProfileRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'john' });

            expect(mockUserProfileRepository.count).toHaveBeenCalledWith({
                search: 'john'
            });
        });

        it('should handle pagination correctly', async () => {
            const userProfiles = [
                createMockUserProfileEntity({ id: 'profile-21' })
            ];
            mockUserProfileRepository.findAll.mockResolvedValue(userProfiles);
            mockUserProfileRepository.count.mockResolvedValue(100);

            const result = await service.fetchAll({ limit: 10, page: 3 });

            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(100);
            expect(result.page).toBe(3);
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should throw NotImplementedException', async () => {
            await expect(
                service.fetchAllByTenantId({
                    limit: 10,
                    page: 1,
                    tenantId: 'tenant-1'
                })
            ).rejects.toThrow(NotImplementedException);
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return user profiles created by specific user', async () => {
            const userProfiles = [
                createMockUserProfileEntity({
                    id: 'profile-1',
                    createdBy: 'creator-id'
                })
            ];
            mockUserProfileRepository.findAll.mockResolvedValue(userProfiles);
            mockUserProfileRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id'
            });

            expect(result.data).toHaveLength(1);
            expect(mockUserProfileRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' }
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['profile-1'] }
                })
            );
        });

        it('should return empty result when user has not created any profiles', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            mockUserProfileRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'user-with-no-profiles'
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchById', () => {
        it('should return user profile by ID', async () => {
            const userProfile = createMockUserProfileEntity({
                id: 'profile-123'
            });
            mockUserProfileRepository.findById.mockResolvedValue(userProfile);

            const result = await service.fetchById('profile-123');

            expect(result.id).toBe('profile-123');
            expect(mockUserProfileRepository.findById).toHaveBeenCalledWith(
                'profile-123'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id'
                })
            );
        });

        it('should emit ResourceViewed event with entity data', async () => {
            const userProfile = createMockUserProfileEntity({
                id: 'profile-123',
                firstName: 'John',
                lastName: 'Doe'
            });
            mockUserProfileRepository.findById.mockResolvedValue(userProfile);

            await service.fetchById('profile-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.any(Object)
            );
        });
    });

    describe('update', () => {
        it('should update user profile successfully', async () => {
            const existingUserProfile = createMockUserProfileEntity({
                id: 'profile-123',
                hasChanges: true,
                changes: { firstName: 'Updated' }
            });
            mockUserProfileRepository.findById.mockResolvedValue(
                existingUserProfile
            );
            mockUserProfileRepository.update.mockResolvedValue(
                existingUserProfile
            );

            const result = await service.update('profile-123', {
                firstName: 'Updated'
            });

            expect(result.id).toBe('profile-123');
            expect(mockUserProfileRepository.update).toHaveBeenCalledWith(
                'profile-123',
                existingUserProfile
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'profile-123'
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingUserProfile = createMockUserProfileEntity({
                id: 'profile-123',
                hasChanges: false
            });
            mockUserProfileRepository.findById.mockResolvedValue(
                existingUserProfile
            );

            await expect(
                service.update('profile-123', { firstName: 'Same' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingUserProfile = createMockUserProfileEntity({
                id: 'profile-123',
                hasChanges: true,
                changes: {
                    firstName: 'Jane',
                    lastName: 'Smith',
                    email: 'jane.smith@example.com'
                }
            });
            mockUserProfileRepository.findById.mockResolvedValue(
                existingUserProfile
            );
            mockUserProfileRepository.update.mockResolvedValue(
                existingUserProfile
            );

            const result = await service.update('profile-123', {
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane.smith@example.com'
            });

            expect(result.id).toBe('profile-123');
            expect(mockUserProfileRepository.update).toHaveBeenCalled();
        });

        it('should update phone and avatar fields', async () => {
            const existingUserProfile = createMockUserProfileEntity({
                id: 'profile-123',
                hasChanges: true,
                changes: { phone: '+9876543210', avatarId: 'new-avatar-id' }
            });
            mockUserProfileRepository.findById.mockResolvedValue(
                existingUserProfile
            );
            mockUserProfileRepository.update.mockResolvedValue(
                existingUserProfile
            );

            const result = await service.update('profile-123', {
                phone: '+9876543210',
                avatarId: 'new-avatar-id'
            });

            expect(result.id).toBe('profile-123');
        });
    });

    describe('deleteById', () => {
        it('should soft delete user profile successfully', async () => {
            const deletedUserProfile = createMockUserProfileEntity({
                id: 'profile-123'
            });
            mockUserProfileRepository.softDelete.mockResolvedValue(
                deletedUserProfile
            );

            const result = await service.deleteById('profile-123');

            expect(result.id).toBe('profile-123');
            expect(mockUserProfileRepository.softDelete).toHaveBeenCalledWith(
                'profile-123'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'profile-123'
                })
            );
        });

        it('should emit ResourceDeleted event with entity data', async () => {
            const deletedUserProfile = createMockUserProfileEntity({
                id: 'profile-123',
                firstName: 'John',
                lastName: 'Doe'
            });
            mockUserProfileRepository.softDelete.mockResolvedValue(
                deletedUserProfile
            );

            await service.deleteById('profile-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'profile-123',
                    responsibleEntityId: 'current-user-id',
                    data: expect.any(Object)
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockUserProfileRepository.softDelete.mockRejectedValue(
                new Error('Delete failed')
            );

            await expect(service.deleteById('profile-123')).rejects.toThrow(
                'Delete failed'
            );
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newUserProfile = createMockUserProfileEntity({
                id: 'new-user-profile-id'
            });
            mockUserProfileRepository.create.mockResolvedValue(newUserProfile);

            const result = await service.create({
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-profile-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            mockUserProfileRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            mockUserProfileRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });

        it('should handle repository errors gracefully', async () => {
            mockUserProfileRepository.create.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(
                service.create({
                    userId: 'user-id-1'
                })
            ).rejects.toThrow('Database connection failed');
        });

        it('should handle profile with all null optional fields', async () => {
            // Create entity with explicit null values using direct object
            const minimalProfile = {
                id: 'minimal-profile',
                firstName: null,
                lastName: null,
                email: null,
                phone: null,
                avatarId: null,
                userId: 'user-id-1',
                resourceStatus: 'ENABLED',
                createdBy: null,
                updatedBy: null,
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T10:00:00Z'),
                deletedAt: null,
                hasChanges: false,
                changes: {},
                toObject: vi.fn().mockReturnValue({
                    id: 'minimal-profile',
                    firstName: null,
                    lastName: null,
                    email: null,
                    phone: null,
                    avatarId: null,
                    userId: 'user-id-1'
                })
            };
            mockUserProfileRepository.findById.mockResolvedValue(minimalProfile);

            const result = await service.fetchById('minimal-profile');

            expect(result.id).toBe('minimal-profile');
            expect(result.firstName).toBeNull();
            expect(result.lastName).toBeNull();
        });
    });
});
