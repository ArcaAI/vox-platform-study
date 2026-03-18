/**
 * TenantService Unit Tests
 *
 * Tests for the TenantService that handles tenant management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantService } from '../tenant.service';
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

// Mock TenantRepository - simulates database operations
const mockTenantRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

// Mock GlobalSettingRepository - for tenant configurations
const mockGlobalSettingRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
};

// Mock DepartmentRepository
const mockDepartmentRepository = {
    findAll: vi.fn(),
    count: vi.fn(),
};

// Mock PromptTemplateRepository
const mockPromptTemplateRepository = {
    findAll: vi.fn(),
    count: vi.fn(),
};

// Mock AsrPipelineRepository
const mockAsrPipelineRepository = {
    findAll: vi.fn(),
    count: vi.fn(),
};

// Mock CoreDatabaseService
const mockDatabaseService = {
    getClient: vi.fn(),
};

// Mock TenantBucketService
const mockTenantBucketService = {
    provisionSystemBuckets: vi.fn(),
};

/**
 * Creates a complete mock tenant entity matching the real TenantEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockTenantEntity = (overrides: Partial<{
    id: string;
    key: string;
    name: string;
    description: string | null;
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
        id: overrides.id ?? 'tenant-id-1',
        key: overrides.key ?? 'TENANT_CODE',
        name: overrides.name ?? 'Test Tenant',
        description: overrides.description ?? null,
        resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
        createdBy: overrides.createdBy ?? null,
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        enable: vi.fn(),
        disable: vi.fn(),
        toObject: vi.fn(),
    };
    entity.toObject.mockReturnValue({
        id: entity.id,
        key: entity.key,
        name: entity.name,
        description: entity.description,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

/**
 * Creates a complete mock global setting entity for tenant configuration tests.
 */
const createMockGlobalSettingEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    namespace: string;
    key: string;
    value: string;
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
        id: overrides.id ?? 'setting-id-1',
        tenantId: overrides.tenantId ?? 'tenant-id-1',
        namespace: overrides.namespace ?? 'com.flw.configurations',
        key: overrides.key ?? 'setting.key',
        value: overrides.value ?? 'setting-value',
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
    entity.toObject.mockReturnValue({
        id: entity.id,
        tenantId: entity.tenantId,
        namespace: entity.namespace,
        key: entity.key,
        value: entity.value,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
    });
    return entity;
};

// Mock TenantFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        TenantFactory: {
            CreateTenant: vi.fn((data) => ({
                ...data,
                id: 'new-tenant-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-tenant-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
    };
});

