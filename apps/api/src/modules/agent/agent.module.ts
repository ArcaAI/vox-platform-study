import {
  AgentServiceModule,
  AiProviderConnectionServiceModule,
  AsrAgentResolverServiceModule,
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
  ],
  controllers: [AgentController],
})
export class AgentModule {}
