import { Logger, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AiRoutingPolicyServiceModule } from '../ai-routing-policy/ai-routing-policy.service.module';
import { ModelResidencyServiceModule } from '../model-residency/model-residency.service.module';
import { PlatformMetricsServiceModule } from '../platform-metrics/platform-metrics.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { GuardrailEvaluationReconcilerService } from './guardrail-evaluation-reconciler.service';
import { GuardrailJudgeDryRunClient } from './guardrail-judge-dry-run.client';
import { GuardrailMonitoringService, IGuardrailMonitoringService } from './guardrail-monitoring.service';
import { GUARDRAIL_POLICY_KEY_CATALOGUE, GuardrailPolicyService } from './guardrail-policy.service';
import { IGuardrailPolicyService } from './IGuardrailPolicyService';
import { loadGuardrailPolicyKeyCatalogue } from './policy-key-catalogue';

/**
 * TASK-1050 W2h — DI for the platform guardrail control plane (policy keys, judge mapping, lane selection, dry run,
 * monitoring, the evaluation-gap reconciler).
 *
 * Imports, each for one fact:
 *  - `AiRoutingPolicyServiceModule` — which SYSTEM model a guardrail task key elects, and the lane → model writes;
 *  - `ModelResidencyServiceModule` — the status-only residency read (dry run, lanes, health). Nothing here loads;
 *  - `PlatformMetricsServiceModule` — `IPrometheusQueryService` for the fixed guardrail PromQL;
 *  - `EffectiveSettingsModule` — `TenantSettingsService` for the reconciler window;
 *  - `HttpModule` + `ConfigModule` — the guardrail dry-run call (`GUARDRAIL_URL`).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    AiRoutingPolicyServiceModule,
    ModelResidencyServiceModule,
    PlatformMetricsServiceModule,
    EffectiveSettingsModule,
  ],
  providers: [
    {
      provide: GUARDRAIL_POLICY_KEY_CATALOGUE,
      useFactory: () => {
        const catalogue = loadGuardrailPolicyKeyCatalogue();
        // Boot does not fail on it: the key routes answer 503 GUARDRAIL_POLICY_CATALOGUE_UNAVAILABLE instead.
        if (!catalogue.available || catalogue.problems.length > 0) {
          new Logger('GuardrailPolicyKeyCatalogue').warn({
            message: 'guardrail.policy.catalogue_degraded',
            available: catalogue.available,
            problems: catalogue.problems,
          });
        }
        return catalogue;
      },
    },
    GuardrailJudgeDryRunClient,
    GuardrailPolicyService,
    { provide: IGuardrailPolicyService, useExisting: GuardrailPolicyService },
    GuardrailMonitoringService,
    { provide: IGuardrailMonitoringService, useExisting: GuardrailMonitoringService },
    GuardrailEvaluationReconcilerService,
  ],
  exports: [IGuardrailPolicyService, IGuardrailMonitoringService],
})
export class GuardrailPolicyServiceModule {}
