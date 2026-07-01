import { Module } from '@nestjs/common';
import { UserRoleAssignmentService } from './userRoleAssignment.service';
import { IUserRoleAssignmentService } from './IUserRoleAssignmentService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';

// TODO: Implement this

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    {
      provide: IUserRoleAssignmentService,
      useClass: UserRoleAssignmentService,
    },
  ],
  exports: [IUserRoleAssignmentService],
})
export class UserRoleAssignmentServiceModule {}
