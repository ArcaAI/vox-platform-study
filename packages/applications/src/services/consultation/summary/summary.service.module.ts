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

@Module({
  // TASK-330 Phase 1 — HarnessAuditServiceModule supplies the WORM audit trail
  // used by approveSummary's attestation gate (ATTEST event on signing).
  // HarnessGatewayServiceModule (Lane G) supplies the outbound sign-off signal.
  // TASK-356 D-7 — HarnessPolicyServiceModule supplies the SMR-selection resolver.
  // TASK-392 Phase 3 — EntitlementsServiceModule supplies the monthlySummaries meter.
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
