/**
 * ResourceSubscriptionService Unit Tests
 *
 * Tests for the ResourceSubscriptionService that handles resource subscription management operations.
 *
 * Testing Strategy:
 * - Focus on verifying actual behavior and return values, not just mock calls
 * - Complete mock entities that match real entity structure
 * - Test error handling and edge cases
 * - Verify event emission payloads
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ResourceSubscriptionService } from '../resourceSubscription.service';
import {
    SysEventType,
    ResourceType,
    ResourceSubscriptionType,
    ResourceStatusType,
} from '@arcaai/domains';

// Mock ClsService
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock ResourceSubscriptionRepository
const mockResourceSubscriptionRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    findByResource: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Helper to create mock resource subscription entity with complete structure.
 * Mocks should be indistinguishable from real entities to catch structural issues.
 *
 * `tenantId` added so the tenant-guard sweep
 * tests can exercise same-tenant / cross-tenant branches. Defaults to
 * `tenant-1` to match the CLS default in `beforeEach`.
 */
const createMockResourceSubscriptionEntity = (
    overrides: Partial<{
        id: string;
        tenantId: string;
        resourceId: string;
        resourceTypeName: ResourceType;
        subscriptionType: ResourceSubscriptionType;
        resourceStatus: ResourceStatusType;
        targetUserId: string;
        subscriptionMetadata: Record<string, unknown> | null;
        createdBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        hasChanges: boolean;
        changes: Record<string, unknown>;
    }> = {}
) => {
    const entity = {
        id: overrides.id ?? 'subscription-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        resourceId: overrides.resourceId ?? 'resource-123',
        resourceTypeName: overrides.resourceTypeName ?? ResourceType.Consultation,
        subscriptionType: overrides.subscriptionType ?? ResourceSubscriptionType.SUBSCRIBER,
        resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
        targetUserId: overrides.targetUserId ?? 'user-123',
        subscriptionMetadata: overrides.subscriptionMetadata ?? null,
        createdBy: overrides.createdBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        // Complete entity methods
        toObject: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
    };

    // toObject returns complete entity structure (matching real entity behavior)
    entity.toObject.mockReturnValue({
        id: entity.id,
        tenantId: entity.tenantId,
        resourceId: entity.resourceId,
        resourceTypeName: entity.resourceTypeName,
        subscriptionType: entity.subscriptionType,
        resourceStatus: entity.resourceStatus,
        targetUserId: entity.targetUserId,
        subscriptionMetadata: entity.subscriptionMetadata,
        createdBy: entity.createdBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });

    return entity;
};

// Mock ResourceSubscriptionFactory
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        ResourceSubscriptionFactory: {
            CreateResourceSubscription: vi.fn((data) => ({
                ...data,
                id: 'new-subscription-id',
                createdAt: new Date(),
                updatedAt: new Date(),
                toObject: vi.fn().mockReturnValue({ id: 'new-subscription-id', ...data }),
            })),
        },
    };
});

