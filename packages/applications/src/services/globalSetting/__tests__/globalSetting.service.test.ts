/**
 * GlobalSettingService Unit Tests
 *
 * Tests for the GlobalSettingService that handles global settings management.
 *
 * Testing Strategy:
 * - Tests verify actual behavior and output data, not just mock calls
 * - Mock entities include complete structure matching real entities
 * - Assertions focus on what the code does, not what mocks do
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GlobalSettingService } from '../globalSetting.service';
import { SysEventType, ValueType } from '@arcaai/domains';

// Define ResourceStatus locally to avoid mock issues
const ResourceStatus = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
} as const;

// Mock ClsService
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock GlobalSettingRepository
// TASK-302 Stream D Phase C (C.7) — `update` migrated to `updateWithVersion`
// for Compare-And-Set semantics; mock both so legacy tests still wire while
// the new behaviour can be asserted on the new method.
const mockGlobalSettingRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Creates a complete mock GlobalSettingEntity that matches the real entity structure.
 * This prevents Anti-Pattern #4 (Incomplete Mocks) by including all fields.
 */
const createMockGlobalSettingEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    key: string;
    value: string;
    dataType: ValueType;
    namespace: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    resourceStatus: ResourceStatus;
    deletedAt: Date | null;
    deletedBy: string | null;
}> = {}) => {
    const entity = {
        id: overrides.id ?? 'setting-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        name: overrides.name ?? 'Test Setting',
        description: overrides.description ?? 'A test setting',
        key: overrides.key ?? 'test.setting.key',
        value: overrides.value ?? 'test-value',
        dataType: overrides.dataType ?? ValueType.String,
        namespace: overrides.namespace ?? 'test',
        createdBy: overrides.createdBy ?? 'user-123',
        createdAt: overrides.createdAt ?? new Date('2026-01-30T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-30T10:00:00Z'),
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        resourceStatus: overrides.resourceStatus ?? ResourceStatus.ENABLED,
        deletedAt: overrides.deletedAt ?? null,
        deletedBy: overrides.deletedBy ?? null,
        // Complete toObject returns all entity fields
        toObject: vi.fn(),
    };

    // toObject returns the complete entity structure
    entity.toObject.mockReturnValue({
        id: entity.id,
        tenantId: entity.tenantId,
        name: entity.name,
        description: entity.description,
        key: entity.key,
        value: entity.value,
        dataType: entity.dataType,
        namespace: entity.namespace,
        createdBy: entity.createdBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        resourceStatus: entity.resourceStatus,
    });

    return entity;
};

// Mock GlobalSettingFactory
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        GlobalSettingFactory: {
            CreateGlobalSetting: vi.fn((data) => ({
                ...data,
                id: 'new-setting-id',
                createdAt: new Date(),
                updatedAt: new Date(),
                toObject: vi.fn().mockReturnValue({ id: 'new-setting-id', ...data }),
            })),
        },
    };
});

