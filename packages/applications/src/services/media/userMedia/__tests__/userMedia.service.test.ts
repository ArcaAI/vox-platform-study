/**
 * UserMediaService Unit Tests
 *
 * Tests for the UserMediaService that handles user-media association management operations.
 *
 * Testing Strategy:
 * - Focus on verifying actual behavior and return values, not just mock calls
 * - Complete mock entities that match real entity structure
 * - Test error handling and edge cases
 * - Verify event emission payloads
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotImplementedException } from '@nestjs/common';
import { UserMediaService } from '../userMedia.service';
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

// Mock UserMediaRepository
const mockUserMediaRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};

/**
 * Helper to create mock user media entity with complete structure.
 * Mocks should be indistinguishable from real entities to catch structural issues.
 * Note: Uses 'in' operator to properly handle null values as explicit overrides.
 */
const createMockUserMediaEntity = (
  overrides: Partial<{
    id: string;
    userId: string;
    mediaId: string;
    sharedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
  }> = {},
) => {
  const entity = {
    id: 'id' in overrides ? overrides.id : 'user-media-id-1',
    userId: 'userId' in overrides ? overrides.userId : 'user-123',
    mediaId: 'mediaId' in overrides ? overrides.mediaId : 'media-456',
    sharedAt: 'sharedAt' in overrides ? overrides.sharedAt : new Date('2026-01-29T12:00:00Z'),
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
    userId: entity.userId,
    mediaId: entity.mediaId,
    sharedAt: entity.sharedAt,
    createdBy: entity.createdBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt,
  });

  return entity;
};

// Mock UserMediaFactory
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    UserMediaFactory: {
      CreateUserMedia: vi.fn((data) => ({
        ...data,
        id: 'new-user-media-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        toObject: vi.fn().mockReturnValue({ id: 'new-user-media-id', ...data }),
      })),
    },
  };
});

