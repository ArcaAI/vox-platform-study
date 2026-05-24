import { Module } from '@nestjs/common';
import { PromptManagementService } from './prompt-management.service';
import { IPromptManagementService } from './IPromptManagementService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { DepartmentServiceModule } from '../department/department.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, DepartmentServiceModule],
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
