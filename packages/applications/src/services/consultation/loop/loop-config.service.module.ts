import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { LoopConfigService } from './loop-config.service';
import { ILoopConfigService } from './ILoopConfigService';

/**
 * LoopConfigService DI module —.
 *
 * Domain-repository wiring (no HTTP, no Redis): `CoreDatabaseModule`
 * supplies `ConsultationRepository`, `ConsultationContextSchemaRepository`,
 * `ConsultationContextSchemaVersionRepository` and
 * `WorkflowDefinitionRepository`, all already registered there.
 *
 * `WorkflowAssignmentServiceModule` resolves the `@Optional()`
 * `IWorkflowAssignmentService` the loop config uses to find the GOVERNING
 * definition. Both injections are optional on the service so it can
 * be constructed positionally in tests; wiring the module HERE is what makes
 * the resolution actually happen in the running gateway.
 *
 * Adds the `global-kv` read for the loop's idle bound.
 * `CommonServiceModule` already exports `IAppSettingsService` (the cached read
 * path), which is `TenantSettingsService`'s only dependency, so the resolver is
 * provided LOCALLY rather than by importing `EffectiveSettingsModule` — that
 * module also pulls the pipeline resolver and the AI task-default service, none
 * of which this resolution needs. Same reasoning, and the same shape, as
 * `RateLimitServiceModule`.
 */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, CommonServiceModule, WorkflowAssignmentServiceModule],
  providers: [
    TenantSettingsService,
    LoopConfigService,
    {
      provide: ILoopConfigService,
      useExisting: LoopConfigService,
    },
  ],
  exports: [ILoopConfigService, LoopConfigService],
})
export class LoopConfigServiceModule {}
