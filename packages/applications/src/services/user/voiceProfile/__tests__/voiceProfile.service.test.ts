import { InternalServerErrorException } from '@arcaai/exceptions';
import { ResourceStatusType, SysEventType } from '@arcaai/domains';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceProfileService } from '../voiceProfile.service';

function makeAxiosError(status: number | undefined, body: unknown, code?: string): AxiosError {
  const headers = new AxiosHeaders();
  const err = new AxiosError(
    status ? `Request failed with status code ${status}` : 'Network Error',
    code,
    { headers } as never,
    {},
    status
      ? {
          status,
          statusText: '',
          headers,
          config: { headers } as never,
          data: body,
        }
      : undefined,
  );
  return err;
}

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
  findActiveEmbeddingsForUser: vi.fn(),
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
    STT_URL: 'http://localhost:8861',
  },
};

/**
 * TASK-887 — enrollment resolves the SAME agent a session would, and the agent names the
 * speaker-embedding model the profile is stored in. This mock stands in for
 * `AsrAgentResolverService`; the default answer is the SYSTEM ASR agent bound to the 256-d
 * wespeaker row with diarization on.
 */
const AGENT_SLUG = 'platform-transcription';
const EMBEDDING_SLUG = 'wespeaker-voxceleb-resnet34';
const EMBEDDING_SOURCE_URI = 'pyannote/wespeaker-voxceleb-resnet34-LM';

const mockAsrResolver = {
  resolve: vi.fn(),
};

