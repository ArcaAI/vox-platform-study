import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { PromptManagementService } from './prompt-management.service';
import { IPromptManagementService } from './IPromptManagementService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { DepartmentServiceModule } from '../department/department.service.module';
import { HarnessPolicyServiceModule } from '../harness-policy/harness-policy.service.module';
import { UserProfileServiceModule } from '../user/userProfile/userProfile.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { EvalServiceModule } from '../eval/eval.service.module';

@Module({
  // HttpModule + ConfigModule wire the SMR/text-generation client
  // used by the prompt-test endpoint (mirrors SummaryServiceModule).
  // HarnessPolicyServiceModule supplies the SMR-selection resolver.
  // UserProfileServiceModule supplies the preferred-template write.
  // EntitlementsServiceModule supplies the maxPromptTemplates quota check.
  imports: [CommonServiceModule, CoreDatabaseModule, DepartmentServiceModule, ConfigModule, HttpModule, HarnessPolicyServiceModule, UserProfileServiceModule, EntitlementsServiceModule, EvalServiceModule],
  providers: [
    {
      provide: IPromptManagementService,
      useClass: PromptManagementService,
    },
    PromptManagementService,
  ],
  exports: [IPromptManagementService, PromptManagementService],
})
export class PromptManagementServiceModule {}
