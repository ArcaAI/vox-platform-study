import {
  AudioRecordingFactory,
  AudioRecordingRepository,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemRepository,
  ContextItemSource,
  ContextItemType,
  MediaFactory,
  MediaRepository,
  ResourceType,
  SysEventType,
  TranscriptionJobRepository,
  TranscriptSegmentFactory,
  TranscriptSegmentRepository,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { ConsultationPipelineEvent, TranscriptionCreatedPayload } from '../../consultation/events';
import { TranscriptionJobResponse } from '../job/dto';
import { TranscriptionJobDtoMapper } from '../job/transcriptionJob.dto.mapper';
import { ISttInternalService } from './ISttInternalService';
import {
  computeSegmentOffsets,
  type TranscriptSegmentInputShape,
} from '../../consultation/lib/transcript-segments';
import {
  AudioRecordResponse,
  CreateAudioRecordRequest,
  CreateTranscriptRequest,
  InternalCreateMediaRequest,
  InternalCreateMediaResponse,
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
    // TASK-369 Phase 3C — optional + trailing so existing positional fixtures
    // keep their arity; when wired, the completed job's resultText/resultMetadata
    // are encrypted before persist (dual-write soak).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // optional + trailing (same arity-preserving reason) so the
    // ingest can persist per-transcript segments when the repo is wired.
    @Optional()
    @Inject(TranscriptSegmentRepository)
    private readonly transcriptSegmentRepository?: TranscriptSegmentRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.TranscriptionJob);
  }

  /**
 * persist the ordered transcript segments emitted by STT as
   * TranscriptSegment rows. `text` on each input is used ONLY to resolve the
   * [charStart, charEnd) offsets into the transcript content and is NOT stored
   * (the durable row keeps offsets + timings + speaker, never the PHI text).
   *
   * Segments arrive either on the typed `dto.segments` field or (D8: stop
   * dropping metadata) embedded as `metadata.segments`. Best-effort: a failure
   * here must not fail the transcript ingest, so it is guarded + logged.
   */
  private async persistTranscriptSegments(
    contextItem: ContextItemEntity,
    dto: CreateTranscriptRequest,
  ): Promise<void> {
    if (!this.transcriptSegmentRepository) return;

    const metaSegments = (dto.metadata as { segments?: TranscriptSegmentInputShape[] } | undefined)?.segments;
    const rawSegments = dto.segments ?? metaSegments;
    if (!Array.isArray(rawSegments) || rawSegments.length === 0) return;

    try {
      // TASK-533 D-22 — report (never silently swallow) a segment that resolved to
      // nothing but its ordinal. That was the defect's whole signature: the batch
      // producer sent a text-less, seconds-based, snake_case shape, every field
      // coerced to null, and the ingest wrote ungroundable rows without a murmur.
      // `computeSegmentOffsets` now normalizes both shapes, so reaching this log
      // means a producer sent something genuinely unusable — alert on it.
      const unusable: number[] = [];
      const resolved = computeSegmentOffsets(dto.transcriptText ?? '', rawSegments, (report) => {
        if (unusable.length === 0) {
          this.logger.error(
            `stt.transcript.segment_shape_unusable — contextItem ${contextItem.id}: segment ` +
              `#${report.position} carries no timing, speaker or offsets after normalization ` +
              `(keys: ${report.keys.join(',') || 'none'}). Evidence grounding will find no source ` +
              `for this transcript; check the stt-v2 producer payload shape.`,
          );
        }
        unusable.push(report.position);
      });
      if (unusable.length > 0) {
        this.logger.error(
          `stt.transcript.segment_shape_unusable_total — contextItem ${contextItem.id}: ` +
            `${unusable.length}/${resolved.length} segments unusable.`,
        );
      }
      for (const seg of resolved) {
        const entity = TranscriptSegmentFactory.CreateTranscriptSegment({
          tenantId: contextItem.tenantId ?? dto.tenantId ?? '',
          contextItemId: contextItem.id,
          idx: seg.idx,
          t0Ms: seg.t0Ms,
          t1Ms: seg.t1Ms,
          speaker: seg.speaker,
          charStart: seg.charStart,
          charEnd: seg.charEnd,
          createdBy: contextItem.createdBy ?? undefined,
        });
        await this.transcriptSegmentRepository.create(entity);
      }
    } catch (error) {
      this.logger.error(
        `TranscriptSegment persist skipped for contextItem ${contextItem.id}: ${(error as Error).message}`,
      );
    }
  }

  private readonly logger = new Logger(SttInternalService.name);

  /**
   * TASK-369 — encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * Create a transcript context item from completed transcription
   */
  async createTranscript(dto: CreateTranscriptRequest): Promise<{ contextItemId: string }> {
    // TASK-342 GAP #1 — streaming finalize has no TranscriptionJob. When no
    // jobId is supplied, persist the transcript keyed directly to the
    // consultation (+ tenant) and skip the job lookup / setContextItem link-back.
    if (!dto.jobId) {
      return this.createStreamingTranscript(dto);
    }

    // Find the job (batch path)
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

    // persist ordered transcript segments (offsets resolved from text).
    await this.persistTranscriptSegments(savedContextItem, dto);

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
   * TASK-342 GAP #1 — persist a streaming-session transcript that has no
   * TranscriptionJob. Keyed directly to the consultation (+ tenant) and
   * idempotent so a finalize retry does not double-create the transcript or
   * re-trigger the harness auto-draft pipeline.
   */
  private async createStreamingTranscript(
    dto: CreateTranscriptRequest,
  ): Promise<{ contextItemId: string }> {
    const consultationId = dto.consultationId;
    if (!consultationId) {
      throw new BadRequestException(
        'consultationId is required to create a transcript without a jobId',
      );
    }

    // Idempotency guard: if a transcript already exists for this consultation,
    // return it without creating a duplicate or re-emitting the pipeline event.
    const existing = await this.contextItemRepository.findTranscripts(consultationId);
    if (existing.length > 0) {
      return { contextItemId: existing[0].id };
    }

    const contextItem = ContextItemFactory.CreateContextItem({
      tenantId: dto.tenantId || undefined,
      consultationId,
      type: ContextItemType.TRANSCRIPT,
      source: ContextItemSource.TRANSCRIPTION,
      content: dto.transcriptText,
    });

    const savedContextItem = await this.contextItemRepository.create(contextItem);

    // persist ordered transcript segments (offsets resolved from text).
    await this.persistTranscriptSegments(savedContextItem, dto);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContextItem.id,
      data: {
        type: 'TRANSCRIPT',
        consultationId,
      },
    });

    // Emit pipeline event to trigger the harness auto-draft (GAP #1).
    this.eventEmitter.emit(ConsultationPipelineEvent.TranscriptionCreated, {
      consultationId,
      tenantId: dto.tenantId || '',
      timestamp: new Date().toISOString(),
      contextItemId: savedContextItem.id,
      wordCount: dto.transcriptText
        ? dto.transcriptText.split(/\s+/).filter(Boolean).length
        : undefined,
      transcriptionSource: dto.transcriptionSource ?? 'streaming',
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

    // TASK-369 Phase 3C — encrypt resultText/resultMetadata into the ciphertext
    // columns before the completing persist (dual-write; plaintext kept for soak).
    await this.encryptBestEffort('TranscriptionJob', () =>
      this.jobRepository.encryptFieldsIntoEntity(job, this.secretsService!),
    );

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
    // Validate the two input shapes up-front (before any side effects, so an
    // invalid request never leaves an orphan container behind).
    if (!dto.contextItemId && !dto.consultationId) {
      throw new BadRequestException('Either contextItemId or consultationId is required');
    }
    const hasStorageObject = Boolean(dto.storagePath && dto.filename && dto.mimeType) && dto.fileSizeBytes != null;
    if (!dto.mediaId && !hasStorageObject) {
      throw new BadRequestException('Either mediaId or (storagePath, filename, fileSizeBytes, mimeType) is required');
    }

    // Resolve the container: explicit contextItemId (batch/local) OR resolve the
    // consultation's AUDIO_RECORDING container (streaming dual-capture, parity
    // with the local path's findOrCreateAudioContainer).
    let contextItemId: string;
    let tenantId: string | undefined;
    if (dto.contextItemId) {
      const contextItem = await this.contextItemRepository.findById(dto.contextItemId);
      if (!contextItem) {
        throw new NotFoundException(`Context item ${dto.contextItemId} not found`);
      }
      contextItemId = dto.contextItemId;
      tenantId = dto.tenantId ?? contextItem.tenantId ?? undefined;
    } else {
      if (!dto.tenantId) {
        throw new BadRequestException('tenantId is required when attaching by consultationId');
      }
      const container = await this.findOrCreateAudioContainer(dto.consultationId as string, dto.tenantId);
      contextItemId = container.id;
      tenantId = dto.tenantId ?? container.tenantId ?? undefined;
    }

    // Resolve the primary Media: a pre-registered mediaId (streaming, where the
    // raw/processed Media were already created via createMedia) wins; otherwise
    // create one from the storage object (batch/local).
    let primaryMediaId: string;
    let extension: string | undefined;
    if (dto.mediaId) {
      primaryMediaId = dto.mediaId;
    } else {
      extension = this.extractExtension(dto.filename as string, dto.mimeType as string);
      const media = MediaFactory.CreateMedia({
        tenantId,
        name: dto.filename as string,
        uri: dto.storagePath as string,
        extension,
        mimeType: dto.mimeType as string,
        size: dto.fileSizeBytes as number,
        hash: dto.hash || '',
      });
      const savedMedia = await this.mediaRepository.create(media);
      primaryMediaId = savedMedia.id;
    }

    // Get next sequence number for this context item
    const sequenceNumber = dto.sequenceNumber || (await this.audioRecordingRepository.getNextSequenceNumber(contextItemId));

    // Create AudioRecording record (links Media to ContextItem with audio metadata)
    const audioRecording = AudioRecordingFactory.CreateAudioRecording({
      tenantId,
      contextItemId,
      mediaId: primaryMediaId,
      rawMediaId: dto.rawMediaId,
      processedMediaId: dto.processedMediaId,
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
        job.mediaId = primaryMediaId;
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
        mediaId: primaryMediaId,
        contextItemId,
        consultationId: dto.consultationId,
        storagePath: dto.storagePath,
      },
    });

    return {
      audioRecordingId: savedAudioRecording.id,
      mediaId: primaryMediaId,
    };
  }

  /**
   * Resolve (or create) the consultation's AUDIO_RECORDING container context
   * item. Mirrors `ContextService.findOrCreateAudioContainer` so the streaming
   * dual-capture path attaches recordings exactly like the local path. Uses the
   * already-injected ContextItemRepository — no cross-service dependency.
   */
  private async findOrCreateAudioContainer(consultationId: string, tenantId: string): Promise<ContextItemEntity> {
    const existing = await this.contextItemRepository.findAudioRecordings(consultationId);
    if (existing.length > 0) {
      return existing[0];
    }
    const container = ContextItemFactory.CreateAudioRecording(tenantId, consultationId);
    return this.contextItemRepository.create(container);
  }

  /**
   * Register a stored object as a Media row (TASK-334 I-2b).
   *
   * The streaming dual-capture path uploads raw/processed WAVs to object
   * storage and calls this once per capture to obtain the Media ids it then
   * threads onto the AudioRecording. Mirrors the internal Media creation that
   * `createAudioRecord` does from a `storagePath`, but as a standalone step so
   * the caller can register raw and processed independently.
   */
  async createMedia(dto: InternalCreateMediaRequest): Promise<InternalCreateMediaResponse> {
    const media = MediaFactory.CreateMedia({
      tenantId: dto.tenantId,
      name: dto.name,
      uri: dto.uri,
      extension: dto.extension,
      mimeType: dto.mimeType,
      size: dto.size,
      hash: dto.hash || '',
      createdBy: dto.createdBy,
    });

    const savedMedia = await this.mediaRepository.create(media);

    return { id: savedMedia.id };
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
