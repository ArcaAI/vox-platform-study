import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { ConsultationTimeoutSweepService } from './consultation-timeout-sweep.service';

/**
 * Registers the self-scheduling {@link ConsultationTimeoutSweepService}
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()`
 * (`SchedulerRegistry`), `EventEmitterModule.forRoot()` (`@OnEvent` +
 * sys-event fan-out), and `ClsModule.forRoot()` (per-row tenant binding).
 * `CommonServiceModule` provides `IAppSettingsService`; `CoreDatabaseModule`
 * provides `ConsultationRepository`; `HarnessAuditServiceModule` resolves the
 * `@Optional` `HarnessAuditService` WORM append.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, HarnessAuditServiceModule],
  providers: [ConsultationTimeoutSweepService],
  exports: [ConsultationTimeoutSweepService],
})
export class ConsultationTimeoutSweepServiceModule {}
