import { Module } from '@nestjs/common';
import {
  ConsultationServiceModule,
  ContextServiceModule,
  ConsultationJobServiceModule,
  NoteGenerationServiceModule,
  SummaryServiceModule,
  TimelineServiceModule,
  ChainSummaryServiceModule,
  TagServiceModule,
  HarnessInternalServiceModule,
  HarnessPolicyServiceModule,
  ConsultationEndpointServiceModule,
  LiveDocumentationServiceModule,
  HighlightServiceModule,
  DocumentSectionServiceModule,
  HarnessProgressServiceModule,
  HarnessAssuranceServiceModule,
  HarnessLiveAssistServiceModule,
  // ordered-trajectory ingest (internal route) + SSE relay.
  AgentTrajectoryServiceModule,
  // Loop-event publish (internal route) + SSE relay.
  ConsultationLoopEventServiceModule,
  // Loop-configuration resolution (internal route).
  LoopConfigServiceModule,
  LoopContextTextServiceModule,
  RedisSubscriberService,
  // ConsultationConsentService for the internal consent-assert endpoint
  // (non-HTTP enforcement front door).
  ConsentServiceModule,
  // IPromptManagementService for the internal prompt-template resolution endpoint
  // (the summarization palette's `prompt.template_ref` node).
  PromptManagementServiceModule,
  // the harness batch-trigger activity's dispatch/poll routes
  // reuse the EXISTING batch-transcription write path (no duplicate job-processing
  // logic in harness).
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
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
    // the legacy SummaryProcessor was deleted, so `generateSummaryAsync`
    // now calls the NoteGeneration seam DIRECTLY. Without this import the
    // controller's INoteGenerationService parameter is unresolvable and the API
    // fails to BOOT — a failure unit tests cannot catch, since they mock it.
    NoteGenerationServiceModule,
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
    ConsultationEndpointServiceModule,
    LiveDocumentationServiceModule,
    // Manual doctor highlighting.
    HighlightServiceModule,
    // Lane D — the clinician write path for DocumentSection (the flush writer
    // lives in LiveDocumentationServiceModule above).
    DocumentSectionServiceModule,
    // Harness progress publish (internal POST) + SSE relay (stream route).
    HarnessProgressServiceModule,
    // Assurance per-claim publish (internal POST) + SSE relay.
    HarnessAssuranceServiceModule,
    // supplies HarnessLiveAssistService to BOTH the internal
    // publish route and the SSE relay.
    HarnessLiveAssistServiceModule,
    // IAgentTrajectoryService for the internal ingest route.
    AgentTrajectoryServiceModule,
    // Loop-event publish (internal route) + SSE relay.
    ConsultationLoopEventServiceModule,
    // Loop-configuration resolution (internal route).
    LoopConfigServiceModule,
    LoopContextTextServiceModule,
    ConsentServiceModule,
    PromptManagementServiceModule,
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
  ],
  controllers: [ConsultationController, AdminConsultationController, ConsultationJobController, HarnessInternalController, ConsentInternalController],
  // dedicated Redis subscriber connection for the
  // `:id/trajectory/stream` SSE relay (mirrors the harness-progress module's
  // own RedisSubscriberService provider; IConfigService is @Global).
  providers: [RedisSubscriberService],
})
export class ConsultationModule {}
