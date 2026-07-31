import type {
  IActiveUserContext,
  IBlobStorageService as IBlobStorageServiceType,
  StorageDescriptor,
  SttLanguageModeCatalog,
} from '@arcaai/applications';
import {
  Authorize,
  CreateBatchJobRequest,
  CreateJobRequest,
  CreateStreamingJobRequest,
  IBlobStorageService,
  IEntitlementsService,
  ITenantBucketService,
  ITenantSttConfigService,
  PipelineService,
  StreamingSessionService,
  TranscriptionJobService,
  TranscriptionRealtimeService,
} from '@arcaai/applications';
import type { SttProviderOverrides } from '@arcaai/applications';
import { TenantBucketPurpose } from '@arcaai/domains';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { StreamTicketService } from '../auth/stream-ticket.service';
import type { MessageEvent } from '@nestjs/common';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
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
    // Persists sessionId → tenantId on create
    // and clears it on close, so the `@TenantOwnedResource('StreamSession')`
    // route guard on `closeStreamSession` can 404 cross-tenant probes.
    private readonly streamSessionTenantBinding: StreamSessionTenantBindingService,
    // Hard-blocks a new streaming session when the
    // caller's tenant is at/over its resolved `maxConcurrentSessions` (no-op
    // while the entitlements kill-switch is OFF).
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    // Resolves the caller tenant's STT fallback spec + BYO provider overrides
    // (TASK-567). Optional so positional test construction still works and a
    // stack without the module degrades gracefully; injection is fail-open.
    @Optional() @Inject(ITenantSttConfigService) private readonly sttConfig?: ITenantSttConfigService,
  ) {}

  private getTenantId(): string {
    const user = this.cls.get('user');
    if (!user?.tenantId) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return user.tenantId;
  }

  /**
   * The caller's identity, used to owner-scope the end-user
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
   * Assert the caller's tenant owns `pipelineId` before the
   * controller forwards work to STT. We translate cross-tenant pipelines
   * to `NotFoundException` so the error surface matches "unknown pipeline"
   * and we do not leak the existence of pipelines in other tenants.
   */
  private async assertPipelineOwnership(pipelineId: string): Promise<void> {
    const pipeline = await this.pipelineService.getById(pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${pipelineId} not found`);
    }
  }

  /**
   * Resolve the tenant's effective fallback pipeline + decrypted BYO provider
   * overrides for a new streaming session (TASK-567). FAIL-OPEN: any resolve or
   * decrypt error (or an unwired config service) yields no overrides and no
   * fallback so the session is still created on platform env creds — a broken
   * BYO key must never block transcription. The decrypted overrides are handed
   * straight to the session payload and NEVER logged here.
   */
  private async resolveSttFallbackConfig(tenantId: string): Promise<{ providerOverrides?: SttProviderOverrides; fallbackPipelineId?: string }> {
    if (!this.sttConfig) {
      return {};
    }
    try {
      const [effective, overrides] = await Promise.all([this.sttConfig.getEffective(tenantId), this.sttConfig.resolveProviderOverrides(tenantId)]);
      return {
        providerOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        fallbackPipelineId: effective.fallbackPipelineId ?? undefined,
      };
    } catch (err) {
      this.logger.warn({
        message: 'Tenant STT config resolve failed; creating session without fallback/overrides',
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
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
    // Owner-scoped: the caller's jobs only.
    return this.jobService.getStatusCountsForOwner(this.getUserId());
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get transcription jobs by status (caller-owned jobs)' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // Owner-scoped: the caller's jobs only.
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
    // Block cross-tenant pipeline use before any I/O.
    await this.assertPipelineOwnership(body.pipelineId);
    const mediaId = uuidv7();

    // 2. Create batch job in DB (status: QUEUED)
    const job = await this.jobService.createBatchJob({
      pipelineId: body.pipelineId,
      mediaId,
      consultationId: body.consultationId,
    });

    // 3. Resolve the tenant's default audio bucket: configured purpose →
    //    `recordings` slug (default) → legacy `audio` slug → global
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

  @Get('language-modes')
  @ApiOperation({ summary: 'List selectable STT language modes + per-mode supported engines (TASK-587)' })
  @ApiResponse({ status: 200, description: 'Language-mode catalog' })
  async getLanguageModes(): Promise<SttLanguageModeCatalog> {
    // Backend-authoritative catalog (STT owns the capability matrix). Read-only,
    // not tenant-scoped; the class-level `@Authorize()` gate is sufficient.
    return this.sessionService.getLanguageModes();
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

    // HARD-BLOCK a new session when the tenant is at/
    // over its resolved `maxConcurrentSessions` (live socket-registry count).
    // Runs before any STT / bucket I/O so an over-capacity caller is rejected
    // early with a typed 429. No-op while the entitlements kill-switch is OFF.
    await this.entitlements.assertConcurrencyQuota(tenantId);

    // Assert tenant ownership of the requested pipeline
    // BEFORE we forward to STT (which is itself defended downstream).
    // The ownership check and the bucket resolution are
    // independent reads, so they run in parallel; a rejected ownership check
    // still rejects the whole step before anything is forwarded to STT.
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

    // Resolve the tenant's STT fallback pointer + decrypted BYO provider
    // overrides and forward both to the session runtime (TASK-567 D-3). Fails
    // OPEN: a config/decrypt error creates the session WITHOUT overrides or a
    // fallback (transcription proceeds on platform env creds) — never a 500.
    const { providerOverrides, fallbackPipelineId } = await this.resolveSttFallbackConfig(tenantId);

    const sessionPayload = {
      sessionId,
      tenantId,
      pipelineId: body.pipelineId,
      consultationId: body.consultationId,
      sampleRate,
      language: body.language,
      languageMode: body.languageMode,
      userId: user?.id,
      audioBucketName,
      storage,
      ...(providerOverrides ? { providerOverrides } : {}),
      ...(fallbackPipelineId ? { fallbackPipelineId } : {}),
    } as Parameters<StreamingSessionService['createSession']>[0];

    const result = await this.sessionService.createSession(sessionPayload);

    if (!result) {
      throw new ServiceUnavailableException('STT streaming service at capacity');
    }

    // Three independent writes (parallelized):
    //  - Persist the sessionId → tenantId mapping so
    //    the global `TenantOwnedResourceInterceptor` can 404 cross-tenant
    //    probes against `DELETE /stream/session/:sessionId`. Default 24h TTL
    //    matches the longest reasonable streaming-session lifetime.
    //  - Persist session meta (negotiated sampleRate) so
    //    the WS gateway forwards audio at the real rate, not hardcoded 16000.
    //  - Mint a one-shot stream ticket scoped to this session.
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

    // Preseed contract — capture voiceProfileSeeded if the
    // streaming service surfaces it.
    const voiceProfileSeeded = (result as unknown as { voiceProfileSeeded?: boolean }).voiceProfileSeeded ?? false;

    return {
      sessionId: result.sessionId,
      status: result.status,
      wsUrl: '/ws/stt/stream',
      maxConcurrent: result.maxConcurrent,
      currentActive: result.currentActive,
      ticket: issuedTicket.ticket,
      ticketExpiresAt: issuedTicket.expiresAt,
      voiceProfileSeeded,
    };
  }

  /**
   * Because `sessionId` is opaque to Prisma (the STT session row lives in
   * STT / Redis, not the gateway DB), `@TenantOwnedResource` cannot use
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
   *     the live SDK contract.
   *   - Modify STT to return `tenantId` on its status endpoint.
   *     Out of scope — touches `apps/stt` (sibling Python service).
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
   * Mint a fresh single-use stream ticket for an existing
   * session. The SDK calls this from `SttWebSocketClient.attemptReconnect`
   * before reopening the WebSocket, since each ticket is one-shot and gets
   * consumed by the previous connection.
   *
   * This is the second `stt_session:<sessionId>` mint (the
   * first is `POST /auth/stream-ticket`), so it carries the same
   * `StreamSession` ownership guard as the sibling DELETE route: the
   * interceptor 404s any caller whose tenant doesn't match the session's
   * binding (no existence leak), keeping mint + WS handshake two
   * independent gates on this path too.
   */
  @Post('stream/session/:sessionId/refresh-ticket')
  @HttpCode(200)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Refresh the stream ticket for a live streaming session' })
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

  /**
   * Manual mid-session switch to the tenant's fallback pipeline (TASK-567 R4) —
   * the end-user "I don't want this provider" affordance. Guarded exactly like
   * `closeStreamSession` (`@TenantOwnedResource` 404s cross-tenant probes with no
   * existence leak). Fail-CLOSED on selection: a tenant with no fallback
   * configured gets a 409 (never a silent no-op). The seamless swap itself runs
   * in apps/stt's `EngineSwitchController`; a 409 from there (already on
   * fallback) is surfaced as a 409, a 404 (unknown session) as a 404.
   */
  @Post('stream/session/:sessionId/switch-to-fallback')
  @HttpCode(200)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Switch a live streaming session to the tenant fallback pipeline' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  @ApiResponse({ status: 200, description: 'Switch requested; the session continues on the fallback engine.' })
  @ApiResponse({ status: 409, description: 'No fallback configured for the tenant, or the session is already on the fallback.' })
  async switchStreamSessionToFallback(@Param('sessionId') sessionId: string): Promise<{ switched: true }> {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }
    const tenantId = this.getTenantId();

    // Fail-closed selection guard: the tenant must have a fallback configured.
    if (this.sttConfig) {
      const effective = await this.sttConfig.getEffective(tenantId);
      if (!effective.fallbackPipelineId) {
        throw new ConflictException('No fallback pipeline configured for this tenant');
      }
    }

    try {
      await this.sessionService.switchToFallback(sessionId);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        throw new ConflictException('Session is already on the fallback pipeline, or no fallback is available');
      }
      if (status === 404) {
        throw new NotFoundException(`Streaming session ${sessionId} not found`);
      }
      throw err;
    }
    return { switched: true };
  }

  /**
   * Manual mid-session switch BACK to the SDK-configured primary pipeline
   * (TASK-586 Lane H) — the primary-direction counterpart of
   * `switchStreamSessionToFallback`, so native SDK consumers get a 2-way
   * pipeline↔default toggle. Guarded exactly like `closeStreamSession`
   * (`@TenantOwnedResource` 404s cross-tenant probes with no existence leak).
   * No fallback-config precheck applies here — that is a fallback-direction
   * concern; the primary pipeline is whatever the session was created with.
   * The seamless swap runs in apps/stt's `EngineSwitchController`; a 409 from
   * there (already on primary / the primary engine was never loaded) is
   * surfaced as a 409, a 404 (unknown session) as a 404.
   */
  @Post('stream/session/:sessionId/switch-to-primary')
  @HttpCode(200)
  @TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })
  @ApiOperation({ summary: 'Switch a live streaming session back to its primary pipeline' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  @ApiResponse({ status: 200, description: 'Switch requested; the session continues on the primary engine.' })
  @ApiResponse({ status: 409, description: 'The session is already on the primary pipeline, or the primary engine was never loaded.' })
  async switchStreamSessionToPrimary(@Param('sessionId') sessionId: string): Promise<{ switched: true }> {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required');
    }

    try {
      await this.sessionService.switchProvider(sessionId, 'primary');
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        throw new ConflictException('Session is already on the primary pipeline, or the primary engine is not available');
      }
      if (status === 404) {
        throw new NotFoundException(`Streaming session ${sessionId} not found`);
      }
      throw err;
    }
    return { switched: true };
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

  // @StreamScope lets single-use tickets from
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
    // Owner-scoped: the caller's jobs only. The tenant-wide
    // listing lives on the admin surface (/admin/audio/transcription-jobs).
    return this.jobService.listForOwner(this.getUserId(), page, limit);
  }
}
