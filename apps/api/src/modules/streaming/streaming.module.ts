import {
  AiModelServiceModule,
  AiProviderConnectionServiceModule,
  AiRuntimeProfileServiceModule,
  AiTaskDefaultServiceModule,
  EntitlementsServiceModule,
  HarnessPolicyServiceModule,
  PipelineServiceModule,
  PlatformMetricsServiceModule,
  StreamingSessionServiceModule,
  TenantBucketServiceModule,
  TenantServiceModule,
  TenantSttConfigServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
  UsageLedgerServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TenantOwnedResourceModule } from '../../common';
import { AdminTranscriptionJobController } from './admin-transcription-job.controller';
import { SessionRemovalRetryService } from './session-removal-retry.service';
import { SmrProxyController } from './smr-proxy.controller';
import { SttWsGateway } from './stt-ws.gateway';
import { TranscriptionJobController } from './transcription-job.controller';

@Module({
  imports: [
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
    HarnessPolicyServiceModule, // SMR-selection resolver for SmrProxyController
    // Registry-backed providers listings on SmrProxyController:
    // AiModelService lists ENABLED rows per taskType; AiTaskDefaultService
    // resolves the effective `guardrail.validate` default.
    AiModelServiceModule,
    AiTaskDefaultServiceModule,
    // Hyperparameter profile resolver for the SMR proxy's
    // caller-wins, fail-open parameter injection.
    AiRuntimeProfileServiceModule,
    // Tenant BYO cloud-credential resolver for the SMR proxy's
    // cloud-only, minimal-exposure, fail-open `provider_overrides` injection.
    AiProviderConnectionServiceModule,
    // Provides `ISocketRegistryService` so `SttWsGateway`
    // publishes its per-instance open-socket count for the platform aggregate.
    PlatformMetricsServiceModule,
    // Provides `IEntitlementsService` so
    // `TranscriptionJobController` can hard-block over-capacity sessions.
    EntitlementsServiceModule,
    // Exposes `StreamSessionTenantBindingService`
    // to `TranscriptionJobController` so it can bind on create / clear on close.
    TenantOwnedResourceModule,
    // Resolves the caller tenant's STT fallback pointer + BYO provider
    // overrides for `createStreamSession` injection + `switch-to-fallback`.
    TenantSttConfigServiceModule,
    // TASK-615 — `IUsageLedgerService` for `SmrProxyController`'s (WS-D)
    // generate.stream emission AND `StreamingSessionService`'s (WS-C)
    // transcribe.stream emission. Both are constructor-injected at THIS
    // module's level (SmrProxyController is declared directly below;
    // StreamingSessionServiceModule importing it only satisfies its OWN
    // providers, not a sibling controller here) — Nest's module
    // encapsulation means each module that injects the token must import it.
    UsageLedgerServiceModule,
  ],
  controllers: [TranscriptionJobController, AdminTranscriptionJobController, SmrProxyController],
  // SessionRemovalRetryService resolves
  // `StreamingSessionService` from StreamingSessionServiceModule above and
  // `IRedisCacheService` from the @Global() RedisCacheModule registration.
  providers: [SttWsGateway, SessionRemovalRetryService],
  exports: [SttWsGateway],
})
export class StreamingModule {}
