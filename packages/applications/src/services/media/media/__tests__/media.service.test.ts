/**
 * MediaService Unit Tests
 *
 * Tests for the MediaService that handles media file management operations.
 *
 * Testing Strategy:
 * - Focus on verifying actual behavior and return values, not just mock calls
 * - Complete mock entities that match real entity structure
 * - Test error handling and edge cases
 * - Verify event emission payloads
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MediaService } from '../media.service';
import { SysEventType } from '@arcaai/domains';

// Mock ClsService
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock MediaRepository
const mockMediaRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

/**
 * Helper to create mock media entity with complete structure.
 * Mocks should be indistinguishable from real entities to catch structural issues.
 * Note: Uses 'in' operator to properly handle null values as explicit overrides.
 */
const createMockMediaEntity = (
    overrides: Partial<{
        id: string;
        tenantId: string;
        name: string;
        uri: string;
        extension: string;
        mimeType: string;
        size: number;
        hash: string;
        createdBy: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        hasChanges: boolean;
        changes: Record<string, unknown>;
    }> = {}
) => {
    const entity = {
        id: 'id' in overrides ? overrides.id : 'media-id-1',
        tenantId: 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
        name: 'name' in overrides ? overrides.name : 'test-file.pdf',
        uri: 'uri' in overrides ? overrides.uri : '/uploads/test-file.pdf',
        extension: 'extension' in overrides ? overrides.extension : 'pdf',
        mimeType: 'mimeType' in overrides ? overrides.mimeType : 'application/pdf',
        size: 'size' in overrides ? overrides.size : 1024,
        hash: 'hash' in overrides ? overrides.hash : 'abc123hash',
        createdBy: 'createdBy' in overrides ? overrides.createdBy : null,
        createdAt: 'createdAt' in overrides ? overrides.createdAt : new Date('2026-01-29T10:00:00Z'),
        updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : new Date('2026-01-29T10:00:00Z'),
        deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : null,
        hasChanges: 'hasChanges' in overrides ? overrides.hasChanges : false,
        changes: 'changes' in overrides ? overrides.changes : {},
        // Complete entity methods
        toObject: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
    };

    // toObject returns complete entity structure (matching real entity behavior)
    entity.toObject.mockReturnValue({
        id: entity.id,
        tenantId: entity.tenantId,
        name: entity.name,
        uri: entity.uri,
        extension: entity.extension,
        mimeType: entity.mimeType,
        size: entity.size,
        hash: entity.hash,
        createdBy: entity.createdBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });

    return entity;
};

// Mock MediaFactory
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        MediaFactory: {
            CreateMedia: vi.fn((data) => ({
                ...data,
                id: 'new-media-id',
                createdAt: new Date(),
                updatedAt: new Date(),
                toObject: vi.fn().mockReturnValue({ id: 'new-media-id', ...data }),
            })),
        },
    };
});

