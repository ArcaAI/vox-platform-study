import {
  AgentServiceModule,
  AiProviderConnectionServiceModule,
  AsrAgentResolverServiceModule,
  BillingServiceModule,
  CommonServiceModule,
  EntitlementsServiceModule,
  MediaServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
  TenantBucketServiceModule,
  TenantSettingsService,
  TtsAgentResolverServiceModule,
  UsageLedgerServiceModule,
} from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { gatewayKeepAliveAgents } from '../../common';
import { AgentController } from './agent.controller';
import { AgentRunService } from './agent-run.service';

/** `/agents/**` — the Agent business plane (TASK-863 §3.5). */
@Module({
  imports: [
    AgentServiceModule,
    // TASK-993 lane C — keepAlive pooling shared with `speech.module.ts` (both call
    // TTS_URL); see `common/gateway-http-agent.ts` for the sizing rationale.
    HttpModule.register({ timeout: 120000, maxRedirects: 3, ...gatewayKeepAliveAgents }),
    AiProviderConnectionServiceModule,
    UsageLedgerServiceModule,
    EntitlementsServiceModule,
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
    MediaServiceModule,
    // TASK-861 — the ASR resolution behind `POST /agents/:slug/transcriptions`.
    AsrAgentResolverServiceModule,
    // TASK-879 — the TEXT_TO_SPEECH resolution behind `POST /agents/:slug/speech`.
    TtsAgentResolverServiceModule,
    // TASK-957 F-4 — `IBillingService.assertSpendLimit`, the tenant's optional monthly ceiling
    // (D12). Without this import the controller's `@Optional()` injection is always undefined and
    // the three metered routes here stay unbounded, which is exactly the defect F-4 names.
    BillingServiceModule,
    // TASK-959 §3.1 — `IComputeDeviceResolver` (`metering.compute.deviceByProvider`) comes from
    // `UsageLedgerServiceModule` above, which provides its `TenantSettingsService` locally. This
    // module therefore needs no `EffectiveSettingsModule` of its own; the controller reads that
    // descriptor through the shared resolver rather than through a second copy of the cascade.
    // TASK-1038 OD-26 — the agent RUN resource: `CommonServiceModule` brings the settings plane
    // `TenantSettingsService` reads the A2 retention knobs from (provided LOCALLY, the
    // `WorkflowRunCompletionModule` precedent); `IRedisCacheService` is @Global.
    CommonServiceModule,
    // TASK-1036 §3.2 — `ITenantBucketService`, the tenant AUDIO bucket a `delivery: 'blob'`
    // synthesis is stored in (`IBlobStorageService` itself is @Global).
    TenantBucketServiceModule,
  ],
  providers: [TenantSettingsService, AgentRunService],
  controllers: [AgentController],
})
export class AgentModule {}
