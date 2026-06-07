import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { HarnessObservabilityServiceModule, HarnessPolicyServiceModule } from '@arcaai/applications';
import { HarnessAdminController } from './harness-admin.controller';
import { HarnessOpsClient } from './harness-ops.client';

/**
 * HarnessAdminModule (TASK-330 Phase 6) — mounts the `/admin/harness/*` surface.
 * HttpModule + ConfigModule back the outbound `HarnessOpsClient` (Temporal proxy);
 * the policy + observability services come from `@arcaai/applications`.
 * `SecretsService` (for the `X-Service-Token`) and `ClsService` resolve from
 * their globally-registered modules.
 */
@Module({
  imports: [HttpModule, ConfigModule, HarnessPolicyServiceModule, HarnessObservabilityServiceModule],
  controllers: [HarnessAdminController],
  providers: [HarnessOpsClient],
})
export class HarnessAdminModule {}
