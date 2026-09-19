import {
  AiModelServiceModule,
  AiProviderConnectionServiceModule,
  AiRoutingPolicyServiceModule,
  AsrAgentResolverServiceModule,
  DnaWritingStyleServiceModule,
  EffectiveSettingsModule,
  EntitlementsServiceModule,
  HarnessPolicyServiceModule,
  OriginRegistryServiceModule,
  PipelineServiceModule,
  PlatformMetricsServiceModule,
  StreamingSessionServiceModule,
  TenantBucketServiceModule,
  TenantServiceModule,
  TenantSttConfigServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
  UsageLedgerServiceModule,
  UserRoleAssignmentServiceModule,
  VisitTypeServiceModule,
  WorkflowExposureServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TenantOwnedResourceModule } from '../../common';
import { AdminTranscriptionJobController } from './admin-transcription-job.controller';
import { SessionRemovalRetryService } from './session-removal-retry.service';
import { TextProxyController } from './text-proxy.controller';
import { TextProxyRedirectShimController } from './text-proxy-redirect.shim.controller';
import { SttWsGateway } from './stt-ws.gateway';
import { TranscriptionJobController } from './transcription-job.controller';
import { WorkflowWsGateway } from './workflow-ws.gateway';

@Module({
  imports: [
    VisitTypeServiceModule,
    HttpModule.register({
      timeout: 120000,
      maxRedirects: 3,
    }),
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
    StreamingSessionServiceModule,
    TenantServiceModule,
    TenantBucketServiceModule,
    PipelineServiceModule,
    CoreDatabaseModule,
    HarnessPolicyServiceModule, // TEXT-selection resolver for TextProxyController
    // Supplies `IOriginRegistry` to `SttWsGateway`'s CSWSH
    // handshake check. Browsers do NOT apply CORS to WebSockets, so this is the
    // only place the allow-list reaches the socket path. The gateway injects it
    // `@Optional()` and fails CLOSED ( reversed the original fail-OPEN
    // posture; see `stt-ws.gateway.ts#isOriginAllowed`), so omitting this
    // import does not break the build — it refuses every browser origin
    // instead. Corrected under, which mirrored this wiring into
    // `speech.module.ts`.
    OriginRegistryServiceModule,
    // Registry-backed providers listings on TextProxyController:
    // AiModelService lists ENABLED rows per taskType; AiRoutingPolicyService
    // resolves the SYSTEM `guardrail.validate` election.
    AiModelServiceModule,
    AiRoutingPolicyServiceModule,
    // Tenant BYO cloud-credential resolver for the TEXT proxy's
    // cloud-only, minimal-exposure, fail-open `provider_overrides` injection.
    AiProviderConnectionServiceModule,
    // A.2 — supplies `EffectiveSettingsService`, the tenant → SYSTEM
    // cascade behind the TEXT proxy's `guardrail_policy` push. Absent it the
    // proxy pushes nothing, which reads downstream as "this tenant has no
    // opinion" and leaves the platform posture in force.
    EffectiveSettingsModule,
    // Provides `ISocketRegistryService` so `SttWsGateway`
    // publishes its per-instance open-socket count for the platform aggregate.
    PlatformMetricsServiceModule,
    // Provides `IEntitlementsService` so
    // `TranscriptionJobController` can hard-block over-capacity sessions.
    EntitlementsServiceModule,
    // Exposes `StreamSessionTenantBindingService`
    // to `TranscriptionJobController` so it can bind on create / clear on close.
    TenantOwnedResourceModule,
    // TASK-861 — the ONE resolution path (agent → ResolvedAsrSpec + credentials)
    // for stream/session, transcribe and the fallback surfaces.
    AsrAgentResolverServiceModule,
    // Deprecated (TASK-861, removed in R4): the tenant-wide STT fallback pointer +
    // BYO provider overrides for the legacy `pipelineId` path only.
    TenantSttConfigServiceModule,
    // `IUsageLedgerService` for `TextProxyController`'s
    // generate.stream emission AND `StreamingSessionService`'s
    // transcribe.stream emission. Both are constructor-injected at THIS
    // module's level (TextProxyController is declared directly below;
    // StreamingSessionServiceModule importing it only satisfies its OWN
    // providers, not a sibling controller here) — Nest's module
    // encapsulation means each module that injects the token must import it.
    UsageLedgerServiceModule,
    // supplies `IDnaWritingStyleService` to `TextProxyController` so
    // its `dna_writing_style_id` path routes through the gated
    // `getEffectiveStyleText` accessor instead of reading the (ciphertext-only,
    // ungated) repository row directly.
    DnaWritingStyleServiceModule,
    // TASK-991 W2-1 — supplies `IUserRoleAssignmentService` to `TranscriptionJobController`, which
    // needs two TENANT-SCOPED identity reads to let a machine credential transcribe for a named
    // clinician: is that clinician a member of this tenant (404 if not), and does the human an API
    // key is bound to administer it. Without this import the controller injects `undefined` and the
    // machine path answers 503 rather than accepting an unverified clinician.
    UserRoleAssignmentServiceModule,
    // TASK-864 — `WorkflowWsGateway` (the `socket` publish protocol) re-checks run ownership and
    // takes its snapshot through `IWorkflowExposureService.getRunStatus`, the SSE route's own
    // pre-stream check.
    WorkflowExposureServiceModule,
  ],
  controllers: [TranscriptionJobController, AdminTranscriptionJobController, TextProxyController, TextProxyRedirectShimController],
  // SessionRemovalRetryService resolves
  // `StreamingSessionService` from StreamingSessionServiceModule above and
  // `IRedisCacheService` from the @Global() RedisCacheModule registration.
  providers: [SttWsGateway, SessionRemovalRetryService, WorkflowWsGateway],
  exports: [SttWsGateway, WorkflowWsGateway],
})
export class StreamingModule {}
