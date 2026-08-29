import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ILiveAgentResolver } from '../live-documentation/live-agent.port';
import { LiveAgentResolutionService } from './live-agent-resolution.service';
import { PromptResolutionServiceModule } from './prompt-resolution.service.module';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';

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
  // `VisitTypeServiceModule` is imported DIRECTLY, not inherited: importing
  // `PromptResolutionServiceModule` does not re-export `VisitTypeService`, so
  // without this line the `@Optional()` injection silently resolves to
  // `undefined` and every live session would resolve the PLATFORM's visit types
  // instead of the tenant's — the kind of miss an `@Optional()` dependency makes
  // invisible at boot. `live-agent-resolution.di-wiring.test.ts` is the guard.
  imports: [CoreDatabaseModule, PromptResolutionServiceModule, VisitTypeServiceModule],
  providers: [{ provide: ILiveAgentResolver, useClass: LiveAgentResolutionService }],
  exports: [ILiveAgentResolver],
})
export class LiveAgentResolutionServiceModule {}
