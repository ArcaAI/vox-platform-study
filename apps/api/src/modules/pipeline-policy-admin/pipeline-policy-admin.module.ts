import { Module } from '@nestjs/common';
import { PipelinePolicyServiceModule } from '@arcaai/applications';
import { PipelinePolicyAdminController } from './pipeline-policy-admin.controller';

/**
 * PipelinePolicyAdminModule (TASK-356 Phase 5 — Pillar B) — mounts the
 * `/admin/harness/pipeline-policy` surface for the realtime-toggle cascade admin.
 * `PipelinePolicyService` (effective resolution + OCC/WORM row writes) comes from
 * `@arcaai/applications`; `ClsService` resolves from its globally-registered module.
 */
@Module({
  imports: [PipelinePolicyServiceModule],
  controllers: [PipelinePolicyAdminController],
})
export class PipelinePolicyAdminModule {}
