import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { PromptManagementService } from './prompt-management.service';
import { IPromptManagementService } from './IPromptManagementService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { DepartmentServiceModule } from '../department/department.service.module';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { SmrRequestServiceModule } from '../text-request/text-request.service.module';
import { UserProfileServiceModule } from '../user/userProfile/userProfile.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { EvalServiceModule } from '../eval/eval.service.module';

@Module({
  // HttpModule + ConfigModule wire the SMR/text-generation client
  // used by the prompt-test endpoint (mirrors SummaryServiceModule).
  // BUG-018: AiTaskDefaultServiceModule supplies the `smr.test` model resolver
  // (replacing the harness policy module — the test bench is not harness), and
  // SmrRequestServiceModule supplies the shared tenant-credential + runtime-profile
  // enrichment the SMR proxy uses.
  // UserProfileServiceModule supplies the preferred-template write.
  // EntitlementsServiceModule supplies the maxPromptTemplates quota check.
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    DepartmentServiceModule,
    ConfigModule,
    HttpModule,
    AiTaskDefaultServiceModule,
    SmrRequestServiceModule,
    UserProfileServiceModule,
    EntitlementsServiceModule,
    EvalServiceModule,
  ],
  providers: [
    PromptManagementService,
    {
      provide: IPromptManagementService,
      // useExisting, not useClass — useClass would construct a second
      // PromptManagementService instance instead of aliasing the one above.
      // Its `smrServiceUrl` field is readonly config resolved once in the
      // constructor, not mutable state, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: PromptManagementService,
    },
  ],
  exports: [IPromptManagementService, PromptManagementService],
})
export class PromptManagementServiceModule {}
