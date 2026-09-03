import { AiRoutingPolicyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AiRoutingPolicyAdminController } from './ai-routing-policy-admin.controller';

/**
 * AiRoutingPolicyModule — mounts the `/admin/routing-policies` surface
 * ( `AiRoutingPolicyService` (tenant → SYSTEM resolution, the
 * three hard gates, the supersede-only lifecycle and its audit trail)
 * comes from `@arcaai/applications`; `ClsService` resolves from its global
 * module.
 */
@Module({
  imports: [AiRoutingPolicyServiceModule],
  controllers: [AiRoutingPolicyAdminController],
})
export class AiRoutingPolicyModule {}
