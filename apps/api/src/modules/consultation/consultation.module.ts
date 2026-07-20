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
  LiveDocumentationServiceModule,
  // TASK-344 Workstream B — manual doctor highlighting.
  HighlightServiceModule,
  // TASK-345 — live harness activity/progress feed.
  HarnessProgressServiceModule,
  // TASK-355 Phase D Slice 5d — live per-claim assurance feed.
  HarnessAssuranceServiceModule,
  // ordered-trajectory ingest (internal route) + SSE relay.
  AgentTrajectoryServiceModule,
  RedisSubscriberService,
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
    // Clinical Workflow Playground (WS1/WS2) — live-summary watcher + recording lifecycle.
    LiveDocumentationServiceModule,
    // TASK-344 Workstream B — manual doctor highlighting.
    HighlightServiceModule,
    // TASK-345 — harness progress publish (internal POST) + SSE relay (stream route).
    HarnessProgressServiceModule,
    // TASK-355 Phase D Slice 5d — assurance per-claim publish (internal POST) + SSE relay.
    HarnessAssuranceServiceModule,
    // IAgentTrajectoryService for the internal ingest route.
    AgentTrajectoryServiceModule,
  ],
  controllers: [ConsultationController, AdminConsultationController, ConsultationJobController, HarnessInternalController],
  // dedicated Redis subscriber connection for the
  // `:id/trajectory/stream` SSE relay (mirrors the harness-progress module's
  // own RedisSubscriberService provider; IConfigService is @Global).
  providers: [RedisSubscriberService],
})
export class ConsultationModule {}
