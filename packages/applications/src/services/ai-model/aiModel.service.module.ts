import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { InferenceReadinessServiceModule } from '../ai-readiness/inference-readiness.service.module';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { ModelResidencyServiceModule } from '../model-residency/model-residency.service.module';
import { AiModelService } from './aiModel.service';
import { ModelLifecycleService } from './lifecycle/model-lifecycle.service';
import { ModelRegistryOperationsService } from './lifecycle/model-registry-operations.service';
import { ModelUsageReader } from './lifecycle/model-usage.reader';
import { HuggingFaceModelSourceClient } from './publish/huggingface-model-source.client';

/**
 * `AiProviderConnectionServiceModule` supplies the ONE thing the TASK-890
 * tenant catalogue cannot answer for itself: whether a model's provider
 * actually resolves a credential for the calling tenant. The catalogue injects
 * that port `@Optional()` so unit fixtures keep their arity — which means a
 * MISSING import here does not fail the boot, it just makes every cloud and
 * engine model report `connection-resolver-unavailable` forever. Hence this
 * import, and the module test that pins it.
 *
 * No cycle: the connection module imports entitlements → tenant / metering /
 * global-setting, and none of those imports this one. (`effective-config` and
 * three API modules import BOTH, which is fine — they are downstream of each.)
 *
 * `InferenceReadinessServiceModule` supplies the readiness SNAPSHOT the
 * catalogue stamps onto every row (TASK-890 §3.12). Same `@Optional()` posture
 * and the same consequence: without this import every row reports `unknown`
 * forever rather than the platform's last observation. No cycle — the readiness
 * module reads `AiModelRepository` from `CoreDatabaseModule`, never this module.
 *
 * `TenantRepository`, for the plan-tier bound, already comes from
 * `CoreDatabaseModule`.
 */
@Module({
  imports: [
    CoreDatabaseModule,
    EventEmitterModule,
    ClsModule,
    AiProviderConnectionServiceModule,
    InferenceReadinessServiceModule,
    // TASK-1019 — the registry OPERATIONS (register from Hub, usage, unregister,
    // download-missing) and the lifecycle status on the admin reads:
    //   · ModelResidencyServiceModule — the per-service load state (and the unload an unregister issues);
    //   · CommonServiceModule         — `IAppSettingsService`, for the two `modelRegistry.download.*` knobs;
    //   · HttpModule                  — the Hub client's transport;
    //   · the publisher queue         — this module PRODUCES download / unregister jobs (the worker consumes them).
    // No cycle: nothing under the residency module imports this one.
    ModelResidencyServiceModule,
    CommonServiceModule,
    HttpModule,
    BullModule.registerQueue({ name: JobQueue.DownloadAiModel }),
  ],
  providers: [AiModelService, ModelLifecycleService, ModelUsageReader, ModelRegistryOperationsService, HuggingFaceModelSourceClient],
  exports: [AiModelService, ModelLifecycleService, ModelRegistryOperationsService],
})
export class AiModelServiceModule {}
