import { Module } from '@nestjs/common';
import {
  TenantServiceModule,
  TenantFrontendConfigServiceModule,
  TenantOnboardingServiceModule,
  PipelineServiceModule,
  TenantReferenceSetServiceModule,
} from '@arcaai/applications';
import { TenantController } from './tenant.controller';
import { MyTenantRedirectShimController } from './my-tenant-redirect.shim.controller';
import { MyTenantController } from './my-tenant.controller';
// Global-admin create-tenant-with-admin (`POST /admin/tenants/provision`).
import { TenantProvisionController } from './tenant-provision.controller';
// Global-admin SYSTEM-template resync (`POST /admin/tenants/:id/pipelines/resync`).
import { TenantPipelineResyncController } from './tenant-pipeline-resync.controller';
// TASK-890 — SYSTEM reference-set re-provisioning (`POST /admin/tenants/:id/reference-set/sync`).
import { TenantReferenceSetController } from './tenant-reference-set.controller';

@Module({
  imports: [
    TenantServiceModule,
    TenantFrontendConfigServiceModule,
    TenantOnboardingServiceModule,
    PipelineServiceModule,
    TenantReferenceSetServiceModule,
  ],
  controllers: [
    TenantController,
    MyTenantController,
    MyTenantRedirectShimController,
    TenantProvisionController,
    TenantPipelineResyncController,
    TenantReferenceSetController,
  ],
})
export class TenantModule {}
