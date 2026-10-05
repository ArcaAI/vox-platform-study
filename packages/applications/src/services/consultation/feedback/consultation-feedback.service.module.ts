import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { GateEditMiningServiceModule } from '../../gate-edit-mining/gate-edit-mining.service.module';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { ContextServiceModule } from '../context/context.service.module';
import { JobIdempotencyModule } from '../jobs/job-idempotency.module';
import { ConsultationFeedbackService } from './consultation-feedback.service';
import { FeedbackProvenanceResolver } from './feedback-provenance';
import { IConsultationFeedbackServiceToken } from './IConsultationFeedbackService';
import { ConsultationLifecycleGateModule } from '../lifecycle/lifecycle.module';
import { AiActivityRunServiceModule } from '../../ai-activity-run/ai-activity-run.service.module';

/**
 * `IConsultationFeedbackService`. `TenantSettingsService` is provided LOCALLY over
 * `CommonServiceModule`'s settings plane (the `MediaUploadServiceModule` precedent).
 *
 * The host must also make two tokens resolvable: `IConsultationLifecycleGateToken` (required —
 * the lifecycle module) and `IActivityRunRecordReaderToken` (optional — without it provenance
 * falls back to `SummaryMeta`).
 */
@Module({
  imports: [
    ConsultationLifecycleGateModule,
    AiActivityRunServiceModule,
    CommonServiceModule,
    CoreDatabaseModule,
    ContextServiceModule,
    JobIdempotencyModule,
    GateEditMiningServiceModule,
  ],
  providers: [
    TenantSettingsService,
    FeedbackProvenanceResolver,
    ConsultationFeedbackService,
    { provide: IConsultationFeedbackServiceToken, useExisting: ConsultationFeedbackService },
  ],
  exports: [IConsultationFeedbackServiceToken, ConsultationFeedbackService],
})
export class ConsultationFeedbackServiceModule {}
