import { GuardrailPolicyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { GuardrailMetricsController } from './guardrail-metrics.controller';
import { GuardrailPolicyController } from './guardrail-policy.controller';

/** TASK-1050 W2h — `admin/guardrail/{policy-keys,judge-models,judge-lanes,dry-run,metrics}`. */
@Module({
  imports: [GuardrailPolicyServiceModule],
  controllers: [GuardrailPolicyController, GuardrailMetricsController],
})
export class GuardrailPolicyModule {}
