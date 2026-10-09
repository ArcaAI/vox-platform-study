import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { PlatformMetricsServiceModule } from '../platform-metrics/platform-metrics.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { AsrAgentResolverServiceModule } from '../stt/agent-resolver/asr-agent-resolver.service.module';
import { ImplicitLivePathReader } from './implicit-live-path';
import { IModelResidencyService } from './IModelResidencyService';
import { ModelResidencyService } from './model-residency.service';
import { ModelUsageIndexReader } from './model-usage-index';
import { ResidencyAgentClient } from './residency-agent.client';
import { ResidencyLoadSpecBuilder } from './residency-load-spec.builder';

/**
 * TASK-1005 — DI for the model-residency controller.
 *
 * Imports, each for exactly one fact (TASK-1055: LM Studio is commanded
 * through its residency agent — `ResidencyAgentClient` — so the REST engine
 * adapter's module is no longer imported here):
 *  - `PlatformMetricsServiceModule` — `IPrometheusQueryService` (DCGM per-device
 *    memory, the per-model request series).
 *  - `EffectiveSettingsModule` — the `residency.*` SYSTEM knobs.
 *  - `AsrAgentResolverServiceModule` — the one producer of `ResolvedAsrSpec`,
 *    which an stt load sends as its `load_spec`.
 *  - `CoreDatabaseModule` — `ModelResidencyPolicyRepository`, the catalogue,
 *    the agent/assignment reads of the implicit live path, and the agent /
 *    fallback / routing-policy / tenant reads of the usage index (§13).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, PlatformMetricsServiceModule, EffectiveSettingsModule, AsrAgentResolverServiceModule],
  providers: [
    ResidencyAgentClient,
    ImplicitLivePathReader,
    ModelUsageIndexReader,
    ResidencyLoadSpecBuilder,
    { provide: IModelResidencyService, useClass: ModelResidencyService },
  ],
  exports: [IModelResidencyService],
})
export class ModelResidencyServiceModule {}
