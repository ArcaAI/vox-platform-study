import {
  AgentServiceModule,
  AiProviderConnectionServiceModule,
  AsrAgentResolverServiceModule,
  BillingServiceModule,
  EffectiveSettingsModule,
  EntitlementsServiceModule,
  MediaServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
  TtsAgentResolverServiceModule,
  UsageLedgerServiceModule,
} from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';

/** `/agents/**` — the Agent business plane (TASK-863 §3.5). */
@Module({
  imports: [
    AgentServiceModule,
    HttpModule.register({ timeout: 120000, maxRedirects: 3 }),
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
    // TASK-959 §3.1 — `TenantSettingsService`, for `metering.compute.deviceByProvider`. Same
    // reason: an unwired cascade would silently take the fallback on every call.
    EffectiveSettingsModule,
  ],
  controllers: [AgentController],
})
export class AgentModule {}
