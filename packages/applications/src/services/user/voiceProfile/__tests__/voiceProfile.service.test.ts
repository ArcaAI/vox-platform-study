import { ResourceStatusType, SysEventType } from '@arcaai/domains';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceProfileService } from '../voiceProfile.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockVoiceProfileRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  findAllByUserId: vi.fn(),
  findActiveByUserId: vi.fn(),
  createWithEmbedding: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  deactivateAllForUser: vi.fn(),
  activateById: vi.fn(),
};

const mockHttpService = {
  post: vi.fn(),
};

const mockConfigService = {
  config: {
    STT_V2_URL: 'http://localhost:8861',
  },
};

// Helper to create mock voice profile entity
const createMockVoiceProfileEntity = (overrides: Record<string, unknown> = {}) => {
  const entity = {
    id: overrides.id ?? 'vp-id-1',
    userId: overrides.userId ?? 'user-id-1',
    isActive: overrides.isActive ?? false,
    label: overrides.label ?? null,
    modelId: overrides.modelId ?? 'pyannote/wespeaker-voxceleb-resnet34-LM',
    resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
    createdBy: overrides.createdBy ?? null,
    updatedBy: overrides.updatedBy ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-04-13T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-04-13T10:00:00Z'),
    hasChanges: overrides.hasChanges ?? false,
    changes: overrides.changes ?? {},
    toObject: vi.fn(),
  };
  entity.toObject.mockReturnValue({ ...entity, toObject: undefined });
  return entity;
};

// ---------------------------------------------------------------------------
// Helper to build service
// ---------------------------------------------------------------------------

