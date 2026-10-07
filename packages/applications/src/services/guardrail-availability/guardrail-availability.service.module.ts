import { CoreDatabaseModule } from '@arcaai/domains';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { GovernedPromptServiceModule } from '../governed-prompt/governed-prompt.service.module';
import { GuardrailAvailabilityService } from './guardrail-availability.service';
import { GuardrailPolicyChangePublisher } from './guardrail-policy-change.publisher';
import { GuardrailRuleTestService, IGuardrailRuleTestService } from './guardrail-rule-test.service';
import { GuardrailTenantPolicyService } from './guardrail-tenant-policy.service';
import { IGuardrailAvailabilityService } from './IGuardrailAvailabilityService';
import { IGuardrailTenantPolicyService } from './IGuardrailTenantPolicyService';

/**
 * Both planes of `TenantGuardrailPolicy`: the platform per-tenant control and (TASK-1050) the tenant's
 * own on/off route. `GovernedPromptServiceModule` is a leaf module (no cycle); it supplies the
 * governed-prompt re-screen the change publisher schedules after a write (TASK-1049 F2).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, GovernedPromptServiceModule, ConfigModule, HttpModule],
  providers: [
    GuardrailPolicyChangePublisher,
    { provide: IGuardrailAvailabilityService, useClass: GuardrailAvailabilityService },
    { provide: IGuardrailTenantPolicyService, useClass: GuardrailTenantPolicyService },
    // TASK-1050 round 2 — the playground's "Test my rules" (`POST admin/guardrail/screen`).
    { provide: IGuardrailRuleTestService, useClass: GuardrailRuleTestService },
  ],
  exports: [IGuardrailAvailabilityService, IGuardrailTenantPolicyService, IGuardrailRuleTestService],
})
export class GuardrailAvailabilityServiceModule {}
