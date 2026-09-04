import { Module } from '@nestjs/common';
import { AgentServiceModule } from '../../agent/agent.service.module';
import { AiProviderConnectionServiceModule } from '../../ai-provider-connection/ai-provider-connection.service.module';
import { AsrAgentResolverService } from './asr-agent-resolver.service';

/**
 * TASK-861 — supplies `AsrAgentResolverService` to the STT entry points (native
 * stream/session + batch, v1-compat `start_session`, the agent `transcriptions`
 * route). Imports the ONE agent resolver (TASK-863) and the ONE credential
 * resolver (TASK-862) rather than re-deriving either.
 */
@Module({
  imports: [AgentServiceModule, AiProviderConnectionServiceModule],
  providers: [AsrAgentResolverService],
  exports: [AsrAgentResolverService],
})
export class AsrAgentResolverServiceModule {}
