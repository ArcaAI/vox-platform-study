import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HarnessGatewayServiceModule } from '../consultation/harness/harness-gateway.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { EvalService } from './eval.service';
import { EvalRunService } from './eval-run.service';
import { EvalPromotionGateService } from './eval-promotion-gate.service';

/**
 * EvalService DI module. Imports CoreDatabaseModule for the
 * GoldenSet/GoldenCase/EvalRun/EvalScore + DepartmentAgent repositories,
 * HarnessGatewayServiceModule for the outbound `/eval/run` call, and
 * EffectiveSettingsModule for the `agentic.eval.promotionGate` mode the gate
 * reads (EventEmitter2/ClsService/SecretsService are globally provided).
 */
@Module({
  imports: [CoreDatabaseModule, HarnessGatewayServiceModule, EffectiveSettingsModule],
  providers: [EvalService, EvalRunService, EvalPromotionGateService],
  exports: [EvalService, EvalRunService, EvalPromotionGateService],
})
export class EvalServiceModule {}
