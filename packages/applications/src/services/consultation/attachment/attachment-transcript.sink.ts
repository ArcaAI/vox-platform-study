import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationAttachmentEntity,
  ConsultationAttachmentRepository,
  ConsultationAttachmentStatus,
  ContextItemRepository,
  ContextItemSource,
  ContextItemType,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { IContextService } from '../context/IContextService';
import { IConsultationLifecycleGate, IConsultationLifecycleGateToken } from '../lifecycle/IConsultationLifecycleService';
import { IAttachmentTranscriptSink } from '../transcript-record/ITranscriptRecordService';
import { stampEncounterSeq } from './processors/attachment-processor';

/** `metaData.origin` of the transcript an uploaded audio file produced (the full-transcript rebuild skips it). */
export const ATTACHMENT_AUDIO_ORIGIN = 'attachment_audio';
export const ATTACHMENT_TRANSCRIPT_EMPTY = 'ATTACHMENT_TRANSCRIPT_EMPTY';

/**
 * Claims the batch-transcription callback of a job an audio attachment started. The result is ONE
 * transcript item (`source = TRANSCRIPTION`, the audio `mediaId`, `metaData.origin =
 * 'attachment_audio'`) — no segments, and no `TranscriptionCreated`, so it never triggers the
 * auto-summary. Returning `true` tells the STT path it was handled.
 *
 * The internal callback carries no tenant context, so the row's tenant is put into CLS before
 * anything tenant-scoped runs. A replayed callback for a row that already left PROCESSING is
 * claimed again and writes nothing.
 */
@Injectable()
export class AttachmentTranscriptSink extends BaseService implements IAttachmentTranscriptSink {
  private readonly logger = new Logger(AttachmentTranscriptSink.name);

  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly attachmentRepository: ConsultationAttachmentRepository,
    @Inject(IContextService) private readonly contextService: IContextService,
    @Inject(IConsultationLifecycleGateToken) private readonly lifecycleGate: IConsultationLifecycleGate,
    private readonly contextItems: ContextItemRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationAttachment);
  }

  async onBatchTranscript(input: { jobId: string; text: string }): Promise<boolean> {
    const row = await this.attachmentRepository.findByTranscriptionJobId(input.jobId);
    if (!row) return false;
    if (row.status !== ConsultationAttachmentStatus.PROCESSING) return true;

    await this.clsService.run(async () => {
      this.clsService.set('tenantId', row.tenantId);
      this.clsService.set('user', createWorkerSession({ userId: row.createdBy ?? undefined, tenantId: row.tenantId, kind: 'attachment-transcript' }));
      await this.write(row, input.text ?? '');
    });
    return true;
  }

  private async write(row: ConsultationAttachmentEntity, text: string): Promise<void> {
    const content = text.trim();
    let contextItemId: string | null = null;
    if (content) {
      // The encounter the file was attached in (captured at intent); the current one when unset.
      const encounterSeq = row.encounterSeq ?? (await this.lifecycleGate.currentEncounterSeq(row.consultationId));
      const item = await this.contextService.addContext(row.consultationId, {
        type: ContextItemType.TRANSCRIPT,
        source: ContextItemSource.TRANSCRIPTION,
        content,
        mediaId: row.mediaId ?? undefined,
        metadata: {
          origin: ATTACHMENT_AUDIO_ORIGIN,
          attachmentId: row.id,
          mediaId: row.mediaId ?? null,
          transcriptionJobId: row.transcriptionJobId ?? null,
          encounterSeq,
        },
      });
      contextItemId = item.id;
      await stampEncounterSeq(this.contextItems, item.id, encounterSeq);
    }

    const status = content ? ConsultationAttachmentStatus.READY : ConsultationAttachmentStatus.FAILED;
    const won = await this.attachmentRepository.compareAndSetStatus(row.id, [ConsultationAttachmentStatus.PROCESSING], status, {
      contextItemId,
      completedAt: new Date(),
      ...(content ? {} : { failureCode: ATTACHMENT_TRANSCRIPT_EMPTY }),
    });
    if (!won) {
      this.logger.warn({ message: 'Attachment left PROCESSING before its transcript arrived', attachmentId: row.id, contextItemId });
      return;
    }
    // An empty transcript (silent audio) is not a failure of the consultation's processing.
    await this.lifecycleGate.endProcessing(row.consultationId, row.id, undefined);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: row.id,
      data: { consultationId: row.consultationId, status, kind: row.kind, contextItemId, failureCode: content ? null : ATTACHMENT_TRANSCRIPT_EMPTY },
    });
  }
}
