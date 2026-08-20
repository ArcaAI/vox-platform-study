import {
  AiModelServiceModule,
  AiProviderConnectionServiceModule,
  AiRuntimeProfileServiceModule,
  AiTaskDefaultServiceModule,
  DnaWritingStyleServiceModule,
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
    HarnessPolicyServiceModule, // TEXT-selection resolver for TextProxyController
    // Supplies `IOriginRegistry` to `SttWsGateway`'s CSWSH
    // handshake check. Browsers do NOT apply CORS to WebSockets, so this is the
    // only place the allow-list reaches the socket path. The gateway injects it
    // `@Optional()` and fails CLOSED (TASK-610 reversed the original fail-OPEN
    // posture; see `stt-ws.gateway.ts#isOriginAllowed`), so omitting this
    // import does not break the build — it refuses every browser origin
    // instead. Corrected under TASK-755, which mirrored this wiring into
    // `speech.module.ts`.
    OriginRegistryServiceModule,
    // Registry-backed providers listings on TextProxyController:
    // AiModelService lists ENABLED rows per taskType; AiTaskDefaultService
    // resolves the effective `guardrail.validate` default.
    AiModelServiceModule,
    AiTaskDefaultServiceModule,
    // Hyperparameter profile resolver for the TEXT proxy's
    // caller-wins, fail-open parameter injection.
    AiRuntimeProfileServiceModule,
    // Tenant BYO cloud-credential resolver for the TEXT proxy's
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
    // `IUsageLedgerService` for `TextProxyController`'s
    // generate.stream emission AND `StreamingSessionService`'s
    // transcribe.stream emission. Both are constructor-injected at THIS
    // module's level (TextProxyController is declared directly below;
    // StreamingSessionServiceModule importing it only satisfies its OWN
    // providers, not a sibling controller here) — Nest's module
    // encapsulation means each module that injects the token must import it.
    UsageLedgerServiceModule,
    // TASK-700: supplies `IDnaWritingStyleService` to `TextProxyController` so
    // its `dna_writing_style_id` path routes through the gated
    // `getEffectiveStyleText` accessor instead of reading the (ciphertext-only,
    // ungated) repository row directly.
    DnaWritingStyleServiceModule,
  ],
  controllers: [TranscriptionJobController, AdminTranscriptionJobController, TextProxyController, TextProxyRedirectShimController],
  // SessionRemovalRetryService resolves
  // `StreamingSessionService` from StreamingSessionServiceModule above and
  // `IRedisCacheService` from the @Global() RedisCacheModule registration.
  providers: [SttWsGateway, SessionRemovalRetryService],
  exports: [SttWsGateway],
})
export class StreamingModule {}
