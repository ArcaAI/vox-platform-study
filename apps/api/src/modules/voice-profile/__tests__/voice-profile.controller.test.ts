import { ResourceStatusType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceProfileController } from '../voice-profile.controller';

const mockVoiceProfileService = {
  enroll: vi.fn(),
  listByUserId: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  deleteById: vi.fn(),
};

const mockClsService = {
  get: vi.fn(),
};

const createMockProfile = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'vp-1',
  userId: overrides.userId ?? 'user-1',
  isActive: overrides.isActive ?? false,
  label: overrides.label ?? null,
  modelId: overrides.modelId ?? 'pyannote/wespeaker-voxceleb-resnet34-LM',
  resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
  createdAt: overrides.createdAt ?? new Date('2026-04-13T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-04-13T10:00:00Z'),
  createdBy: overrides.createdBy ?? null,
  updatedBy: overrides.updatedBy ?? null,
  toObject: vi.fn().mockReturnValue(overrides),
});

describe('VoiceProfileController', () => {
  let controller: VoiceProfileController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'user-1', tenantId: 'tenant-1' };
      return null;
    });
    controller = new VoiceProfileController(
      mockVoiceProfileService as any,
      mockClsService as any,
    );
  });

  describe('enroll', () => {
    it('should call service.enroll with userId and audio buffers', async () => {
      const mockProfile = createMockProfile();
      mockVoiceProfileService.enroll.mockResolvedValue(mockProfile);

      const file = {
        buffer: Buffer.from('fake-audio'),
        originalname: 'test.wav',
        mimetype: 'audio/wav',
        size: 1024,
      } as Express.Multer.File;

      const result = await controller.enroll([file], { label: 'My Voice' });

      expect(mockVoiceProfileService.enroll).toHaveBeenCalledWith({
        userId: 'user-1',
        audioBuffers: [file.buffer],
        label: 'My Voice',
      });
      expect(result).toHaveProperty('id', 'vp-1');
    });

    it('should throw when no audio file provided', async () => {
      await expect(
        controller.enroll(undefined as any, {}),
      ).rejects.toThrow();
    });
  });

  describe('list', () => {
    it('should return profiles for current user', async () => {
      const profiles = [
        createMockProfile({ id: 'vp-1', isActive: true }),
        createMockProfile({ id: 'vp-2', isActive: false }),
      ];
      mockVoiceProfileService.listByUserId.mockResolvedValue(profiles);

      const result = await controller.list();

      expect(mockVoiceProfileService.listByUserId).toHaveBeenCalledWith('user-1');
      expect(result).toHaveLength(2);
    });
  });

  describe('activate', () => {
    it('should activate a voice profile', async () => {
      mockVoiceProfileService.activate.mockResolvedValue(undefined);

      await controller.activate('vp-1');

      expect(mockVoiceProfileService.activate).toHaveBeenCalledWith('vp-1');
    });
  });

  describe('deactivate', () => {
    it('should deactivate a voice profile', async () => {
      mockVoiceProfileService.deactivate.mockResolvedValue(undefined);

      await controller.deactivate('vp-1');

      expect(mockVoiceProfileService.deactivate).toHaveBeenCalledWith('vp-1');
    });
  });

  describe('deleteById', () => {
    it('should soft-delete a voice profile', async () => {
      const mockProfile = createMockProfile({ id: 'vp-1' });
      mockVoiceProfileService.deleteById.mockResolvedValue(mockProfile);

      const result = await controller.deleteById('vp-1');

      expect(mockVoiceProfileService.deleteById).toHaveBeenCalledWith('vp-1');
      expect(result).toHaveProperty('id', 'vp-1');
    });
  });

  // TASK-296 C-3: CASL permission tuples per method (no more empty @Authorize()).
  describe('CASL permission tuples', () => {
    const REQUIRED_PERMISSIONS_KEY = 'required_permissions';

    it('enroll requires ["create", "UserVoiceProfile"]', () => {
      const permissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VoiceProfileController.prototype.enroll,
      );
      expect(permissions).toEqual([{ action: 'create', subject: 'UserVoiceProfile' }]);
    });

    it('list requires ["read", "UserVoiceProfile"]', () => {
      const permissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VoiceProfileController.prototype.list,
      );
      expect(permissions).toEqual([{ action: 'read', subject: 'UserVoiceProfile' }]);
    });

    it('activate requires ["update", "UserVoiceProfile"]', () => {
      const permissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VoiceProfileController.prototype.activate,
      );
      expect(permissions).toEqual([{ action: 'update', subject: 'UserVoiceProfile' }]);
    });

    it('deactivate requires ["update", "UserVoiceProfile"]', () => {
      const permissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VoiceProfileController.prototype.deactivate,
      );
      expect(permissions).toEqual([{ action: 'update', subject: 'UserVoiceProfile' }]);
    });

    it('deleteById requires ["delete", "UserVoiceProfile"]', () => {
      const permissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VoiceProfileController.prototype.deleteById,
      );
      expect(permissions).toEqual([{ action: 'delete', subject: 'UserVoiceProfile' }]);
    });
  });
});
