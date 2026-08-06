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

@Module({
  // HarnessAuditServiceModule supplies the WORM audit trail
  // used by approveSummary's attestation gate (ATTEST event on signing).
  // HarnessGatewayServiceModule (Lane G) supplies the outbound sign-off signal.
  // HarnessPolicyServiceModule supplies the SMR-selection resolver.
  // EntitlementsServiceModule supplies the monthlySummaries meter.
  // AiTaskDefaultServiceModule supplies the nlp.ner model-injection resolver
  // for extractEntities (TASK-552 Lane A).
  // UsageLedgerServiceModule supplies IUsageLedgerService: WS-D uses it so a
  // generated summary's token consumption is recorded in the same
  // transaction as its SummaryMeta, and WS-E uses it for the ner.extract
  // usage row extractEntities emits (TASK-615).
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
    // §2C/§2D — resolves the @Optional IAgentTrajectoryService emitter
    // dep so a summary generation records its LLM_CALL trajectory step.
    AgentTrajectoryServiceModule,
    AiTaskDefaultServiceModule,
    UsageLedgerServiceModule,
  ],
  providers: [
    {
      provide: ISummaryService,
      useClass: SummaryService,
    },
    PromptAssemblyService,
    SummaryService,
  ],
  exports: [ISummaryService, SummaryService],
})
export class SummaryServiceModule {}
