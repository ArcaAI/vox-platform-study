import { Module } from '@nestjs/common';
import {
  TenantServiceModule,
  TenantFrontendConfigServiceModule,
  TenantOnboardingServiceModule,
  TenantReferenceSetServiceModule,
} from '@arcaai/applications';
import { TenantController } from './tenant.controller';
import { MyTenantRedirectShimController } from './my-tenant-redirect.shim.controller';
import { MyTenantController } from './my-tenant.controller';
// Global-admin create-tenant-with-admin (`POST /admin/tenants/provision`).
import { TenantProvisionController } from './tenant-provision.controller';
// TASK-890 — SYSTEM reference-set re-provisioning (`POST /admin/tenants/:id/reference-set/sync`).
import { TenantReferenceSetController } from './tenant-reference-set.controller';

@Module({
  imports: [TenantServiceModule, TenantFrontendConfigServiceModule, TenantOnboardingServiceModule, TenantReferenceSetServiceModule],
  controllers: [TenantController, MyTenantController, MyTenantRedirectShimController, TenantProvisionController, TenantReferenceSetController],
})
export class TenantModule {}
