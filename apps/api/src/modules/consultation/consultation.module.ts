import { Module } from '@nestjs/common';
import {
  ConsultationAttachmentServiceModule,
  ConsultationFeedbackServiceModule,
  FeedbackRollupServiceModule,
  ConsultationLifecycleModule,
  ConsultationEncounterServiceModule,
  MediaServiceModule,
  TenantLockModule,
} from '@arcaai/applications';
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
  AsrAgentResolverServiceModule,
  EffectiveSettingsModule,
  // TASK-999 Lane B — the read-only per-consultation AI telemetry projection.
  ConsultationTelemetryServiceModule,
  // TASK-1036 §9.3 / TASK-1038 — the `consultation.*` declared-read plane.
  ConsultationReadServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConsultationController } from './consultation.controller';
import { AdminConsultationController } from './admin-consultation.controller';
import { ConsultationTelemetryController } from './consultation-telemetry.controller';
import { ConsultationJobController } from './consultation-job.controller';
import { HarnessInternalController, HarnessNotePlanController } from './harness-internal.controller';
import { ConsentInternalController } from './consent-internal.controller';
import { ConsultationReadInternalController } from './consultation-read-internal.controller';
import { AdminFeedbackRollupController } from './admin-feedback-rollup.controller';
import { ConsultationLifecycleEventsController } from './consultation-lifecycle-events.controller';
import { ConsultationAccessHelper } from './consultation-access.helper';
import { ConsultationAttachmentController } from './consultation-attachment.controller';
import { ConsultationFeedbackController } from './consultation-feedback.controller';

@Module({
  imports: [
    TenantLockModule,
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
    // TASK-1006 — resolves a workflow ASR node's agent into the `ResolvedAsrSpec` the harness
    // batch-trigger route (`POST internal/harness/stt/batch-jobs`) keys its job to.
    AsrAgentResolverServiceModule,
    // TASK-932 S2-4 — supplies `TenantSettingsService`, which
    // `ConsultationController.isSharingEnabled` resolves the
    // `enable-consultation-sharing` gate through (tenant row -> SYSTEM row ->
    // descriptor default). It replaces the `GlobalSettingRepository` the
    // controller used to query directly. NestJS dedupes the module instance
    // with the AppModule / AuthModule imports.
    EffectiveSettingsModule,
    // TASK-999 Lane B — supplies `IConsultationTelemetryService` to
    // `ConsultationTelemetryController`.
    ConsultationTelemetryServiceModule,
    // TASK-1036 §9.3 / TASK-1038 — `IConsultationReadService` for the harness's declared reads.
    ConsultationReadServiceModule,
    // Attachment intents/complete/content and clinician feedback (business plane).
    ConsultationAttachmentServiceModule,
    ConsultationFeedbackServiceModule,
    // `IFeedbackRollupReaderToken` for the admin rollups read.
    FeedbackRollupServiceModule,
    // Lifecycle commands + event stream, the episode encounters, and recording part URLs.
    ConsultationLifecycleModule,
    ConsultationEncounterServiceModule,
    MediaServiceModule,
  ],
  controllers: [
    ConsultationController,
    AdminConsultationController,
    // Registered after the admin controller, though order does not decide the
    // match here: `:id/telemetry` carries an extra path segment, so Nest can
    // never route it to `admin/consultations/:id`.
    ConsultationTelemetryController,
    ConsultationJobController,
    HarnessInternalController,
    // `internal/consultations/:id/note-plans/:planId` — the harness fetches the composed note plan.
    HarnessNotePlanController,
    ConsentInternalController,
    ConsultationReadInternalController,
    // `feedback/reason-codes` is a two-segment literal path, so it never binds as `:id`.
    ConsultationAttachmentController,
    ConsultationFeedbackController,
    AdminFeedbackRollupController,
    ConsultationLifecycleEventsController,
  ],
  // dedicated Redis subscriber connection for the
  // `:id/trajectory/stream` SSE relay (mirrors the harness-progress module's
  // own RedisSubscriberService provider; IConfigService is @Global).
  providers: [RedisSubscriberService, ConsultationAccessHelper],
})
export class ConsultationModule {}
