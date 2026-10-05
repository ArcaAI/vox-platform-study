import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ConsultationHistoryService } from './consultation-history.service';
import { IConsultationHistoryServiceToken } from './IConsultationHistoryService';

/**
 * `ConsultationHistoryService` DI module — a read-only projection over the consultation's items,
 * encounters and approvals.
 *
 * The feedback source (`ConsultationActivityFeedbackSourceToken`) and the run reader
 * (`IActivityRunRecordReaderToken`) are optional: the feed renders without them, and they are
 * bound where the feedback and run-record modules are assembled.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [ConsultationHistoryService, { provide: IConsultationHistoryServiceToken, useExisting: ConsultationHistoryService }],
  exports: [IConsultationHistoryServiceToken, ConsultationHistoryService],
})
export class ConsultationHistoryServiceModule {}