describe('GlobalSettingService', () => {
    let service: GlobalSettingService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Default: return valid user from CLS
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'current-user-id' };
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
        service = new GlobalSettingService(
            mockGlobalSettingRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new global setting and return the created entity', async () => {
            const expectedName = 'New Setting';
            const expectedKey = 'new.setting.key';
            const expectedValue = 'new-value';
            const newSetting = createMockGlobalSettingEntity({
                id: 'new-setting-id',
                name: expectedName,
                key: expectedKey,
                value: expectedValue,
            });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: expectedName,
                key: expectedKey,
                value: expectedValue,
                dataType: ValueType.String,
            });

            // Verify the returned entity has correct data (behavior verification)
            expect(result.id).toBe('new-setting-id');
            expect(result.name).toBe(expectedName);
            expect(result.key).toBe(expectedKey);
            expect(result.value).toBe(expectedValue);

            // Verify event was emitted with complete entity data
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-setting-id',
                    data: expect.objectContaining({
                        id: 'new-setting-id',
                        name: expectedName,
                        key: expectedKey,
                    }),
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockGlobalSettingRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    name: 'New Setting',
                    key: 'new.setting.key',
                    value: 'new-value',
                    dataType: ValueType.String,
                })
            ).rejects.toThrow('Failed to create GlobalSettingEntity');
        });

        it('should include createdBy from user context in the created entity', async () => {
            const newSetting = createMockGlobalSettingEntity({
                id: 'new-setting-id',
                createdBy: 'current-user-id',
            });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Setting',
                key: 'new.setting.key',
                value: 'new-value',
                dataType: ValueType.String,
            });

            // Verify the result contains the user context
            expect(result.createdBy).toBe('current-user-id');
        });

        it('should broadcast ResourceCreated event with timestamp and complete entity data', async () => {
            const createdAt = new Date('2026-01-30T10:00:00Z');
            const newSetting = createMockGlobalSettingEntity({
                id: 'new-setting-id',
                createdAt,
            });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            await service.create({
                tenantId: 'tenant-1',
                name: 'New Setting',
                key: 'new.setting.key',
                value: 'new-value',
                dataType: ValueType.String,
            });

            // Verify event contains all required audit data
            const emitCall = mockEventEmitter.emit.mock.calls[0];
            expect(emitCall[0]).toBe(SysEventType.ResourceCreated);
            expect(emitCall[1]).toMatchObject({
                resourceId: 'new-setting-id',
                createdAt,
            });
            expect(emitCall[1].data).toBeDefined();
        });

        it('should persist description when provided', async () => {
            const description = 'Custom description for the setting';
            const newSetting = createMockGlobalSettingEntity({
                id: 'new-setting-id',
                description,
            });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Setting',
                key: 'new.setting.key',
                value: 'new-value',
                dataType: ValueType.String,
                description,
            });

            expect(result.description).toBe(description);
        });

        it('should persist namespace when provided', async () => {
            const namespace = 'custom.namespace';
            const newSetting = createMockGlobalSettingEntity({
                id: 'new-setting-id',
                namespace,
            });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Setting',
                key: 'new.setting.key',
                value: 'new-value',
                dataType: ValueType.String,
                namespace,
            });

            expect(result.namespace).toBe(namespace);
        });

        it('should handle all ValueType data types correctly', async () => {
            const dataTypes = [ValueType.String, ValueType.Integer, ValueType.Boolean];

            for (const dataType of dataTypes) {
                vi.clearAllMocks();
                const newSetting = createMockGlobalSettingEntity({
                    id: `setting-${dataType}`,
                    dataType,
                });
                mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

                const result = await service.create({
                    tenantId: 'tenant-1',
                    name: 'Test Setting',
                    key: 'test.key',
                    value: 'test-value',
                    dataType,
                });

                expect(result.dataType).toBe(dataType);
            }
        });
    });

    describe('fetchAll', () => {
        it('should return paginated response with correct structure', async () => {
            const settings = [
                createMockGlobalSettingEntity({ id: 'setting-1', name: 'Setting One' }),
                createMockGlobalSettingEntity({ id: 'setting-2', name: 'Setting Two' }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
            mockGlobalSettingRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            // Verify response structure
            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);

            // Verify actual data content
            expect(result.data[0].id).toBe('setting-1');
            expect(result.data[0].name).toBe('Setting One');
            expect(result.data[1].id).toBe('setting-2');
            expect(result.data[1].name).toBe('Setting Two');

            // Verify audit event contains the viewed item IDs
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['setting-1', 'setting-2'] },
                })
            );
        });

        it('should return empty FetchResponse when no settings exist', async () => {
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
        });

        it('should pass search parameter to repository for filtering', async () => {
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

            // Verify search is passed to count for accurate pagination
            expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test-search',
                })
            );
        });

        it('should calculate correct pagination offset', async () => {
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(50);

            const result = await service.fetchAll({ limit: 10, page: 3 });

            expect(result.page).toBe(3);
            expect(result.limit).toBe(10);
            // Repository should be called with skip/take for page 3
            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalled();
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return settings filtered by tenant ID', async () => {
            const settings = [createMockGlobalSettingEntity({ id: 'setting-1', tenantId: 'tenant-1' })];
            mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
            mockGlobalSettingRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(1);
            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'tenant-1' },
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { tenantId: 'tenant-1', items: ['setting-1'] },
                })
            );
        });

        it('should apply pagination and search with tenant filter', async () => {
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            await service.fetchAllByTenantId({
                limit: 20,
                page: 2,
                search: 'test',
                tenantId: 'tenant-1',
            });

            expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    search: 'test',
                    where: { tenantId: 'tenant-1' },
                })
            );
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return settings created by specific user', async () => {
            const settings = [createMockGlobalSettingEntity({ id: 'setting-1', createdBy: 'creator-id' })];
            mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
            mockGlobalSettingRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['setting-1'] },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return global setting by ID', async () => {
            const setting = createMockGlobalSettingEntity({ id: 'setting-123' });
            mockGlobalSettingRepository.findById.mockResolvedValue(setting);

            const result = await service.fetchById('setting-123');

            expect(result.id).toBe('setting-123');
            expect(mockGlobalSettingRepository.findById).toHaveBeenCalledWith('setting-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should broadcast event with entity data', async () => {
            const setting = createMockGlobalSettingEntity({ id: 'setting-123' });
            mockGlobalSettingRepository.findById.mockResolvedValue(setting);

            await service.fetchById('setting-123');

            expect(setting.toObject).toHaveBeenCalled();
        });
    });

    describe('update', () => {
        it('should update global setting successfully via updateWithVersion (TASK-302 Stream D Phase C C.7)', async () => {
            const existingSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { value: 'updated-value' },
            });
            (existingSetting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(existingSetting);

            const result = await service.update('setting-123', { value: 'updated-value', expectedVersion: 5 } as any);

            expect(result.id).toBe('setting-123');
            // C.7 — `update` issues a Compare-And-Set against the client's
            // expectedVersion. Legacy non-versioned `update` must NOT be called.
            expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalledWith('setting-123', existingSetting, 5);
            expect(mockGlobalSettingRepository.update).not.toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'setting-123',
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: false,
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);

            await expect(
                service.update('setting-123', { value: 'same-value', expectedVersion: 1 } as any)
            ).rejects.toThrow('No changes to write to');
            // ArgumentInvalidException fires BEFORE the CAS, so the repo must
            // not have been touched.
            expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
        });

        it('should broadcast ResourceUpdated event with previousVersion + newVersion (TASK-302 Stream D Phase C C.7/C.8)', async () => {
            const existingSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { name: 'Updated Name' },
            });
            (existingSetting as any).version = 7;
            const persistedSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { name: 'Updated Name' },
            });
            (persistedSetting as any).version = 8; // bumped by CAS
            mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(persistedSetting);

            await service.update('setting-123', { name: 'Updated Name', expectedVersion: 7 } as any);

            // C.8 — the audit-log SysEvent must carry both the pre-write and
            // post-write versions so downstream observers can correlate.
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'setting-123',
                    data: expect.objectContaining({
                        previousVersion: 7,
                        newVersion: 8,
                    }),
                    previousData: expect.any(Object),
                })
            );
        });

        it('propagates OptimisticConcurrencyException when expectedVersion drifted (TASK-302 Stream D Phase C C.7)', async () => {
            const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
            const existingSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: true,
            });
            (existingSetting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
            mockGlobalSettingRepository.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('GlobalSetting', 'setting-123', {
                    expectedVersion: 5,
                    currentVersion: 6,
                }),
            );

            await expect(
                service.update('setting-123', { value: 'new-value', expectedVersion: 5 } as any),
            ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
        });

        it('should update multiple fields at once via updateWithVersion', async () => {
            const existingSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: true,
                changes: { name: 'Updated Name', value: 'updated-value', description: 'Updated description' },
            });
            (existingSetting as any).version = 3;
            mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(existingSetting);

            await service.update('setting-123', {
                name: 'Updated Name',
                value: 'updated-value',
                description: 'Updated description',
                expectedVersion: 3,
            } as any);

            expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalled();
        });
    });

    describe('deleteById', () => {
        it('should soft delete global setting successfully', async () => {
            const deletedSetting = createMockGlobalSettingEntity({ id: 'setting-123' });
            mockGlobalSettingRepository.softDelete.mockResolvedValue(deletedSetting);

            const result = await service.deleteById('setting-123');

            expect(result.id).toBe('setting-123');
            expect(mockGlobalSettingRepository.softDelete).toHaveBeenCalledWith('setting-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'setting-123',
                })
            );
        });

        it('should broadcast ResourceDeleted event with entity data', async () => {
            const deletedSetting = createMockGlobalSettingEntity({ id: 'setting-123' });
            mockGlobalSettingRepository.softDelete.mockResolvedValue(deletedSetting);

            await service.deleteById('setting-123');

            expect(deletedSetting.toObject).toHaveBeenCalled();
        });
    });

    describe('Context Integration', () => {
        it('should use user from CLS context for createdBy', async () => {
            const newSetting = createMockGlobalSettingEntity({ id: 'new-setting-id' });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            await service.create({
                tenantId: 'tenant-1',
                name: 'New Setting',
                key: 'new.setting.key',
                value: 'new-value',
                dataType: ValueType.String,
            });

            expect(mockClsService.get).toHaveBeenCalledWith('user');
        });

        it('should handle missing user in context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newSetting = createMockGlobalSettingEntity({ id: 'new-setting-id', createdBy: null });
            mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'New Setting',
                key: 'new.setting.key',
                value: 'new-value',
                dataType: ValueType.String,
            });

            expect(result).toBeDefined();
        });
    });

    describe('Data Types', () => {
        it('should store and return String data type with string value', async () => {
            const setting = createMockGlobalSettingEntity({
                dataType: ValueType.String,
                value: 'string-value',
            });
            mockGlobalSettingRepository.create.mockResolvedValue(setting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'String Setting',
                key: 'string.setting',
                value: 'string-value',
                dataType: ValueType.String,
            });

            expect(result.dataType).toBe(ValueType.String);
            expect(result.value).toBe('string-value');
        });

        it('should store and return Integer data type with numeric string value', async () => {
            const setting = createMockGlobalSettingEntity({
                dataType: ValueType.Integer,
                value: '42',
            });
            mockGlobalSettingRepository.create.mockResolvedValue(setting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'Integer Setting',
                key: 'integer.setting',
                value: '42',
                dataType: ValueType.Integer,
            });

            expect(result.dataType).toBe(ValueType.Integer);
            expect(result.value).toBe('42');
        });

        it('should store and return Boolean data type with boolean string value', async () => {
            const setting = createMockGlobalSettingEntity({
                dataType: ValueType.Boolean,
                value: 'true',
            });
            mockGlobalSettingRepository.create.mockResolvedValue(setting);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'Boolean Setting',
                key: 'boolean.setting',
                value: 'true',
                dataType: ValueType.Boolean,
            });

            expect(result.dataType).toBe(ValueType.Boolean);
            expect(result.value).toBe('true');
        });
    });

    describe('Repository Error Handling', () => {
        it('should propagate repository errors on findById', async () => {
            const error = new Error('Entity not found');
            mockGlobalSettingRepository.findById.mockRejectedValue(error);

            await expect(service.fetchById('non-existent-id')).rejects.toThrow('Entity not found');
        });

        it('should propagate repository errors on findAll', async () => {
            const error = new Error('Database connection failed');
            mockGlobalSettingRepository.findAll.mockRejectedValue(error);

            await expect(service.fetchAll({ limit: 10, page: 1 })).rejects.toThrow('Database connection failed');
        });

        it('should propagate repository errors on update', async () => {
            const existingSetting = createMockGlobalSettingEntity({
                id: 'setting-123',
                hasChanges: true,
            });
            (existingSetting as any).version = 1;
            mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
            mockGlobalSettingRepository.updateWithVersion.mockRejectedValue(new Error('Update failed'));

            await expect(service.update('setting-123', { value: 'new-value', expectedVersion: 1 } as any)).rejects.toThrow('Update failed');
        });

        it('should propagate repository errors on softDelete', async () => {
            mockGlobalSettingRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('setting-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('Concurrent Operations', () => {
        it('should handle multiple concurrent fetchAll requests', async () => {
            const settings = [createMockGlobalSettingEntity({ id: 'setting-1' })];
            mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
            mockGlobalSettingRepository.count.mockResolvedValue(1);

            const [result1, result2, result3] = await Promise.all([
                service.fetchAll({ limit: 10, page: 1 }),
                service.fetchAll({ limit: 10, page: 2 }),
                service.fetchAll({ limit: 10, page: 3 }),
            ]);

            expect(result1.data).toHaveLength(1);
            expect(result2.data).toHaveLength(1);
            expect(result3.data).toHaveLength(1);
        });
    });
});
