import { Module } from '@nestjs/common';
import { ChainSummaryService } from './chain-summary.service';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AgentServiceModule } from '../../agent/agent.service.module';
import { UsageLedgerServiceModule } from '../../usageLedger/usage-ledger.service.module';
import { NoteGenerationServiceModule } from '../note-generation/note-generation.service.module';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { AiActivityRunServiceModule } from '../../ai-activity-run/ai-activity-run.service.module';

@Module({
  // UsageLedgerServiceModule supplies IUsageLedgerService so a
  // chain generation's token consumption is recorded with its SummaryMeta.
  imports: [
    // Text run records for chain generations.
    AiActivityRunServiceModule,
    VisitTypeServiceModule,
    CommonServiceModule,
    CoreDatabaseModule,
    // TASK-1006 — the agent plane: `AgentResolverService` (the tenant's TEXT_GENERATION agent) and
    // `AgentInvocationService` (the one invocation, with its credential fold and guardrail decision).
    // It replaces the prompt-assembly / TEXT-selection / TEXT-enrichment modules the direct TEXT call
    // needed.
    AgentServiceModule,
    UsageLedgerServiceModule,
    // seam — always resolves to 'legacy' for this trigger (no
    // harness equivalent); logging-only, never short-circuits generation.
    NoteGenerationServiceModule,
    // TASK-1001 (OD-12) — supplies `EffectiveSettingsService`, through which `ChainSummaryService`
    // resolves `consultation.summary.outputLanguage`. Injected `@Optional()`, so a missing import
    // would leave a platform admin's write silently dead on the chain path.
    EffectiveSettingsModule,
  ],
  providers: [ChainSummaryService],
  exports: [ChainSummaryService],
})
export class ChainSummaryServiceModule {}
