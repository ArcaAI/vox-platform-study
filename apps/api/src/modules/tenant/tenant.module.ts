import { Module } from '@nestjs/common';
import { TenantServiceModule, TenantFrontendConfigServiceModule, TenantOnboardingServiceModule } from '@arcaai/applications';
import { TenantController } from './tenant.controller';
import { MyTenantController } from './my-tenant.controller';
// TASK-497 — global-admin create-tenant-with-admin (`POST /admin/tenants/provision`).
import { TenantProvisionController } from './tenant-provision.controller';

@Module({
  imports: [TenantServiceModule, TenantFrontendConfigServiceModule, TenantOnboardingServiceModule],
  controllers: [TenantController, MyTenantController, TenantProvisionController],
})
export class TenantModule {}
