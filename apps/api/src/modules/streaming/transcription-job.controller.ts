import type {
  IActiveUserContext,
  IBlobStorageService as IBlobStorageServiceType,
  StorageDescriptor,
  SttLanguageModeCatalog,
} from '@arcaai/applications';
import {
  Authorize,
  BATCH_TRANSCRIPTION_DEFAULTS,
  BatchTranscriptionLimitsService,
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
import { probeAudioDurationSeconds } from './audio-duration';
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
  HttpStatus,
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
  BatchTranscriptionLimitsResponse,
  CreateStreamSessionRequest,
  MAX_UPLOAD_HARD_CEILING,
  SttFallbackProviderResponse,
  StreamSessionResponse,
  TranscribeFileRequest,
} from './dto';
import { RequiredScopes, RequiredSvcScopes } from '../../decorators';

@ApiBearerAuth()
@Authorize()
@ApiTags('transcription-jobs')
@Controller('audio/transcription-jobs')
// TASK-742: the STT job surface the gateway conformance review named as
// reachable with no authorization check at all (21 routes, 0 scopes). ONE
// class-level scope, deliberately the STRONGER of the declared `stt:*` pair —
// the same coarse-grained choice TASK-708 made for `/admin/*`: a uniformly
// scoped class is mechanically exhaustive, where a per-verb read/write split
// across 20 methods risks leaving one silently ungated. Splitting the GETs onto
// `stt:transcription:read` is a precision follow-up, never a widening.
@RequiredScopes('stt:transcription:write')
// TASK-767 — the standalone speech-to-text feature, reachable by the THIRD
// credential class as well. The `svc:` scope is renamespaced from the very
// `stt:transcription:write` above (`STANDALONE_FEATURE_SCOPE_SOURCES`), so a
// machine identity reaches exactly the routes a scoped tenant key does.
//
// SVC-NOTE — four routes on this class stay 404 for a machine, BY DESIGN.
// `stream/session/:sessionId/{DELETE,refresh-ticket,switch-to-fallback,
// switch-to-primary}` carry `@TenantOwnedResource('StreamSession')`, whose
// `assertStreamSessionOwnership` requires a CLS `user.id` and compares it to
// the session's owning clinician (TASK-754, fail-closed on an ownerless
// binding). A service-account principal deliberately sets no CLS `user` — the
// whole point of the class is that a machine's actions are not recorded against
// a person — so it can never satisfy that check, and the WS handshake refuses
// the socket for the same reason (`stt-ws.gateway.ts`: ticket user must equal
// the binding owner). Creating a session and driving BATCH transcription work;
// the live WebSocket lifecycle does not. Giving machines an owner identity is
// an owner decision, recorded in the TASK-767 README, not something to paper
// over here.
@RequiredSvcScopes('svc:stt:transcription:write')
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
    /** Tenant fallback pipeline the worker re-runs on if the primary ASR fails. */
    fallbackPipelineId?: string;
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
    // . Optional so positional test construction still works and a
    // stack without the module degrades gracefully; injection is fail-open.
    @Optional() @Inject(ITenantSttConfigService) private readonly sttConfig?: ITenantSttConfigService,
    // Resolves the admin-configurable `stt.batch.*` ceilings.
    // Optional so positional test construction and a stack without the settings
    // module still work — the ceilings then apply at their CODE DEFAULTS. The
    // limit is never SKIPPED when this is absent, only made non-configurable.
    @Optional() private readonly batchLimits?: BatchTranscriptionLimitsService,
  ) {}

  /**
   * The effective batch ceilings for the caller's tenant, or the code defaults
   * when the resolver is not wired. Never throws — see
   * `BatchTranscriptionLimitsService` for why these fail open.
   */
  private async resolveBatchLimits(tenantId: string) {
    return (await this.batchLimits?.resolve(tenantId)) ?? { ...BATCH_TRANSCRIPTION_DEFAULTS };
  }

  /**
   * Refuse a new batch job when the caller already holds `maxActive` in flight.
   * QUEUED + PROCESSING are the only in-flight states — finished, failed and
   * cancelled jobs never consume a slot, however many of them there are.
   *
   * 429 (not 409): this is "too much at once, retry later", and it is what the
   * SDK's queue backs off on.
   */
  private async assertBatchConcurrency(maxActive: number): Promise<void> {
    const counts = await this.jobService.getStatusCountsForOwner(this.getUserId());
    const inFlight = (counts?.queued ?? 0) + (counts?.processing ?? 0);
    if (inFlight >= maxActive) {
      throw new HttpException(
        `You already have ${inFlight} transcription job(s) in progress (maximum ${maxActive}). Wait for one to finish before uploading another.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The caller's ACTIVE tenant, resolved in the canonical order used
   * everywhere else in the gateway — `ClsTenantContextProvider.getTenantId()`
   * (`src/database/tenant-context.provider.ts`) and the sibling admin
   * controllers: the CLS `tenantId` key FIRST, then the JWT-derived identity.
   *
   * The `tenantId` key is where `ContextInterceptor` elevates a SUPER_ADMIN's
   * selected working tenant from the `x-tenant-id` header; a super admin's own
   * JWT carries `tenantId: ''`, so reading `user.tenantId` alone rejected every
   * super-admin caller with a 400 (BUG-012). `??` (not `||`) matches the
   * provider exactly, and the explicit length check keeps an empty-string claim
   * from leaking through as a tenant — a caller with no active tenant still
   * fails closed here.
   *
   * No new trust is granted: the only way the CLS `tenantId` diverges from
   * `user.tenantId` is that audited super-admin elevation, which
   * `resolveActiveTenant` already restricts to elevated callers with an empty
   * JWT tenant and a well-formed UUID (a forged header from a tenant-bound
   * caller is rejected as 400 before the handler runs).
   */
  private getTenantId(): string {
    const active = this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId;
    if (!active || active.length === 0) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return active;
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
   * The pipeline to use when a batch request names none (D11).
   *
   * Order: the pipeline the tenant marked default, then the configured STT
   * fallback. Both absent ⇒ 409 rather than a guess — running a consultation
   * through an arbitrary engine is worse than refusing, and picking
   * `pipelines[0]` would make the engine depend on row order.
   */
  private async resolveDefaultPipelineId(fallbackPipelineId?: string): Promise<string> {
    const pipelines = await this.pipelineService.getAll();
    const tenantDefault = pipelines.find((pipeline) => pipeline.isDefault);
    const resolved = tenantDefault?.id ?? fallbackPipelineId;
    if (!resolved) {
      throw new ConflictException(
        'No pipelineId was supplied and this tenant has no default STT pipeline (and no configured fallback). ' +
          'Mark a pipeline as default, configure an STT fallback, or pass pipelineId explicitly.',
      );
    }
    return resolved;
  }

  /**
   * Resolve the tenant's effective fallback pipeline + decrypted BYO provider
   * overrides for a new streaming session. FAIL-OPEN: any resolve or
   * decrypt error (or an unwired config service) yields no overrides and no
   * fallback so the session is still created on platform env creds — a broken
   * BYO key must never block transcription. The decrypted overrides are handed
   * straight to the session payload and NEVER logged here.
   */
  private async resolveSttFallbackConfig(tenantId: string): Promise<{
    providerOverrides?: SttProviderOverrides;
    fallbackPipelineId?: string;
    autoSwitchEnabled?: boolean;
    consecutiveFailureThreshold?: number;
  }> {
    if (!this.sttConfig) {
      return {};
    }
    try {
      const [effective, overrides] = await Promise.all([this.sttConfig.getEffective(tenantId), this.sttConfig.resolveProviderOverrides(tenantId)]);
      return {
        providerOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        fallbackPipelineId: effective.fallbackPipelineId ?? undefined,
        // The governance half of the same resolved config. It was
        // read here and then dropped, so STT never learned that a tenant had
        // turned auto-fallback off.
        autoSwitchEnabled: effective.autoSwitchEnabled ?? undefined,
        consecutiveFailureThreshold: effective.consecutiveFailureThreshold ?? undefined,
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
  @ApiResponse({ status: 400, description: 'Missing/unsupported file, file too large, or a recording over the duration ceiling.' })
  @ApiResponse({ status: 429, description: 'The caller already holds the maximum number of in-flight batch jobs.' })
  // The interceptor limit is a STATIC hard ceiling — a decorator cannot read a
  // per-tenant setting. The admin-configurable `stt.batch.maxFileSizeMb` is
  // enforced in the handler below; this only stops a multi-GB body from being
  // buffered before that check can run.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_HARD_CEILING } }))
  async transcribeFile(@UploadedFile() file: Express.Multer.File, @Body() body: TranscribeFileRequest): Promise<BatchTranscribeResponse> {
    // 1. Validate file
    if (!file?.buffer) {
      throw new BadRequestException('Audio file is required');
    }
    if (!ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported audio type: ${file.mimetype}`);
    }

    const tenantId = this.getTenantId();

    // 1b. Admin-configurable ceilings. Every rejection below happens
    // BEFORE object storage, the job row, and the worker dispatch — an upload
    // that is going to be refused must not cost a 200 MB write first. These run
    // ahead of pipeline resolution (1c) for the same reason: they are pure
    // in-process checks, so a refused upload never costs a DB round-trip.
    const limits = await this.resolveBatchLimits(tenantId);

    const maxBytes = limits.maxFileSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new BadRequestException(`File size ${(file.size / (1024 * 1024)).toFixed(1)} MB exceeds the maximum of ${limits.maxFileSizeMb} MB`);
    }

    // DURATION is the requirement ("each recording at most 60 minutes"); size is
    // only a proxy for it. Read from the container header, never from the
    // client-declared MIME type.
    const durationSeconds = probeAudioDurationSeconds(file.buffer, file.mimetype);
    if (durationSeconds === null) {
      // FAIL-CLOSED (owner decision): a duration that cannot be
      // established is not evidence of a recording within the limit. Typically a
      // live/streamed capture whose container never recorded its own length.
      throw new BadRequestException(
        `Could not determine the duration of ${file.originalname || 'the uploaded file'}. ` +
          `Re-export it with duration metadata (for example as WAV, FLAC, MP3 or M4A) and upload again.`,
      );
    }
    const durationMinutes = durationSeconds / 60;
    if (durationMinutes > limits.maxDurationMinutes) {
      throw new BadRequestException(
        `Recording is ${durationMinutes.toFixed(1)} min long, which exceeds the maximum of ${limits.maxDurationMinutes} min`,
      );
    }

    // In-flight cap — the server-side counterpart of the client's per-batch
    // limit. Without it "5 per batch" is bypassed by sending five batches.
    await this.assertBatchConcurrency(limits.maxActiveJobsPerUser);

    // 1c. Resolve the pipeline. `pipelineId` is optional since : omitting
    //     it means "use the tenant's default", the same intent a live session has
    //     always been able to express. Resolution order — the pipeline the tenant
    //     marked default, then the configured STT fallback. If the tenant has
    //     neither, REFUSE: transcribing a consultation on an arbitrary engine is
    //     worse than a clear error.
    const { fallbackPipelineId } = await this.resolveSttFallbackConfig(tenantId);
    const pipelineId = body.pipelineId ?? (await this.resolveDefaultPipelineId(fallbackPipelineId));

    // Block cross-tenant pipeline use before any I/O.
    await this.assertPipelineOwnership(pipelineId);
    const mediaId = uuidv7();

    // 2. Create batch job in DB (status: QUEUED)
    const job = await this.jobService.createBatchJob({
      pipelineId,
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

      // 7. Dispatch Dramatiq message to stt_batch queue. `fallbackPipelineId`
      //    (resolved above) lets a cloud-ASR/model failure in the worker re-run
      // on the tenant fallback instead of failing the job:
      // `transcribe_file` has accepted it, but nothing ever
      //    supplied it, so the whole batch-fallback path was unreachable.
      const user = this.cls.get('user');
      await this.dispatchBatchJob({
        jobId: job.id,
        tenantId,
        pipelineId,
        audioUri,
        consultationId: body.consultationId,
        mediaId,
        language: body.language,
        userId: user?.id,
        audioBucketName: uploadBucket,
        storage,
        ...(fallbackPipelineId ? { fallbackPipelineId } : {}),
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

  /**
   * The batch ceilings a client must respect. Read-only, non-admin,
   * and declared BEFORE `@Get(':id')` so the literal path is not parsed as a job
   * id. Exists so the SDK enforces the SAME numbers the gateway does instead of
   * hardcoding "5" and "60" a second time — an operator who lowers a knob moves
   * both sides at once.
   */
  @Get('limits')
  @ApiOperation({ summary: 'Batch upload ceilings (recordings per batch, minutes per recording, size, in-flight jobs)' })
  @ApiResponse({ status: 200, description: 'Effective batch limits for the caller’s tenant' })
  async getBatchLimits(): Promise<BatchTranscriptionLimitsResponse> {
    const limits = await this.resolveBatchLimits(this.getTenantId());
    return {
      maxFilesPerBatch: limits.maxFilesPerBatch,
      maxDurationMinutes: limits.maxDurationMinutes,
      maxFileSizeBytes: limits.maxFileSizeMb * 1024 * 1024,
      maxActiveJobsPerUser: limits.maxActiveJobsPerUser,
      allowedMimeTypes: [...ALLOWED_AUDIO_MIMES],
    };
  }

  /**
   * The tenant's configured STT fallback provider.
   *
   * The live pipeline↔default toggle previously had no way to NAME the target
   * or to know whether one exists — a user only found out by switching
   * mid-consultation and taking the 409 from `switch-to-fallback`. This is the
   * read that lets the SDK label the control and disable it up front.
   *
   * Degrades to `configured: false` on ANY resolve failure: this is a labelling
   * aid, and a settings outage must not turn it into a 500 on a live session.
   * It exposes only the pipeline's id and name — never credential material.
   */
  @Get('fallback')
  @ApiOperation({ summary: 'The tenant’s configured STT fallback pipeline, for the live provider toggle' })
  @ApiResponse({ status: 200, description: 'Fallback pipeline pointer (configured flag + id + display name)' })
  async getFallbackProvider(): Promise<SttFallbackProviderResponse> {
    const notConfigured: SttFallbackProviderResponse = { configured: false, pipelineId: null, pipelineName: null };
    if (!this.sttConfig) return notConfigured;

    try {
      const effective = await this.sttConfig.getEffective(this.getTenantId());
      const pipelineId = effective?.fallbackPipelineId ?? null;
      if (!pipelineId) return notConfigured;

      // A pointer to a deleted/cross-tenant pipeline is NOT a usable fallback,
      // so it reports unconfigured while still naming the stale id for support.
      const pipeline = await this.pipelineService.getById(pipelineId).catch(() => null);
      if (!pipeline) return { configured: false, pipelineId, pipelineName: null };

      return { configured: true, pipelineId, pipelineName: pipeline.name ?? null };
    } catch (err) {
      this.logger.warn({
        message: 'Fallback pipeline lookup failed; reporting not-configured',
        error: err instanceof Error ? err.message : String(err),
      });
      return notConfigured;
    }
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
    // overrides and forward both to the session runtime. Fails
    // OPEN: a config/decrypt error creates the session WITHOUT overrides or a
    // fallback (transcription proceeds on platform env creds) — never a 500.
    const { providerOverrides, fallbackPipelineId, autoSwitchEnabled, consecutiveFailureThreshold } = await this.resolveSttFallbackConfig(tenantId);

    // Pre-start default-provider selection. Fail-closed: opening
    // directly on the fallback engine requires a resolved fallback pipeline —
    // never silently start on primary (mirrors the C3 switch guard).
    if (body.startOn === 'fallback' && !fallbackPipelineId) {
      throw new ConflictException('No fallback pipeline configured for this tenant');
    }

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
      // Spread on `!== undefined`, NOT truthiness — `false` is the whole point
      // of `autoSwitchEnabled`, and a truthy guard would drop
      // exactly the tenant choice that matters.
      ...(autoSwitchEnabled !== undefined ? { autoSwitchEnabled } : {}),
      ...(consecutiveFailureThreshold !== undefined ? { consecutiveFailureThreshold } : {}),
      ...(body.startOn ? { startOn: body.startOn } : {}),
      // Dual-/multi-mic source count for STT usage repricing.
      ...(body.channelCount !== undefined ? { channelCount: body.channelCount } : {}),
    } as Parameters<StreamingSessionService['createSession']>[0];

    const result = await this.sessionService.createSession(sessionPayload);

    if (!result) {
      throw new ServiceUnavailableException('STT streaming service at capacity');
    }

    // Three independent writes (parallelized):
    //  - Persist the sessionId → { tenantId, userId } mapping so
    //    the global `TenantOwnedResourceInterceptor` can 404 cross-tenant AND
    //    cross-user probes against `DELETE /stream/session/:sessionId` and its
    //    siblings. Default 24h TTL matches the longest reasonable
    //    streaming-session lifetime.
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
      // The binding records the OWNING USER as well as the tenant: a live
      // session belongs to one clinician, and every gate downstream (ticket
      // mint, refresh-ticket, WS handshake, close/switch) compares against it.
      this.streamSessionTenantBinding.bind(result.sessionId, tenantId, user?.id ?? null),
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
      // The RESOLVED baseline. Spread only when STT echoed it, so an
      // older STT yields an unchanged response rather than null fields the SDK
      // would have to distinguish from "opened on primary".
      ...(result.pipelineId ? { pipelineId: result.pipelineId } : {}),
      ...(result.activeEngine ? { activeEngine: result.activeEngine } : {}),
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
    // TASK-737: the CLS tenant this route already authorised against is the
    // session's owner — thread it so the internal DELETE is attributable.
    await this.sessionService.removeSession(sessionId, false, this.getTenantId());
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
   * Manual mid-session switch to the tenant's fallback pipeline
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
      await this.sessionService.switchToFallback(sessionId, tenantId);
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
   * the primary-direction counterpart of
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
      await this.sessionService.switchProvider(sessionId, 'primary', this.getTenantId());
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
