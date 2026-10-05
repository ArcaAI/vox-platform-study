import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { BillingServiceModule } from '../../billing/billing.service.module';
import { MediaServiceModule } from '../../media/media/media.service.module';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { AsrAgentResolverServiceModule } from '../../stt/agent-resolver/asr-agent-resolver.service.module';
import { TranscriptionJobServiceModule } from '../../stt/job/transcriptionJob.service.module';
import { TranscriptionRealtimeServiceModule } from '../../stt/realtime/transcriptionRealtime.service.module';
import { TenantBucketServiceModule } from '../../tenant-bucket/tenant-bucket.service.module';
import { ContextServiceModule } from '../context/context.service.module';
import { LoopConfigServiceModule } from '../loop/loop-config.service.module';
import { IAttachmentTranscriptSink, IAttachmentTranscriptSinkToken } from '../transcript-record/ITranscriptRecordService';
import { AttachmentCapabilityService } from './attachment-capability.service';
import { AttachmentReaperService } from './attachment-reaper.service';
import { AttachmentTranscriptSink } from './attachment-transcript.sink';
import { ConsultationAttachmentService } from './consultation-attachment.service';
import { IConsultationAttachmentService, IConsultationAttachmentServiceToken } from './IConsultationAttachmentService';
import { AudioAttachmentProcessor } from './processors/audio.processor';
import { CaseNoteAttachmentProcessor } from './processors/case-note.processor';
import { DocumentAttachmentProcessor } from './processors/document.processor';
import { ImageAttachmentProcessor } from './processors/image.processor';
import { ConsultationLifecycleGateModule } from '../lifecycle/lifecycle.module';

/**
 * Consultation attachments: the intent/complete service, its per-kind processors, the batch
 * transcript sink and the intent reaper.
 *
 * Relies on the app-level globals `BlobStorageModule` (`IBlobStorageService`), `ScheduleModule`
 * (`SchedulerRegistry`), `EventEmitterModule` and, when registered, the @Global `RedisCacheModule`
 * (the reaper's cross-replica lock — optional). `TenantSettingsService` is provided LOCALLY over
 * `CommonServiceModule`'s settings plane (the `MediaUploadServiceModule` precedent).
 *
 * `IConsultationLifecycleGateToken` is NOT provided here: the lifecycle module that owns the gate
 * must be imported (or be global) wherever this module is wired.
 */
@Module({
  imports: [
    // The content lock and the processing axis.
    ConsultationLifecycleGateModule,
    CommonServiceModule,
    CoreDatabaseModule,
    ContextServiceModule,
    MediaServiceModule,
    TenantBucketServiceModule,
    LoopConfigServiceModule,
    AsrAgentResolverServiceModule,
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
    BillingServiceModule,
  ],
  providers: [
    TenantSettingsService,
    AttachmentCapabilityService,
    CaseNoteAttachmentProcessor,
    DocumentAttachmentProcessor,
    ImageAttachmentProcessor,
    AudioAttachmentProcessor,
    ConsultationAttachmentService,
    { provide: IConsultationAttachmentService, useExisting: ConsultationAttachmentService },
    { provide: IConsultationAttachmentServiceToken, useExisting: ConsultationAttachmentService },
    AttachmentTranscriptSink,
    { provide: IAttachmentTranscriptSink, useExisting: AttachmentTranscriptSink },
    { provide: IAttachmentTranscriptSinkToken, useExisting: AttachmentTranscriptSink },
    AttachmentReaperService,
  ],
  exports: [
    IConsultationAttachmentService,
    IConsultationAttachmentServiceToken,
    IAttachmentTranscriptSink,
    IAttachmentTranscriptSinkToken,
    AttachmentCapabilityService,
  ],
})
export class ConsultationAttachmentServiceModule {}
