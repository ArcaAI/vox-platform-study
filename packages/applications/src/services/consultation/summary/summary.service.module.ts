import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { SummaryService } from './summary.service';
import { ISummaryService } from './ISummaryService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { AgentTrajectoryServiceModule } from '../../agent-trajectory/agent-trajectory.service.module';
import { AiTaskDefaultServiceModule } from '../../ai-task-default/ai-task-default.service.module';
import { UsageLedgerServiceModule } from '../../usageLedger/usage-ledger.service.module';
import { BillingServiceModule } from '../../billing/billing.service.module';
import { NoteGenerationServiceModule } from '../note-generation/note-generation.service.module';

@Module({
  // HarnessAuditServiceModule supplies the WORM audit trail
  // used by approveSummary's attestation gate (ATTEST event on signing).
  // HarnessGatewayServiceModule (Lane G) supplies the outbound sign-off signal.
  // HarnessPolicyServiceModule supplies the SMR-selection resolver.
  // EntitlementsServiceModule supplies the monthlySummaries meter.
  // AiTaskDefaultServiceModule supplies the nlp.ner model-injection resolver
  // for extractEntities.
  // UsageLedgerServiceModule supplies IUsageLedgerService: WS-D uses it so a
  // generated summary's token consumption is recorded in the same
  // transaction as its SummaryMeta, and WS-E uses it for the ner.extract
  // usage row extractEntities emits.
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    PromptResolutionServiceModule,
    HarnessAuditServiceModule,
    HarnessGatewayServiceModule,
    HarnessPolicyServiceModule,
    EntitlementsServiceModule,
    // Resolves the @Optional IAgentTrajectoryService emitter
    // dep so a summary generation records its LLM_CALL trajectory step.
    AgentTrajectoryServiceModule,
    AiTaskDefaultServiceModule,
    UsageLedgerServiceModule,
    // BillingServiceModule supplies IBillingService for the optional
    // spend-limit precheck on LLM generation (402).
    BillingServiceModule,
    // TASK-704 seam — logging-only for generateSummary/generatePreSummary
    // (see summary.service.ts for the HUMAN-GATED note on why sync
    // generateSummary does not short-circuit to harness).
    NoteGenerationServiceModule,
  ],
  providers: [
    PromptAssemblyService,
    SummaryService,
    {
      provide: ISummaryService,
      // useExisting, not useClass — useClass would construct a second
      // SummaryService instance instead of aliasing the one above. Its
      // fields (smrServiceUrl/nlpServiceUrl) are readonly config resolved
      // once in the constructor, not mutable state, so the duplicate was
      // harmless, but aliasing is free.
      useExisting: SummaryService,
    },
  ],
  exports: [ISummaryService, SummaryService],
})
export class SummaryServiceModule {}
