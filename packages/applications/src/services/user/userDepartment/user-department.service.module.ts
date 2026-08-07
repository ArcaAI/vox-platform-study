import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { UserDepartmentService } from './user-department.service';
import { IUserDepartmentService } from './IUserDepartmentService';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    UserDepartmentService,
    {
      provide: IUserDepartmentService,
      // useExisting, not useClass — useClass would construct a second
      // UserDepartmentService instance instead of aliasing the one above. No
      // cache/listener/timer state here, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: UserDepartmentService,
    },
  ],
  exports: [IUserDepartmentService, UserDepartmentService],
})
export class UserDepartmentServiceModule {}
