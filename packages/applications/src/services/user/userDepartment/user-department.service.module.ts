import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { UserDepartmentService } from './user-department.service';
import { IUserDepartmentService } from './IUserDepartmentService';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IUserDepartmentService,
      useClass: UserDepartmentService,
    },
    UserDepartmentService,
  ],
  exports: [IUserDepartmentService, UserDepartmentService],
})
export class UserDepartmentServiceModule {}