function asrSpec(
  overrides: { embedding?: unknown; enabled?: boolean; backend?: 'embedding' | 'sortformer'; matchThreshold?: number | null } = {},
) {
  const embedding = 'embedding' in overrides ? overrides.embedding : { slug: EMBEDDING_SLUG, sourceUri: EMBEDDING_SOURCE_URI };
  return {
    spec: {
      agent: { slug: AGENT_SLUG },
      models: { embedding },
      audioFrontEnd: {
        diarization: {
          enabled: overrides.enabled ?? true,
          backend: overrides.backend ?? 'embedding',
          ...(overrides.matchThreshold === undefined ? {} : { matchThreshold: overrides.matchThreshold }),
        },
      },
    },
  };
}

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
    undefined,
    mockAsrResolver as any,
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
    mockAsrResolver.resolve.mockResolvedValue(asrSpec());
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
          model_id: EMBEDDING_SOURCE_URI,
          model_slug: EMBEDDING_SLUG,
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
      expect(mockVoiceProfileRepository.createWithEmbedding).toHaveBeenCalledWith(expect.any(Object), mockExtractionResponse.data.embedding);

      // Verify sys event emitted
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: mockCreatedEntity.id,
        }),
      );

      expect(result).toBe(mockCreatedEntity);
    });

    // A voice profile is biometric PHI stamped with its enrollment
    // tenant; reads (incl. the STT-v2 diarization preseed) filter on it.
    it('should stamp the enrolled profile with the CLS tenant', async () => {
      const { of } = await import('rxjs');
      mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(256).fill(0.1), model_id: EMBEDDING_SOURCE_URI, model_slug: EMBEDDING_SLUG } }));
      mockVoiceProfileRepository.createWithEmbedding.mockImplementation(async (entity: any) => entity);

      await service.enroll({
        userId: 'user-id-1',
        audioBuffers: [Buffer.from('fake-audio-data')],
        label: 'My Voice',
      });

      const [entityArg] = mockVoiceProfileRepository.createWithEmbedding.mock.calls[0];
      expect(entityArg.tenantId).toBe('tenant-1');
    });

    it('should reject enrollment without a tenant context', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'user-id-1' };
        return null; // no tenantId in CLS
      });
      const { of } = await import('rxjs');
      mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(256).fill(0.1), model_id: EMBEDDING_SOURCE_URI, model_slug: EMBEDDING_SLUG } }));

      await expect(
        service.enroll({
          userId: 'user-id-1',
          audioBuffers: [Buffer.from('fake-audio-data')],
          label: 'My Voice',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockVoiceProfileRepository.createWithEmbedding).not.toHaveBeenCalled();
    });

    it('should throw when STT-v2 service is unreachable', async () => {
      const { throwError } = await import('rxjs');
      const error = new Error('Connection refused');
      (error as any).response = undefined;
      mockHttpService.post.mockReturnValue(throwError(() => error));

      const audioBuffer = Buffer.from('fake-audio-data');
      await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [audioBuffer] })).rejects.toThrow();
    });

    // Translate STT-v2 errors into friendly HTTP exceptions
    // so the UI surfaces the real cause instead of an opaque 500/AxiosError dump.
    describe('extractEmbeddings error translation', () => {
      it('maps STT-v2 400 with {detail} to BadRequestException carrying the detail', async () => {
        const { throwError } = await import('rxjs');
        const axiosErr = makeAxiosError(400, { detail: 'Sample 1 exceeds 15.0s (got 33.6s)' }, 'ERR_BAD_REQUEST');
        mockHttpService.post.mockReturnValue(throwError(() => axiosErr));

        await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] })).rejects.toMatchObject({
          constructor: BadRequestException,
          message: 'Sample 1 exceeds 15.0s (got 33.6s)',
        });
        expect(mockVoiceProfileRepository.createWithEmbedding).not.toHaveBeenCalled();
      });

      it('maps STT-v2 503 to ServiceUnavailableException carrying the detail', async () => {
        const { throwError } = await import('rxjs');
        const axiosErr = makeAxiosError(503, { detail: 'Embedding service not available' });
        mockHttpService.post.mockReturnValue(throwError(() => axiosErr));

        await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] })).rejects.toMatchObject({
          constructor: ServiceUnavailableException,
          message: 'Embedding service not available',
        });
      });

      it('maps ECONNREFUSED (no response) to ServiceUnavailableException with a friendly message', async () => {
        const { throwError } = await import('rxjs');
        const axiosErr = makeAxiosError(undefined, undefined, 'ECONNREFUSED');
        mockHttpService.post.mockReturnValue(throwError(() => axiosErr));

        await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] })).rejects.toMatchObject({
          constructor: ServiceUnavailableException,
          message: expect.stringMatching(/voice profile extraction service is unavailable/i),
        });
      });

      it('maps unknown non-axios errors to InternalServerErrorException', async () => {
        const { throwError } = await import('rxjs');
        mockHttpService.post.mockReturnValue(throwError(() => new Error('boom')));

        await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] })).rejects.toBeInstanceOf(
          InternalServerErrorException,
        );
      });
    });

    /**
     * TASK-887 — the AGENT names the embedding space, and the profile records it.
     *
     * These replace the old "embedding dimension guard" block, which rejected anything that
     * was not 256-d because the platform declared ONE embedding space
     * (`stt.diarization.hfModelId` + a `vector(256)` column). Both are gone: the column is a
     * dimension-agnostic `vector` and a profile is only ever matched by an agent bound to the
     * model that embedded it, so the width is the model's business.
     */
    describe('the agent declares the embedding space', () => {
      it('pushes the agent’s model + threshold to apps/stt and stamps the profile with the SLUG', async () => {
        const { of } = await import('rxjs');
        mockAsrResolver.resolve.mockResolvedValue(asrSpec({ matchThreshold: 0.72 }));
        mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(192).fill(0.1), model_id: EMBEDDING_SOURCE_URI, model_slug: EMBEDDING_SLUG } }));
        mockVoiceProfileRepository.createWithEmbedding.mockImplementation(async (entity: any) => entity);

        await service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')], agentSlug: AGENT_SLUG });

        expect(mockAsrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: AGENT_SLUG, departmentId: null });
        const form = mockHttpService.post.mock.calls[0][1] as FormData;
        expect(form.get('model_slug')).toBe(EMBEDDING_SLUG);
        expect(form.get('model_source_uri')).toBe(EMBEDDING_SOURCE_URI);
        expect(form.get('min_similarity')).toBe('0.72');

        // The SLUG, not the HuggingFace repo id the response also carries: the slug is what an
        // agent binds and what a session compares a profile against.
        const [entityArg] = mockVoiceProfileRepository.createWithEmbedding.mock.calls[0];
        expect(entityArg.modelId).toBe(EMBEDDING_SLUG);
      });

      it('accepts a 192-d vector — width is the model’s property, not the platform’s', async () => {
        const { of } = await import('rxjs');
        mockAsrResolver.resolve.mockResolvedValue(asrSpec({ embedding: { slug: 'ecapa-tdnn-voxceleb', sourceUri: 'speechbrain/spkrec-ecapa-voxceleb' } }));
        mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(192).fill(0.1), model_id: 'speechbrain/spkrec-ecapa-voxceleb', model_slug: 'ecapa-tdnn-voxceleb' } }));
        mockVoiceProfileRepository.createWithEmbedding.mockImplementation(async (entity: any) => entity);

        const created: any = await service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] });
        expect(created.modelId).toBe('ecapa-tdnn-voxceleb');
      });

      it('omits min_similarity entirely when the agent declared no threshold', async () => {
        const { of } = await import('rxjs');
        mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(256).fill(0.1), model_id: EMBEDDING_SOURCE_URI, model_slug: EMBEDDING_SLUG } }));
        mockVoiceProfileRepository.createWithEmbedding.mockImplementation(async (entity: any) => entity);

        await service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] });
        expect((mockHttpService.post.mock.calls[0][1] as FormData).get('min_similarity')).toBeNull();
      });

      /**
       * TASK-977 follow-up (owner decision 2026-09-16) — enrollment COMPUTES a voice embedding,
       * and voice embedding is off unless the admin enabled diarization on the agent. So a
       * disabled stage refuses enrollment outright, even when the agent already names an
       * embedding model (the seeded `realtime-transcription` agent does), and it refuses before
       * a single sample reaches apps/stt: nothing is embedded or stored for a stage nothing uses.
       * This reverses TASK-887's "enrol ahead of enabling".
       */
      it('refuses with 409 ASR_AGENT_DIARIZATION_DISABLED BEFORE any audio leaves the gateway when diarization is off', async () => {
        mockAsrResolver.resolve.mockResolvedValue(asrSpec({ embedding: undefined, enabled: false }));

        const thrown = await service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] }).catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(ConflictException);
        expect((thrown as ConflictException).getResponse()).toEqual({
          code: 'ASR_AGENT_DIARIZATION_DISABLED',
          message: expect.stringContaining(`'${AGENT_SLUG}'`),
        });
        expect(((thrown as ConflictException).getResponse() as { message: string }).message).toContain('audioFrontEnd.diarization.enabled');
        // The stale advice must be gone: the model slug was never the problem.
        expect(((thrown as ConflictException).getResponse() as { message: string }).message).not.toContain('embeddingModelSlug');
        expect(mockHttpService.post).not.toHaveBeenCalled();
        expect(mockVoiceProfileRepository.createWithEmbedding).not.toHaveBeenCalled();
      });

      it('refuses with 409 even when the disabled agent already names an embedding model (the seeded agent’s shape)', async () => {
        // Before D-4 the model still shipped with the stage off; refusing on the switch, not on
        // model presence, keeps the answer the same whichever way the resolver ships it.
        mockAsrResolver.resolve.mockResolvedValue(asrSpec({ enabled: false }));

        await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] })).rejects.toMatchObject({
          constructor: ConflictException,
          response: { code: 'ASR_AGENT_DIARIZATION_DISABLED' },
        });
        expect(mockHttpService.post).not.toHaveBeenCalled();
        expect(mockVoiceProfileRepository.createWithEmbedding).not.toHaveBeenCalled();
      });

      it('refuses with a TRUE 400 when diarization is on but the sortformer backend needs no enrolled profiles', async () => {
        mockAsrResolver.resolve.mockResolvedValue(asrSpec({ embedding: undefined, enabled: true, backend: 'sortformer' }));

        const thrown = await service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')] }).catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        const message = (thrown as BadRequestException).message;
        expect(message).toContain(`'${AGENT_SLUG}'`);
        expect(message).toContain('sortformer');
        expect(message).not.toContain('embeddingModelSlug');
        expect(mockHttpService.post).not.toHaveBeenCalled();
        expect(mockVoiceProfileRepository.createWithEmbedding).not.toHaveBeenCalled();
      });

      it('lets the resolver’s own 404 through — a foreign agent is not this user’s to enrol for', async () => {
        const notFound = new Error('Agent not found');
        mockAsrResolver.resolve.mockRejectedValue(notFound);

        await expect(service.enroll({ userId: 'user-id-1', audioBuffers: [Buffer.from('audio')], agentSlug: 'someone-elses' })).rejects.toBe(notFound);
        expect(mockHttpService.post).not.toHaveBeenCalled();
      });
    });

    // Auto-activate the first enrolled profile.
    it('auto-activates the newly created profile when the user has no active profile yet', async () => {
      const { of } = await import('rxjs');
      mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(256).fill(0.1), model_id: EMBEDDING_SOURCE_URI, model_slug: EMBEDDING_SLUG } }));

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
      mockHttpService.post.mockReturnValue(of({ data: { embedding: Array(256).fill(0.1), model_id: EMBEDDING_SOURCE_URI, model_slug: EMBEDDING_SLUG } }));

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

    // IDOR.
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

    // IDOR.
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

    // IDOR.
    it('throws ForbiddenException when the profile belongs to another user', async () => {
      const mockProfile = createMockVoiceProfileEntity({ id: 'vp-1', userId: 'someone-else' });
      mockVoiceProfileRepository.findById.mockResolvedValue(mockProfile);

      await expect(service.deleteById('vp-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockVoiceProfileRepository.softDelete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // enrollmentTarget / listForRuntime — TASK-887
  // =========================================================================

  describe('enrollmentTarget', () => {
    it('reports the resolved agent’s embedding model and whether it diarizes', async () => {
      mockAsrResolver.resolve.mockResolvedValue(asrSpec({ matchThreshold: 0.55 }));

      await expect(service.enrollmentTarget()).resolves.toEqual({
        agentSlug: AGENT_SLUG,
        modelId: EMBEDDING_SLUG,
        modelSourceUri: EMBEDDING_SOURCE_URI,
        diarizationEnabled: true,
        matchThreshold: 0.55,
      });
      // No slug given ⇒ the ASSIGNED agent, which is what a session with no explicit agent runs.
      expect(mockAsrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null });
    });

    it('reports a null threshold when the agent declared none', async () => {
      await expect(service.enrollmentTarget()).resolves.toMatchObject({ matchThreshold: null });
    });

    it('refuses the target with 409 ASR_AGENT_DIARIZATION_DISABLED while the agent’s diarization is off', async () => {
      mockAsrResolver.resolve.mockResolvedValue(asrSpec({ enabled: false, matchThreshold: 0.55 }));

      await expect(service.enrollmentTarget()).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: 'ASR_AGENT_DIARIZATION_DISABLED' },
      });
    });
  });

  describe('listForRuntime', () => {
    it('asks the repository for the user’s ACTIVE rows in ONE model’s space and maps them to the wire shape', async () => {
      mockVoiceProfileRepository.findActiveEmbeddingsForUser.mockResolvedValue([
        { id: 'vp-1', label: 'Dr Who', modelId: EMBEDDING_SLUG, embedding: [0.1, 0.2] },
      ]);

      await expect(service.listForRuntime('user-id-1', 'tenant-1', EMBEDDING_SLUG)).resolves.toEqual([
        { profile_id: 'vp-1', label: 'Dr Who', model_id: EMBEDDING_SLUG, embedding: [0.1, 0.2] },
      ]);
      // The model is a WHERE clause, never a post-filter: vectors from another embedding space
      // are not comparable, so they are not fetched at all.
      expect(mockVoiceProfileRepository.findActiveEmbeddingsForUser).toHaveBeenCalledWith('user-id-1', 'tenant-1', EMBEDDING_SLUG);
    });

    it('never throws — a failed lookup costs generic speaker labels, not the session', async () => {
      mockVoiceProfileRepository.findActiveEmbeddingsForUser.mockRejectedValue(new Error('pg down'));
      await expect(service.listForRuntime('user-id-1', 'tenant-1', EMBEDDING_SLUG)).resolves.toEqual([]);
    });

    it('resolves nothing when any of user / tenant / model is missing', async () => {
      await expect(service.listForRuntime('', 'tenant-1', EMBEDDING_SLUG)).resolves.toEqual([]);
      await expect(service.listForRuntime('user-id-1', '', EMBEDDING_SLUG)).resolves.toEqual([]);
      await expect(service.listForRuntime('user-id-1', 'tenant-1', '')).resolves.toEqual([]);
      expect(mockVoiceProfileRepository.findActiveEmbeddingsForUser).not.toHaveBeenCalled();
    });
  });
});
