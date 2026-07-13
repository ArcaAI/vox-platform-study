import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IdpResolverServiceModule } from '../idp-resolver/idp-resolver.service.module';
import { UserServiceModule } from '../user/user/user.service.module';
import { UserRoleAssignmentServiceModule } from '../user/userRoleAssignment/userRoleAssignment.service.module';
import { UserDepartmentServiceModule } from '../user/userDepartment/user-department.service.module';
import { UserProfileServiceModule } from '../user/userProfile/userProfile.service.module';
import { FederatedAuthService } from './federated-auth.service';

@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    IdpResolverServiceModule,
    UserServiceModule,
    UserRoleAssignmentServiceModule,
    UserDepartmentServiceModule,
    UserProfileServiceModule,
  ],
  providers: [FederatedAuthService],
  exports: [FederatedAuthService],
})
export class FederatedAuthServiceModule {}
