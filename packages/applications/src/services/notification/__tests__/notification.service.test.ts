/**
 * NotificationService Unit Tests
 *
 * Tests for the NotificationService that handles notification management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationService } from '../notification.service';
import { SysEventType, ResourceStatusType, NotificationType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock NotificationRepository - simulates database operations
const mockNotificationRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Creates a complete mock notification entity matching the real NotificationEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockNotificationEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    targetUserId: string;
    title: string;
    message: string | null;
    data: Record<string, unknown> | null;
    type: NotificationType;
    read: boolean;
    resourceSubscriptionId: string | null;
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
        id: overrides.id ?? 'notification-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        targetUserId: overrides.targetUserId ?? 'user-1',
        title: overrides.title ?? 'Test Notification',
        message: overrides.message ?? 'Test message',
        data: overrides.data ?? null,
        type: overrides.type ?? NotificationType.INFO,
        read: overrides.read ?? false,
        resourceSubscriptionId: overrides.resourceSubscriptionId ?? null,
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
        targetUserId: entity.targetUserId,
        title: entity.title,
        message: entity.message,
        data: entity.data,
        type: entity.type,
        read: entity.read,
        resourceSubscriptionId: entity.resourceSubscriptionId,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

// Mock NotificationFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        NotificationFactory: {
            CreateNotification: vi.fn((data) => ({
                ...data,
                id: 'new-notification-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-notification-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
    };
});

describe('NotificationService', () => {
    let service: NotificationService;

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
        service = new NotificationService(
            mockNotificationRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new notification with all required fields', async () => {
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'New Notification',
                type: NotificationType.INFO,
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'New Notification',
                type: NotificationType.INFO,
            });

            // Verify the returned entity has correct data
            expect(result.id).toBe('new-notification-id');
            expect(result.tenantId).toBe('tenant-1');
            expect(result.targetUserId).toBe('user-1');
            expect(result.title).toBe('New Notification');
            expect(result.type).toBe(NotificationType.INFO);
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newNotification = createMockNotificationEntity({ id: 'new-notification-id' });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'New Notification',
                type: NotificationType.INFO,
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-notification-id',
                    createdAt: newNotification.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockNotificationRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    targetUserId: 'user-1',
                    title: 'New Notification',
                    type: NotificationType.INFO,
                })
            ).rejects.toThrow('Failed to create NotificationEntity');
        });

        it('should create notification with optional message', async () => {
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                message: 'This is a detailed message',
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'New Notification',
                message: 'This is a detailed message',
                type: NotificationType.INFO,
            });

            expect(result.message).toBe('This is a detailed message');
        });

        it('should create notification with custom data payload', async () => {
            const customData = { action: 'view', resourceId: 'res-123', metadata: { priority: 'high' } };
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                data: customData,
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'New Notification',
                data: customData,
                type: NotificationType.INFO,
            });

            expect(result.data).toEqual(customData);
        });

        it('should create notification linked to resource subscription', async () => {
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                resourceSubscriptionId: 'sub-123',
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'Subscription Notification',
                resourceSubscriptionId: 'sub-123',
                type: NotificationType.INFO,
            });

            expect(result.resourceSubscriptionId).toBe('sub-123');
        });

        it('should create notifications with different types', async () => {
            const notificationTypes = [
                NotificationType.INFO,
                NotificationType.WARNING,
                NotificationType.ERROR,
                NotificationType.SUCCESS,
            ];

            for (const type of notificationTypes) {
                const newNotification = createMockNotificationEntity({
                    id: 'new-notification-id',
                    type,
                });
                mockNotificationRepository.create.mockResolvedValue(newNotification);

                const result = await service.create({
                    tenantId: 'tenant-1',
                    targetUserId: 'user-1',
                    title: `${type} Notification`,
                    type,
                });

                expect(result.type).toBe(type);
            }
        });

        it('should handle repository errors gracefully', async () => {
            mockNotificationRepository.create.mockRejectedValue(new Error('Database connection failed'));

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    targetUserId: 'user-1',
                    title: 'New Notification',
                    type: NotificationType.INFO,
                })
            ).rejects.toThrow('Database connection failed');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated notifications with correct pagination metadata', async () => {
            const notifications = [
                createMockNotificationEntity({ id: 'notification-1', title: 'Notification 1' }),
                createMockNotificationEntity({ id: 'notification-2', title: 'Notification 2' }),
            ];
            mockNotificationRepository.findAll.mockResolvedValue(notifications);
            mockNotificationRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual notification data is returned
            expect(result.data[0].title).toBe('Notification 1');
            expect(result.data[1].title).toBe('Notification 2');
        });

        it('should return empty result when no notifications exist', async () => {
            mockNotificationRepository.findAll.mockResolvedValue([]);
            mockNotificationRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should emit ResourceViewed event with notification IDs', async () => {
            const notifications = [
                createMockNotificationEntity({ id: 'notification-1' }),
                createMockNotificationEntity({ id: 'notification-2' }),
            ];
            mockNotificationRepository.findAll.mockResolvedValue(notifications);
            mockNotificationRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['notification-1', 'notification-2'] },
                })
            );
        });

        it('should pass search parameter to repository', async () => {
            mockNotificationRepository.findAll.mockResolvedValue([]);
            mockNotificationRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'important' });

            expect(mockNotificationRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: 'important' })
            );
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return notifications filtered by tenant ID', async () => {
            const notifications = [createMockNotificationEntity({ id: 'notification-1', tenantId: 'tenant-1' })];
            mockNotificationRepository.findAll.mockResolvedValue(notifications);
            mockNotificationRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].tenantId).toBe('tenant-1');
            expect(mockNotificationRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'tenant-1' },
                })
            );
        });

        it('should emit event with tenantId in data', async () => {
            const notifications = [createMockNotificationEntity({ id: 'notification-1', tenantId: 'tenant-1' })];
            mockNotificationRepository.findAll.mockResolvedValue(notifications);
            mockNotificationRepository.count.mockResolvedValue(1);

            await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { tenantId: 'tenant-1', items: ['notification-1'] },
                })
            );
        });

        it('should return empty result when no notifications match tenant', async () => {
            mockNotificationRepository.findAll.mockResolvedValue([]);
            mockNotificationRepository.count.mockResolvedValue(0);

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
        it('should return notifications created by specific user', async () => {
            const notifications = [createMockNotificationEntity({ id: 'notification-1', createdBy: 'creator-id' })];
            mockNotificationRepository.findAll.mockResolvedValue(notifications);
            mockNotificationRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].createdBy).toBe('creator-id');
            expect(mockNotificationRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
        });

        it('should emit event with createdBy in data', async () => {
            const notifications = [createMockNotificationEntity({ id: 'notification-1', createdBy: 'creator-id' })];
            mockNotificationRepository.findAll.mockResolvedValue(notifications);
            mockNotificationRepository.count.mockResolvedValue(1);

            await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['notification-1'] },
                })
            );
        });
    });

    describe('fetchById', () => {
        it('should return notification by ID with complete data', async () => {
            const notification = createMockNotificationEntity({
                id: 'notification-123',
                title: 'Test Notification',
                message: 'Test message content',
                type: NotificationType.WARNING,
            });
            mockNotificationRepository.findById.mockResolvedValue(notification);

            const result = await service.fetchById('notification-123');

            expect(result.id).toBe('notification-123');
            expect(result.title).toBe('Test Notification');
            expect(result.message).toBe('Test message content');
            expect(result.type).toBe(NotificationType.WARNING);
        });

        it('should emit ResourceViewed event with notification data', async () => {
            const notification = createMockNotificationEntity({ id: 'notification-123' });
            mockNotificationRepository.findById.mockResolvedValue(notification);

            await service.fetchById('notification-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockNotificationRepository.findById.mockRejectedValue(new Error('Notification not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('Notification not found');
        });
    });

    describe('update', () => {
        it('should update notification successfully and return updated entity', async () => {
            const existingNotification = createMockNotificationEntity({
                id: 'notification-123',
                read: false,
                hasChanges: true,
                changes: { read: true },
            });
            mockNotificationRepository.findById.mockResolvedValue(existingNotification);
            mockNotificationRepository.update.mockResolvedValue(existingNotification);

            const result = await service.update('notification-123', { read: true });

            expect(result.id).toBe('notification-123');
            expect(mockNotificationRepository.update).toHaveBeenCalledWith('notification-123', existingNotification);
        });

        it('should emit ResourceUpdated event with changes and previous data', async () => {
            const existingNotification = createMockNotificationEntity({
                id: 'notification-123',
                hasChanges: true,
                changes: { read: true },
            });
            mockNotificationRepository.findById.mockResolvedValue(existingNotification);
            mockNotificationRepository.update.mockResolvedValue(existingNotification);

            await service.update('notification-123', { read: true });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'notification-123',
                    data: { read: true },
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingNotification = createMockNotificationEntity({
                id: 'notification-123',
                hasChanges: false,
            });
            mockNotificationRepository.findById.mockResolvedValue(existingNotification);

            await expect(
                service.update('notification-123', { read: false })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingNotification = createMockNotificationEntity({
                id: 'notification-123',
                hasChanges: true,
                changes: { read: true, title: 'Updated Title' },
            });
            mockNotificationRepository.findById.mockResolvedValue(existingNotification);
            mockNotificationRepository.update.mockResolvedValue(existingNotification);

            await service.update('notification-123', {
                read: true,
                title: 'Updated Title',
            });

            expect(mockNotificationRepository.update).toHaveBeenCalled();
        });
    });

    describe('deleteById', () => {
        it('should soft delete notification and return deleted entity', async () => {
            const deletedNotification = createMockNotificationEntity({
                id: 'notification-123',
                deletedAt: new Date(),
            });
            mockNotificationRepository.softDelete.mockResolvedValue(deletedNotification);

            const result = await service.deleteById('notification-123');

            expect(result.id).toBe('notification-123');
            expect(mockNotificationRepository.softDelete).toHaveBeenCalledWith('notification-123');
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedNotification = createMockNotificationEntity({ id: 'notification-123' });
            mockNotificationRepository.softDelete.mockResolvedValue(deletedNotification);

            await service.deleteById('notification-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'notification-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockNotificationRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('notification-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newNotification = createMockNotificationEntity({ id: 'new-notification-id' });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'New Notification',
                type: NotificationType.INFO,
            });

            expect(result.id).toBe('new-notification-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockNotificationRepository.findAll.mockResolvedValue([]);
            mockNotificationRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockNotificationRepository.findAll.mockResolvedValue([]);
            mockNotificationRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });

        it('should handle notifications with special characters in title', async () => {
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                title: 'Alert: "Important" & <urgent> notification!',
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'Alert: "Important" & <urgent> notification!',
                type: NotificationType.WARNING,
            });

            expect(result.title).toBe('Alert: "Important" & <urgent> notification!');
        });

        it('should handle notifications with complex data payload', async () => {
            const complexData = {
                action: 'navigate',
                route: '/consultations/123',
                params: {
                    highlight: true,
                    section: 'summary',
                },
                metadata: {
                    source: 'system',
                    priority: 1,
                    tags: ['urgent', 'medical'],
                },
            };
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                data: complexData,
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'Complex Notification',
                data: complexData,
                type: NotificationType.INFO,
            });

            expect(result.data).toEqual(complexData);
        });

        it('should handle notifications with very long message', async () => {
            const longMessage = 'A'.repeat(5000);
            const newNotification = createMockNotificationEntity({
                id: 'new-notification-id',
                message: longMessage,
            });
            mockNotificationRepository.create.mockResolvedValue(newNotification);

            const result = await service.create({
                tenantId: 'tenant-1',
                targetUserId: 'user-1',
                title: 'Long Message Notification',
                message: longMessage,
                type: NotificationType.INFO,
            });

            expect(result.message).toBe(longMessage);
        });
    });
});
