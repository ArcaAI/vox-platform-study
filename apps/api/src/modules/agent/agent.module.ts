import {
  AgentServiceModule,
  AiProviderConnectionServiceModule,
  AsrAgentResolverServiceModule,
  EntitlementsServiceModule,
  MediaServiceModule,
  TenantTtsConfigServiceModule,
  TranscriptionJobServiceModule,
  TranscriptionRealtimeServiceModule,
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
    TenantTtsConfigServiceModule,
    AiProviderConnectionServiceModule,
    UsageLedgerServiceModule,
    EntitlementsServiceModule,
    TranscriptionJobServiceModule,
    TranscriptionRealtimeServiceModule,
    MediaServiceModule,
    // TASK-861 — the ASR resolution behind `POST /agents/:slug/transcriptions`.
    AsrAgentResolverServiceModule,
  ],
  controllers: [AgentController],
})
export class AgentModule {}
