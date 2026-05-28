import type { IActiveUserContext, IS3Service as IS3ServiceType } from '@arcaai/applications';
import {
  Authorize,
  IS3Service,
  ITenantBucketService,
  PipelineService,
  StreamingSessionService,
  TranscriptionJobService,
  TranscriptionRealtimeService,
} from '@arcaai/applications';
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
import { TenantOwnedResource } from '../../common';
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
    @Inject(IS3Service) private readonly s3Service: IS3ServiceType,
    @Inject(ITenantBucketService) private readonly tenantBucketService: ITenantBucketService,
    private readonly pipelineService: PipelineService,
    private readonly streamTicketService: StreamTicketService,
  ) {}

  private getTenantId(): string {
    const user = this.cls.get('user');
    if (!user?.tenantId) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return user.tenantId;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async create(@Body() dto: any) {
    return this.jobService.create(dto);
  }

  @Post('batch')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a batch transcription job' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createBatch(@Body() dto: any) {
    return this.jobService.createBatchJob(dto);
  }

  @Post('streaming')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a streaming transcription job' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createStreaming(@Body() dto: any) {
    return this.jobService.createStreamingJob(dto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get transcription job status counts' })
  async getStats() {
    return this.jobService.getStatusCounts();
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get transcription jobs by status' })
  @ApiParam({ name: 'status', description: 'Job status filter' })
  async getByStatus(@Param('status') status: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.jobService.getByStatus(status as any);
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

    // 3. Resolve tenant bucket (prefer tenant-scoped, fallback to global)
    let uploadBucket = AUDIO_BUCKET;
    try {
      const tenantBucket = await this.tenantBucketService.getBucketBySlug('audio');
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
      // 5. Upload audio to MinIO (tenant bucket)
      await this.s3Service.putFile(uploadBucket, pathSegment, file.buffer, file.mimetype);

      this.logger.log(`Uploaded audio to ${audioUri} for job ${job.id}`);

      // 6. Dispatch Dramatiq message to stt_batch queue
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
  @ApiOperation({ summary: 'Get transcription jobs by consultation' })
  @ApiParam({ name: 'consultationId', description: 'Consultation ID' })
  async getByConsultation(@Param('consultationId') consultationId: string) {
    return this.jobService.getByConsultation(consultationId);
  }

  @Post('stream/session')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a WebSocket streaming session' })
  @ApiResponse({ status: 201, description: 'Streaming session created', type: StreamSessionResponse })
  async createStreamSession(@Body() body: CreateStreamSessionRequest): Promise<StreamSessionResponse> {
    const sessionId = uuidv7();
    const tenantId = this.getTenantId();
    const user = this.cls.get('user');

    // TASK-298 D-2 — assert tenant ownership of the requested pipeline
    // BEFORE we forward to STT-V2 (which is itself defended by D-3).
    await this.assertPipelineOwnership(body.pipelineId);

    // Resolve tenant-scoped audio bucket so STT-v2 writes audio to the
    // tenant's bucket instead of falling back to the global 'hope-audio'.
    let audioBucketName: string | undefined;
    try {
      const tenantBucket = await this.tenantBucketService.getBucketBySlug('audio');
      audioBucketName = tenantBucket?.name;
    } catch (err) {
      this.logger.warn(`Failed to resolve tenant audio bucket for streaming: ${err}`);
    }

    const sessionPayload = {
      sessionId,
      tenantId,
      pipelineId: body.pipelineId,
      consultationId: body.consultationId,
      sampleRate: body.sampleRate ?? 16000,
      language: body.language,
      userId: user?.id,
      audioBucketName,
    } as Parameters<StreamingSessionService['createSession']>[0];

    const result = await this.sessionService.createSession(sessionPayload);

    if (!result) {
      throw new ServiceUnavailableException('STT-V2 streaming service at capacity');
    }

    // TASK-298 D-1 — mint a one-shot stream ticket scoped to this session.
    // The SDK appends it to the WS URL; the gateway consumes it on first
    // open and rejects (4401) every subsequent attempt.
    const issuedTicket = await this.streamTicketService.issueTicket({
      userId: user?.id ?? '',
      tenantId,
      scope: `stt_session:${result.sessionId}`,
    });

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
   * TASK-307 W7.A.9 (carryover note from W3 review) — this endpoint takes
   * a `sessionId` (the STT-V2 streaming session, opaque to the gateway),
   * not a `jobId` (the `TranscriptionJob` row). `@TenantOwnedResource`
   * cannot be applied directly with `modelName: 'TranscriptionJob'`
   * because there is no foreign-key relationship from `sessionId`
   * back to a Prisma model — the session record lives in STT-V2 / Redis,
   * not the API gateway DB. Tenant scoping today relies on the
   * downstream `StreamingSessionService.removeSession(sessionId)` honoring
   * the Prisma `tenantScope` extension on whatever rows it touches
   * (TASK-305 W2.B extension fans tenantId out from CLS to every
   * `findMany/findFirst/update/delete`). Closing the gap end-to-end
   * needs either: (a) a dedicated `StreamSessionTenantBindingService`
   * that resolves sessionId → tenantId and runs an explicit equality
   * check, or (b) reshaping the URL to nest under `/jobs/:id/stream-
   * session/:sessionId` so the parent `jobId` carries the tenant scope.
   * Both are out of W7 scope — see §10 deferral.
   */
  @Delete('stream/session/:sessionId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Close a WebSocket streaming session' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  async closeStreamSession(@Param('sessionId') sessionId: string): Promise<void> {
    await this.sessionService.removeSession(sessionId);
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

  @Get(':id/stream')
  @Sse()
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Stream transcription job events via SSE' })
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
    return this.jobService.cancelJob(id);
  }

  @Post(':id/retry')
  @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
  @ApiOperation({ summary: 'Retry a failed transcription job' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async retry(@Param('id') id: string) {
    return this.jobService.retryJob(id);
  }

  @Get()
  @ApiOperation({ summary: 'List transcription jobs (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Query('page') page: number = 1, @Query('limit') limit: number = 20) {
    return this.jobService.list(page, limit);
  }
}