describe('MediaService', () => {
    let service: MediaService;

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
        service = new MediaService(
            mockMediaRepository as any,
            mockEventEmitter as any,
            mockClsService as any
        );
    });

    describe('create', () => {
        it('should create a new media successfully', async () => {
            const newMedia = createMockMediaEntity({ id: 'new-media-id' });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'document.pdf',
                uri: '/uploads/document.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 2048,
                hash: 'xyz789hash',
            });

            expect(result.id).toBe('new-media-id');
            expect(mockMediaRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-media-id',
                })
            );
        });

        it('should throw InternalServerErrorException when creation fails', async () => {
            mockMediaRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    tenantId: 'tenant-1',
                    name: 'document.pdf',
                    uri: '/uploads/document.pdf',
                    extension: 'pdf',
                    mimeType: 'application/pdf',
                    size: 2048,
                    hash: 'xyz789hash',
                })
            ).rejects.toThrow('Failed to create MediaEntity');
        });

        it('should set createdBy from current user context', async () => {
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                createdBy: 'current-user-id',
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            await service.create({
                tenantId: 'tenant-1',
                name: 'document.pdf',
                uri: '/uploads/document.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 2048,
                hash: 'xyz789hash',
            });

            expect(mockMediaRepository.create).toHaveBeenCalled();
        });

        it('should create media with different file types', async () => {
            const fileTypes = [
                { extension: 'pdf', mimeType: 'application/pdf' },
                { extension: 'jpg', mimeType: 'image/jpeg' },
                { extension: 'png', mimeType: 'image/png' },
                { extension: 'mp4', mimeType: 'video/mp4' },
                { extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            ];

            for (const fileType of fileTypes) {
                const newMedia = createMockMediaEntity({
                    id: 'new-media-id',
                    extension: fileType.extension,
                    mimeType: fileType.mimeType,
                });
                mockMediaRepository.create.mockResolvedValue(newMedia);

                const result = await service.create({
                    tenantId: 'tenant-1',
                    name: `file.${fileType.extension}`,
                    uri: `/uploads/file.${fileType.extension}`,
                    extension: fileType.extension,
                    mimeType: fileType.mimeType,
                    size: 1024,
                    hash: 'hash123',
                });

                expect(result.extension).toBe(fileType.extension);
                expect(result.mimeType).toBe(fileType.mimeType);
            }
        });
    });

    describe('fetchAll', () => {
        it('should return paginated media files', async () => {
            const mediaFiles = [
                createMockMediaEntity({ id: 'media-1' }),
                createMockMediaEntity({ id: 'media-2' }),
            ];
            mockMediaRepository.findAll.mockResolvedValue(mediaFiles);
            mockMediaRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['media-1', 'media-2'] },
                })
            );
        });

        it('should return empty result when no media files found', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should pass search parameter to repository', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'document' });

            expect(mockMediaRepository.count).toHaveBeenCalledWith({
                search: 'document',
            });
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should return media files filtered by tenant ID', async () => {
            const mediaFiles = [
                createMockMediaEntity({ id: 'media-1', tenantId: 'tenant-1' }),
            ];
            mockMediaRepository.findAll.mockResolvedValue(mediaFiles);
            mockMediaRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(1);
            expect(mockMediaRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'tenant-1' },
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { tenantId: 'tenant-1', items: ['media-1'] },
                })
            );
        });

        it('should return empty result when no media for tenant', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(0);

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
        it('should return media files created by specific user', async () => {
            const mediaFiles = [
                createMockMediaEntity({ id: 'media-1', createdBy: 'creator-id' }),
            ];
            mockMediaRepository.findAll.mockResolvedValue(mediaFiles);
            mockMediaRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(mockMediaRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['media-1'] },
                })
            );
        });

        it('should return empty result when user has no media', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'user-with-no-media',
            });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchById', () => {
        it('should return media by ID', async () => {
            const media = createMockMediaEntity({ id: 'media-123' });
            mockMediaRepository.findById.mockResolvedValue(media);

            const result = await service.fetchById('media-123');

            expect(result.id).toBe('media-123');
            expect(mockMediaRepository.findById).toHaveBeenCalledWith('media-123');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });
    });

    describe('update', () => {
        it('should update media successfully', async () => {
            const existingMedia = createMockMediaEntity({
                id: 'media-123',
                hasChanges: true,
                changes: { name: 'updated-file.pdf' },
            });
            mockMediaRepository.findById.mockResolvedValue(existingMedia);
            mockMediaRepository.update.mockResolvedValue(existingMedia);

            const result = await service.update('media-123', {
                name: 'updated-file.pdf',
            });

            expect(result.id).toBe('media-123');
            expect(mockMediaRepository.update).toHaveBeenCalledWith(
                'media-123',
                existingMedia
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'media-123',
                })
            );
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingMedia = createMockMediaEntity({
                id: 'media-123',
                hasChanges: false,
            });
            mockMediaRepository.findById.mockResolvedValue(existingMedia);

            await expect(
                service.update('media-123', { name: 'same-name.pdf' })
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields', async () => {
            const existingMedia = createMockMediaEntity({
                id: 'media-123',
                hasChanges: true,
                changes: { name: 'new-name.pdf', uri: '/new/path.pdf' },
            });
            mockMediaRepository.findById.mockResolvedValue(existingMedia);
            mockMediaRepository.update.mockResolvedValue(existingMedia);

            const result = await service.update('media-123', {
                name: 'new-name.pdf',
                uri: '/new/path.pdf',
            });

            expect(result.id).toBe('media-123');
            expect(mockMediaRepository.update).toHaveBeenCalled();
        });
    });

    describe('deleteById', () => {
        it('should soft delete media successfully', async () => {
            const deletedMedia = createMockMediaEntity({ id: 'media-123' });
            mockMediaRepository.softDelete.mockResolvedValue(deletedMedia);

            const result = await service.deleteById('media-123');

            // Verify actual return value, not just mock call
            expect(result.id).toBe('media-123');
            expect(result.name).toBe('test-file.pdf');
            expect(mockMediaRepository.softDelete).toHaveBeenCalledWith('media-123');
            // Verify event emission with complete payload structure
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'media-123',
                    data: expect.any(Object),
                })
            );
        });

        it('should throw when media not found', async () => {
            mockMediaRepository.softDelete.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(service.deleteById('non-existent-id')).rejects.toThrow(
                'Entity not found'
            );
        });

        it('should handle repository errors gracefully', async () => {
            mockMediaRepository.softDelete.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(service.deleteById('media-123')).rejects.toThrow(
                'Database connection failed'
            );
        });
    });

    describe('fetchById - error handling', () => {
        it('should throw when media not found', async () => {
            mockMediaRepository.findById.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(service.fetchById('non-existent-id')).rejects.toThrow(
                'Entity not found'
            );
        });

        it('should return complete entity with all fields', async () => {
            const media = createMockMediaEntity({
                id: 'media-123',
                tenantId: 'tenant-456',
                name: 'document.pdf',
                uri: '/uploads/document.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 5242880,
                hash: 'sha256:abc123',
                createdBy: 'creator-123',
                createdAt: new Date('2026-01-29T10:00:00Z'),
                updatedAt: new Date('2026-01-29T11:00:00Z'),
            });
            mockMediaRepository.findById.mockResolvedValue(media);

            const result = await service.fetchById('media-123');

            // Verify all fields are returned correctly
            expect(result.id).toBe('media-123');
            expect(result.tenantId).toBe('tenant-456');
            expect(result.name).toBe('document.pdf');
            expect(result.uri).toBe('/uploads/document.pdf');
            expect(result.extension).toBe('pdf');
            expect(result.mimeType).toBe('application/pdf');
            expect(result.size).toBe(5242880);
            expect(result.hash).toBe('sha256:abc123');
            expect(result.createdBy).toBe('creator-123');
        });
    });

    describe('update - error handling', () => {
        it('should throw when media not found', async () => {
            mockMediaRepository.findById.mockRejectedValue(
                new Error('Entity not found')
            );

            await expect(
                service.update('non-existent-id', { name: 'new-name.pdf' })
            ).rejects.toThrow('Entity not found');
        });

        it('should throw when repository update fails', async () => {
            const existingMedia = createMockMediaEntity({
                id: 'media-123',
                hasChanges: true,
                changes: { name: 'new-name.pdf' },
            });
            mockMediaRepository.findById.mockResolvedValue(existingMedia);
            mockMediaRepository.update.mockRejectedValue(new Error('Update failed'));

            await expect(
                service.update('media-123', { name: 'new-name.pdf' })
            ).rejects.toThrow('Update failed');
        });
    });

    describe('fetchAll - edge cases', () => {
        it('should handle pagination edge case with page 0', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 0 });

            expect(result.page).toBe(0);
        });

        it('should handle large page numbers', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 10, page: 100 });

            expect(result.page).toBe(100);
            expect(result.count).toBe(1000);
        });

        it('should handle empty search string', async () => {
            mockMediaRepository.findAll.mockResolvedValue([]);
            mockMediaRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: '' });

            expect(mockMediaRepository.count).toHaveBeenCalledWith({
                search: '',
            });
        });
    });

    describe('fetchAllByTenantId - edge cases', () => {
        it('should handle multiple media files for same tenant', async () => {
            const mediaFiles = [
                createMockMediaEntity({
                    id: 'media-1',
                    tenantId: 'tenant-1',
                    name: 'file1.pdf',
                }),
                createMockMediaEntity({
                    id: 'media-2',
                    tenantId: 'tenant-1',
                    name: 'file2.jpg',
                }),
                createMockMediaEntity({
                    id: 'media-3',
                    tenantId: 'tenant-1',
                    name: 'file3.mp4',
                }),
            ];
            mockMediaRepository.findAll.mockResolvedValue(mediaFiles);
            mockMediaRepository.count.mockResolvedValue(3);

            const result = await service.fetchAllByTenantId({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(3);
            expect(result.data[0].name).toBe('file1.pdf');
            expect(result.data[1].name).toBe('file2.jpg');
            expect(result.data[2].name).toBe('file3.mp4');
        });
    });

    describe('event emission verification', () => {
        it('should emit ResourceCreated event with complete payload', async () => {
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                name: 'document.pdf',
                uri: '/uploads/document.pdf',
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            await service.create({
                tenantId: 'tenant-1',
                name: 'document.pdf',
                uri: '/uploads/document.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 2048,
                hash: 'xyz789hash',
            });

            // Verify complete event payload structure
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-media-id',
                    createdAt: expect.any(Date),
                    data: expect.objectContaining({
                        id: 'new-media-id',
                        name: 'document.pdf',
                    }),
                })
            );
        });

        it('should emit ResourceUpdated event with changes', async () => {
            const existingMedia = createMockMediaEntity({
                id: 'media-123',
                name: 'old-name.pdf',
                hasChanges: true,
                changes: { name: 'new-name.pdf' },
            });
            const updatedMedia = createMockMediaEntity({
                id: 'media-123',
                name: 'new-name.pdf',
            });

            mockMediaRepository.findById.mockResolvedValue(existingMedia);
            mockMediaRepository.update.mockResolvedValue(updatedMedia);

            await service.update('media-123', { name: 'new-name.pdf' });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'media-123',
                    data: expect.objectContaining({
                        name: 'new-name.pdf',
                    }),
                })
            );
        });
    });

    describe('file size handling', () => {
        it('should handle zero-byte files', async () => {
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                size: 0,
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'empty.txt',
                uri: '/uploads/empty.txt',
                extension: 'txt',
                mimeType: 'text/plain',
                size: 0,
                hash: 'empty-hash',
            });

            expect(result.size).toBe(0);
        });

        it('should handle very large files', async () => {
            const largeSize = 10 * 1024 * 1024 * 1024; // 10GB
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                size: largeSize,
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'large-video.mp4',
                uri: '/uploads/large-video.mp4',
                extension: 'mp4',
                mimeType: 'video/mp4',
                size: largeSize,
                hash: 'large-hash',
            });

            expect(result.size).toBe(largeSize);
        });
    });

    describe('special characters handling', () => {
        it('should handle file names with special characters', async () => {
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                name: 'file (1) [copy] - final.pdf',
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: 'file (1) [copy] - final.pdf',
                uri: '/uploads/file-1-copy-final.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 1024,
                hash: 'hash123',
            });

            expect(result.name).toBe('file (1) [copy] - final.pdf');
        });

        it('should handle unicode file names', async () => {
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                name: '文档_2026.pdf',
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            const result = await service.create({
                tenantId: 'tenant-1',
                name: '文档_2026.pdf',
                uri: '/uploads/document-2026.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 1024,
                hash: 'hash123',
            });

            expect(result.name).toBe('文档_2026.pdf');
        });
    });

    describe('context/CLS verification', () => {
        it('should use createdBy from user context when creating', async () => {
            const newMedia = createMockMediaEntity({
                id: 'new-media-id',
                createdBy: 'current-user-id',
            });
            mockMediaRepository.create.mockResolvedValue(newMedia);

            await service.create({
                tenantId: 'tenant-1',
                name: 'document.pdf',
                uri: '/uploads/document.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                size: 2048,
                hash: 'xyz789hash',
            });

            // Verify the service used the user context
            expect(mockClsService.get).toHaveBeenCalledWith('user');
        });

        it('should handle missing user context gracefully for read operations', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const media = createMockMediaEntity({ id: 'media-123' });
            mockMediaRepository.findById.mockResolvedValue(media);

            // Read operations should still work without user context
            const result = await service.fetchById('media-123');
            expect(result.id).toBe('media-123');
        });
    });
});
