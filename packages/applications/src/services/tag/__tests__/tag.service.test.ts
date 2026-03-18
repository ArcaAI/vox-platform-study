/**
 * TagService Unit Tests
 *
 * Tests for the TagService that handles tag management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TagService } from '../tag.service';
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

// Mock TagRepository - simulates database operations
const mockTagRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Creates a complete mock tag entity matching the real TagEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockTagEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    resourceTypeName: string | null;
    resourceId: string | null;
    tagKey: string | null;
    tagValue: string;
    description: string | null;
    color: string | null;
    icon: string | null;
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
        id: overrides.id ?? 'tag-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        resourceTypeName: overrides.resourceTypeName ?? null,
        resourceId: overrides.resourceId ?? null,
        tagKey: overrides.tagKey ?? 'category',
        tagValue: overrides.tagValue ?? 'Test Tag',
        description: overrides.description ?? null,
        color: overrides.color ?? '#FF0000',
        icon: overrides.icon ?? null,
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
        tenantId: entity.tenantId,
        resourceTypeName: entity.resourceTypeName,
        resourceId: entity.resourceId,
        tagKey: entity.tagKey,
        tagValue: entity.tagValue,
        description: entity.description,
        color: entity.color,
        icon: entity.icon,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

// Mock TagFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        TagFactory: {
            CreateTag: vi.fn((data) => ({
                ...data,
                id: 'new-tag-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-tag-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
    };
});

describe('TagService', () => {
    let service: TagService;

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
        service = new TagService(
            mockTagRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new tag with all required fields', async () => {
            const newTag = createMockTagEntity({
                id: 'new-tag-id',
                tenantId: 'tenant-1',
                tagValue: 'New Tag',
                color: '#00FF00',
            });
            mockTagRepository.create.mockResolvedValue(newTag);

            const result = await service.create({
                tenantId: 'tenant-1',
                tagValue: 'New Tag',
                color: '#00FF00',
            });

            // Verify the returned entity has correct data
            expect(result.id).toBe('new-tag-id');
            expect(result.tenantId).toBe('tenant-1');
            expect(result.tagValue).toBe('New Tag');
            expect(result.color).toBe('#00FF00');
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newTag = createMockTagEntity({ id: 'new-tag-id' });
            mockTagRepository.create.mockResolvedValue(newTag);

            await service.create({
                tenantId: 'tenant-1',
                tagValue: 'New Tag',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-tag-id',
                    createdAt: newTag.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockTagRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    tagValue: 'New Tag',
                })
            ).rejects.toThrow('Failed to create TagEntity');
        });

        it('should create tag with optional fields', async () => {
            const newTag = createMockTagEntity({
                id: 'new-tag-id',
                tagKey: 'priority',
                tagValue: 'high',
                description: 'High priority tag',
                color: '#FF0000',
                icon: 'star',
            });
            mockTagRepository.create.mockResolvedValue(newTag);

            const result = await service.create({
                tenantId: 'tenant-1',
                tagKey: 'priority',
                tagValue: 'high',
                description: 'High priority tag',
                color: '#FF0000',
                icon: 'star',
            });

            expect(result.tagKey).toBe('priority');
            expect(result.description).toBe('High priority tag');
            expect(result.icon).toBe('star');
        });

        it('should create tag associated with a resource', async () => {
            const newTag = createMockTagEntity({
                id: 'new-tag-id',
                resourceTypeName: 'Consultation',
                resourceId: 'consultation-123',
            });
            mockTagRepository.create.mockResolvedValue(newTag);

            const result = await service.create({
                tenantId: 'tenant-1',
                resourceTypeName: 'Consultation',
                resourceId: 'consultation-123',
                tagValue: 'Important',
            });

            expect(result.resourceTypeName).toBe('Consultation');
            expect(result.resourceId).toBe('consultation-123');
        });

        it('should handle repository errors gracefully', async () => {
            mockTagRepository.create.mockRejectedValue(new Error('Database connection failed'));

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    tagValue: 'New Tag',
                })
            ).rejects.toThrow('Database connection failed');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated tags with correct pagination metadata', async () => {
            const tags = [
                createMockTagEntity({ id: 'tag-1', tagValue: 'Tag 1' }),
                createMockTagEntity({ id: 'tag-2', tagValue: 'Tag 2' }),
            ];
            mockTagRepository.findAll.mockResolvedValue(tags);
            mockTagRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual tag data is returned
            expect(result.data[0].tagValue).toBe('Tag 1');
            expect(result.data[1].tagValue).toBe('Tag 2');
        });

        it('should return empty result when no tags exist', async () => {
            mockTagRepository.findAll.mockResolvedValue([]);
            mockTagRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should emit ResourceViewed event with tag IDs', async () => {
            const tags = [
                createMockTagEntity({ id: 'tag-1' }),
                createMockTagEntity({ id: 'tag-2' }),
            ];
            mockTagRepository.findAll.mockResolvedValue(tags);
            mockTagRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['tag-1', 'tag-2'] },
                })
            );
        });

        it('should pass search parameter to repository', async () => {
            mockTagRepository.findAll.mockResolvedValue([]);
            mockTagRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'priority' });

            expect(mockTagRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: 'priority' })
            );
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return tags filtered by tenant ID', async () => {
            const tags = [createMockTagEntity({ id: 'tag-1', tenantId: 'tenant-1' })];
            mockTagRepository.findAll.mockResolvedValue(tags);
            mockTagRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].tenantId).toBe('tenant-1');
            expect(mockTagRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'tenant-1' },
                })
            );
        });

        it('should emit event with tenantId in data', async () => {
            const tags = [createMockTagEntity({ id: 'tag-1', tenantId: 'tenant-1' })];
            mockTagRepository.findAll.mockResolvedValue(tags);
            mockTagRepository.count.mockResolvedValue(1);

            await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { tenantId: 'tenant-1', items: ['tag-1'] },
                })
            );
        });

        it('should return empty result when no tags match tenant', async () => {
            mockTagRepository.findAll.mockResolvedValue([]);
            mockTagRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'non-existent-tenant',
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return tags created by specific user', async () => {
            const tags = [createMockTagEntity({ id: 'tag-1', createdBy: 'creator-id' })];
            mockTagRepository.findAll.mockResolvedValue(tags);
            mockTagRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].createdBy).toBe('creator-id');
            expect(mockTagRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
        });

        it('should emit event with createdBy in data', async () => {
            const tags = [createMockTagEntity({ id: 'tag-1', createdBy: 'creator-id' })];
            mockTagRepository.findAll.mockResolvedValue(tags);
            mockTagRepository.count.mockResolvedValue(1);

            await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['tag-1'] },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return tag by ID with complete data', async () => {
            const tag = createMockTagEntity({
                id: 'tag-123',
                tagKey: 'status',
                tagValue: 'active',
                color: '#00FF00',
            });
            mockTagRepository.findById.mockResolvedValue(tag);

            const result = await service.fetchById('tag-123');

            expect(result.id).toBe('tag-123');
            expect(result.tagKey).toBe('status');
            expect(result.tagValue).toBe('active');
            expect(result.color).toBe('#00FF00');
        });

        it('should emit ResourceViewed event with tag data', async () => {
            const tag = createMockTagEntity({ id: 'tag-123' });
            mockTagRepository.findById.mockResolvedValue(tag);

            await service.fetchById('tag-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockTagRepository.findById.mockRejectedValue(new Error('Tag not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('Tag not found');
        });
    });

    describe('update', () => {
        it('should update tag successfully and return updated entity', async () => {
            const existingTag = createMockTagEntity({
                id: 'tag-123',
                tagValue: 'Old Value',
                hasChanges: true,
                changes: { tagValue: 'Updated Tag' },
            });
            mockTagRepository.findById.mockResolvedValue(existingTag);
            mockTagRepository.update.mockResolvedValue(existingTag);

            const result = await service.update('tag-123', { tagValue: 'Updated Tag' });

            expect(result.id).toBe('tag-123');
            expect(mockTagRepository.update).toHaveBeenCalledWith('tag-123', existingTag);
        });

        it('should emit ResourceUpdated event with changes and previous data', async () => {
            const existingTag = createMockTagEntity({
                id: 'tag-123',
                hasChanges: true,
                changes: { tagValue: 'Updated Tag' },
            });
            mockTagRepository.findById.mockResolvedValue(existingTag);
            mockTagRepository.update.mockResolvedValue(existingTag);

            await service.update('tag-123', { tagValue: 'Updated Tag' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'tag-123',
                    data: { tagValue: 'Updated Tag' },
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingTag = createMockTagEntity({
                id: 'tag-123',
                hasChanges: false,
            });
            mockTagRepository.findById.mockResolvedValue(existingTag);

            await expect(
                service.update('tag-123', { tagValue: 'Same Value' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingTag = createMockTagEntity({
                id: 'tag-123',
                hasChanges: true,
                changes: { tagValue: 'New Value', color: '#0000FF', description: 'Updated description' },
            });
            mockTagRepository.findById.mockResolvedValue(existingTag);
            mockTagRepository.update.mockResolvedValue(existingTag);

            await service.update('tag-123', {
                tagValue: 'New Value',
                color: '#0000FF',
                description: 'Updated description',
            });

            expect(mockTagRepository.update).toHaveBeenCalled();
        });
    });

    describe('deleteById', () => {
        it('should soft delete tag and return deleted entity', async () => {
            const deletedTag = createMockTagEntity({
                id: 'tag-123',
                deletedAt: new Date(),
            });
            mockTagRepository.softDelete.mockResolvedValue(deletedTag);

            const result = await service.deleteById('tag-123');

            expect(result.id).toBe('tag-123');
            expect(mockTagRepository.softDelete).toHaveBeenCalledWith('tag-123');
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedTag = createMockTagEntity({ id: 'tag-123' });
            mockTagRepository.softDelete.mockResolvedValue(deletedTag);

            await service.deleteById('tag-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'tag-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockTagRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('tag-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newTag = createMockTagEntity({ id: 'new-tag-id' });
            mockTagRepository.create.mockResolvedValue(newTag);

            const result = await service.create({
                tenantId: 'tenant-1',
                tagValue: 'New Tag',
            });

            expect(result.id).toBe('new-tag-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockTagRepository.findAll.mockResolvedValue([]);
            mockTagRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockTagRepository.findAll.mockResolvedValue([]);
            mockTagRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });

        it('should handle tags with special characters in values', async () => {
            const newTag = createMockTagEntity({
                id: 'new-tag-id',
                tagValue: 'Tag with "quotes" & <special> chars',
            });
            mockTagRepository.create.mockResolvedValue(newTag);

            const result = await service.create({
                tenantId: 'tenant-1',
                tagValue: 'Tag with "quotes" & <special> chars',
            });

            expect(result.tagValue).toBe('Tag with "quotes" & <special> chars');
        });
    });
});
