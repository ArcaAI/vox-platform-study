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
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
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
    HarnessPolicyServiceModule, // TASK-356 D-7 — SMR-selection resolver for SmrProxyController
    // TASK-506 — registry-backed providers listings on SmrProxyController:
    // AiModelService lists ENABLED rows per taskType; AiTaskDefaultService
    // resolves the effective `guardrail.validate` default.
    AiModelServiceModule,
    AiTaskDefaultServiceModule,
    // TASK-524 — hyperparameter profile resolver for the SMR proxy's
    // caller-wins, fail-open parameter injection.
    AiRuntimeProfileServiceModule,
    // TASK-526 — tenant BYO cloud-credential resolver for the SMR proxy's
    // cloud-only, minimal-exposure, fail-open `provider_overrides` injection.
    AiProviderConnectionServiceModule,
    // TASK-386 (#5/#17): provides `ISocketRegistryService` so `SttWsGateway`
    // publishes its per-instance open-socket count for the platform aggregate.
    PlatformMetricsServiceModule,
    // TASK-392 (concurrency): provides `IEntitlementsService` so
    // `TranscriptionJobController` can hard-block over-capacity sessions.
    EntitlementsServiceModule,
    // TASK-310 W7.A.9 (AC-3): exposes `StreamSessionTenantBindingService`
    // to `TranscriptionJobController` so it can bind on create / clear on close.
    TenantOwnedResourceModule,
  ],
  controllers: [TranscriptionJobController, AdminTranscriptionJobController, SmrProxyController],
  // TASK-351 P1-3 (M6 part 2): SessionRemovalRetryService resolves
  // `StreamingSessionService` from StreamingSessionServiceModule above and
  // `IRedisCacheService` from the @Global() RedisCacheModule registration.
  providers: [SttWsGateway, SessionRemovalRetryService],
  exports: [SttWsGateway],
})
export class StreamingModule {}
