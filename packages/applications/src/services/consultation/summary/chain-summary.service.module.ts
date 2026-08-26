import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ChainSummaryService } from './chain-summary.service';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { ConfigResolverModule } from '../../config-resolver';
import { UsageLedgerServiceModule } from '../../usageLedger/usage-ledger.service.module';
import { NoteGenerationServiceModule } from '../note-generation/note-generation.service.module';
import { GateEditMiningServiceModule } from '../../gate-edit-mining/gate-edit-mining.service.module';
import { TextRequestServiceModule } from '../../text-request/text-request.service.module';

@Module({
  // HarnessPolicyServiceModule supplies the TEXT-selection resolver.
  // ConfigResolverModule supplies the preferred-prompt resolver.
  // UsageLedgerServiceModule supplies IUsageLedgerService so a
  // chain generation's token consumption is recorded with its SummaryMeta.
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    PromptResolutionServiceModule,
    HarnessPolicyServiceModule,
    // TASK-808 — the shared TEXT credential/profile enrichment. TEXT holds no
    // endpoint or credential of its own; without a `provider_overrides` entry it
    // fails closed with 503 PROVIDER_CREDENTIALS_MISSING.
    TextRequestServiceModule,
    ConfigResolverModule,
    UsageLedgerServiceModule,
    // TASK-704 seam — always resolves to 'legacy' for this trigger (no
    // harness equivalent); logging-only, never short-circuits generation.
    NoteGenerationServiceModule,
    // TASK-792 W2 — supplies `IGateEditExemplarRetriever` for the
    // `PromptAssemblyService` provided below; absent ⇒ silent zero-shot.
    GateEditMiningServiceModule,
  ],
  providers: [PromptAssemblyService, ChainSummaryService],
  exports: [ChainSummaryService],
})
export class ChainSummaryServiceModule {}
