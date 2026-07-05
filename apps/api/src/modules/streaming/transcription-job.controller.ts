import type { IActiveUserContext, IBlobStorageService as IBlobStorageServiceType, StorageDescriptor } from '@arcaai/applications';
import {
  Authorize,
  CreateBatchJobRequest,
  CreateJobRequest,
  CreateStreamingJobRequest,
  IBlobStorageService,
  IEntitlementsService,
  ITenantBucketService,
  PipelineService,
  StreamingSessionService,
  TranscriptionJobService,
  TranscriptionRealtimeService,
} from '@arcaai/applications';
import { TenantBucketPurpose } from '@arcaai/domains';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../auth/stream-ticket.service';
import type { MessageEvent } from '@nestjs/common';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { uuidv7 } from 'uuidv7';
import { StreamSessionTenantBindingService, TenantOwnedResource } from '../../common';
import {
  ALLOWED_AUDIO_MIMES,
  AUDIO_BUCKET,
  BatchTranscribeResponse,
  CreateStreamSessionRequest,
  MAX_FILE_SIZE,
  StreamSessionResponse,
  TranscribeFileRequest,
} from './dto';

@ApiBearerAuth()
@Authorize()
@ApiTags('transcription-jobs')
@Controller('audio/transcription-jobs')
export class TranscriptionJobController {
  private readonly logger = new Logger(TranscriptionJobController.name);

  private async dispatchBatchJob(params: {
    jobId: string;
    tenantId: string;
    pipelineId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    language?: string;
    userId?: string;
    audioBucketName?: string;
    storage?: StorageDescriptor | null;
  }): Promise<void> {
    const service = this.realtimeService as unknown as {
      dispatchDramatiqJob: (args: typeof params) => Promise<void>;
    };
    await service.dispatchDramatiqJob(params);
  }

  constructor(
    private readonly jobService: TranscriptionJobService,
    private readonly realtimeService: TranscriptionRealtimeService,
    private readonly sessionService: StreamingSessionService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageServiceType,
    @Inject(ITenantBucketService) private readonly tenantBucketService: ITenantBucketService,
    private readonly pipelineService: PipelineService,
    private readonly streamTicketService: StreamTicketService,
    // TASK-310 W7.A.9 (AC-3): persists sessionId → tenantId on create
    // and clears it on close, so the `@TenantOwnedResource('StreamSession')`
    // route guard on `closeStreamSession` can 404 cross-tenant probes.
    private readonly streamSessionTenantBinding: StreamSessionTenantBindingService,
    // TASK-392 (concurrency) — hard-blocks a new streaming session when the
    // caller's tenant is at/over its resolved `maxConcurrentSessions` (no-op
    // while the entitlements kill-switch is OFF).
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
  ) {}

  private getTenantId(): string {
    const user = this.cls.get('user');
    if (!user?.tenantId) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return user.tenantId;
  }

