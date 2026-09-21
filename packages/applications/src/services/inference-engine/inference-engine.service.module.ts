import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { PlatformMetricsServiceModule } from '../platform-metrics/platform-metrics.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { IInferenceEngineService } from './IInferenceEngineService';
import { LmStudioEngineClient } from './lmstudio-engine.client';
import { LmStudioServingService } from './lmstudio-serving.service';

/**
 * TASK-996 Phase 3 — DI for the LM Studio serving-control plane.
 *
 * Three imports beyond the usual pair, each for exactly one fact:
 *  - `AiProviderConnectionServiceModule` supplies the engine ADDRESS, which is
 *    `db-config` on the SYSTEM `llm:lm-studio` row and never an env var.
 *  - `PlatformMetricsServiceModule` supplies `IPrometheusQueryService`, the
 *    only per-device VRAM source there is (DCGM).
 *  - `EffectiveSettingsModule` supplies the `lmStudio.serving.*` platform tier.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AiProviderConnectionServiceModule, PlatformMetricsServiceModule, EffectiveSettingsModule],
  providers: [LmStudioEngineClient, { provide: IInferenceEngineService, useClass: LmStudioServingService }],
  exports: [IInferenceEngineService],
})
export class InferenceEngineServiceModule {}
