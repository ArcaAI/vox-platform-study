import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { LoopConfigService } from './loop-config.service';
import { ILoopConfigService } from './ILoopConfigService';

/**
 * LoopConfigService DI module —.
 *
 * Domain-repository wiring (no HTTP, no Redis): `CoreDatabaseModule`
 * supplies `ConsultationRepository`, `DepartmentAgentRepository`,
 * `DepartmentAgentVersionRepository`, `ConsultationContextSchemaRepository`
 * and `ConsultationContextSchemaVersionRepository`, all already registered
 * there.
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
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule, CommonServiceModule],
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
