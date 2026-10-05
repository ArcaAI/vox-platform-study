import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { UsageLedgerServiceModule } from '../../usageLedger';
import { SttInternalService } from './sttInternal.service';
import { TranscriptRecordServiceModule } from '../../consultation/transcript-record/transcript-record.service.module';
import { ConsultationAttachmentServiceModule } from '../../consultation/attachment/consultation-attachment.service.module';
import { AiActivityRunServiceModule } from '../../ai-activity-run/ai-activity-run.service.module';

@Module({
  // UsageLedgerServiceModule — `IUsageLedgerService` for the
  // `transcribe.batch` AUDIO_SECOND emission on job completion.
  // `CoreUnitOfWorkService` needs no extra import: `CoreDatabaseModule`
  // already provides + exports it.
  imports: [
    TranscriptRecordServiceModule,
    ConsultationAttachmentServiceModule,
    AiActivityRunServiceModule,
    CoreDatabaseModule,
    EventEmitterModule,
    ClsModule,
    UsageLedgerServiceModule,
  ],
  providers: [SttInternalService],
  exports: [SttInternalService],
})
export class SttInternalServiceModule {}
