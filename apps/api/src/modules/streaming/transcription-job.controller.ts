import type { IActiveUserContext, IS3Service as IS3ServiceType } from '@arcaai/applications';
import {
  Authorize,
  IS3Service,
  ITenantBucketService,
  StreamingSessionService,
  TranscriptionJobService,
  TranscriptionRealtimeService,
} from '@arcaai/applications';
import { SYSTEM_BUCKET_SLUGS } from '@arcaai/domains';
import type { MessageEvent } from '@nestjs/common';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
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

  constructor(
    private readonly jobService: TranscriptionJobService,
    private readonly realtimeService: TranscriptionRealtimeService,
    private readonly sessionService: StreamingSessionService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Inject(IS3Service) private readonly s3Service: IS3ServiceType,
    @Inject(ITenantBucketService) private readonly tenantBucketService: ITenantBucketService,
  ) {}

  private getTenantId(): string {
    const user = this.cls.get('user');
    if (!user?.tenantId) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return user.tenantId;
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
      const tenantBucket = await this.tenantBucketService.getBucketBySlug(SYSTEM_BUCKET_SLUGS.AUDIO);
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
      await this.realtimeService.dispatchDramatiqJob({
        jobId: job.id,
        tenantId,
        pipelineId: body.pipelineId,
        audioUri,
        consultationId: body.consultationId,
        mediaId,
        userId: user?.id,
      });
    } catch (error) {
      // If upload or dispatch fails, mark the job as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch transcription setup failed for job ${job.id}: ${errorMessage}`);
      await this.jobService.failJob(job.id, errorMessage, 'SETUP_ERROR').catch(() => {});
      throw error;
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
  async createStreamSession(@Body() body: CreateStreamSessionRequest) {
    const sessionId = uuidv7();
    const tenantId = this.getTenantId();
    const user = this.cls.get('user');

    const result = await this.sessionService.createSession({
      sessionId,
      tenantId,
      pipelineId: body.pipelineId,
      consultationId: body.consultationId,
      sampleRate: body.sampleRate ?? 16000,
      userId: user?.id,
    });

    if (!result) {
      throw new ServiceUnavailableException('STT-V2 streaming service at capacity');
    }

    return {
      sessionId: result.sessionId,
      status: result.status,
      wsUrl: '/ws/stt-v2/stream',
      maxConcurrent: result.maxConcurrent,
      currentActive: result.currentActive,
    };
  }

  @Delete('stream/session/:sessionId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Close a WebSocket streaming session' })
  @ApiParam({ name: 'sessionId', description: 'Streaming session ID' })
  async closeStreamSession(@Param('sessionId') sessionId: string): Promise<void> {
    await this.sessionService.removeSession(sessionId);
  }

  @Get(':id')
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
  @ApiOperation({ summary: 'Stream transcription job events via SSE' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  streamJob(@Param('id') id: string): Observable<MessageEvent> {
    if (!id?.trim()) {
      throw new BadRequestException('A valid transcription job ID is required');
    }
    return this.realtimeService.subscribeToJob(id.trim());
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a transcription job' })
  @ApiParam({ name: 'id', description: 'Transcription job ID' })
  async cancel(@Param('id') id: string) {
    return this.jobService.cancelJob(id);
  }

  @Post(':id/retry')
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
