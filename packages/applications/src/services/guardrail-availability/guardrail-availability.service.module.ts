import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { GovernedPromptServiceModule } from '../governed-prompt/governed-prompt.service.module';
import { GuardrailAvailabilityService } from './guardrail-availability.service';
import { GuardrailPolicyChangePublisher } from './guardrail-policy-change.publisher';
import { GuardrailTenantPolicyService } from './guardrail-tenant-policy.service';
import { IGuardrailAvailabilityService } from './IGuardrailAvailabilityService';
import { IGuardrailTenantPolicyService } from './IGuardrailTenantPolicyService';

/**
 * Both planes of `TenantGuardrailPolicy`: the platform per-tenant control and (TASK-1050) the tenant's
 * own on/off route. `GovernedPromptServiceModule` is a leaf module (no cycle); it supplies the
 * governed-prompt re-screen the change publisher schedules after a write (TASK-1049 F2).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, GovernedPromptServiceModule],
  providers: [
    GuardrailPolicyChangePublisher,
    { provide: IGuardrailAvailabilityService, useClass: GuardrailAvailabilityService },
    { provide: IGuardrailTenantPolicyService, useClass: GuardrailTenantPolicyService },
  ],
  exports: [IGuardrailAvailabilityService, IGuardrailTenantPolicyService],
})
export class GuardrailAvailabilityServiceModule {}