function buildService(): VoiceProfileService {
  return new VoiceProfileService(
    mockVoiceProfileRepository as any,
    mockHttpService as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockConfigService as any,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceProfileService', () => {
  let service: VoiceProfileService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'user-id-1', firstName: 'Test', lastName: 'User' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    service = buildService();
  });

  // =========================================================================
  // enroll
  // =========================================================================

  describe('enroll', () => {
    it('should call STT-v2 extraction endpoint and create a voice profile', async () => {
      const mockExtractionResponse = {
        data: {
          embedding: Array(256).fill(0.1),
          model_id: 'pyannote/wespeaker-voxceleb-resnet34-LM',
        },
      };

      const mockCreatedEntity = createMockVoiceProfileEntity();

      // firstValueFrom resolves with the observable's value
      mockHttpService.post.mockReturnValue({
        pipe: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
        toPromise: vi.fn().mockResolvedValue(mockExtractionResponse),
        // Make it work with firstValueFrom by being a proper observable-like
        [Symbol.observable]: undefined,
      });

      // Mock rxjs firstValueFrom behavior: the post returns an observable
      // We mock the post to return something firstValueFrom can resolve
      const { of } = await import('rxjs');
      mockHttpService.post.mockReturnValue(of(mockExtractionResponse));

      mockVoiceProfileRepository.createWithEmbedding.mockResolvedValue(mockCreatedEntity);

      const audioBuffer = Buffer.from('fake-audio-data');
      const result = await service.enroll({
        userId: 'user-id-1',
        audioBuffers: [audioBuffer],
        label: 'My Voice',
      });

      // Verify extraction call
      expect(mockHttpService.post).toHaveBeenCalledTimes(1);
      const [url] = mockHttpService.post.mock.calls[0];
      expect(url).toBe('http://localhost:8861/internal/voice-profile/extract');

      // Verify entity creation and embedding persistence
      expect(mockVoiceProfileRepository.createWithEmbedding).toHaveBeenCalledWith(
        expect.any(Object),
        mockExtractionResponse.data.embedding,
      );

      // Verify sys event emitted
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: mockCreatedEntity.id,
        }),
      );

      expect(result).toBe(mockCreatedEntity);
    });

    it('should throw when STT-v2 service is unreachable', async () => {
      const { throwError } = await import('rxjs');
      const error = new Error('Connection refused');
      (error as any).response = undefined;
      mockHttpService.post.mockReturnValue(throwError(() => error));

      const audioBuffer = Buffer.from('fake-audio-data');
      await expect(
        service.enroll({ userId: 'user-id-1', audioBuffers: [audioBuffer] }),
      ).rejects.toThrow();
    });

    // TASK-296 C-1: auto-activate the first enrolled profile.
    it('auto-activates the newly created profile when the user has no active profile yet', async () => {
      const { of } = await import('rxjs');
      mockHttpService.post.mockReturnValue(
        of({ data: { embedding: Array(256).fill(0.1), model_id: 'pyannote/wespeaker-voxceleb-resnet34-LM' } }),
      );

      const created = createMockVoiceProfileEntity({ id: 'vp-new', userId: 'user-id-1', isActive: false });
      mockVoiceProfileRepository.createWithEmbedding.mockResolvedValue(created);
      mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue(null);
      mockVoiceProfileRepository.activateById.mockResolvedValue(undefined);

      const result = await service.enroll({
        userId: 'user-id-1',
        audioBuffers: [Buffer.from('fake-audio-data')],
      });

      expect(mockVoiceProfileRepository.findActiveByUserId).toHaveBeenCalledWith('user-id-1');
      expect(mockVoiceProfileRepository.activateById).toHaveBeenCalledWith('vp-new');
      expect(result.isActive).toBe(true);
    });

    it('does NOT auto-activate when the user already has an active profile', async () => {
      const { of } = await import('rxjs');
      mockHttpService.post.mockReturnValue(
        of({ data: { embedding: Array(256).fill(0.1), model_id: 'pyannote/wespeaker-voxceleb-resnet34-LM' } }),
      );

      const created = createMockVoiceProfileEntity({ id: 'vp-new', userId: 'user-id-1', isActive: false });
      mockVoiceProfileRepository.createWithEmbedding.mockResolvedValue(created);
      mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue(
        createMockVoiceProfileEntity({ id: 'vp-existing', userId: 'user-id-1', isActive: true }),
      );

      const result = await service.enroll({
        userId: 'user-id-1',
        audioBuffers: [Buffer.from('fake-audio-data')],
      });

      expect(mockVoiceProfileRepository.findActiveByUserId).toHaveBeenCalledWith('user-id-1');
      expect(mockVoiceProfileRepository.activateById).not.toHaveBeenCalled();
      expect(result.isActive).toBe(false);
    });
  });

  // =========================================================================
  // listByUserId
  // =========================================================================

  describe('listByUserId', () => {
    it('should return all voice profiles for a user', async () => {
      const mockProfiles = [
        createMockVoiceProfileEntity({ id: 'vp-1', isActive: true }),
        createMockVoiceProfileEntity({ id: 'vp-2', isActive: false }),
      ];
      mockVoiceProfileRepository.findAllByUserId.mockResolvedValue(mockProfiles);

      const result = await service.listByUserId('user-id-1');

      expect(mockVoiceProfileRepository.findAllByUserId).toHaveBeenCalledWith('user-id-1');
      expect(result).toHaveLength(2);
    });

    it('should return empty array when user has no profiles', async () => {
      mockVoiceProfileRepository.findAllByUserId.mockResolvedValue([]);

      const result = await service.listByUserId('user-id-1');
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // activate
  // =========================================================================

  describe('activate', () => {
    it('should deactivate all profiles then activate the specified one', async () => {
      const mockProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'user-id-1' });
      mockVoiceProfileRepository.findById.mockResolvedValue(mockProfile);
      mockVoiceProfileRepository.deactivateAllForUser.mockResolvedValue(undefined);
      mockVoiceProfileRepository.activateById.mockResolvedValue(undefined);

      await service.activate('vp-1');

      expect(mockVoiceProfileRepository.findById).toHaveBeenCalledWith('vp-1');
      expect(mockVoiceProfileRepository.deactivateAllForUser).toHaveBeenCalledWith('user-id-1');
      expect(mockVoiceProfileRepository.activateById).toHaveBeenCalledWith('vp-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'vp-1',
        }),
      );
    });

    // TASK-296 C-3: IDOR.
    it('throws ForbiddenException when the profile belongs to another user', async () => {
      const mockProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'someone-else' });
      mockVoiceProfileRepository.findById.mockResolvedValue(mockProfile);

      await expect(service.activate('vp-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockVoiceProfileRepository.deactivateAllForUser).not.toHaveBeenCalled();
      expect(mockVoiceProfileRepository.activateById).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // deactivate
  // =========================================================================

  describe('deactivate', () => {
    it('should deactivate a voice profile', async () => {
      const mockProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'user-id-1', isActive: true });
      mockVoiceProfileRepository.findById.mockResolvedValue(mockProfile);
      mockVoiceProfileRepository.deactivateAllForUser.mockResolvedValue(undefined);

      await service.deactivate('vp-1');

      expect(mockVoiceProfileRepository.findById).toHaveBeenCalledWith('vp-1');
    });

    // TASK-296 C-3: IDOR.
    it('throws ForbiddenException when the profile belongs to another user', async () => {
      const mockProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'someone-else' });
      mockVoiceProfileRepository.findById.mockResolvedValue(mockProfile);

      await expect(service.deactivate('vp-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockVoiceProfileRepository.deactivateAllForUser).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // deleteById
  // =========================================================================

  describe('deleteById', () => {
    it('should soft-delete a voice profile when the caller owns it', async () => {
      const ownedProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'user-id-1' });
      mockVoiceProfileRepository.findById.mockResolvedValue(ownedProfile);
      const deleted = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'user-id-1' });
      mockVoiceProfileRepository.softDelete.mockResolvedValue(deleted);

      const result = await service.deleteById('vp-1');

      expect(mockVoiceProfileRepository.findById).toHaveBeenCalledWith('vp-1');
      expect(mockVoiceProfileRepository.softDelete).toHaveBeenCalledWith('vp-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'vp-1',
        }),
      );
      expect(result).toBe(deleted);
    });

    // TASK-296 C-3: IDOR.
    it('throws ForbiddenException when the profile belongs to another user', async () => {
      const mockProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'someone-else' });
      mockVoiceProfileRepository.findById.mockResolvedValue(mockProfile);

      await expect(service.deleteById('vp-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockVoiceProfileRepository.softDelete).not.toHaveBeenCalled();
    });
  });
});
