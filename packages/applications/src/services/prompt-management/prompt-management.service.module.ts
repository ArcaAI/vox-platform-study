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

@Module({
  // TASK-328 A4 — HttpModule + ConfigModule wire the SMR/text-generation client
  // used by the prompt-test endpoint (mirrors SummaryServiceModule).
  // TASK-356 D-7 — HarnessPolicyServiceModule supplies the SMR-selection resolver.
  // TASK-356 Phase 6 — UserProfileServiceModule supplies the preferred-template write.
  imports: [CommonServiceModule, CoreDatabaseModule, DepartmentServiceModule, ConfigModule, HttpModule, HarnessPolicyServiceModule, UserProfileServiceModule],
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
