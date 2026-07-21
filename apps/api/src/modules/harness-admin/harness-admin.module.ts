import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import {
  EvalServiceModule,
  GateEditMiningServiceModule,
  HarnessObservabilityServiceModule,
  HarnessPolicyServiceModule,
  LiveDocumentationServiceModule,
} from '@arcaai/applications';
import { HarnessAdminController } from './harness-admin.controller';
import { HarnessOpsClient } from './harness-ops.client';

/**
 * HarnessAdminModule — mounts the `/admin/harness/*` surface.
 * HttpModule + ConfigModule back the outbound `HarnessOpsClient` (Temporal proxy);
 * the policy + observability services come from `@arcaai/applications`.
 * `LiveDocumentationServiceModule` backs the `/admin/harness/live/*`
 * console (Redis session stats + engine kill-switch).
 * `EvalServiceModule` backs the `/admin/harness/golden-sets*`
 * dataset surface.
 * `SecretsService` (for the `X-Service-Token`) and `ClsService` resolve from
 * their globally-registered modules.
 */
@Module({
  imports: [
    HttpModule,
    ConfigModule,
    HarnessPolicyServiceModule,
    HarnessObservabilityServiceModule,
    LiveDocumentationServiceModule,
    EvalServiceModule,
    // Backs `/admin/harness/gate-edit-exemplars` (SME-gated
    // eval regression-corpus export from the gate-edit learning loop).
    GateEditMiningServiceModule,
  ],
  controllers: [HarnessAdminController],
  providers: [HarnessOpsClient],
})
export class HarnessAdminModule {}
