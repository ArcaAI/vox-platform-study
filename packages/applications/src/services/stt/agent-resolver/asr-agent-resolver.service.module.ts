import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AgentServiceModule } from '../../agent/agent.service.module';
import { AiProviderConnectionServiceModule } from '../../ai-provider-connection/ai-provider-connection.service.module';
import { AsrAgentResolverService } from './asr-agent-resolver.service';
import { GoverningWorkflowAsrReader } from './governing-workflow-asr';

/**
 * TASK-861 — supplies `AsrAgentResolverService` to the STT entry points (native
 * stream/session + batch, v1-compat `start_session`, the agent `transcriptions`
 * route). Imports the ONE agent resolver (TASK-863) and the ONE credential
 * resolver (TASK-862) rather than re-deriving either.
 *
 * TASK-1002 — `GoverningWorkflowAsrReader` (tier 2: the consultation's governing workflow) reads
 * the consultation / workflow-run / workflow-definition / agent repositories, hence
 * `CoreDatabaseModule`.
 */
@Module({
  imports: [AgentServiceModule, AiProviderConnectionServiceModule, CoreDatabaseModule],
  providers: [AsrAgentResolverService, GoverningWorkflowAsrReader],
  exports: [AsrAgentResolverService],
})
export class AsrAgentResolverServiceModule {}
