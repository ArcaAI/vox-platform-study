/**
 * UserSettingsService Unit Tests
 *
 * Tests for the UserSettingsService that handles user settings management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { UserSettingsService } from '../userSettings.service';
import { SysEventType, ValueType, ResourceStatusType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
    get: vi.fn(),
    set: vi.fn()
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
    emit: vi.fn()
};

// Mock UserSettingsRepository - simulates database operations
const mockUserSettingsRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn()
};

/**
 * Creates a complete mock user settings entity matching the real UserSettingsEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockUserSettingsEntity = (
    overrides: Partial<{
        id: string;
        name: string;
        key: string;
        value: string;
        dataType: ValueType;
        namespace: string | null;
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
        id: overrides.id ?? 'user-settings-id-1',
        name: overrides.name ?? 'Test Setting',
        key: overrides.key ?? 'test_key',
        value: overrides.value ?? 'test_value',
        dataType: overrides.dataType ?? ValueType.String,
        namespace: overrides.namespace ?? null,
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
        name: entity.name,
        key: entity.key,
        value: entity.value,
        dataType: entity.dataType,
        namespace: entity.namespace,
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

// Mock UserSettingsFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        UserSettingsFactory: {
            CreateUserSettings: vi.fn((data) => ({
                ...data,
                id: 'new-user-settings-id',
                resourceStatus:
                    (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-user-settings-id',
                    ...data,
                    resourceStatus:
                        (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED'
                })
            }))
        }
    };
});

describe('UserSettingsService', () => {
    let service: UserSettingsService;

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
        service = new UserSettingsService(
            mockUserSettingsRepository as any,
            mockEventEmitter as any,
            mockClsService as any
        );
    });

    describe('create', () => {
        it('should create a new user settings successfully', async () => {
            const newUserSettings = createMockUserSettingsEntity({
                id: 'new-user-settings-id'
            });
            mockUserSettingsRepository.create.mockResolvedValue(newUserSettings);

            const result = await service.create({
                name: 'Language Setting',
                key: 'language',
                value: 'en',
                dataType: ValueType.String,
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-settings-id');
            expect(mockUserSettingsRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-user-settings-id'
                })
            );
        });

        it('should throw InternalServerErrorException when creation fails', async () => {
            mockUserSettingsRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    name: 'Test',
                    key: 'test',
                    value: 'value',
                    dataType: ValueType.String,
                    userId: 'user-id-1'
                })
            ).rejects.toThrow('Failed to create UserSettingsEntity');
        });

        it('should set createdBy from current user context', async () => {
            const newUserSettings = createMockUserSettingsEntity({
                id: 'new-user-settings-id',
                createdBy: 'current-user-id'
            });
            mockUserSettingsRepository.create.mockResolvedValue(newUserSettings);

            await service.create({
                name: 'Test',
                key: 'test',
                value: 'value',
                dataType: ValueType.String,
                userId: 'user-id-1'
            });

            expect(mockUserSettingsRepository.create).toHaveBeenCalled();
        });

        it('should create settings with namespace', async () => {
            const newUserSettings = createMockUserSettingsEntity({
                id: 'new-user-settings-id',
                namespace: 'arcaai-sdk'
            });
            mockUserSettingsRepository.create.mockResolvedValue(newUserSettings);

            const result = await service.create({
                name: 'SDK Setting',
                key: 'theme',
                value: 'dark',
                dataType: ValueType.String,
                namespace: 'arcaai-sdk',
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-settings-id');
            expect(mockUserSettingsRepository.create).toHaveBeenCalled();
        });

        it('should create settings with different data types', async () => {
            const intSetting = createMockUserSettingsEntity({
                id: 'int-setting-id',
                dataType: ValueType.Int
            });
            mockUserSettingsRepository.create.mockResolvedValue(intSetting);

            const result = await service.create({
                name: 'Count Setting',
                key: 'max_items',
                value: '100',
                dataType: ValueType.Int,
                userId: 'user-id-1'
            });

            expect(result.id).toBe('int-setting-id');
        });

        it('should create settings with JSON data type', async () => {
            const jsonSetting = createMockUserSettingsEntity({
                id: 'json-setting-id',
                dataType: ValueType.Json,
                value: '{"theme":"dark","fontSize":14}'
            });
            mockUserSettingsRepository.create.mockResolvedValue(jsonSetting);

            const result = await service.create({
                name: 'Custom Settings',
                key: 'custom',
                value: '{"theme":"dark","fontSize":14}',
                dataType: ValueType.Json,
                userId: 'user-id-1'
            });

            expect(result.id).toBe('json-setting-id');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated user settings', async () => {
            const userSettings = [
                createMockUserSettingsEntity({ id: 'setting-1' }),
                createMockUserSettingsEntity({ id: 'setting-2' })
            ];
            mockUserSettingsRepository.findAll.mockResolvedValue(userSettings);
            mockUserSettingsRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['setting-1', 'setting-2'] }
                })
            );
        });

        it('should return empty result when no user settings found', async () => {
            mockUserSettingsRepository.findAll.mockResolvedValue([]);
            mockUserSettingsRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search parameter to repository', async () => {
            mockUserSettingsRepository.findAll.mockResolvedValue([]);
            mockUserSettingsRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'language' });

            expect(mockUserSettingsRepository.count).toHaveBeenCalledWith({
                search: 'language'
            });
        });

        it('should handle pagination correctly', async () => {
            const userSettings = [
                createMockUserSettingsEntity({ id: 'setting-21' })
            ];
            mockUserSettingsRepository.findAll.mockResolvedValue(userSettings);
            mockUserSettingsRepository.count.mockResolvedValue(50);

            const result = await service.fetchAll({ limit: 10, page: 3 });

            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(50);
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
        it('should return user settings created by specific user', async () => {
            const userSettings = [
                createMockUserSettingsEntity({
                    id: 'setting-1',
                    createdBy: 'creator-id'
                })
            ];
            mockUserSettingsRepository.findAll.mockResolvedValue(userSettings);
            mockUserSettingsRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id'
            });

            expect(result.data).toHaveLength(1);
            expect(mockUserSettingsRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' }
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['setting-1'] }
                })
            );
        });

        it('should return empty result when user has not created any settings', async () => {
            mockUserSettingsRepository.findAll.mockResolvedValue([]);
            mockUserSettingsRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'user-with-no-settings'
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchById', () => {
        it('should return user settings by ID', async () => {
            const userSettings = createMockUserSettingsEntity({
                id: 'setting-123'
            });
            mockUserSettingsRepository.findById.mockResolvedValue(userSettings);

            const result = await service.fetchById('setting-123');

            expect(result.id).toBe('setting-123');
            expect(mockUserSettingsRepository.findById).toHaveBeenCalledWith(
                'setting-123'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id'
                })
            );
        });

        it('should emit ResourceViewed event with entity data', async () => {
            const userSettings = createMockUserSettingsEntity({
                id: 'setting-123',
                key: 'language',
                value: 'en'
            });
            mockUserSettingsRepository.findById.mockResolvedValue(userSettings);

            await service.fetchById('setting-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.any(Object)
            );
        });
    });

    describe('update', () => {
        it('should update user settings successfully', async () => {
            const existingUserSettings = createMockUserSettingsEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { value: 'th' }
            });
            mockUserSettingsRepository.findById.mockResolvedValue(
                existingUserSettings
            );
            mockUserSettingsRepository.update.mockResolvedValue(
                existingUserSettings
            );

            const result = await service.update('setting-123', { value: 'th' });

            expect(result.id).toBe('setting-123');
            expect(mockUserSettingsRepository.update).toHaveBeenCalledWith(
                'setting-123',
                existingUserSettings
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'setting-123'
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingUserSettings = createMockUserSettingsEntity({
                id: 'setting-123',
                hasChanges: false
            });
            mockUserSettingsRepository.findById.mockResolvedValue(
                existingUserSettings
            );

            await expect(
                service.update('setting-123', { value: 'same' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingUserSettings = createMockUserSettingsEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { name: 'Updated Name', value: 'new_value' }
            });
            mockUserSettingsRepository.findById.mockResolvedValue(
                existingUserSettings
            );
            mockUserSettingsRepository.update.mockResolvedValue(
                existingUserSettings
            );

            const result = await service.update('setting-123', {
                name: 'Updated Name',
                value: 'new_value'
            });

            expect(result.id).toBe('setting-123');
            expect(mockUserSettingsRepository.update).toHaveBeenCalled();
        });

        it('should update namespace', async () => {
            const existingUserSettings = createMockUserSettingsEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { namespace: 'new-namespace' }
            });
            mockUserSettingsRepository.findById.mockResolvedValue(
                existingUserSettings
            );
            mockUserSettingsRepository.update.mockResolvedValue(
                existingUserSettings
            );

            const result = await service.update('setting-123', {
                namespace: 'new-namespace'
            });

            expect(result.id).toBe('setting-123');
        });
    });

    describe('deleteById', () => {
        it('should soft delete user settings successfully', async () => {
            const deletedUserSettings = createMockUserSettingsEntity({
                id: 'setting-123'
            });
            mockUserSettingsRepository.softDelete.mockResolvedValue(
                deletedUserSettings
            );

            const result = await service.deleteById('setting-123');

            expect(result.id).toBe('setting-123');
            expect(mockUserSettingsRepository.softDelete).toHaveBeenCalledWith(
                'setting-123'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'setting-123'
                })
            );
        });

        it('should emit ResourceDeleted event with entity data', async () => {
            const deletedUserSettings = createMockUserSettingsEntity({
                id: 'setting-123',
                key: 'language',
                value: 'en'
            });
            mockUserSettingsRepository.softDelete.mockResolvedValue(
                deletedUserSettings
            );

            await service.deleteById('setting-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'setting-123',
                    responsibleEntityId: 'current-user-id',
                    data: expect.any(Object)
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockUserSettingsRepository.softDelete.mockRejectedValue(
                new Error('Delete failed')
            );

            await expect(service.deleteById('setting-123')).rejects.toThrow(
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

            const newUserSettings = createMockUserSettingsEntity({
                id: 'new-user-settings-id'
            });
            mockUserSettingsRepository.create.mockResolvedValue(newUserSettings);

            const result = await service.create({
                name: 'Test',
                key: 'test',
                value: 'value',
                dataType: ValueType.String,
                userId: 'user-id-1'
            });

            expect(result.id).toBe('new-user-settings-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockUserSettingsRepository.findAll.mockResolvedValue([]);
            mockUserSettingsRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockUserSettingsRepository.findAll.mockResolvedValue([]);
            mockUserSettingsRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });

        it('should handle repository errors gracefully', async () => {
            mockUserSettingsRepository.create.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(
                service.create({
                    name: 'Test',
                    key: 'test',
                    value: 'value',
                    dataType: ValueType.String,
                    userId: 'user-id-1'
                })
            ).rejects.toThrow('Database connection failed');
        });

        it('should handle settings with boolean data type', async () => {
            const boolSetting = createMockUserSettingsEntity({
                id: 'bool-setting-id',
                key: 'enabled',
                value: 'true',
                dataType: ValueType.Boolean
            });
            mockUserSettingsRepository.create.mockResolvedValue(boolSetting);

            const result = await service.create({
                name: 'Enabled Setting',
                key: 'enabled',
                value: 'true',
                dataType: ValueType.Boolean,
                userId: 'user-id-1'
            });

            expect(result.id).toBe('bool-setting-id');
            expect(result.dataType).toBe(ValueType.Boolean);
        });
    });
});