describe('TenantService', () => {
    let service: TenantService;

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
        service = new TenantService(
            mockTenantRepository as any,
            mockGlobalSettingRepository as any,
            mockDepartmentRepository as any,
            mockPromptTemplateRepository as any,
            mockAsrPipelineRepository as any,
            mockDatabaseService as any,
            mockTenantBucketService as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new tenant with all required fields', async () => {
            const newTenant = createMockTenantEntity({
                id: 'new-tenant-id',
                key: 'NEW_TENANT',
                name: 'New Tenant',
                createdBy: 'current-user-id',
            });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            const result = await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
            });

            expect(result.id).toBe('new-tenant-id');
            expect(result.key).toBe('NEW_TENANT');
            expect(result.name).toBe('New Tenant');
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-tenant-id',
                    createdAt: newTenant.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockTenantRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    key: 'NEW_TENANT',
                    name: 'New Tenant',
                })
            ).rejects.toThrow('Failed to create TenantEntity');
        });

        it('should create tenant with optional description field', async () => {
            const newTenant = createMockTenantEntity({
                id: 'new-tenant-id',
                description: 'Test description',
            });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            const result = await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
                description: 'Test description',
            });

            expect(result.description).toBe('Test description');
        });

        it('should handle repository errors gracefully', async () => {
            mockTenantRepository.create.mockRejectedValue(new Error('Database connection failed'));

            await expect(
                service.create({
                    key: 'NEW_TENANT',
                    name: 'New Tenant',
                })
            ).rejects.toThrow('Database connection failed');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated tenants with correct pagination metadata', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', name: 'Tenant 1' }),
                createMockTenantEntity({ id: 'tenant-2', name: 'Tenant 2' }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual tenant data is returned
            expect(result.data[0].name).toBe('Tenant 1');
            expect(result.data[1].name).toBe('Tenant 2');
        });

        it('should return empty result when no tenants exist', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should emit ResourceViewed event with tenant IDs', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1' }),
                createMockTenantEntity({ id: 'tenant-2' }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['tenant-1', 'tenant-2'] },
                })
            );
        });

        it('should pass search parameter to repository', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

            expect(mockTenantRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: 'test-search' })
            );
        });

        it('should return both ENABLED and DISABLED tenants (no client-side filtering)', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', name: 'Active Tenant', resourceStatus: ResourceStatusType.ENABLED }),
                createMockTenantEntity({ id: 'tenant-2', name: 'Disabled Tenant', resourceStatus: ResourceStatusType.DISABLED }),
                createMockTenantEntity({ id: 'tenant-3', name: 'Another Active', resourceStatus: ResourceStatusType.ENABLED }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(3);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(3);
            expect(result.data[1].resourceStatus).toBe(ResourceStatusType.DISABLED);
        });

        it('should not filter out all-DISABLED tenants', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', resourceStatus: ResourceStatusType.DISABLED }),
                createMockTenantEntity({ id: 'tenant-2', resourceStatus: ResourceStatusType.DISABLED }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.data.every((t: any) => t.resourceStatus === ResourceStatusType.DISABLED)).toBe(true);
        });

        it('should include resourceStatus in every response DTO', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', resourceStatus: ResourceStatusType.DISABLED }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data[0]).toHaveProperty('resourceStatus');
            expect(result.data[0].resourceStatus).toBe(ResourceStatusType.DISABLED);
        });
    });

    describe('fetchAllByTenantCodeName', () => {
        it('should return tenants filtered by code name', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', key: 'CODE_1' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantCodeName({
                limit: 10,
                page: 1,
                codeName: 'CODE_1',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].key).toBe('CODE_1');
            expect(mockTenantRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { key: 'CODE_1' },
                })
            );
        });

        it('should emit event with code name in data', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', key: 'CODE_1' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            await service.fetchAllByTenantCodeName({
                limit: 10,
                page: 1,
                codeName: 'CODE_1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: expect.objectContaining({
                        key: 'CODE_1',
                        items: ['tenant-1'],
                    }),
                })
            );
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return tenants created by specific user', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', createdBy: 'creator-id' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].createdBy).toBe('creator-id');
            expect(mockTenantRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
        });

        it('should emit event with createdBy in data', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', createdBy: 'creator-id' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['tenant-1'] },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return tenant by ID with complete data', async () => {
            const tenant = createMockTenantEntity({
                id: 'tenant-123',
                name: 'Test Tenant',
                key: 'TEST_KEY',
            });
            mockTenantRepository.findById.mockResolvedValue(tenant);

            const result = await service.fetchById('tenant-123');

            expect(result.id).toBe('tenant-123');
            expect(result.name).toBe('Test Tenant');
            expect(result.key).toBe('TEST_KEY');
        });

        it('should emit ResourceViewed event with tenant data', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findById.mockResolvedValue(tenant);

            await service.fetchById('tenant-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockTenantRepository.findById.mockRejectedValue(new Error('Tenant not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('Tenant not found');
        });
    });

    describe('fetchByCodeName', () => {
        it('should return tenant by code name', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'MY_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const result = await service.fetchByCodeName('MY_CODE');

            expect(result.id).toBe('tenant-123');
            expect(result.key).toBe('MY_CODE');
            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { key: 'MY_CODE' },
            });
        });

        it('should emit ResourceViewed event with code name', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'MY_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            await service.fetchByCodeName('MY_CODE');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { key: 'MY_CODE', id: 'tenant-123' },
                })
            );
        });
    });

    describe('update', () => {
        it('should update tenant successfully and return updated entity', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                name: 'Old Name',
                hasChanges: true,
                changes: { name: 'Updated Tenant' },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.update.mockResolvedValue(existingTenant);

            const result = await service.update('tenant-123', { name: 'Updated Tenant' });

            expect(result.id).toBe('tenant-123');
            expect(mockTenantRepository.update).toHaveBeenCalledWith('tenant-123', existingTenant);
        });

        it('should emit ResourceUpdated event with changes and previous data', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'Updated Tenant' },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.update.mockResolvedValue(existingTenant);

            await service.update('tenant-123', { name: 'Updated Tenant' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'tenant-123',
                    data: { name: 'Updated Tenant' },
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: false,
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);

            await expect(
                service.update('tenant-123', { name: 'Same Name' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'New Name', description: 'New Description' },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.update.mockResolvedValue(existingTenant);

            await service.update('tenant-123', {
                name: 'New Name',
                description: 'New Description',
            });

            expect(mockTenantRepository.update).toHaveBeenCalled();
        });

        it('should update resourceStatus to DISABLED', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.update.mockResolvedValue(
                createMockTenantEntity({
                    id: 'tenant-123',
                    resourceStatus: ResourceStatusType.DISABLED,
                }),
            );

            const result = await service.update('tenant-123', {
                resourceStatus: ResourceStatusType.DISABLED,
            });

            expect(mockTenantRepository.update).toHaveBeenCalledWith('tenant-123', existingTenant);
            expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
        });

        it('should update resourceStatus to ENABLED', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                resourceStatus: ResourceStatusType.DISABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.ENABLED },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.update.mockResolvedValue(
                createMockTenantEntity({
                    id: 'tenant-123',
                    resourceStatus: ResourceStatusType.ENABLED,
                }),
            );

            const result = await service.update('tenant-123', {
                resourceStatus: ResourceStatusType.ENABLED,
            });

            expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
        });

        it('should update resourceStatus alongside other fields', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'New Name', resourceStatus: ResourceStatusType.DISABLED },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.update.mockResolvedValue(
                createMockTenantEntity({
                    id: 'tenant-123',
                    name: 'New Name',
                    resourceStatus: ResourceStatusType.DISABLED,
                }),
            );

            const result = await service.update('tenant-123', {
                name: 'New Name',
                resourceStatus: ResourceStatusType.DISABLED,
            });

            expect(result.name).toBe('New Name');
            expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
        });
    });

    describe('deleteById', () => {
        it('should soft delete tenant and return deleted entity', async () => {
            const deletedTenant = createMockTenantEntity({
                id: 'tenant-123',
                deletedAt: new Date(),
            });
            mockTenantRepository.softDelete.mockResolvedValue(deletedTenant);

            const result = await service.deleteById('tenant-123');

            expect(result.id).toBe('tenant-123');
            expect(mockTenantRepository.softDelete).toHaveBeenCalledWith('tenant-123');
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedTenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.softDelete.mockResolvedValue(deletedTenant);

            await service.deleteById('tenant-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'tenant-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockTenantRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('tenant-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('fetchTenantConfigs', () => {
        it('should throw ArgumentInvalidException when neither tenantId nor codeName provided', async () => {
            await expect(
                service.fetchTenantConfigs({ limit: 10, page: 1 })
            ).rejects.toThrow('Tenant ID or Tenant Code is required');
        });

        it('should throw ArgumentInvalidException when tenant not found', async () => {
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await expect(
                service.fetchTenantConfigs({ limit: 10, page: 1, tenantId: 'non-existent' })
            ).rejects.toThrow('Tenant not found');
        });

        it('should return all tenant configurations filtered by tenantId', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            const configs = [
                createMockGlobalSettingEntity({
                    id: 'config-1',
                    tenantId: 'tenant-123',
                    key: 'setting.one',
                    value: 'value-1',
                }),
                createMockGlobalSettingEntity({
                    id: 'config-2',
                    tenantId: 'tenant-123',
                    key: 'setting.two',
                    value: 'value-2',
                }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
            mockGlobalSettingRepository.count.mockResolvedValue(2);

            const result = await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                tenantId: 'tenant-123',
            });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId: 'tenant-123',
                    }),
                })
            );
        });

        it('should fetch configs by tenant code name', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'MY_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                codeName: 'MY_CODE',
            });

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: {
                    OR: [{ id: undefined }, { key: 'MY_CODE' }],
                },
            });
        });

        it('should emit ResourceViewed event with config IDs', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            const configs = [
                createMockGlobalSettingEntity({ id: 'config-1', tenantId: 'tenant-123' }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
            mockGlobalSettingRepository.count.mockResolvedValue(1);

            await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                tenantId: 'tenant-123',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: {
                        tenantId: 'tenant-123',
                        items: ['config-1'],
                    },
                })
            );
        });
    });

    describe('updateTenantConfigs', () => {
        it('should throw ArgumentInvalidException when tenant not found', async () => {
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs('non-existent', [{ id: 'config-1', value: 'new-value' }])
            ).rejects.toThrow('Tenant not found');
        });

        it('should throw ArgumentInvalidException when config not found', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs('tenant-123', [{ id: 'non-existent', value: 'new-value' }])
            ).rejects.toThrow('Config with id non-existent not found');
        });

        it('should throw ArgumentInvalidException when config belongs to different tenant', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            const config = createMockGlobalSettingEntity({
                id: 'config-1',
                tenantId: 'different-tenant',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(config);

            await expect(
                service.updateTenantConfigs('tenant-123', [{ id: 'config-1', value: 'new-value' }])
            ).rejects.toThrow('Config config-1 does not belong to tenant tenant-123');
        });

        it('should find tenant by code name when updating configs', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'TENANT_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs('TENANT_CODE', [{ id: 'config-1', value: 'new-value' }])
            ).rejects.toThrow('Config with id config-1 not found');

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: {
                    OR: [{ id: 'TENANT_CODE' }, { key: 'TENANT_CODE' }],
                },
            });
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            const result = await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
            });

            expect(result.id).toBe('new-tenant-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });
    });

    describe('updateTenantConfigs — SMR provider/model validation (TASK-240)', () => {
        const CATALOG_JSON = JSON.stringify([
            {
                provider: 'ollama',
                models: [
                    { name: 'granite4:latest', size: '2.1 GB' },
                    { name: 'gemma3:latest', size: '3.3 GB' },
                ],
            },
            {
                provider: 'lm-studio',
                models: [{ name: 'qwen3.5-4b', size: '3.1 GB' }],
            },
            {
                provider: 'azure-openai',
                models: [{ name: 'gpt-4o-mini', size: '' }],
            },
        ]);

        it('should reject an invalid default-smr-provider not in catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const providerSetting = createMockGlobalSettingEntity({
                id: 'smr-provider-id',
                tenantId: 'tenant-123',
                key: 'default-smr-provider',
                value: 'ollama',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(providerSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'catalog-id',
                tenantId: 'tenant-123',
                key: 'smr-provider-models',
                value: CATALOG_JSON,
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting]);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'smr-provider-id', value: 'invalid-provider' },
                ]),
            ).rejects.toThrow(/not a valid SMR provider/i);
        });

        it('should reject an invalid default-smr-model not in the selected provider catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const modelSetting = createMockGlobalSettingEntity({
                id: 'smr-model-id',
                tenantId: 'tenant-123',
                key: 'default-smr-model',
                value: 'granite4:latest',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(modelSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'catalog-id',
                tenantId: 'tenant-123',
                key: 'smr-provider-models',
                value: CATALOG_JSON,
            });

            const providerSetting = createMockGlobalSettingEntity({
                id: 'smr-provider-id',
                tenantId: 'tenant-123',
                key: 'default-smr-provider',
                value: 'ollama',
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting, providerSetting]);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'smr-model-id', value: 'nonexistent-model' },
                ]),
            ).rejects.toThrow(/not a valid model/i);
        });

        it('should accept a valid provider from the catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const providerSetting = createMockGlobalSettingEntity({
                id: 'smr-provider-id',
                tenantId: 'tenant-123',
                key: 'default-smr-provider',
                value: 'ollama',
                hasChanges: true,
                changes: { value: 'lm-studio' },
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(providerSetting);
            mockGlobalSettingRepository.update.mockResolvedValue(providerSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'catalog-id',
                tenantId: 'tenant-123',
                key: 'smr-provider-models',
                value: CATALOG_JSON,
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting]);

            const result = await service.updateTenantConfigs('tenant-123', [
                { id: 'smr-provider-id', value: 'lm-studio' },
            ]);

            expect(result.data).toHaveLength(1);
        });
    });
});
