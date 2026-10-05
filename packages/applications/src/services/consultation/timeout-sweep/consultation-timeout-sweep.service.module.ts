import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ConsultationTimeoutSweepService } from './consultation-timeout-sweep.service';
import { ConsultationLifecycleModule } from '../lifecycle/lifecycle.module';

/**
 * Registers the self-scheduling {@link ConsultationTimeoutSweepService}.
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()` (`SchedulerRegistry`),
 * `EventEmitterModule.forRoot()` (`@OnEvent`) and `ClsModule.forRoot()` (per-row tenant binding).
 * `CommonServiceModule` provides `IAppSettingsService`, `CoreDatabaseModule` provides
 * `ConsultationRepository`, `EffectiveSettingsModule` the tenant -> SYSTEM resolution of the
 * auto-close policy and time zone.
 *
 * `IConsultationLifecycleServiceToken` must be resolvable here: the consultation lifecycle module
 * is imported by the composition root (see the hand-over), not by this module, so the sweep stays
 * free of an import cycle with the lifecycle service.
 */
@Module({
  imports: [ConsultationLifecycleModule, CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule],
  providers: [ConsultationTimeoutSweepService],
  exports: [ConsultationTimeoutSweepService],
})
export class ConsultationTimeoutSweepServiceModule {}
