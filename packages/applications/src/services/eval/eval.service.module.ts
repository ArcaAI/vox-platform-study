import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PhiRedactionServiceModule } from '../phi-redaction/phi-redaction.service.module';
import { HarnessGatewayServiceModule } from '../consultation/harness/harness-gateway.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { EvalService } from './eval.service';
import { EvalRunService } from './eval-run.service';
import { EvalPromotionGateService } from './eval-promotion-gate.service';
import { GoldenCasePromotionService } from './golden-case-promotion.service';

/**
 * EvalService DI module. Imports CoreDatabaseModule for the
 * GoldenSet/GoldenCase/EvalRun/EvalScore + DepartmentAgent repositories,
 * HarnessGatewayServiceModule for the outbound `/eval/run` call, and
 * EffectiveSettingsModule for the `agentic.eval.promotionGate` mode the gate
 * reads (EventEmitter2/ClsService/SecretsService are globally provided).
 */
@Module({
  // PhiRedactionServiceModule supplies IPhiRedactor for GoldenCasePromotionService,
  // which redacts a consultation transcript fail-closed before it can become
  // eval ground truth.
  imports: [CoreDatabaseModule, HarnessGatewayServiceModule, EffectiveSettingsModule, PhiRedactionServiceModule],
  providers: [EvalService, EvalRunService, EvalPromotionGateService, GoldenCasePromotionService],
  exports: [EvalService, EvalRunService, EvalPromotionGateService, GoldenCasePromotionService],
})
export class EvalServiceModule {}
