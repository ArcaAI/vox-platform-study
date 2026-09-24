import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { InferenceEngineServiceModule } from '../inference-engine/inference-engine.service.module';
import { PlatformMetricsServiceModule } from '../platform-metrics/platform-metrics.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { AsrAgentResolverServiceModule } from '../stt/agent-resolver/asr-agent-resolver.service.module';
import { ImplicitLivePathReader } from './implicit-live-path';
import { IModelResidencyService } from './IModelResidencyService';
import { ModelResidencyService } from './model-residency.service';
import { ResidencyAgentClient } from './residency-agent.client';
import { ResidencyLoadSpecBuilder } from './residency-load-spec.builder';

/**
 * TASK-1005 — DI for the model-residency controller.
 *
 * Imports, each for exactly one fact:
 *  - `InferenceEngineServiceModule` — the ONE `LmStudioEngineClient`, so the
 *    adapter's per-engine load lock is shared with the LM Studio serving routes
 *    instead of each module holding its own.
 *  - `PlatformMetricsServiceModule` — `IPrometheusQueryService` (DCGM per-device
 *    memory, the per-model request series).
 *  - `EffectiveSettingsModule` — the `residency.*` SYSTEM knobs.
 *  - `AsrAgentResolverServiceModule` — the one producer of `ResolvedAsrSpec`,
 *    which an stt load sends as its `load_spec`.
 *  - `CoreDatabaseModule` — `ModelResidencyPolicyRepository`, the catalogue and
 *    the agent/assignment reads of the implicit live path.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    InferenceEngineServiceModule,
    PlatformMetricsServiceModule,
    EffectiveSettingsModule,
    AsrAgentResolverServiceModule,
  ],
  providers: [
    ResidencyAgentClient,
    ImplicitLivePathReader,
    ResidencyLoadSpecBuilder,
    { provide: IModelResidencyService, useClass: ModelResidencyService },
  ],
  exports: [IModelResidencyService],
})
export class ModelResidencyServiceModule {}
