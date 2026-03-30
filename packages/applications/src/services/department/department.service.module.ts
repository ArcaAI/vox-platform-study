import { Module } from '@nestjs/common';
import { DepartmentService } from './department.service';
import { IDepartmentService } from './IDepartmentService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IDepartmentService,
      useClass: DepartmentService,
    },
    DepartmentService,
  ],
  exports: [IDepartmentService, DepartmentService],
})
export class DepartmentServiceModule {}
