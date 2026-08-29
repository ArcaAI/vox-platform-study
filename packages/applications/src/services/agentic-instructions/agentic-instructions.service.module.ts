import { Module } from '@nestjs/common';
import { HarnessPolicyServiceModule } from '../harness-policy/harness-policy.service.module';
import { PromptResolutionServiceModule } from '../consultation/prompt/prompt-resolution.service.module';
import { AgenticInstructionsService } from './agentic-instructions.service';
import { IAgenticInstructionsService } from './IAgenticInstructionsService';
import { VisitTypeServiceModule } from '../consultation/visit-type/visit-type.service.module';

/**
 * AgenticInstructionsService DI module. Imports the
 * two aggregation sources — HarnessPolicyServiceModule (effective policy:
 * thresholds + safety) and PromptResolutionServiceModule (the prompt tier).
 * `EventEmitter2` + `ClsService` come from the globally-registered modules.
 */
@Module({
  imports: [VisitTypeServiceModule, HarnessPolicyServiceModule, PromptResolutionServiceModule],
  providers: [{ provide: IAgenticInstructionsService, useClass: AgenticInstructionsService }],
  exports: [IAgenticInstructionsService],
})
export class AgenticInstructionsServiceModule {}
