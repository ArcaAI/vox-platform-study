import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { PromptManagementService } from './prompt-management.service';
import { IPromptManagementService } from './IPromptManagementService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { DepartmentServiceModule } from '../department/department.service.module';

@Module({
  // TASK-328 A4 — HttpModule + ConfigModule wire the SMR/text-generation client
  // used by the prompt-test endpoint (mirrors SummaryServiceModule).
  imports: [CommonServiceModule, CoreDatabaseModule, DepartmentServiceModule, ConfigModule, HttpModule],
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