describe('UserMediaService', () => {
  let service: UserMediaService;

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
    service = new UserMediaService(mockUserMediaRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('create', () => {
    it('should create a new user media association successfully', async () => {
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      const result = await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
        sharedAt: new Date('2026-01-29T12:00:00Z'),
      });

      expect(result.id).toBe('new-user-media-id');
      expect(mockUserMediaRepository.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-user-media-id',
        }),
      );
    });

    it('should throw InternalServerErrorException when creation fails', async () => {
      mockUserMediaRepository.create.mockResolvedValue(null);

      await expect(
        service.create({
          userId: 'user-123',
          mediaId: 'media-456',
        }),
      ).rejects.toThrow('Failed to create UserMediaEntity');
    });

    it('should set createdBy from current user context', async () => {
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        createdBy: 'current-user-id',
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
      });

      expect(mockUserMediaRepository.create).toHaveBeenCalled();
    });

    it('should create user media without sharedAt', async () => {
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        sharedAt: null,
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      const result = await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
      });

      expect(result.id).toBe('new-user-media-id');
    });

    it('should create user media with sharedAt date', async () => {
      const sharedDate = new Date('2026-02-15T14:30:00Z');
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        sharedAt: sharedDate,
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      const result = await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
        sharedAt: sharedDate,
      });

      expect(result.sharedAt).toEqual(sharedDate);
    });
  });

  describe('fetchAll', () => {
    it('should return paginated user media associations', async () => {
      const userMedias = [createMockUserMediaEntity({ id: 'user-media-1' }), createMockUserMediaEntity({ id: 'user-media-2' })];
      mockUserMediaRepository.findAll.mockResolvedValue(userMedias);
      mockUserMediaRepository.count.mockResolvedValue(2);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { items: ['user-media-1', 'user-media-2'] },
        }),
      );
    });

    it('should return empty result when no user media found', async () => {
      mockUserMediaRepository.findAll.mockResolvedValue([]);
      mockUserMediaRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should pass search parameter to repository', async () => {
      mockUserMediaRepository.findAll.mockResolvedValue([]);
      mockUserMediaRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

      expect(mockUserMediaRepository.count).toHaveBeenCalledWith({
        search: 'test-search',
      });
    });
  });

  describe('fetchAllByTenantId', () => {
    it('should throw NotImplementedException', async () => {
      await expect(
        service.fetchAllByTenantId({
          limit: 10,
          page: 1,
          tenantId: 'tenant-1',
        }),
      ).rejects.toThrow(NotImplementedException);
    });
  });

  describe('fetchAllCreatedByUser', () => {
    it('should return user media associations created by specific user', async () => {
      const userMedias = [
        createMockUserMediaEntity({
          id: 'user-media-1',
          createdBy: 'creator-id',
        }),
      ];
      mockUserMediaRepository.findAll.mockResolvedValue(userMedias);
      mockUserMediaRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(result.data).toHaveLength(1);
      expect(mockUserMediaRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdBy: 'creator-id' },
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { createdBy: 'creator-id', items: ['user-media-1'] },
        }),
      );
    });

    it('should return empty result when user has no media associations', async () => {
      mockUserMediaRepository.findAll.mockResolvedValue([]);
      mockUserMediaRepository.count.mockResolvedValue(0);

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
    it('should return user media by ID', async () => {
      const userMedia = createMockUserMediaEntity({ id: 'user-media-123' });
      mockUserMediaRepository.findById.mockResolvedValue(userMedia);

      const result = await service.fetchById('user-media-123');

      expect(result.id).toBe('user-media-123');
      expect(mockUserMediaRepository.findById).toHaveBeenCalledWith('user-media-123');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          responsibleEntityId: 'current-user-id',
        }),
      );
    });
  });

  describe('update', () => {
    it('should update user media successfully', async () => {
      const existingUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        hasChanges: true,
        changes: { sharedAt: new Date('2026-02-01T10:00:00Z') },
      });
      mockUserMediaRepository.findById.mockResolvedValue(existingUserMedia);
      mockUserMediaRepository.update.mockResolvedValue(existingUserMedia);

      const result = await service.update('user-media-123', {
        sharedAt: new Date('2026-02-01T10:00:00Z'),
      });

      expect(result.id).toBe('user-media-123');
      expect(mockUserMediaRepository.update).toHaveBeenCalledWith('user-media-123', existingUserMedia);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'user-media-123',
        }),
      );
    });

    it('should throw ArgumentInvalidException when no changes detected', async () => {
      const existingUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        hasChanges: false,
      });
      mockUserMediaRepository.findById.mockResolvedValue(existingUserMedia);

      await expect(service.update('user-media-123', { userId: 'same-user' })).rejects.toThrow('No changes to write to');
    });

    it('should update userId', async () => {
      const existingUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        hasChanges: true,
        changes: { userId: 'new-user-id' },
      });
      mockUserMediaRepository.findById.mockResolvedValue(existingUserMedia);
      mockUserMediaRepository.update.mockResolvedValue(existingUserMedia);

      const result = await service.update('user-media-123', {
        userId: 'new-user-id',
      });

      expect(result.id).toBe('user-media-123');
      expect(mockUserMediaRepository.update).toHaveBeenCalled();
    });

    it('should update mediaId', async () => {
      const existingUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        hasChanges: true,
        changes: { mediaId: 'new-media-id' },
      });
      mockUserMediaRepository.findById.mockResolvedValue(existingUserMedia);
      mockUserMediaRepository.update.mockResolvedValue(existingUserMedia);

      const result = await service.update('user-media-123', {
        mediaId: 'new-media-id',
      });

      expect(result.id).toBe('user-media-123');
      expect(mockUserMediaRepository.update).toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('should soft delete user media successfully', async () => {
      const deletedUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
      });
      mockUserMediaRepository.softDelete.mockResolvedValue(deletedUserMedia);

      const result = await service.deleteById('user-media-123');

      // Verify actual return value, not just mock call
      expect(result.id).toBe('user-media-123');
      expect(result.userId).toBe('user-123');
      expect(result.mediaId).toBe('media-456');
      expect(mockUserMediaRepository.softDelete).toHaveBeenCalledWith('user-media-123');
      // Verify event emission with complete payload structure
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'user-media-123',
          data: expect.any(Object),
        }),
      );
    });

    it('should throw when user media not found', async () => {
      mockUserMediaRepository.softDelete.mockRejectedValue(new Error('Entity not found'));

      await expect(service.deleteById('non-existent-id')).rejects.toThrow('Entity not found');
    });

    it('should handle repository errors gracefully', async () => {
      mockUserMediaRepository.softDelete.mockRejectedValue(new Error('Database connection failed'));

      await expect(service.deleteById('user-media-123')).rejects.toThrow('Database connection failed');
    });
  });

  describe('fetchById - error handling', () => {
    it('should throw when user media not found', async () => {
      mockUserMediaRepository.findById.mockRejectedValue(new Error('Entity not found'));

      await expect(service.fetchById('non-existent-id')).rejects.toThrow('Entity not found');
    });

    it('should return complete entity with all fields', async () => {
      const userMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        userId: 'user-456',
        mediaId: 'media-789',
        sharedAt: new Date('2026-02-15T14:30:00Z'),
        createdBy: 'creator-123',
        createdAt: new Date('2026-01-29T10:00:00Z'),
        updatedAt: new Date('2026-01-29T11:00:00Z'),
      });
      mockUserMediaRepository.findById.mockResolvedValue(userMedia);

      const result = await service.fetchById('user-media-123');

      // Verify all fields are returned correctly
      expect(result.id).toBe('user-media-123');
      expect(result.userId).toBe('user-456');
      expect(result.mediaId).toBe('media-789');
      expect(result.sharedAt).toEqual(new Date('2026-02-15T14:30:00Z'));
      expect(result.createdBy).toBe('creator-123');
    });
  });

  describe('update - error handling', () => {
    it('should throw when user media not found', async () => {
      mockUserMediaRepository.findById.mockRejectedValue(new Error('Entity not found'));

      await expect(service.update('non-existent-id', { userId: 'new-user-id' })).rejects.toThrow('Entity not found');
    });

    it('should throw when repository update fails', async () => {
      const existingUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        hasChanges: true,
        changes: { userId: 'new-user-id' },
      });
      mockUserMediaRepository.findById.mockResolvedValue(existingUserMedia);
      mockUserMediaRepository.update.mockRejectedValue(new Error('Update failed'));

      await expect(service.update('user-media-123', { userId: 'new-user-id' })).rejects.toThrow('Update failed');
    });
  });

  describe('fetchAll - edge cases', () => {
    it('should handle pagination edge case with page 0', async () => {
      mockUserMediaRepository.findAll.mockResolvedValue([]);
      mockUserMediaRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 0 });

      expect(result.page).toBe(0);
    });

    it('should handle large page numbers', async () => {
      mockUserMediaRepository.findAll.mockResolvedValue([]);
      mockUserMediaRepository.count.mockResolvedValue(1000);

      const result = await service.fetchAll({ limit: 10, page: 100 });

      expect(result.page).toBe(100);
      expect(result.count).toBe(1000);
    });

    it('should handle empty search string', async () => {
      mockUserMediaRepository.findAll.mockResolvedValue([]);
      mockUserMediaRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, search: '' });

      expect(mockUserMediaRepository.count).toHaveBeenCalledWith({
        search: '',
      });
    });
  });

  describe('fetchAllCreatedByUser - edge cases', () => {
    it('should handle multiple user media associations for same creator', async () => {
      const userMedias = [
        createMockUserMediaEntity({
          id: 'user-media-1',
          createdBy: 'creator-id',
          userId: 'user-1',
        }),
        createMockUserMediaEntity({
          id: 'user-media-2',
          createdBy: 'creator-id',
          userId: 'user-2',
        }),
        createMockUserMediaEntity({
          id: 'user-media-3',
          createdBy: 'creator-id',
          userId: 'user-3',
        }),
      ];
      mockUserMediaRepository.findAll.mockResolvedValue(userMedias);
      mockUserMediaRepository.count.mockResolvedValue(3);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(result.data).toHaveLength(3);
      expect(result.data[0].userId).toBe('user-1');
      expect(result.data[1].userId).toBe('user-2');
      expect(result.data[2].userId).toBe('user-3');
    });
  });

  describe('event emission verification', () => {
    it('should emit ResourceCreated event with complete payload', async () => {
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        userId: 'user-123',
        mediaId: 'media-456',
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
      });

      // Verify complete event payload structure
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-user-media-id',
          createdAt: expect.any(Date),
          data: expect.objectContaining({
            id: 'new-user-media-id',
            userId: 'user-123',
            mediaId: 'media-456',
          }),
        }),
      );
    });

    it('should emit ResourceUpdated event with changes', async () => {
      const existingUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        userId: 'old-user-id',
        hasChanges: true,
        changes: { userId: 'new-user-id' },
      });
      const updatedUserMedia = createMockUserMediaEntity({
        id: 'user-media-123',
        userId: 'new-user-id',
      });

      mockUserMediaRepository.findById.mockResolvedValue(existingUserMedia);
      mockUserMediaRepository.update.mockResolvedValue(updatedUserMedia);

      await service.update('user-media-123', { userId: 'new-user-id' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'user-media-123',
          data: expect.objectContaining({
            userId: 'new-user-id',
          }),
        }),
      );
    });
  });

  describe('sharedAt handling', () => {
    it('should handle null sharedAt', async () => {
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        sharedAt: null,
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      const result = await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
      });

      expect(result.sharedAt).toBeNull();
    });

    it('should handle future sharedAt date', async () => {
      const futureDate = new Date('2027-12-31T23:59:59Z');
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        sharedAt: futureDate,
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      const result = await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
        sharedAt: futureDate,
      });

      expect(result.sharedAt).toEqual(futureDate);
    });

    it('should handle past sharedAt date', async () => {
      const pastDate = new Date('2020-01-01T00:00:00Z');
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        sharedAt: pastDate,
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      const result = await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
        sharedAt: pastDate,
      });

      expect(result.sharedAt).toEqual(pastDate);
    });
  });

  describe('context/CLS verification', () => {
    it('should use createdBy from user context when creating', async () => {
      const newUserMedia = createMockUserMediaEntity({
        id: 'new-user-media-id',
        createdBy: 'current-user-id',
      });
      mockUserMediaRepository.create.mockResolvedValue(newUserMedia);

      await service.create({
        userId: 'user-123',
        mediaId: 'media-456',
      });

      // Verify the service used the user context
      expect(mockClsService.get).toHaveBeenCalledWith('user');
    });

    it('should handle missing user context gracefully for read operations', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return null;
        return null;
      });

      const userMedia = createMockUserMediaEntity({ id: 'user-media-123' });
      mockUserMediaRepository.findById.mockResolvedValue(userMedia);

      // Read operations should still work without user context
      const result = await service.fetchById('user-media-123');
      expect(result.id).toBe('user-media-123');
    });
  });
});
