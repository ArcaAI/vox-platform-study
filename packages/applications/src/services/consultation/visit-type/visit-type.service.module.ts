import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../../baseServices';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { VisitTypeService } from './visit-type.service';

/**
 * `VisitTypeService` DI module — the tenant's visit-type catalogue.
 *
 * Deliberately TINY, and provided as a module rather than as a provider copied
 * into eight consumer modules: the visit-type axis is read by prompt
 * resolution, both summary services, both summary processors, the harness
 * assemble path and gate-edit mining, and one shared import is what keeps those
 * eight from drifting into eight slightly different wirings.
 *
 * `CommonServiceModule` already exports `IAppSettingsService` (the cached
 * `GlobalSetting` read), which is `TenantSettingsService`'s only dependency, so
 * the cascade resolver is provided LOCALLY here rather than by importing
 * `EffectiveSettingsModule` — that module also pulls the pipeline resolver, the
 * AI task-default service and `CoreDatabaseModule`, none of which resolving a
 * label set needs. Same shape and same reasoning as `LoopConfigServiceModule`
 * and `RateLimitServiceModule`.
 */
@Module({
  imports: [CommonServiceModule],
  providers: [TenantSettingsService, VisitTypeService],
  exports: [VisitTypeService],
})
export class VisitTypeServiceModule {}
