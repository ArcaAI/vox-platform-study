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
  HighlightServiceModule,
  HarnessProgressServiceModule,
  HarnessAssuranceServiceModule,
  // ordered-trajectory ingest (internal route) + SSE relay.
  AgentTrajectoryServiceModule,
  // Loop-event publish (internal route) + SSE relay.
  ConsultationLoopEventServiceModule,
  // Loop-configuration resolution (internal route).
  LoopConfigServiceModule,
  LoopContextTextServiceModule,
  RedisSubscriberService,
  // ConsultationConsentService for the internal consent-assert endpoint
  // (TASK-712 Phase 4 — non-HTTP enforcement front door).
  ConsentServiceModule,
  // IPromptManagementService for the internal prompt-template resolution endpoint
  // (TASK-720 N-2 — the summarization palette's `prompt.template_ref` node).
  PromptManagementServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConsultationController } from './consultation.controller';
import { AdminConsultationController } from './admin-consultation.controller';
import { ConsultationJobController } from './consultation-job.controller';
import { HarnessInternalController } from './harness-internal.controller';
import { ConsentInternalController } from './consent-internal.controller';

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
    // Inbound harness gate adapter.
    HarnessInternalServiceModule,
    // Effective-policy read for the worker's fetch_policy.
    HarnessPolicyServiceModule,
    // Clinical Workflow Playground (WS1/WS2) — live-summary watcher + recording lifecycle.
    LiveDocumentationServiceModule,
    // Manual doctor highlighting.
    HighlightServiceModule,
    // Harness progress publish (internal POST) + SSE relay (stream route).
    HarnessProgressServiceModule,
    // Assurance per-claim publish (internal POST) + SSE relay.
    HarnessAssuranceServiceModule,
    // IAgentTrajectoryService for the internal ingest route.
    AgentTrajectoryServiceModule,
    // Loop-event publish (internal route) + SSE relay.
    ConsultationLoopEventServiceModule,
    // Loop-configuration resolution (internal route).
    LoopConfigServiceModule,
    LoopContextTextServiceModule,
    ConsentServiceModule,
    PromptManagementServiceModule,
  ],
  controllers: [ConsultationController, AdminConsultationController, ConsultationJobController, HarnessInternalController, ConsentInternalController],
  // dedicated Redis subscriber connection for the
  // `:id/trajectory/stream` SSE relay (mirrors the harness-progress module's
  // own RedisSubscriberService provider; IConfigService is @Global).
  providers: [RedisSubscriberService],
})
export class ConsultationModule {}
