import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AgentAssignmentServiceModule } from '../agent-assignment/agent-assignment.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { AgentServiceModule } from './agent.service.module';
import { TtsAgentResolverService } from './tts-agent-resolver.service';

/**
 * TASK-879 — supplies `TtsAgentResolverService` to the three speech entry points (the HTTP
 * synthesize proxy, the WS-duplex gateway, and the harness's internal `agentic.tts` route).
 * Imports the ONE agent resolver (TASK-863) and the ONE credential/connection plane (TASK-862)
 * rather than re-deriving either; the model registry comes with `CoreDatabaseModule`, which
 * `CoreDatabaseModule` supplies directly.
 */
@Module({
  imports: [AgentServiceModule, AgentAssignmentServiceModule, AiProviderConnectionServiceModule, CoreDatabaseModule],
  providers: [TtsAgentResolverService],
  exports: [TtsAgentResolverService],
})
export class TtsAgentResolverServiceModule {}
