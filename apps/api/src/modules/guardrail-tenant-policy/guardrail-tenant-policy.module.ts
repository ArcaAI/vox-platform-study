import { GuardrailAvailabilityServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { GuardrailRuleTestController } from './guardrail-rule-test.controller';
import { GuardrailTenantPolicyController } from './guardrail-tenant-policy.controller';

/**
 * TASK-1050 — the tenant on/off plane of `TenantGuardrailPolicy`. Mounted through
 * `GuardrailAvailabilityModule` (its sibling plane), so the app module needs no change.
 */
@Module({
  imports: [GuardrailAvailabilityServiceModule],
  controllers: [GuardrailTenantPolicyController, GuardrailRuleTestController],
})
export class GuardrailTenantPolicyModule {}
