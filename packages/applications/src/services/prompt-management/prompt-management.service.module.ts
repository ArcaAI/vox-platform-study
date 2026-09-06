import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { PromptManagementService } from './prompt-management.service';
import { IPromptManagementService } from './IPromptManagementService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { DepartmentServiceModule } from '../department/department.service.module';
import { AgentServiceModule } from '../agent/agent.service.module';
import { TextRequestServiceModule } from '../text-request/text-request.service.module';
import { UserProfileServiceModule } from '../user/userProfile/userProfile.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { EvalServiceModule } from '../eval/eval.service.module';
import { UsageLedgerServiceModule } from '../usageLedger/usage-ledger.service.module';

@Module({
  // HttpModule + ConfigModule wire the TEXT/text-generation client
  // used by the prompt-test endpoint (mirrors SummaryServiceModule).
  // TASK-876: AgentServiceModule supplies `TextAgentResolverService` — the test bench runs on
  // the tenant's ASSIGNED TEXT_GENERATION agent, the same resolution every real generation
  // makes (it used to select through the retired `text.test` AiTaskDefault key). And
  // TextRequestServiceModule supplies the shared tenant-credential + runtime-profile
  // enrichment the TEXT proxy uses.
  // UserProfileServiceModule supplies the preferred-template write.
  // EntitlementsServiceModule supplies the maxPromptTemplates quota check AND
  // (TASK-890 §3.13) the monthlyLlmTokens precheck on a non-dry test run.
  // UsageLedgerServiceModule supplies the finalize-time usage record.
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    DepartmentServiceModule,
    ConfigModule,
    HttpModule,
    AgentServiceModule,
    TextRequestServiceModule,
    UserProfileServiceModule,
    EntitlementsServiceModule,
    EvalServiceModule,
    UsageLedgerServiceModule,
  ],
  providers: [
    PromptManagementService,
    {
      provide: IPromptManagementService,
      // useExisting, not useClass — useClass would construct a second
      // PromptManagementService instance instead of aliasing the one above.
      // Its `textServiceUrl` field is readonly config resolved once in the
      // constructor, not mutable state, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: PromptManagementService,
    },
  ],
  exports: [IPromptManagementService, PromptManagementService],
})
export class PromptManagementServiceModule {}
