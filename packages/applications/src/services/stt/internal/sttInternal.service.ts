import {
    AudioRecordingFactory,
    AudioRecordingRepository,
    ContextItemFactory,
    ContextItemRepository,
    ContextItemSource,
    ContextItemType,
    MediaFactory,
    MediaRepository,
    ResourceType,
    SysEventType,
    TranscriptionJobRepository,
} from '@arcaai/domains';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ConsultationPipelineEvent, TranscriptionCreatedPayload } from '../../consultation/events';
import { TranscriptionJobResponse } from '../job/dto';
import { TranscriptionJobDtoMapper } from '../job/transcriptionJob.dto.mapper';
import { ISttInternalService } from './ISttInternalService';
import {
    AudioRecordResponse,
    CreateAudioRecordRequest,
    CreateTranscriptRequest,
    InternalCompleteJobRequest,
    InternalFailJobRequest,
    InternalStartJobRequest,
    InternalUpdateProgressRequest,
} from './dto';

@Injectable()
export class SttInternalService extends BaseService implements ISttInternalService {
  constructor(
    private readonly jobRepository: TranscriptionJobRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly mediaRepository: MediaRepository,
    private readonly audioRecordingRepository: AudioRecordingRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TranscriptionJob);
  }

  /**
   * Create a transcript context item from completed transcription
   */
  async createTranscript(dto: CreateTranscriptRequest): Promise<{ contextItemId: string }> {
    // Find the job
    const job = await this.jobRepository.findById(dto.jobId);
    if (!job) {
      throw new NotFoundException(`Job ${dto.jobId} not found`);
    }

    // Determine consultation ID
    const consultationId = dto.consultationId || job.consultationId;
    if (!consultationId) {
      throw new BadRequestException('Consultation ID is required to create transcript');
    }

    // Create context item for the transcript
    const contextItem = ContextItemFactory.CreateContextItem({
      tenantId: job.tenantId || undefined,
      consultationId,
      type: ContextItemType.TRANSCRIPT,
      source: ContextItemSource.TRANSCRIPTION,
      content: dto.transcriptText,
      createdBy: job.createdBy || undefined,
    });

    const savedContextItem = await this.contextItemRepository.create(contextItem);

    // Update job with context item ID
    job.setContextItem(savedContextItem.id);
    await this.jobRepository.update(dto.jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContextItem.id,
      responsibleEntityId: job.createdBy || undefined,
      data: {
        type: 'TRANSCRIPT',
        jobId: dto.jobId,
        consultationId,
      },
    });

    // Emit pipeline event to trigger auto-summary → auto-NER (GAP-1)
    this.eventEmitter.emit(ConsultationPipelineEvent.TranscriptionCreated, {
      consultationId,
      tenantId: job.tenantId || '',
      userId: job.createdBy || undefined,
      timestamp: new Date().toISOString(),
      contextItemId: savedContextItem.id,
      jobId: dto.jobId,
      wordCount: dto.transcriptText ? dto.transcriptText.split(/\s+/).filter(Boolean).length : undefined,
      transcriptionSource: dto.transcriptionSource ?? 'batch',
    } satisfies TranscriptionCreatedPayload);

    return { contextItemId: savedContextItem.id };
  }

  /**
   * Start processing a job
   */
  async startJob(jobId: string, dto: InternalStartJobRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.startProcessing(dto.workerId);
    const updated = await this.jobRepository.update(jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: jobId,
      responsibleEntityId: job.createdBy || undefined,
      data: { status: 'PROCESSING', workerId: dto.workerId },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Update job progress
   */
  async updateProgress(jobId: string, dto: InternalUpdateProgressRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.updateProgress(dto.progress);
    const updated = await this.jobRepository.update(jobId, job);

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Complete a job
   */
  async completeJob(jobId: string, dto: InternalCompleteJobRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.complete(dto.resultText, dto.resultMetadata);
    const updated = await this.jobRepository.update(jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: jobId,
      responsibleEntityId: job.createdBy || undefined,
      data: { status: 'COMPLETED' },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Fail a job
   */
  async failJob(jobId: string, dto: InternalFailJobRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.fail(dto.errorMessage, dto.errorCode);
    const updated = await this.jobRepository.update(jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: jobId,
      responsibleEntityId: job.createdBy || undefined,
      data: { status: 'FAILED', errorMessage: dto.errorMessage },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Get job status (lightweight check for worker cancellation polling)
   */
  async getJobStatus(jobId: string): Promise<{ status: string }> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return { status: job.status };
  }

  /**
   * Create an audio recording record
   * Called by STT-v2 after storing audio blob to MinIO
   */
  async createAudioRecord(dto: CreateAudioRecordRequest): Promise<AudioRecordResponse> {
    // Verify context item exists
    const contextItem = await this.contextItemRepository.findById(dto.contextItemId);
    if (!contextItem) {
      throw new NotFoundException(`Context item ${dto.contextItemId} not found`);
    }

    // Extract file extension from filename or mimeType
    const extension = this.extractExtension(dto.filename, dto.mimeType);

    // Create Media record first (stores the file reference)
    const media = MediaFactory.CreateMedia({
      tenantId: contextItem.tenantId || undefined,
      name: dto.filename,
      uri: dto.storagePath,
      extension,
      mimeType: dto.mimeType,
      size: dto.fileSizeBytes,
      hash: dto.hash || '',
    });

    const savedMedia = await this.mediaRepository.create(media);

    // Get next sequence number for this context item
    const sequenceNumber = dto.sequenceNumber || (await this.audioRecordingRepository.getNextSequenceNumber(dto.contextItemId));

    // Create AudioRecording record (links Media to ContextItem with audio metadata)
    const audioRecording = AudioRecordingFactory.CreateAudioRecording({
      tenantId: contextItem.tenantId || undefined,
      contextItemId: dto.contextItemId,
      mediaId: savedMedia.id,
      duration: dto.durationMs,
      format: extension,
      sampleRate: dto.sampleRate,
      channels: dto.channels,
      bitrate: dto.bitrate,
      language: dto.language,
      sequenceNumber,
      recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
    });

    const savedAudioRecording = await this.audioRecordingRepository.create(audioRecording);

    // If associated with a job, update the job's mediaId
    if (dto.jobId) {
      const job = await this.jobRepository.findById(dto.jobId);
      if (job) {
        job.mediaId = savedMedia.id;
        await this.jobRepository.update(dto.jobId, job);
      }
    }

    // For audio records, try to attribute to the job creator if a job is linked
    let audioResponsibleEntityId: string | undefined;
    if (dto.jobId) {
      const relatedJob = await this.jobRepository.findById(dto.jobId).catch(() => null);
      audioResponsibleEntityId = relatedJob?.createdBy || undefined;
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedAudioRecording.id,
      responsibleEntityId: audioResponsibleEntityId,
      data: {
        type: 'AUDIO_RECORDING',
        mediaId: savedMedia.id,
        contextItemId: dto.contextItemId,
        storagePath: dto.storagePath,
      },
    });

    return {
      audioRecordingId: savedAudioRecording.id,
      mediaId: savedMedia.id,
    };
  }

  /**
   * Extract file extension from filename or mimeType
   */
  private extractExtension(filename: string, mimeType: string): string {
    // Try to get from filename first
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex > 0) {
      return filename.substring(dotIndex + 1).toLowerCase();
    }

    // Fallback to mimeType mapping
    const mimeToExt: Record<string, string> = {
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
    };

    return mimeToExt[mimeType] || 'bin';
  }
}
