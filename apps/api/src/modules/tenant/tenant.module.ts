import { Module } from '@nestjs/common';
import { TenantServiceModule, TenantFrontendConfigServiceModule, TenantOnboardingServiceModule, PipelineServiceModule } from '@arcaai/applications';
import { TenantController } from './tenant.controller';
import { MyTenantController } from './my-tenant.controller';
// Global-admin create-tenant-with-admin (`POST /admin/tenants/provision`).
import { TenantProvisionController } from './tenant-provision.controller';
// Global-admin SYSTEM-template resync (`POST /admin/tenants/:id/pipelines/resync`).
import { TenantPipelineResyncController } from './tenant-pipeline-resync.controller';

@Module({
  imports: [TenantServiceModule, TenantFrontendConfigServiceModule, TenantOnboardingServiceModule, PipelineServiceModule],
  controllers: [TenantController, MyTenantController, TenantProvisionController, TenantPipelineResyncController],
})
export class TenantModule {}
