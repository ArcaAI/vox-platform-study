import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ILiveAgentResolver } from '../live-documentation/live-agent.port';
import { LiveAgentResolutionService } from './live-agent-resolution.service';
import { PromptResolutionServiceModule } from './prompt-resolution.service.module';

/**
 * Provides {@link LiveAgentResolutionService} under the
 * `ILiveAgentResolver` symbol token, so `LiveDocumentationService` depends on
 * the NARROW PORT rather than on a concrete assembly service (C1 DR-3).
 *
 * Kept in its own module (not folded into `PromptResolutionServiceModule`) so
 * importing the prompt chain never drags the live-loop port — and so the live
 * documentation module can opt in explicitly.
 */
@Module({
  imports: [CoreDatabaseModule, PromptResolutionServiceModule],
  providers: [{ provide: ILiveAgentResolver, useClass: LiveAgentResolutionService }],
  exports: [ILiveAgentResolver],
})
export class LiveAgentResolutionServiceModule {}
