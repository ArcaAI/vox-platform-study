import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { TenantServiceModule } from '../tenant.service.module';
import { UserServiceModule } from '../../user/user/user.service.module';
import { UserRoleAssignmentServiceModule } from '../../user/userRoleAssignment/userRoleAssignment.service.module';
import { TenantOnboardingService } from './tenantOnboarding.service';
import { ITenantOnboardingService } from './ITenantOnboardingService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, TenantServiceModule, UserServiceModule, UserRoleAssignmentServiceModule],
  providers: [{ provide: ITenantOnboardingService, useClass: TenantOnboardingService }],
  exports: [ITenantOnboardingService],
})
export class TenantOnboardingServiceModule {}