  /**
   * TASK-319 F3 — the caller's identity, used to owner-scope the end-user
   * list/stats/status reads so a user only ever sees the jobs THEY created.
   * The tenant-wide view lives on the admin surface
   * (`/admin/audio/transcription-jobs`).
   */
  private getUserId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new BadRequestException('User context is required. Ensure you are authenticated.');
    }
    return user.id;
  }

  /**
   * TASK-298 D-2 — assert the caller's tenant owns `pipelineId` before the
   * controller forwards work to STT-V2. We translate cross-tenant pipelines
   * to `NotFoundException` so the error surface matches "unknown pipeline"
   * and we do not leak the existence of pipelines in other tenants.
   */
  private async assertPipelineOwnership(pipelineId: string): Promise<void> {
    const pipeline = await this.pipelineService.getById(pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} not found`);
    }
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a transcription job' })
  async create(@Body() dto: CreateJobRequest) {
    return this.jobService.create(dto);
  }

  @Post('batch')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a batch transcription job' })
  async createBatch(@Body() dto: CreateBatchJobRequest) {
    return this.jobService.createBatchJob(dto);
  }

  @Post('streaming')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a streaming transcription job' })
  async createStreaming(@Body() dto: CreateStreamingJobRequest) {
    return this.jobService.createStreamingJob(dto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get transcription job status counts (caller-owned jobs)' })
  async getStats() {
    // TASK-319 F3 — owner-scoped: the caller's jobs only.
    return this.jobService.getStatusCountsForOwner(this.getUserId());
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get transcription jobs by status (caller-owned jobs)' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // TASK-319 F3 — owner-scoped: the caller's jobs only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.jobService.getByStatusForOwner(this.getUserId(), status as any);
  }

  @Post('transcribe')
  @HttpCode(201)
  @ApiOperation({ summary: 'Upload audio file for batch transcription via worker' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Batch job created and queued', type: BatchTranscribeResponse })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  async transcribeFile(@UploadedFile() file: Express.Multer.File, @Body() body: TranscribeFileRequest): Promise<BatchTranscribeResponse> {
    // 1. Validate file
    if (!file?.buffer) {
      throw new BadRequestException('Audio file is required');
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(`File size ${(file.size / (1024 * 1024)).toFixed(1)}MB exceeds maximum of ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }
    if (!ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported audio type: ${file.mimetype}`);
    }

    const tenantId = this.getTenantId();
    // TASK-298 D-2 — block cross-tenant pipeline use before any I/O.
    await this.assertPipelineOwnership(body.pipelineId);
    const mediaId = uuidv7();

    // 2. Create batch job in DB (status: QUEUED)
    const job = await this.jobService.createBatchJob({
      pipelineId: body.pipelineId,
      mediaId,
      consultationId: body.consultationId,
    });

    // 3. Resolve the tenant's default audio bucket: configured purpose →
    //    `recordings` slug (TASK-426 default) → legacy `audio` slug → global
    //    constant.
    let uploadBucket = AUDIO_BUCKET;
    try {
      const tenantBucket =
        (await this.tenantBucketService.getBucketByPurpose(TenantBucketPurpose.AUDIO)) ??
        (await this.tenantBucketService.getBucketBySlug('recordings')) ??
        (await this.tenantBucketService.getBucketBySlug('audio'));
      if (tenantBucket) {
        uploadBucket = tenantBucket.name;
      }
    } catch (err) {
      this.logger.warn(`Failed to resolve tenant bucket, using default: ${err}`);
    }

    // 4. Build MinIO path (must match STT-v2 StoragePathResolver.audio_path)
    const now = new Date();
    const year = now.getUTCFullYear().toString();
    const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const safeName = this.sanitizeFilename(file.originalname);

    const pathSegment = body.consultationId
      ? `${year}/${month}/consultations/${body.consultationId}/${job.id}/raw/${safeName}`
      : `${year}/${month}/jobs/${job.id}/raw/${safeName}`;

    const audioUri = `s3://${uploadBucket}/${pathSegment}`;

    try {
      // 5. Upload audio to the tenant-resolved store (S3/MinIO or Azure)
      await this.blobStorage.putObject({
        bucket: uploadBucket,
        key: pathSegment,
        body: file.buffer,
        contentType: file.mimetype,
      });

      this.logger.log(`Uploaded audio to ${audioUri} for job ${job.id}`);

      // 6. Resolve a per-tenant storage descriptor so a DEDICATED (S3/Azure)
      //    tenant's worker connects to the right backend. `null` for SHARED
      //    tenants — the worker then uses its env-default client + bucket name.
      const storage = await this.blobStorage.resolveDescriptor(uploadBucket).catch((err) => {
        this.logger.warn(`Failed to resolve storage descriptor for ${uploadBucket}: ${err}`);
        return null;
      });

      // 7. Dispatch Dramatiq message to stt_batch queue
      const user = this.cls.get('user');
      await this.dispatchBatchJob({
        jobId: job.id,
        tenantId,
        pipelineId: body.pipelineId,
        audioUri,
        consultationId: body.consultationId,
        mediaId,
        language: body.language,
        userId: user?.id,
        audioBucketName: uploadBucket,
        storage,
      });
    } catch (error) {
      // If upload or dispatch fails, mark the job as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch transcription setup failed for job ${job.id}: ${errorMessage}`);
      await this.jobService.failJob(job.id, errorMessage, 'SETUP_ERROR').catch(() => {});
      throw error instanceof HttpException ? error : new InternalServerErrorException(`Batch transcription setup failed: ${errorMessage}`);
    }

    // 6. Return job details + SSE URL immediately
    const sseUrl = `/api/v1/audio/transcription-jobs/${job.id}/stream`;

    return {
      id: job.id,
      status: job.status,
      sseUrl,
      audioUri,
    };
  }

  /**
   * Sanitize filename to match STT-v2's StoragePathResolver._sanitize_filename.
   */
  private sanitizeFilename(filename: string): string {
    let name = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
    name = name
      .replace(/\s/g, '_')
      .replace(/[&]/g, '_')
      .replace(/['"?#%*:|\u003c\u003e]/g, '');
    if (name.length > 200) {
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        const ext = name.slice(dotIdx);
        name = name.slice(0, 190) + ext;
      } else {
        name = name.slice(0, 200);
      }
    }
    return name || 'audio';
  }

  @Get('consultation/:consultationId')
  @ApiOperation({ summary: 'Get transcription jobs by consultation (caller-owned jobs)' })
  @ApiParam({ name: 'consultationId', description: 'Consultation ID' })
  async getByConsultation(@Param('consultationId') consultationId: string) {
    // EU-02 — owner-scoped: only the caller's OWN jobs for this consultation.
    // The tenant-wide view lives on the admin surface.
    return this.jobService.getByConsultationForOwner(this.getUserId(), consultationId);
  }

  @Post('stream/session')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a WebSocket streaming session' })
  @ApiResponse({ status: 201, description: 'Streaming session created', type: StreamSessionResponse })
  async createStreamSession(@Body() body: CreateStreamSessionRequest): Promise<StreamSessionResponse> {
    const sessionId = uuidv7();
    const tenantId = this.getTenantId();
    const user = this.cls.get('user');
    const sampleRate = body.sampleRate ?? 16000;

    // TASK-392 (concurrency) — HARD-BLOCK a new session when the tenant is at/
    // over its resolved `maxConcurrentSessions` (live socket-registry count).
    // Runs before any STT-V2 / bucket I/O so an over-capacity caller is rejected
    // early with a typed 429. No-op while the entitlements kill-switch is OFF.
    await this.entitlements.assertConcurrencyQuota(tenantId);

    // TASK-298 D-2 — assert tenant ownership of the requested pipeline
    // BEFORE we forward to STT-V2 (which is itself defended by D-3).
    // TASK-351 P0-2 (M6) — the ownership check and the bucket resolution are
    // independent reads, so they run in parallel; a rejected ownership check
    // still rejects the whole step before anything is forwarded to STT-V2.
    //
    // Bucket resolution: the tenant's default audio bucket (configured
    // purpose → `recordings` slug → legacy `audio` slug) so STT-v2 writes
    // audio to the tenant's bucket instead of the global 'hope-audio', plus a
    // storage descriptor for DEDICATED (S3/Azure) tenants.
    const resolveAudioBucket = async (): Promise<{ audioBucketName: string | undefined; storage: StorageDescriptor | null }> => {
      try {
        const tenantBucket =
          (await this.tenantBucketService.getBucketByPurpose(TenantBucketPurpose.AUDIO)) ??
          (await this.tenantBucketService.getBucketBySlug('recordings')) ??
          (await this.tenantBucketService.getBucketBySlug('audio'));
        const audioBucketName = tenantBucket?.name;
        const storage = audioBucketName ? await this.blobStorage.resolveDescriptor(audioBucketName) : null;
        return { audioBucketName, storage };
      } catch (err) {
        this.logger.warn(`Failed to resolve tenant audio bucket for streaming: ${err}`);
        return { audioBucketName: undefined, storage: null };
      }
    };

    const [, { audioBucketName, storage }] = await Promise.all([this.assertPipelineOwnership(body.pipelineId), resolveAudioBucket()]);

    const sessionPayload = {
      sessionId,
      tenantId,
      pipelineId: body.pipelineId,
      consultationId: body.consultationId,
      sampleRate,
      language: body.language,
      userId: user?.id,
      audioBucketName,
      storage,
    } as Parameters<StreamingSessionService['createSession']>[0];

    const result = await this.sessionService.createSession(sessionPayload);

    if (!result) {
      throw new ServiceUnavailableException('STT-V2 streaming service at capacity');
    }

    // Three independent writes (TASK-351 P0-2 / M6 — parallelized):
    //  - TASK-310 W7.A.9 (AC-3): persist the sessionId → tenantId mapping so
    //    the global `TenantOwnedResourceInterceptor` can 404 cross-tenant
    //    probes against `DELETE /stream/session/:sessionId`. Default 24h TTL
    //    matches the longest reasonable streaming-session lifetime.
    //  - TASK-351 P0-2 (C5): persist session meta (negotiated sampleRate) so
    //    the WS gateway forwards audio at the real rate, not hardcoded 16000.
    //  - TASK-298 D-1: mint a one-shot stream ticket scoped to this session.
    //    The SDK appends it to the WS URL; the gateway consumes it on first
    //    open and rejects (4401) every subsequent attempt.
    const [issuedTicket] = await Promise.all([
      this.streamTicketService.issueTicket({
        userId: user?.id ?? '',
        tenantId,
        scope: `stt_session:${result.sessionId}`,
      }),
      this.streamSessionTenantBinding.bind(result.sessionId, tenantId),
      this.streamSessionTenantBinding.bindSessionMeta(result.sessionId, { sampleRate }),
    ]);

    // TASK-296 preseed contract — capture voiceProfileSeeded if the
    // streaming service surfaces it.
    const voiceProfileSeeded = (result as unknown as { voiceProfileSeeded?: boolean }).voiceProfileSeeded ?? false;

    return {
      sessionId: result.sessionId,
      status: result.status,
      wsUrl: '/ws/stt-v2/stream',
      maxConcurrent: result.maxConcurrent,
      currentActive: result.currentActive,
      ticket: issuedTicket.ticket,
      ticketExpiresAt: issuedTicket.expiresAt,
      voiceProfileSeeded,
    };
  }

  /**
   * TASK-310 W7.A.9 (AC-3) — closes the carryover gap from TASK-307 W7.A.9.
   *
   * Because `sessionId` is opaque to Prisma (the STT-V2 session row lives in
   * STT-V2 / Redis, not the gateway DB), `@TenantOwnedResource` cannot use
   * any of the repository-backed resolvers. Instead, `createStreamSession`
   * now writes a gateway-side `sessionId → tenantId` binding via
   * `StreamSessionTenantBindingService`, and the decorator's `'StreamSession'`
   * branch reads it. Cross-tenant probes 404 with no existence leak
   * (DEF-C3), matching the posture every other resource model uses.
   *
   * The binding is best-effort cleared after the downstream
   * `removeSession` succeeds; the binding's TTL (default 24h) is the
   * fallback when this clear is skipped (e.g. removeSession throws).
   *
   * Alternative designs that were considered and rejected:
   *   - Reshape the URL to `/jobs/:id/stream-session/:sessionId` so the
   *     parent jobId carries the tenant scope. Out of scope — would break
   *     the live SDK contract documented in TASK-298 D-1.
   *   - Modify STT-V2 to return `tenantId` on its status endpoint.
   *     Out of scope — touches `apps/stt-v2` (sibling Python service).
   */
  @Delete('stream/session/:sessionId')
  @HttpCode(204)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Close a WebSocket streaming session' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  async closeStreamSession(@Param('sessionId') sessionId: string): Promise<void> {
    await this.sessionService.removeSession(sessionId);
    await this.streamSessionTenantBinding.clear(sessionId);
  }

  /**
   * TASK-298 D-18 — mint a fresh single-use stream ticket for an existing
   * session. The SDK calls this from `SttV2WebSocketClient.attemptReconnect`
   * before reopening the WebSocket, since each ticket is one-shot and gets
   * consumed by the previous connection.
   */
  @Post('stream/session/:sessionId/refresh-ticket')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh the stream ticket for a live streaming session (TASK-298 D-18)' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  async refreshStreamTicket(@Param('sessionId') sessionId: string): Promise<{ ticket: string; ticketExpiresAt: number }> {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }

    const tenantId = this.getTenantId();
    const user = this.cls.get('user');

    const issued = await this.streamTicketService.issueTicket({
      userId: user?.id ?? '',
      tenantId,
      scope: `stt_session:${sessionId}`,
    });

    return { ticket: issued.ticket, ticketExpiresAt: issued.expiresAt };
  }

  @Get(':id')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Get transcription job by ID' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async getById(@Param('id') id: string) {
    const job = await this.jobService.getById(id);
    if (!job) {
      throw new NotFoundException(`Transcription job ${id} not found`);
    }
    return job;
  }

  // TASK-419 item 6 — @StreamScope lets single-use tickets from
  // POST /auth/stream-ticket (scope `transcription_job:<id>`) authenticate this
  // SSE route; the @TenantOwnedResource pre-stream tenant assertion is unchanged.
  @Get(':id/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @StreamScope({ namespace: 'transcription_job', param: 'id' })
  @ApiOperation({
    summary: 'Stream transcription job events via SSE',
    description:
      'Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by ' +
      '`POST /auth/stream-ticket` with scope `transcription_job:<id>`.',
  })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  streamJob(@Param('id') id: string): Observable<MessageEvent> {
    if (!id?.trim()) {
      throw new BadRequestException('A valid transcription job ID is required');
    }
    return this.realtimeService.subscribeToJob(id.trim());
  }

  @Post(':id/cancel')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Cancel a transcription job' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async cancel(@Param('id') id: string) {
    // EU-01 — creator-scoped: a same-tenant peer cannot cancel a job they did
    // not create. (The @TenantOwnedResource interceptor enforces the tenant
    // boundary; its creator branch resolves a `userId`, but TranscriptionJob is
    // `createdBy`-scoped, so the creator check is enforced in the service.)
    return this.jobService.cancelJobForOwner(this.getUserId(), id);
  }

  @Post(':id/retry')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Retry a failed transcription job' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async retry(@Param('id') id: string) {
    // EU-01 — creator-scoped (mirrors cancel).
    return this.jobService.retryJobForOwner(this.getUserId(), id);
  }

  @Get()
  @ApiOperation({ summary: 'List transcription jobs (paginated, caller-owned jobs)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query('page') page: number = 1, @Query('limit') limit: number = 20) {
    // TASK-319 F3 — owner-scoped: the caller's jobs only. The tenant-wide
    // listing lives on the admin surface (/admin/audio/transcription-jobs).
    return this.jobService.listForOwner(this.getUserId(), page, limit);
  }
}
