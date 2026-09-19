import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateStreamSessionRequest, TranscribeFileRequest } from '../dto';
import { CreateJobRequest, CreateBatchJobRequest, CreateStreamingJobRequest } from '@arcaai/applications';
import { TranscriptionJobType } from '@arcaai/domains';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from '../../../common/tenant-owned-resource.decorator';
import { STREAM_SCOPE_METADATA } from '../../auth/decorators/stream-scope.decorator';

const createMockJobService = () => ({
  create: vi.fn(),
  createBatchJob: vi.fn(),
  createStreamingJob: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  listForOwner: vi.fn(),
  getStatusCounts: vi.fn(),
  getStatusCountsForOwner: vi.fn(),
  getByConsultation: vi.fn(),
  getByConsultationForOwner: vi.fn(),
  getByStatus: vi.fn(),
  getByStatusForOwner: vi.fn(),
  cancelJob: vi.fn(),
  cancelJobForOwner: vi.fn(),
  retryJob: vi.fn(),
  retryJobForOwner: vi.fn(),
});

const createMockRealtimeService = () => ({
  createAndStream: vi.fn(),
  subscribeToJob: vi.fn(),
  dispatchDramatiqJob: vi.fn(),
  retryAndDispatch: vi.fn(),
});

const createMockSessionService = () => ({
  checkAvailability: vi.fn(),
  createSession: vi.fn(),
  removeSession: vi.fn(),
});

/**
 * Key-aware CLS mock (BUG-012). The real CLS is a keyed store: `user` holds the
 * JWT-derived identity and `tenantId` holds the ACTIVE tenant — the JWT tenant
 * for a tenant-bound caller, or the super-admin's elevated working tenant
 * (`ContextInterceptor`). A mock that returns one object for EVERY key cannot
 * express the super-admin shape (`user.tenantId === ''` + `tenantId` set), so
 * the store is keyed here.
 */
const clsFor = (store: Record<string, unknown>) => ({
  get: vi.fn((key?: string) => (key === undefined ? undefined : store[key])),
});

// Default: a tenant-bound caller — `JwtStrategy.validate` writes the same
// tenant into BOTH `user.tenantId` and the CLS `tenantId` key.
const createMockCls = () => clsFor({ user: { id: 'user-1', tenantId: 'tenant-1' }, tenantId: 'tenant-1' });

const createMockBlobStorage = () => ({
  putObject: vi.fn(),
  resolveDescriptor: vi.fn().mockResolvedValue(null),
});

const createMockTenantBucketService = () => ({
  getBucketBySlug: vi.fn(),
  getBucketByName: vi.fn(),
  getBucketByPurpose: vi.fn(),
});

const createMockPipelineService = () => ({
  // Default: pipeline exists and belongs to caller's tenant.
  getById: vi.fn().mockImplementation(async (id: string) => ({
    id,
    tenantId: 'tenant-1',
    name: 'Default Pipeline',
    slug: id,
  })),
});

const createMockStreamTicketService = () => ({
  issueTicket: vi.fn().mockResolvedValue({
    ticket: 'minted-ticket-1',
    expiresAt: Date.now() + 30_000,
    scope: 'stt_session:placeholder',
  }),
  consumeTicket: vi.fn(),
});

// The controller binds on session create and
// clears on close. Tests stub the binding so we can assert the dependency
// is invoked (and used in the new annotation contract).
// The controller also persists session meta (sampleRate)
// so the WS gateway can forward frames at the negotiated rate.
const createMockStreamSessionTenantBinding = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  bindSessionMeta: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn().mockResolvedValue(null),
  lookupBinding: vi.fn().mockResolvedValue(null),
  lookupSessionMeta: vi.fn().mockResolvedValue(null),
  clear: vi.fn().mockResolvedValue(undefined),
});

// The entitlements service gates new streaming
// sessions against the tenant's resolved `maxConcurrentSessions`. Default:
// a no-op (kill-switch OFF / under limit) so existing tests are unaffected.
const createMockEntitlements = () => ({
  assertConcurrencyQuota: vi.fn().mockResolvedValue(undefined),
});

