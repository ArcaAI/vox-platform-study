import { Module } from '@nestjs/common';
import {
  ConsultationServiceModule,
  ContextServiceModule,
  ConsultationJobServiceModule,
  SummaryServiceModule,
  TimelineServiceModule,
  ChainSummaryServiceModule,
  TagServiceModule,
  HarnessInternalServiceModule,
  HarnessPolicyServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConsultationController } from './consultation.controller';
import { AdminConsultationController } from './admin-consultation.controller';
import { ConsultationJobController } from './consultation-job.controller';
import { HarnessInternalController } from './harness-internal.controller';

@Module({
  imports: [
    ConsultationServiceModule,
    ContextServiceModule,
    ConsultationJobServiceModule,
    SummaryServiceModule,
    TimelineServiceModule,
    ChainSummaryServiceModule,
    TagServiceModule,
    CoreDatabaseModule,
    // TASK-330 Phase 1 (Lane G) — inbound harness gate adapter.
    HarnessInternalServiceModule,
    // TASK-330 Phase 6 — effective-policy read for the worker's fetch_policy.
    HarnessPolicyServiceModule,
  ],
  controllers: [
    ConsultationController,
    AdminConsultationController,
    ConsultationJobController,
    HarnessInternalController,
  ],
})
export class ConsultationModule {}
