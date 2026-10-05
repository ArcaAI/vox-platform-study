import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ConsultationHistoryService } from './consultation-history.service';
import { ConsultationActivityFeedbackSourceToken, IConsultationHistoryServiceToken } from './IConsultationHistoryService';
import { IConsultationFeedbackServiceToken } from '../feedback/IConsultationFeedbackService';
import { ConsultationFeedbackServiceModule } from '../feedback/consultation-feedback.service.module';
import { AiActivityRunServiceModule } from '../../ai-activity-run/ai-activity-run.service.module';

/**
 * `ConsultationHistoryService` DI module — a read-only projection over the consultation's items,
 * encounters and approvals.
 *
 * The feedback source (`ConsultationActivityFeedbackSourceToken`) and the run reader
 * (`IActivityRunRecordReaderToken`) are optional: the feed renders without them, and they are
 * bound where the feedback and run-record modules are assembled.
 */
@Module({
  imports: [ConsultationFeedbackServiceModule, AiActivityRunServiceModule, CommonServiceModule, CoreDatabaseModule],
  providers: [
    ConsultationHistoryService,
    { provide: ConsultationActivityFeedbackSourceToken, useExisting: IConsultationFeedbackServiceToken },
    { provide: IConsultationHistoryServiceToken, useExisting: ConsultationHistoryService },
  ],
  exports: [IConsultationHistoryServiceToken, ConsultationHistoryService],
})
export class ConsultationHistoryServiceModule {}
