/**
 * UserProfileService — TASK-328 A1–A3 coverage.
 *
 * Verifies `preferredPromptTemplateId` is threaded through the create + update
 * paths and that `getByUserId` / `upsertByUserId` behave by-user. Uses the REAL
 * UserProfileFactory / UserProfileEntity (only the repository is mocked) so the
 * test genuinely exercises the entity setter + change tracking for the new
 * field rather than a stand-in.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SysEventType, UserProfileFactory } from '@arcaai/domains';
import { UserProfileService } from '../userProfile.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepo = {
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  softDelete: vi.fn(),
};

describe('UserProfileService (TASK-328)', () => {
  let service: UserProfileService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'current-user-id' };
        case 'tenantId':
          return 'tenant-1';
        default:
          return null;
      }
    });
    service = new UserProfileService(mockRepo as never, mockEventEmitter as never, mockClsService as never);
  });

  describe('upsertByUserId', () => {
    it('creates a profile carrying preferredPromptTemplateId when none exists', async () => {
      mockRepo.findAll.mockResolvedValueOnce([]);
      mockRepo.create.mockImplementation(async (entity) => entity);

      const result = await service.upsertByUserId('user-1', { preferredPromptTemplateId: 'tpl-42' });

      expect(result.userId).toBe('user-1');
      expect(result.preferredPromptTemplateId).toBe('tpl-42');
      expect(mockRepo.create).toHaveBeenCalledTimes(1);
    });

    it('persists a changed preferredPromptTemplateId on an existing profile', async () => {
      const existing = UserProfileFactory.CreateUserProfile({ userId: 'user-1', preferredPromptTemplateId: 'old-tpl' });
      mockRepo.findAll.mockResolvedValueOnce([existing]);
      mockRepo.update.mockImplementation(async (_id, entity) => entity);

      const result = await service.upsertByUserId('user-1', { preferredPromptTemplateId: 'new-tpl' });

      expect(result.preferredPromptTemplateId).toBe('new-tpl');
      expect(mockRepo.update).toHaveBeenCalledWith(existing.id, existing);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ preferredPromptTemplateId: 'new-tpl' }) }),
      );
    });
  });

  describe('getByUserId', () => {
    it('returns null when the user has no profile', async () => {
      mockRepo.findAll.mockResolvedValueOnce([]);
      const result = await service.getByUserId('user-1');
      expect(result).toBeNull();
    });

    it('returns the profile (with preferredPromptTemplateId) when present', async () => {
      const existing = UserProfileFactory.CreateUserProfile({ userId: 'user-1', preferredPromptTemplateId: 'tpl-7' });
      mockRepo.findAll.mockResolvedValueOnce([existing]);

      const result = await service.getByUserId('user-1');

      expect(result?.preferredPromptTemplateId).toBe('tpl-7');
    });
  });
});