describe('TranscriptionJobController', () => {
  let controller: TranscriptionJobController;
  let mockJobService: ReturnType<typeof createMockJobService>;
  let mockRealtimeService: ReturnType<typeof createMockRealtimeService>;
  let mockSessionService: ReturnType<typeof createMockSessionService>;
  let mockCls: ReturnType<typeof createMockCls>;
  let mockBlobStorage: ReturnType<typeof createMockBlobStorage>;
  let mockTenantBucketService: ReturnType<typeof createMockTenantBucketService>;
  let mockPipelineService: ReturnType<typeof createMockPipelineService>;
  let mockStreamTicketService: ReturnType<typeof createMockStreamTicketService>;
  let mockStreamSessionTenantBinding: ReturnType<typeof createMockStreamSessionTenantBinding>;
  let mockEntitlements: ReturnType<typeof createMockEntitlements>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJobService = createMockJobService();
    mockRealtimeService = createMockRealtimeService();
    mockSessionService = createMockSessionService();
    mockCls = createMockCls();
    mockBlobStorage = createMockBlobStorage();
    mockTenantBucketService = createMockTenantBucketService();
    mockPipelineService = createMockPipelineService();
    mockStreamTicketService = createMockStreamTicketService();
    mockStreamSessionTenantBinding = createMockStreamSessionTenantBinding();
    mockEntitlements = createMockEntitlements();
    controller = new TranscriptionJobController(
      mockJobService as any,
      mockRealtimeService as any,
      mockSessionService as any,
      mockCls as any,
      mockBlobStorage as any,
      mockTenantBucketService as any,
      mockPipelineService as any,
      mockStreamTicketService as any,
      mockStreamSessionTenantBinding as any,
      mockEntitlements as any,
    );
  });

  describe('POST / (create job)', () => {
    it('should delegate to jobService.create', async () => {
      const jobResponse = { id: 'job-1', status: 'QUEUED', pipelineId: 'pipe-1' };
      mockJobService.create.mockResolvedValue(jobResponse);

      const result = await controller.create({ jobType: TranscriptionJobType.BATCH, pipelineId: 'pipe-1' });

      expect(mockJobService.create).toHaveBeenCalledWith({ jobType: TranscriptionJobType.BATCH, pipelineId: 'pipe-1' });
      expect(result).toEqual(jobResponse);
    });
  });

  describe('POST /batch (create batch job)', () => {
    it('should delegate to jobService.createBatchJob', async () => {
      const jobResponse = { id: 'job-2', status: 'QUEUED' };
      mockJobService.createBatchJob.mockResolvedValue(jobResponse);

      const result = await controller.createBatch({ pipelineId: 'pipe-1', mediaId: 'media-1' });

      expect(mockJobService.createBatchJob).toHaveBeenCalledWith({ pipelineId: 'pipe-1', mediaId: 'media-1' });
      expect(result).toEqual(jobResponse);
    });
  });

  describe('POST /streaming (create streaming job)', () => {
    it('should delegate to jobService.createStreamingJob', async () => {
      const jobResponse = { id: 'job-3', status: 'QUEUED' };
      mockJobService.createStreamingJob.mockResolvedValue(jobResponse);

      const result = await controller.createStreaming({ pipelineId: 'pipe-1' });

      expect(mockJobService.createStreamingJob).toHaveBeenCalledWith({ pipelineId: 'pipe-1' });
      expect(result).toEqual(jobResponse);
    });
  });

  describe('GET /stats', () => {
    it('should return OWNER-scoped job status counts (never tenant-wide)', async () => {
      const stats = { queued: 5, processing: 2, completed: 10, failed: 1, cancelled: 0, dead: 0 };
      mockJobService.getStatusCountsForOwner.mockResolvedValue(stats);

      const result = await controller.getStats();

      expect(mockJobService.getStatusCountsForOwner).toHaveBeenCalledWith('user-1');
      expect(mockJobService.getStatusCounts).not.toHaveBeenCalled();
      expect(result).toEqual(stats);
    });
  });

  describe('GET /status/:status', () => {
    it('should return OWNER-scoped jobs for the given status', async () => {
      const jobs = [{ id: 'job-1', status: 'COMPLETED' }];
      mockJobService.getByStatusForOwner.mockResolvedValue(jobs);

      const result = await controller.getByStatus('COMPLETED');

      expect(mockJobService.getByStatusForOwner).toHaveBeenCalledWith('user-1', 'COMPLETED');
      expect(mockJobService.getByStatus).not.toHaveBeenCalled();
      expect(result).toEqual(jobs);
    });
  });

  describe('GET /consultation/:consultationId', () => {
    // Owner-scoped: the end-user surface returns only the
    // caller's OWN jobs for the consultation, not every tenant job on it.
    it('should return the caller-owned jobs for the consultation', async () => {
      const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
      mockJobService.getByConsultationForOwner.mockResolvedValue(jobs);

      const result = await controller.getByConsultation('consult-1');

      expect(mockJobService.getByConsultationForOwner).toHaveBeenCalledWith('user-1', 'consult-1');
      expect(mockJobService.getByConsultation).not.toHaveBeenCalled();
      expect(result).toEqual(jobs);
    });
  });

  describe('GET /:id', () => {
    it('should return a job by ID', async () => {
      const job = { id: 'job-1', status: 'COMPLETED' };
      mockJobService.getById.mockResolvedValue(job);

      const result = await controller.getById('job-1');

      expect(mockJobService.getById).toHaveBeenCalledWith('job-1');
      expect(result).toEqual(job);
    });

    it('should throw NotFoundException when job not found', async () => {
      mockJobService.getById.mockResolvedValue(null);

      await expect(controller.getById('missing')).rejects.toThrow('not found');
    });
  });

  describe('GET / (list)', () => {
    it('should return an OWNER-scoped paginated job list (never tenant-wide)', async () => {
      const paginated = { data: [], total: 0, page: 1, limit: 20, totalPages: 0 };
      mockJobService.listForOwner.mockResolvedValue(paginated);

      const result = await controller.list(1, 20);

      expect(mockJobService.listForOwner).toHaveBeenCalledWith('user-1', 1, 20);
      expect(mockJobService.list).not.toHaveBeenCalled();
      expect(result).toEqual(paginated);
    });
  });

  describe('GET /:id/stream (SSE)', () => {
    it('should return an Observable from realtime service', () => {
      const events$ = of({ data: '{}' });
      mockRealtimeService.subscribeToJob.mockReturnValue(events$);

      const result = controller.streamJob('job-1');

      expect(mockRealtimeService.subscribeToJob).toHaveBeenCalledWith('job-1');
      expect(result).toBeInstanceOf(Observable);
    });

    it('should throw for empty job ID', () => {
      expect(() => controller.streamJob('   ')).toThrow('valid transcription job ID is required');
      expect(mockRealtimeService.subscribeToJob).not.toHaveBeenCalled();
    });

    // Single-use tickets from POST /auth/stream-ticket must
    // authenticate this route: the JwtAuthGuard rejects any ticket presented
    // on a route without @StreamScope, so the console's `transcription_job:<id>`
    // scoped tickets 401'd before this declaration existed.
    it('declares @StreamScope({ namespace: "transcription_job", param: "id" }) for ticket auth', () => {
      const meta = Reflect.getMetadata(STREAM_SCOPE_METADATA, TranscriptionJobController.prototype.streamJob);
      expect(meta).toEqual({ namespace: 'transcription_job', param: 'id' });
    });
  });

  describe('POST /stream/session', () => {
    it('should create a streaming session with generated sessionId', async () => {
      const sessionStatus = {
        sessionId: 'sess-1',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      };
      mockSessionService.createSession.mockResolvedValue(sessionStatus);

      const result = await controller.createStreamSession({
        pipelineId: 'pipe-1',
      } as any);

      expect(mockSessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineId: 'pipe-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
        }),
      );
      expect(result).toMatchObject({
        sessionId: expect.any(String),
        wsUrl: '/ws/stt/stream',
        maxConcurrent: 5,
        currentActive: 1,
      });
    });

    it('throws NotFoundException when pipelineId is not in caller tenant (D-2)', async () => {
      mockPipelineService.getById.mockResolvedValueOnce(null);

      await expect(controller.createStreamSession({ pipelineId: 'pipe-foreign' } as any)).rejects.toThrow(/Pipeline pipe-foreign not found/);
      expect(mockSessionService.createSession).not.toHaveBeenCalled();
    });

    it('mints a stream ticket scoped to stt_session:<sessionId> and returns it (D-1)', async () => {
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-mint',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
        voiceProfileSeeded: true,
      });

      const result = await controller.createStreamSession({ pipelineId: 'pipe-1' } as any);

      expect(mockStreamTicketService.issueTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: 'tenant-1',
          scope: 'stt_session:sess-mint',
        }),
      );
      expect(result).toMatchObject({
        ticket: 'minted-ticket-1',
        ticketExpiresAt: expect.any(Number),
        voiceProfileSeeded: true,
      });
    });

    it('persists the negotiated sampleRate as session meta for the gateway', async () => {
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-meta',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipe-1', sampleRate: 48000 } as any);

      expect(mockStreamSessionTenantBinding.bindSessionMeta).toHaveBeenCalledWith('sess-meta', expect.objectContaining({ sampleRate: 48000 }));
    });

    it('defaults the session-meta sampleRate to 16000 when the client omits it', async () => {
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-meta-default',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipe-1' } as any);

      expect(mockStreamSessionTenantBinding.bindSessionMeta).toHaveBeenCalledWith(
        'sess-meta-default',
        expect.objectContaining({ sampleRate: 16000 }),
      );
    });

    it('should resolve and forward tenant audioBucketName when available', async () => {
      mockTenantBucketService.getBucketBySlug.mockResolvedValue({
        id: 'b-1',
        name: 'hope-recordings-arcaai',
        slug: 'recordings',
      });
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-1',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipe-1' });

      // The default system slug is now `recordings`.
      expect(mockTenantBucketService.getBucketBySlug).toHaveBeenCalledWith('recordings');
      expect(mockSessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          audioBucketName: 'hope-recordings-arcaai',
        }),
      );
    });

    // The configured AUDIO-purpose bucket is preferred over
    // the legacy 'audio' slug, and a DEDICATED tenant's storage descriptor is
    // forwarded to STT-v2 so the worker connects to the right backend.
    it('prefers the AUDIO-purpose bucket and forwards the storage descriptor (W3-B)', async () => {
      mockTenantBucketService.getBucketByPurpose.mockResolvedValue({
        id: 'b-purpose',
        name: 'tenant-audio-bucket',
        slug: 'audio',
      });
      mockBlobStorage.resolveDescriptor.mockResolvedValue({
        provider: 'azure_blob',
        bucket: 'tenant-audio-bucket',
        account_name: 'acct',
      });
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-1',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipe-1' });

      expect(mockTenantBucketService.getBucketByPurpose).toHaveBeenCalled();
      expect(mockTenantBucketService.getBucketBySlug).not.toHaveBeenCalled();
      expect(mockBlobStorage.resolveDescriptor).toHaveBeenCalledWith('tenant-audio-bucket');
      expect(mockSessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          audioBucketName: 'tenant-audio-bucket',
          storage: expect.objectContaining({ provider: 'azure_blob' }),
        }),
      );
    });

    it('omits audioBucketName when tenant bucket lookup throws', async () => {
      mockTenantBucketService.getBucketBySlug.mockRejectedValue(new Error('boom'));
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-1',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipe-1' });

      const arg = mockSessionService.createSession.mock.calls[0][0];
      expect(arg.audioBucketName).toBeUndefined();
    });

    it('should throw ServiceUnavailableException when STT at capacity', async () => {
      mockSessionService.createSession.mockResolvedValue(null);

      await expect(controller.createStreamSession({ pipelineId: 'pipe-1' } as any)).rejects.toThrow();
    });

    // The concurrency gate runs on the caller's
    // tenant before any STT session is created.
    it('asserts the tenant concurrency quota before creating the session', async () => {
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-conc',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipe-1' } as any);

      expect(mockEntitlements.assertConcurrencyQuota).toHaveBeenCalledWith('tenant-1');
      const gateOrder = mockEntitlements.assertConcurrencyQuota.mock.invocationCallOrder[0];
      const createOrder = mockSessionService.createSession.mock.invocationCallOrder[0];
      expect(gateOrder).toBeLessThan(createOrder);
    });

    // A hard-block from the gate rejects the request
    // and never creates a session downstream.
    it('propagates a concurrency hard-block and does not create the session', async () => {
      const { QuotaExceededException } = await import('@arcaai/exceptions');
      mockEntitlements.assertConcurrencyQuota.mockRejectedValueOnce(
        new QuotaExceededException('at capacity', {
          capability: 'maxConcurrentSessions',
          limit: 5,
          used: 5,
          requested: 1,
          tenantId: 'tenant-1',
        }),
      );

      await expect(controller.createStreamSession({ pipelineId: 'pipe-1' } as any)).rejects.toBeInstanceOf(QuotaExceededException);
      expect(mockSessionService.createSession).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Refresh-ticket endpoint
  // =========================================================================
  describe('POST /stream/session/:sessionId/refresh-ticket (D-18)', () => {
    it('mints a new ticket scoped to the existing session', async () => {
      mockStreamTicketService.issueTicket.mockResolvedValueOnce({
        ticket: 'fresh-ticket',
        expiresAt: 1_700_000_000_000,
        scope: 'stt_session:sess-refresh',
      });

      const result = await controller.refreshStreamTicket('sess-refresh');

      expect(mockStreamTicketService.issueTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: 'tenant-1',
          scope: 'stt_session:sess-refresh',
        }),
      );
      expect(result).toEqual({ ticket: 'fresh-ticket', ticketExpiresAt: 1_700_000_000_000 });
    });

    it('rejects empty sessionId', async () => {
      await expect(controller.refreshStreamTicket('   ')).rejects.toThrow(/sessionId is required/);
    });
  });

  // =========================================================================
  // pipelineId shape validation
  // =========================================================================
  describe('CreateStreamSessionRequest.pipelineId shape validation (D-19)', () => {
    const validPipelineIds = [
      'general-consult',
      'cardio2',
      'a',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479', // UUID
      'F47AC10B-58CC-4372-A567-0E02B2C3D479', // upper UUID
      'p-1',
    ];
    const invalidPipelineIds = ['../../etc/passwd', 'pipe; DROP TABLE users', "1' OR '1'='1", 'spaces here', '', '-leading-dash'];

    for (const id of validPipelineIds) {
      it(`accepts valid pipelineId ${JSON.stringify(id)}`, async () => {
        const dto = plainToInstance(CreateStreamSessionRequest, { pipelineId: id });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      });
    }

    for (const id of invalidPipelineIds) {
      it(`rejects invalid pipelineId ${JSON.stringify(id)}`, async () => {
        const dto = plainToInstance(CreateStreamSessionRequest, { pipelineId: id });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    }
  });

  describe('TranscribeFileRequest.pipelineId shape validation (D-19)', () => {
    it('rejects pipelineId with path traversal', async () => {
      const dto = plainToInstance(TranscribeFileRequest, { pipelineId: '../bad' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts a UUID pipelineId', async () => {
      const dto = plainToInstance(TranscribeFileRequest, {
        pipelineId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('DELETE /stream/session/:sessionId', () => {
    it('should close a streaming session', async () => {
      mockSessionService.removeSession.mockResolvedValue(undefined);

      await controller.closeStreamSession('sess-1');

      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-1', false, 'tenant-1');
    });
  });

  describe('POST /:id/cancel', () => {
    // Creator-scoped: a same-tenant peer cannot cancel a
    // job they did not create (id enumeration). The controller forwards the
    // caller id so the service can 404 non-creators.
    it('should cancel a job via the creator-scoped service method', async () => {
      const cancelled = { id: 'job-1', status: 'CANCELLED' };
      mockJobService.cancelJobForOwner.mockResolvedValue(cancelled);

      const result = await controller.cancel('job-1');

      expect(mockJobService.cancelJobForOwner).toHaveBeenCalledWith('user-1', 'job-1');
      expect(mockJobService.cancelJob).not.toHaveBeenCalled();
      expect(result).toEqual(cancelled);
    });
  });

  describe('POST /:id/retry', () => {
    // TASK-992 FU-1 — the route must go through the RE-DISPATCH path, not the bare
    // status flip. Calling `retryJobForOwner` directly answers 200 with a QUEUED job
    // that has no Dramatiq message behind it, so no worker ever claims it.
    it('should retry a failed job by re-publishing it, creator-scoped', async () => {
      const retried = { id: 'job-1', status: 'QUEUED' };
      mockRealtimeService.retryAndDispatch.mockResolvedValue(retried);

      const result = await controller.retry('job-1');

      expect(mockRealtimeService.retryAndDispatch).toHaveBeenCalledWith('job-1', { ownerId: 'user-1' });
      expect(mockJobService.retryJobForOwner).not.toHaveBeenCalled();
      expect(mockJobService.retryJob).not.toHaveBeenCalled();
      expect(result).toEqual(retried);
    });
  });

  // ------------------------------------------------------------------------
  // Every transcription-job-by-id handler must carry
  // @TenantOwnedResource so the global interceptor 404s cross-tenant probes.
  // ------------------------------------------------------------------------
  describe('@TenantOwnedResource metadata', () => {
    const meta = (m: keyof TranscriptionJobController): TenantOwnedResourceOptions | undefined =>
      Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, TranscriptionJobController.prototype[m] as object) as TenantOwnedResourceOptions | undefined;

    const expected = { modelName: 'TranscriptionJob', paramName: 'id' };

    it('getById is annotated', () => {
      expect(meta('getById')).toEqual(expected);
    });

    it('cancel is annotated', () => {
      expect(meta('cancel')).toEqual(expected);
    });

    it('retry is annotated', () => {
      expect(meta('retry')).toEqual(expected);
    });

    it('streamJob is annotated', () => {
      expect(meta('streamJob')).toEqual(expected);
    });

    it('list / create / createBatch / createStreaming / transcribeFile / getStats / getByStatus / getByConsultation / createStreamSession are NOT annotated (no ownable route param)', () => {
      // Bulk negative — they either have no route param at all, or a
      // consultationId whose ownership is enforced by the owner-scoped
      // service method. Service-layer tenant filtering covers them via
      // the W5.1 Prisma extension.
      expect(meta('list')).toBeUndefined();
      expect(meta('create')).toBeUndefined();
      expect(meta('createBatch')).toBeUndefined();
      expect(meta('createStreaming')).toBeUndefined();
      expect(meta('transcribeFile')).toBeUndefined();
      expect(meta('getStats')).toBeUndefined();
      expect(meta('getByStatus')).toBeUndefined();
      expect(meta('getByConsultation')).toBeUndefined();
      expect(meta('createStreamSession')).toBeUndefined();
    });

    // closeStreamSession IS now annotated with
    // the new `StreamSession` resolver branch.
    it('closeStreamSession IS annotated with {modelName: StreamSession, paramName: sessionId, lookup: "session"}', () => {
      expect(meta('closeStreamSession')).toEqual({
        modelName: 'StreamSession',
        paramName: 'sessionId',
        lookup: 'session',
      });
    });

    // refreshStreamTicket mints an `stt_session:<sessionId>`
    // ticket, so it must carry the SAME StreamSession ownership guard as
    // the sibling DELETE route (it HAS a :sessionId route param — the old
    // "no :id route param" rationale was wrong). Pre-fix it was un-gated:
    // any authenticated tenant could mint a 200 ticket for a foreign
    // sessionId, leaving the WS handshake gate as a single point of
    // failure instead of one of two independent gates.
    it('refreshStreamTicket IS annotated with {modelName: StreamSession, paramName: sessionId, lookup: "session"}', () => {
      expect(meta('refreshStreamTicket')).toEqual({
        modelName: 'StreamSession',
        paramName: 'sessionId',
        lookup: 'session',
      });
    });
  });

  // ------------------------------------------------------------------------
  // createStreamSession binds sessionId → { tenantId, userId }
  // in the gateway-side `StreamSessionTenantBindingService` so the
  // interceptor can 404 cross-tenant AND cross-user probes on
  // closeStreamSession and its siblings.
  // closeStreamSession clears the binding after the downstream remove
  // succeeds.
  // ------------------------------------------------------------------------
  describe('StreamSessionTenantBindingService integration', () => {
    it('createStreamSession binds the returned sessionId to the caller tenant AND the creating user', async () => {
      mockSessionService.createSession.mockResolvedValueOnce({
        sessionId: 'sess-xyz',
        status: 'ACTIVE',
        maxConcurrent: 4,
        currentActive: 1,
      });

      await controller.createStreamSession({ pipelineId: 'pipeline-1' } as CreateStreamSessionRequest);

      expect(mockStreamSessionTenantBinding.bind).toHaveBeenCalledWith('sess-xyz', 'tenant-1', 'user-1');
    });

    it('closeStreamSession clears the binding after a successful downstream remove', async () => {
      mockSessionService.removeSession.mockResolvedValueOnce(undefined);

      await controller.closeStreamSession('sess-xyz');

      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-xyz', false, 'tenant-1');
      expect(mockStreamSessionTenantBinding.clear).toHaveBeenCalledWith('sess-xyz');
    });
  });

  // ------------------------------------------------------------------------
  // The create endpoints (`create` / `createBatch` /
  // `createStreaming`) previously accepted `@Body() dto: any`, bypassing the
  // global ValidationPipe. They now bind to typed request DTOs so malformed
  // input (bad enum, malformed ids, missing required fields) is rejected.
  // Note: `CreateJobRequest.pipelineId` accepts
  // slug-or-UUID via PIPELINE_ID_PATTERN, so a plain slug is valid input.
  // These tests lock the validation contract those endpoints rely on.
  // ------------------------------------------------------------------------
  describe('EU-07 — create endpoints use typed, validated request DTOs', () => {
    const VALID_UUID_V7 = '0188b1f7-7f1a-7e7a-9c0a-2d9b6f3a1c2d';
    const VALID_UUID_V7_B = '0190a2c4-1b2c-7d3e-8f4a-5b6c7d8e9f01';

    it('CreateJobRequest accepts a valid jobType + UUIDv7 pipelineId', async () => {
      const dto = plainToInstance(CreateJobRequest, {
        jobType: 'BATCH',
        pipelineId: VALID_UUID_V7,
        mediaId: VALID_UUID_V7_B,
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    // Probe must fail BOTH branches of PIPELINE_ID_PATTERN
    // (slug `[A-Za-z0-9][A-Za-z0-9-]*` or UUID): spaces and '!' do.
    // The old probe 'not-a-uuid' is a valid slug under this pattern.
    it('CreateJobRequest rejects an invalid jobType and a non-slug, non-UUID pipelineId', async () => {
      const dto = plainToInstance(CreateJobRequest, { jobType: 'NOT_A_TYPE', pipelineId: 'not a uuid!' });
      const errors = await validate(dto);
      const failedProps = errors.map((e) => e.property);
      expect(failedProps).toContain('jobType');
      expect(failedProps).toContain('pipelineId');
    });

    // Pin the widened pipelineId contract itself: a plain
    // slug pipelineId must keep passing CreateJobRequest validation.
    it('CreateJobRequest accepts a valid slug pipelineId', async () => {
      const dto = plainToInstance(CreateJobRequest, {
        jobType: 'BATCH',
        pipelineId: 'general-consult',
        mediaId: VALID_UUID_V7_B,
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('CreateBatchJobRequest requires both pipelineId and mediaId', async () => {
      const missingMedia = plainToInstance(CreateBatchJobRequest, { pipelineId: VALID_UUID_V7 });
      expect((await validate(missingMedia)).map((e) => e.property)).toContain('mediaId');
    });

    it('CreateStreamingJobRequest rejects a path-traversal pipelineId', async () => {
      const dto = plainToInstance(CreateStreamingJobRequest, { pipelineId: '../../etc/passwd' });
      expect((await validate(dto)).length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------------
  // BUG-012 — active-tenant resolution.
  //
  // `getTenantId()` must use the canonical order the rest of the gateway uses
  // (`ClsTenantContextProvider.getTenantId()`, `agentic-admin.controller.ts`,
  // `harness-admin.controller.ts`): CLS `tenantId` FIRST — that is where
  // `ContextInterceptor` elevates a SUPER_ADMIN's working tenant from the
  // `x-tenant-id` header — then the JWT-derived `user.tenantId`. Reading only
  // `user.tenantId` 400s every super-admin caller, whose JWT carries
  // `tenantId: ''`.
  // ------------------------------------------------------------------------
  describe('BUG-012 — active tenant resolution (super-admin working tenant)', () => {
    const buildController = (clsStore: Record<string, unknown>) =>
      new TranscriptionJobController(
        mockJobService as any,
        mockRealtimeService as any,
        mockSessionService as any,
        clsFor(clsStore) as any,
        mockBlobStorage as any,
        mockTenantBucketService as any,
        mockPipelineService as any,
        mockStreamTicketService as any,
        mockStreamSessionTenantBinding as any,
        mockEntitlements as any,
      );

    // A 5-minute WAV — see wav-fixture.ts for why a placeholder buffer no
    // longer survives the route's duration probe.
    const audioFile = () => wavFixture(300, { originalname: 'test-1.wav' });

    // SUPER_ADMIN shape: empty JWT tenant + elevated working tenant in CLS.
    const superAdminStore = { user: { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] }, tenantId: 'tenant-1' };

    it('transcribeFile resolves the elevated CLS working tenant for a SUPER_ADMIN with an empty JWT tenant', async () => {
      mockJobService.createBatchJob.mockResolvedValue({ id: 'job-ga', status: 'QUEUED' });
      const ctrl = buildController(superAdminStore);

      const result = await ctrl.transcribeFile(audioFile(), { pipelineId: 'pipe-1' } as TranscribeFileRequest);

      expect(result).toMatchObject({ id: 'job-ga', status: 'QUEUED' });
      expect(mockRealtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-ga', tenantId: 'tenant-1' }));
    });

    it('createStreamSession resolves the elevated CLS working tenant for a SUPER_ADMIN', async () => {
      mockSessionService.createSession.mockResolvedValue({
        sessionId: 'sess-ga',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 1,
      });
      const ctrl = buildController(superAdminStore);

      await ctrl.createStreamSession({ pipelineId: 'pipe-1' } as CreateStreamSessionRequest);

      expect(mockEntitlements.assertConcurrencyQuota).toHaveBeenCalledWith('tenant-1');
      expect(mockSessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
      expect(mockStreamSessionTenantBinding.bind).toHaveBeenCalledWith('sess-ga', 'tenant-1', 'admin-1');
    });

    // Regression guard in the other direction: a tenant-bound caller whose CLS
    // `tenantId` key was never populated must still resolve via the JWT identity.
    it('transcribeFile falls back to the JWT user tenant when no CLS tenantId is set', async () => {
      mockJobService.createBatchJob.mockResolvedValue({ id: 'job-tb', status: 'QUEUED' });
      const ctrl = buildController({ user: { id: 'user-1', tenantId: 'tenant-1' } });

      await ctrl.transcribeFile(audioFile(), { pipelineId: 'pipe-1' } as TranscribeFileRequest);

      expect(mockRealtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    // Fail-closed posture preserved: an empty string is "no tenant", never a
    // tenant. A super admin with NO working tenant selected still 400s.
    it('transcribeFile still rejects when neither the CLS tenantId nor the JWT tenant is present', async () => {
      const ctrl = buildController({ user: { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] }, tenantId: '' });

      await expect(ctrl.transcribeFile(audioFile(), { pipelineId: 'pipe-1' } as TranscribeFileRequest)).rejects.toThrow(
        /Tenant context is required/,
      );
      expect(mockJobService.createBatchJob).not.toHaveBeenCalled();
    });
  });
});
