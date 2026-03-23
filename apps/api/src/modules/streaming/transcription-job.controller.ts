import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
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
import { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';
import {
    TranscriptionJobService,
    TranscriptionRealtimeService,
    StreamingSessionService,
} from '@arcaai/applications';
import type { IActiveUserContext } from '@arcaai/applications';
import { TranscribeFileRequest, CreateStreamSessionRequest, StreamSessionResponse } from './dto';

@ApiBearerAuth()
@ApiTags('transcription-jobs')
@Controller('audio/transcription-jobs')
export class TranscriptionJobController {
    private readonly logger = new Logger(TranscriptionJobController.name);

    constructor(
        private readonly jobService: TranscriptionJobService,
        private readonly realtimeService: TranscriptionRealtimeService,
        private readonly sessionService: StreamingSessionService,
        private readonly cls: ClsService<IActiveUserContext>,
    ) {}

    private getTenantId(): string {
        try {
            const user = this.cls.get('user');
            return user?.tenantId ?? 'unknown';
        } catch {
            return 'unknown';
        }
    }

    @Post()
    @HttpCode(201)
    @ApiOperation({ summary: 'Create a transcription job' })
    async create(@Body() dto: any) {
        return this.jobService.create(dto);
    }

    @Post('batch')
    @HttpCode(201)
    @ApiOperation({ summary: 'Create a batch transcription job' })
    async createBatch(@Body() dto: any) {
        return this.jobService.createBatchJob(dto);
    }

    @Post('streaming')
    @HttpCode(201)
    @ApiOperation({ summary: 'Create a streaming transcription job' })
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
        return this.jobService.getByStatus(status as any);
    }

    @Post('transcribe')
    @HttpCode(201)
    @ApiOperation({ summary: 'Upload audio file for transcription' })
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file'))
    async transcribeFile(
        @UploadedFile() file: Express.Multer.File,
        @Body() body: TranscribeFileRequest,
    ) {
        const job = await this.jobService.createStreamingJob({
            pipelineId: body.pipelineId,
            consultationId: body.consultationId,
            language: body.language,
            codeSwitching: body.codeSwitching === 'true',
        });

        if (file?.buffer) {
            const tenantId = this.getTenantId();
            const diarization = body.diarization === 'true'
                ? true
                : body.diarization === 'false'
                    ? false
                    : undefined;
            this.processFileAsync(
                job.id,
                file,
                body.pipelineId,
                tenantId,
                body.language,
                body.codeSwitching === 'true',
                diarization,
            );
        }

        return job;
    }

    private processFileAsync(
        jobId: string,
        file: Express.Multer.File,
        pipelineId: string,
        tenantId: string,
        language?: string,
        codeSwitching?: boolean,
        diarization?: boolean,
    ) {
        const sttBaseUrl = process.env.STT_V2_URL || 'http://localhost:8861';
        const url = `${sttBaseUrl}/api/v1/transcribe`;

        const formData = new FormData();
        formData.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
        formData.append('pipeline_id', pipelineId);
        formData.append('tenant_id', tenantId);
        if (language) {
            const isoCode = language.split('-')[0].toLowerCase();
            formData.append('language', isoCode);
        }
        if (typeof codeSwitching === 'boolean') {
            formData.append('code_switching', String(codeSwitching));
        }
        if (typeof diarization === 'boolean') {
            formData.append('diarization', String(diarization));
        }

        this.logger.log(`Forwarding file to STT-v2 for job ${jobId}`);

        this.jobService.startProcessing(jobId, 'api-gateway-file-proxy')
            .then(() => fetch(url, { method: 'POST', body: formData }))
            .then(async (res) => {
                if (!res.ok) {
                    const text = await res.text().catch(() => 'Unknown error');
                    throw new Error(`STT-v2 returned ${res.status}: ${text}`);
                }
                const result = await res.json();
                const transcriptionText = result.text || result.transcription || JSON.stringify(result);

                const segments = result.metadata?.per_segment_results;
                if (Array.isArray(segments)) {
                    for (const seg of segments) {
                        if (seg.text && !seg.text.match(/^[!?.\s]+$/)) {
                            const speakerId = (
                                seg.speaker
                                ?? seg.speakerId
                                ?? seg.speaker_id
                            ) as string | undefined;
                            const rawSpeakerConfidence = (
                                seg.speakerConfidence
                                ?? seg.speaker_confidence
                            ) as number | string | undefined;
                            const speakerConfidence = typeof rawSpeakerConfidence === 'number'
                                ? rawSpeakerConfidence
                                : typeof rawSpeakerConfidence === 'string'
                                    ? Number.parseFloat(rawSpeakerConfidence)
                                    : undefined;
                            const speakerLabel = (
                                seg.speakerLabel
                                ?? seg.speaker_label
                            ) as string | undefined;
                            await this.realtimeService.emitTranscriptEvent(jobId, {
                                type: 'transcript',
                                text: seg.text.trim(),
                                isFinal: true,
                                ...(speakerId ? { speaker: speakerId, speakerId } : {}),
                                ...(speakerLabel ? { speakerLabel } : {}),
                                ...(typeof speakerConfidence === 'number' && Number.isFinite(speakerConfidence)
                                    ? { speakerConfidence }
                                    : {}),
                            });
                        }
                    }
                } else {
                    await this.realtimeService.emitTranscriptEvent(jobId, {
                        type: 'transcript',
                        text: transcriptionText,
                        isFinal: true,
                    });
                }

                await this.realtimeService.emitCompleteEvent(jobId);
                await this.jobService.completeJob(jobId, transcriptionText);
            })
            .catch(async (err) => {
                this.logger.error(`File transcription failed for job ${jobId}: ${err.message}`);
                await this.realtimeService.emitErrorEvent(jobId, err.message).catch(() => {});
                await this.jobService.failJob(jobId, err.message, 'TRANSCRIPTION_ERROR').catch(() => {});
            });
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
    async createStreamSession(
        @Body() body: CreateStreamSessionRequest,
    ) {
        const sessionId = uuidv7();
        const tenantId = this.getTenantId();

        const result = await this.sessionService.createSession({
            sessionId,
            tenantId,
            pipelineId: body.pipelineId,
            consultationId: body.consultationId,
            sampleRate: body.sampleRate ?? 16000,
            language: body.language,
            codeSwitching: body.codeSwitching,
            diarization: body.diarization,
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
        return this.realtimeService.subscribeToJob(id);
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
    async list(
        @Query('page') page: number = 1,
        @Query('limit') limit: number = 20,
    ) {
        return this.jobService.list(page, limit);
    }
}
