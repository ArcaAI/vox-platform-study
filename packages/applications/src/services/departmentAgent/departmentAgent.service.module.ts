import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { DepartmentAgentService } from './departmentAgent.service';
import { IDepartmentAgentService } from './IDepartmentAgentService';
import { CommonServiceModule } from '../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IDepartmentAgentService,
      useClass: DepartmentAgentService,
    },
    DepartmentAgentService,
  ],
  exports: [IDepartmentAgentService, DepartmentAgentService],
})
export class DepartmentAgentServiceModule {}
