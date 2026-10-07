import { GuardrailAvailabilityServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { GuardrailTenantPolicyModule } from '../guardrail-tenant-policy/guardrail-tenant-policy.module';
import { GuardrailAvailabilityController } from './guardrail-availability.controller';

@Module({
  // TASK-1050: the tenant on/off plane (`admin/guardrail/policy`) rides on this module's registration.
  imports: [GuardrailAvailabilityServiceModule, GuardrailTenantPolicyModule],
  controllers: [GuardrailAvailabilityController],
})
export class GuardrailAvailabilityModule {}