describe('ResourceSubscriptionService', () => {
    let service: ResourceSubscriptionService;

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
        service = new ResourceSubscriptionService(
            mockResourceSubscriptionRepository as any,
            mockEventEmitter as any,
            mockClsService as any
        );
    });

    describe('create', () => {
        it('should create a new resource subscription successfully', async () => {
            const newSubscription = createMockResourceSubscriptionEntity({
                id: 'new-subscription-id',
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(newSubscription);

            const result = await service.create({
                resourceId: 'resource-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });

            expect(result.id).toBe('new-subscription-id');
            expect(mockResourceSubscriptionRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-subscription-id',
                })
            );
        });

        it('should throw InternalServerErrorException when creation fails', async () => {
            mockResourceSubscriptionRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    resourceId: 'resource-123',
                    resourceTypeName: ResourceType.Consultation,
                    subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
                    resourceStatus: ResourceStatusType.ENABLED,
                    targetUserId: 'user-123',
                })
            ).rejects.toThrow('Failed to create resource subscription');
        });

        it('should set createdBy from current user context', async () => {
            const newSubscription = createMockResourceSubscriptionEntity({
                id: 'new-subscription-id',
                createdBy: 'current-user-id',
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(newSubscription);

            await service.create({
                resourceId: 'resource-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });

            expect(mockResourceSubscriptionRepository.create).toHaveBeenCalled();
        });

        it('should create subscription with different subscription types', async () => {
            // Test SUBSCRIBER type
            const subscriberSubscription = createMockResourceSubscriptionEntity({
                id: 'new-subscription-id',
                subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(subscriberSubscription);

            const subscriberResult = await service.create({
                resourceId: 'resource-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });
            expect(subscriberResult.subscriptionType).toBe(ResourceSubscriptionType.SUBSCRIBER);

            // Test CREATOR type
            const creatorSubscription = createMockResourceSubscriptionEntity({
                id: 'new-subscription-id',
                subscriptionType: ResourceSubscriptionType.CREATOR,
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(creatorSubscription);

            const creatorResult = await service.create({
                resourceId: 'resource-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.CREATOR,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });
            expect(creatorResult.subscriptionType).toBe(ResourceSubscriptionType.CREATOR);

            // Test MENTIONED type
            const mentionedSubscription = createMockResourceSubscriptionEntity({
                id: 'new-subscription-id',
                subscriptionType: ResourceSubscriptionType.MENTIONED,
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(mentionedSubscription);

            const mentionedResult = await service.create({
                resourceId: 'resource-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.MENTIONED,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });
            expect(mentionedResult.subscriptionType).toBe(ResourceSubscriptionType.MENTIONED);
        });
    });

    describe('fetchAll', () => {
        it('should return paginated resource subscriptions', async () => {
            const subscriptions = [
                createMockResourceSubscriptionEntity({ id: 'sub-1' }),
                createMockResourceSubscriptionEntity({ id: 'sub-2' }),
            ];
            mockResourceSubscriptionRepository.findAll.mockResolvedValue(subscriptions);
            mockResourceSubscriptionRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['sub-1', 'sub-2'] },
                })
            );
        });

        it('should return empty result when no subscriptions found', async () => {
            mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
            mockResourceSubscriptionRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search parameter to repository', async () => {
            mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
            mockResourceSubscriptionRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

            expect(mockResourceSubscriptionRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: 'test-search' })
            );
        });
    });

    describe('fetchAllByResource', () => {
        it('should return subscriptions filtered by resource', async () => {
            const subscriptions = [
                createMockResourceSubscriptionEntity({
                    id: 'sub-1',
                    resourceId: 'resource-123',
                }),
            ];
            mockResourceSubscriptionRepository.findAll.mockResolvedValue(subscriptions);
            mockResourceSubscriptionRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByResource({
                limit: 10,
                page: 1,
                resourceTypeName: ResourceType.Consultation,
                resourceId: 'resource-123',
            });

            expect(result.data).toHaveLength(1);
            expect(mockResourceSubscriptionRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        // `fetchAllByResource` injects `tenantId` alongside the
                        // resource predicate when the caller is not GLOBAL_ADMIN.
                        // The CLS default for this suite is `tenant-1`.
                        tenantId: 'tenant-1',
                        resourceId: 'resource-123',
                        resourceTypeName: ResourceType.Consultation,
                    },
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: {
                        resourceId: 'resource-123',
                        resourceTypeName: ResourceType.Consultation,
                        items: ['sub-1'],
                    },
                })
            );
        });

        it('should throw ArgumentNotProvidedException when resourceId is missing', async () => {
            await expect(
                service.fetchAllByResource({
                    limit: 10,
                    page: 1,
                    resourceTypeName: ResourceType.Consultation,
                    resourceId: '',
                })
            ).rejects.toThrow('Invalid arguments');
        });

        it('should throw ArgumentNotProvidedException when resourceTypeName is missing', async () => {
            await expect(
                service.fetchAllByResource({
                    limit: 10,
                    page: 1,
                    resourceTypeName: '',
                    resourceId: 'resource-123',
                })
            ).rejects.toThrow('Invalid arguments');
        });
    });

    describe('fetchByResource', () => {
        it('should return subscription when found by resource', async () => {
            const subscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceId: 'resource-123',
            });
            mockResourceSubscriptionRepository.findByResource.mockResolvedValue(
                subscription
            );

            const result = await service.fetchByResource(
                ResourceType.Consultation,
                'resource-123'
            );

            expect(result).not.toBeNull();
            expect(result?.id).toBe('sub-123');
            expect(mockResourceSubscriptionRepository.findByResource).toHaveBeenCalledWith(
                ResourceType.Consultation,
                'resource-123'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    resourceId: 'sub-123',
                })
            );
        });

        it('should return null when subscription not found', async () => {
            mockResourceSubscriptionRepository.findByResource.mockRejectedValue(
                new Error('Not found')
            );

            const result = await service.fetchByResource(
                ResourceType.Consultation,
                'non-existent'
            );

            expect(result).toBeNull();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    resourceId: 'non-existent',
                    data: { message: 'Resource not found' },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return subscription by ID', async () => {
            const subscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(subscription);

            const result = await service.fetchById('sub-123');

            expect(result.id).toBe('sub-123');
            expect(mockResourceSubscriptionRepository.findById).toHaveBeenCalledWith(
                'sub-123'
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    resourceId: 'sub-123',
                })
            );
        });
    });

    describe('update', () => {
        it('should update subscription successfully', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue(
                existingSubscription
            );

            const result = await service.update('sub-123', {
                resourceStatus: ResourceStatusType.DISABLED,
            });

            expect(result.id).toBe('sub-123');
            expect(mockResourceSubscriptionRepository.update).toHaveBeenCalledWith(
                'sub-123',
                existingSubscription
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'sub-123',
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                hasChanges: false,
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );

            await expect(
                service.update('sub-123', { resourceStatus: ResourceStatusType.ENABLED })
            ).rejects.toThrow('No changes to write to');
        });
    });

    describe('toggleSubscriptionByResource', () => {
        it('should create new subscription when none exists', async () => {
            mockResourceSubscriptionRepository.findByResource.mockRejectedValue(
                new Error('Not found')
            );
            const newSubscription = createMockResourceSubscriptionEntity({
                id: 'new-sub-id',
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(newSubscription);

            const result = await service.toggleSubscriptionByResource(
                ResourceType.Consultation,
                'resource-123'
            );

            expect(result.id).toBe('new-sub-id');
            expect(mockResourceSubscriptionRepository.create).toHaveBeenCalled();
        });

        it('should throw UnauthorizedException when no user context and subscription not found', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });
            mockResourceSubscriptionRepository.findByResource.mockRejectedValue(
                new Error('Not found')
            );

            // Recreate service with updated mock
            service = new ResourceSubscriptionService(
                mockResourceSubscriptionRepository as any,
                mockEventEmitter as any,
                mockClsService as any
            );

            await expect(
                service.toggleSubscriptionByResource(
                    ResourceType.Consultation,
                    'resource-123'
                )
            ).rejects.toThrow('Unauthorized');
        });

        it('should toggle existing subscription from ENABLED to DISABLED', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            mockResourceSubscriptionRepository.findByResource.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue({
                ...existingSubscription,
                resourceStatus: ResourceStatusType.DISABLED,
            });

            const result = await service.toggleSubscriptionByResource(
                ResourceType.Consultation,
                'resource-123'
            );

            expect(mockResourceSubscriptionRepository.update).toHaveBeenCalledWith(
                'sub-123',
                expect.anything()
            );
        });

        it('should toggle existing subscription from DISABLED to ENABLED', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.DISABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.ENABLED },
            });
            mockResourceSubscriptionRepository.findByResource.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue({
                ...existingSubscription,
                resourceStatus: ResourceStatusType.ENABLED,
            });

            const result = await service.toggleSubscriptionByResource(
                ResourceType.Consultation,
                'resource-123'
            );

            expect(mockResourceSubscriptionRepository.update).toHaveBeenCalled();
        });
    });

    describe('toggleSubscriptionById', () => {
        it('should toggle subscription from ENABLED to DISABLED', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue({
                ...existingSubscription,
                resourceStatus: ResourceStatusType.DISABLED,
            });

            const result = await service.toggleSubscriptionById('sub-123');

            expect(mockResourceSubscriptionRepository.update).toHaveBeenCalledWith(
                'sub-123',
                expect.anything()
            );
        });

        it('should toggle subscription from DISABLED to ENABLED', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.DISABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.ENABLED },
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue({
                ...existingSubscription,
                resourceStatus: ResourceStatusType.ENABLED,
            });

            const result = await service.toggleSubscriptionById('sub-123');

            expect(mockResourceSubscriptionRepository.update).toHaveBeenCalled();
        });
    });

    describe('deleteById', () => {
        it('should soft delete subscription successfully', async () => {
            const deletedSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
            });
            mockResourceSubscriptionRepository.softDelete.mockResolvedValue(
                deletedSubscription
            );

            const result = await service.deleteById('sub-123');

            // Verify actual return value, not just mock call
            expect(result.id).toBe('sub-123');
            expect(result.resourceId).toBe('resource-123');
            expect(mockResourceSubscriptionRepository.softDelete).toHaveBeenCalledWith(
                'sub-123'
            );
            // Verify event emission with complete payload structure
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'sub-123',
                    data: expect.any(Object),
                })
            );
        });

        it('should throw when subscription not found', async () => {
            mockResourceSubscriptionRepository.softDelete.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(service.deleteById('non-existent-id')).rejects.toThrow(
                'Entity not found'
            );
        });

        it('should handle repository errors gracefully', async () => {
            mockResourceSubscriptionRepository.softDelete.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(service.deleteById('sub-123')).rejects.toThrow(
                'Database connection failed'
            );
        });
    });

    describe('fetchById - error handling', () => {
        it('should throw when subscription not found', async () => {
            mockResourceSubscriptionRepository.findById.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(service.fetchById('non-existent-id')).rejects.toThrow(
                'Entity not found'
            );
        });

        it('should return complete entity with all fields', async () => {
            const subscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceId: 'res-456',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.OWNER,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-789',
                subscriptionMetadata: { priority: 'high' },
                createdBy: 'creator-123',
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T11:00:00Z'),
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(subscription);

            const result = await service.fetchById('sub-123');

            // Verify key fields are returned correctly
            expect(result.id).toBe('sub-123');
            expect(result.resourceId).toBe('res-456');
            expect(result.resourceTypeName).toBe(ResourceType.Consultation);
            // Note: subscriptionType may be different based on entity implementation
            expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
            expect(result.targetUserId).toBe('user-789');
            expect(result.subscriptionMetadata).toEqual({ priority: 'high' });
            expect(result.createdBy).toBe('creator-123');
        });
    });

    describe('update - error handling', () => {
        it('should throw when subscription not found', async () => {
            mockResourceSubscriptionRepository.findById.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(
                service.update('non-existent-id', {
                    resourceStatus: ResourceStatusType.DISABLED,
                })
            ).rejects.toThrow('Entity not found');
        });

        it('should throw when repository update fails', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockRejectedValue(
                new Error('Update failed')
            );

            await expect(
                service.update('sub-123', {
                    resourceStatus: ResourceStatusType.DISABLED,
                })
            ).rejects.toThrow('Update failed');
        });
    });

    describe('toggleSubscriptionById - error handling', () => {
        it('should throw when subscription not found', async () => {
            mockResourceSubscriptionRepository.findById.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(
                service.toggleSubscriptionById('non-existent-id')
            ).rejects.toThrow('Entity not found');
        });

        it('should correctly toggle and return updated entity', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            const updatedSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.DISABLED,
            });

            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue(
                updatedSubscription
            );

            const result = await service.toggleSubscriptionById('sub-123');

            // Verify the returned entity has the toggled status
            expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
        });
    });

    describe('toggleSubscriptionByResource - error handling', () => {
        it('should throw when create fails after subscription not found', async () => {
            mockResourceSubscriptionRepository.findByResource.mockRejectedValue(
                new Error('Not found')
            );
            mockResourceSubscriptionRepository.create.mockRejectedValue(
                new Error('Create failed')
            );

            await expect(
                service.toggleSubscriptionByResource(
                    ResourceType.Consultation,
                    'resource-123'
                )
            ).rejects.toThrow('Create failed');
        });

        it('should throw when update fails for existing subscription', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
            });
            mockResourceSubscriptionRepository.findByResource.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockRejectedValue(
                new Error('Update failed')
            );

            await expect(
                service.toggleSubscriptionByResource(
                    ResourceType.Consultation,
                    'resource-123'
                )
            ).rejects.toThrow('Update failed');
        });
    });

    describe('fetchAll - edge cases', () => {
        it('should handle pagination edge case with page 0', async () => {
            mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
            mockResourceSubscriptionRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 0 });

            expect(result.page).toBe(0);
        });

        it('should handle large page numbers', async () => {
            mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
            mockResourceSubscriptionRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 10, page: 100 });

            expect(result.page).toBe(100);
            expect(result.count).toBe(1000);
        });

        it('should handle empty search string', async () => {
            mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
            mockResourceSubscriptionRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: '' });

            expect(mockResourceSubscriptionRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: '' })
            );
        });
    });

    describe('fetchAllByResource - edge cases', () => {
        it('should handle multiple subscriptions for same resource', async () => {
            const subscriptions = [
                createMockResourceSubscriptionEntity({
                    id: 'sub-1',
                    resourceId: 'resource-123',
                    targetUserId: 'user-1',
                }),
                createMockResourceSubscriptionEntity({
                    id: 'sub-2',
                    resourceId: 'resource-123',
                    targetUserId: 'user-2',
                }),
                createMockResourceSubscriptionEntity({
                    id: 'sub-3',
                    resourceId: 'resource-123',
                    targetUserId: 'user-3',
                }),
            ];
            mockResourceSubscriptionRepository.findAll.mockResolvedValue(subscriptions);
            mockResourceSubscriptionRepository.count.mockResolvedValue(3);

            const result = await service.fetchAllByResource({
                limit: 10,
                page: 1,
                resourceTypeName: ResourceType.Consultation,
                resourceId: 'resource-123',
            });

            expect(result.data).toHaveLength(3);
            expect(result.data[0].targetUserId).toBe('user-1');
            expect(result.data[1].targetUserId).toBe('user-2');
            expect(result.data[2].targetUserId).toBe('user-3');
        });
    });

    describe('event emission verification', () => {
        it('should emit ResourceCreated event with complete payload', async () => {
            const newSubscription = createMockResourceSubscriptionEntity({
                id: 'new-sub-id',
                resourceId: 'res-123',
                subscriptionType: ResourceSubscriptionType.OWNER,
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(newSubscription);

            await service.create({
                resourceId: 'res-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.OWNER,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });

            // Verify event was emitted with correct type and resource ID
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-sub-id',
                    createdAt: expect.any(Date),
                    data: expect.objectContaining({
                        id: 'new-sub-id',
                        resourceId: 'res-123',
                    }),
                })
            );
        });

        it('should emit ResourceUpdated event with changes and previous data', async () => {
            const existingSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            const updatedSubscription = createMockResourceSubscriptionEntity({
                id: 'sub-123',
                resourceStatus: ResourceStatusType.DISABLED,
            });

            mockResourceSubscriptionRepository.findById.mockResolvedValue(
                existingSubscription
            );
            mockResourceSubscriptionRepository.update.mockResolvedValue(
                updatedSubscription
            );

            await service.update('sub-123', {
                resourceStatus: ResourceStatusType.DISABLED,
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'sub-123',
                    data: expect.any(Object),
                    previousData: expect.any(Object),
                })
            );
        });
    });

    describe('context/CLS verification', () => {
        it('should use createdBy from user context when creating', async () => {
            const newSubscription = createMockResourceSubscriptionEntity({
                id: 'new-sub-id',
                createdBy: 'current-user-id',
            });
            mockResourceSubscriptionRepository.create.mockResolvedValue(newSubscription);

            const result = await service.create({
                resourceId: 'resource-123',
                resourceTypeName: ResourceType.Consultation,
                subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
                resourceStatus: ResourceStatusType.ENABLED,
                targetUserId: 'user-123',
            });

            // Verify the service used the user context
            expect(mockClsService.get).toHaveBeenCalledWith('user');
        });

        it('rejects reads when CLS has neither user nor tenant context (posture)', async () => {
            // Without this guard the read returned the row regardless of
            // caller context — a tenant-blind read that leaked subscriptions
            // across tenants. The `assertEqualTenants` guard now fails closed:
            // when there is no caller tenant in CLS and the caller is not
            // GLOBAL_ADMIN, the read is rejected (mirrors the
            // NotificationService policy for fail-closed CLS-less calls).
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const subscription = createMockResourceSubscriptionEntity({ id: 'sub-123' });
            mockResourceSubscriptionRepository.findById.mockResolvedValue(subscription);

            await expect(service.fetchById('sub-123')).rejects.toThrow();
        });
    });

    /**
     * `ResourceSubscriptionService` was previously tenant-blind on every
     * read/write surface (the existing `create` already required CLS context
     * but did not check anything else). This block exercises the full sweep
     * across 5 methods:
     *   - fetchAll: inject `{ tenantId: this.tenantId }` filter
     *     (GLOBAL_ADMIN bypass)
     *   - fetchAllByResource: same shape — inject tenantId
     *     alongside resourceId / resourceTypeName
     *   - fetchById: load-then-assert via assertEqualTenants
     *   - update: assert tenant after the pre-write findById
     *   - deleteById: load + assert + softDelete
     *
     * The service did NOT previously have an `isSuperAdmin()` helper — it now
     * mirrors the `NotificationService.isSuperAdmin` strict-default convention.
     *
     * CLS default in `beforeEach` is `tenant-1`. Tests use `tenant-2`
     * for cross-tenant probes. The local `setRequestUserRoles` helper
     * re-installs the CLS mock with the requested role list.
     */
    describe('ResourceSubscription tenant-guard sweep', () => {
        const setRequestUserRoles = (roles: string[] | undefined) => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user':
                        return {
                            id: 'current-user-id',
                            firstName: 'Test',
                            lastName: 'User',
                            email: 'test@example.com',
                            roles,
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
        };

        describe('fetchAll (5.3.7)', () => {
            it('injects the CLS tenantId into the findAll + count where clauses for non-GLOBAL_ADMIN callers', async () => {
                mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
                mockResourceSubscriptionRepository.count.mockResolvedValue(0);

                await service.fetchAll({ limit: 10, page: 1 });

                expect(mockResourceSubscriptionRepository.findAll).toHaveBeenCalledWith(
                    expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
                );
                expect(mockResourceSubscriptionRepository.count).toHaveBeenCalledWith(
                    expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
                );
            });

            it('omits the tenant filter when the caller is a GLOBAL_ADMIN (cross-tenant list)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
                mockResourceSubscriptionRepository.count.mockResolvedValue(0);

                await service.fetchAll({ limit: 10, page: 1 });

                const findAllArgs = mockResourceSubscriptionRepository.findAll.mock.calls[0][0];
                const countArgs = mockResourceSubscriptionRepository.count.mock.calls[0][0];
                expect(findAllArgs.where?.tenantId).toBeUndefined();
                expect(countArgs.where?.tenantId).toBeUndefined();
            });
        });

        describe('fetchAllByResource (5.3.8)', () => {
            it('injects the CLS tenantId alongside resourceId / resourceTypeName for non-GLOBAL_ADMIN callers', async () => {
                mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
                mockResourceSubscriptionRepository.count.mockResolvedValue(0);

                await service.fetchAllByResource({
                    limit: 10,
                    page: 1,
                    resourceTypeName: ResourceType.Consultation,
                    resourceId: 'resource-123',
                });

                expect(mockResourceSubscriptionRepository.findAll).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({
                            tenantId: 'tenant-1',
                            resourceId: 'resource-123',
                            resourceTypeName: ResourceType.Consultation,
                        }),
                    }),
                );
                expect(mockResourceSubscriptionRepository.count).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({
                            tenantId: 'tenant-1',
                            resourceId: 'resource-123',
                            resourceTypeName: ResourceType.Consultation,
                        }),
                    }),
                );
            });

            it('omits the tenant filter for GLOBAL_ADMIN callers (cross-tenant resource lookup)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                mockResourceSubscriptionRepository.findAll.mockResolvedValue([]);
                mockResourceSubscriptionRepository.count.mockResolvedValue(0);

                await service.fetchAllByResource({
                    limit: 10,
                    page: 1,
                    resourceTypeName: ResourceType.Consultation,
                    resourceId: 'resource-123',
                });

                const findAllArgs = mockResourceSubscriptionRepository.findAll.mock.calls[0][0];
                const countArgs = mockResourceSubscriptionRepository.count.mock.calls[0][0];
                expect(findAllArgs.where?.tenantId).toBeUndefined();
                expect(countArgs.where?.tenantId).toBeUndefined();
                // The resource scoping itself must still be enforced.
                expect(findAllArgs.where?.resourceId).toBe('resource-123');
                expect(findAllArgs.where?.resourceTypeName).toBe(ResourceType.Consultation);
            });
        });

        describe('fetchById (5.3.9)', () => {
            it('returns the subscription when it belongs to the caller tenant', async () => {
                const sameTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-same',
                    tenantId: 'tenant-1',
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(sameTenantSub);

                const result = await service.fetchById('sub-same');
                expect(result.id).toBe('sub-same');
            });

            it('throws NotFoundException when a non-GLOBAL_ADMIN caller requests a subscription owned by another tenant', async () => {
                const crossTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-foreign',
                    tenantId: 'tenant-2',
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(crossTenantSub);

                await expect(service.fetchById('sub-foreign')).rejects.toThrow(NotFoundException);
                await expect(service.fetchById('sub-foreign')).rejects.toThrow('Resource not found');

                // Pin "no audit-log leak on denied read":
                // the assertEqualTenants throw must short-circuit BEFORE the
                // ResourceViewed broadcast. Structurally guaranteed by the
                // guard's throw position, but the explicit negative-assertion
                // makes the contract self-evident at the test level (matches
                // the existing update/deleteById denial-test pattern).
                expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                    SysEventType.ResourceViewed,
                    expect.anything(),
                );
            });

            it('allows a GLOBAL_ADMIN to read a subscription owned by another tenant (admin bypass)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const crossTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-foreign',
                    tenantId: 'tenant-2',
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(crossTenantSub);

                const result = await service.fetchById('sub-foreign');
                expect(result.id).toBe('sub-foreign');
                expect(result.tenantId).toBe('tenant-2');
            });
        });

        describe('update (5.3.10)', () => {
            it('updates the subscription when it belongs to the caller tenant', async () => {
                const sameTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-same',
                    tenantId: 'tenant-1',
                    hasChanges: true,
                    changes: { resourceStatus: ResourceStatusType.DISABLED },
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(sameTenantSub);
                mockResourceSubscriptionRepository.update.mockResolvedValue(sameTenantSub);

                const result = await service.update('sub-same', {
                    resourceStatus: ResourceStatusType.DISABLED,
                });
                expect(result.id).toBe('sub-same');
                expect(mockResourceSubscriptionRepository.update).toHaveBeenCalled();
            });

            it('throws NotFoundException for a non-GLOBAL_ADMIN caller updating another tenant\'s subscription, with no mutation', async () => {
                const crossTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-foreign',
                    tenantId: 'tenant-2',
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(crossTenantSub);

                await expect(
                    service.update('sub-foreign', { resourceStatus: ResourceStatusType.DISABLED }),
                ).rejects.toThrow(NotFoundException);
                expect(mockResourceSubscriptionRepository.update).not.toHaveBeenCalled();
            });

            it('allows a GLOBAL_ADMIN to update a subscription owned by another tenant (admin bypass)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const crossTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-foreign',
                    tenantId: 'tenant-2',
                    hasChanges: true,
                    changes: { resourceStatus: ResourceStatusType.DISABLED },
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(crossTenantSub);
                mockResourceSubscriptionRepository.update.mockResolvedValue(crossTenantSub);

                const result = await service.update('sub-foreign', {
                    resourceStatus: ResourceStatusType.DISABLED,
                });
                expect(result.id).toBe('sub-foreign');
                expect(mockResourceSubscriptionRepository.update).toHaveBeenCalled();
            });
        });

        describe('deleteById (5.3.11)', () => {
            it('soft-deletes the subscription when it belongs to the caller tenant', async () => {
                const sameTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-same',
                    tenantId: 'tenant-1',
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(sameTenantSub);
                mockResourceSubscriptionRepository.softDelete.mockResolvedValue(sameTenantSub);

                const result = await service.deleteById('sub-same');
                expect(result.id).toBe('sub-same');
                expect(mockResourceSubscriptionRepository.softDelete).toHaveBeenCalledWith('sub-same');
            });

            it('throws NotFoundException for a non-GLOBAL_ADMIN caller deleting another tenant\'s subscription, with no softDelete', async () => {
                const crossTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-foreign',
                    tenantId: 'tenant-2',
                });
                mockResourceSubscriptionRepository.findById.mockResolvedValue(crossTenantSub);

                await expect(service.deleteById('sub-foreign')).rejects.toThrow(NotFoundException);
                expect(mockResourceSubscriptionRepository.softDelete).not.toHaveBeenCalled();
            });

            it('allows a GLOBAL_ADMIN to delete a subscription owned by another tenant (admin bypass)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const crossTenantSub = createMockResourceSubscriptionEntity({
                    id: 'sub-foreign',
                    tenantId: 'tenant-2',
                });
                mockResourceSubscriptionRepository.softDelete.mockResolvedValue(crossTenantSub);

                const result = await service.deleteById('sub-foreign');
                expect(result.id).toBe('sub-foreign');
                expect(mockResourceSubscriptionRepository.softDelete).toHaveBeenCalledWith('sub-foreign');
                // GLOBAL_ADMIN bypass skips the pre-load `findById`
                expect(mockResourceSubscriptionRepository.findById).not.toHaveBeenCalled();
            });
        });
    });
});
