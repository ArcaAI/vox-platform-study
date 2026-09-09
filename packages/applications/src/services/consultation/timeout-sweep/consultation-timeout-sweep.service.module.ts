import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { RedisCacheModule } from '../../baseServices/redis';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { ConsultationServiceModule } from '../consultation/consultation.service.module';
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
 *
 * TASK-932 OD-9 added the RECORDING leg, which needs two more:
 * - `RedisCacheModule` -> `IRedisCacheService` (the live-summary lock check).
 *   `@Global()` once registered, but imported explicitly here so this module
 *   is self-contained if loaded in isolation — matches every other consumer
 *   (`HarnessProgressServiceModule`, `WorkflowExposureServiceModule`, ...).
 * - `ConsultationServiceModule` -> `IConsultationService` (the real
 *   `stopRecording` path a client uses). No cycle: `ConsultationServiceModule`
 *   imports neither this module nor anything leading back to it (its own
 *   module doc records the same check for `ConsentServiceModule`).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, HarnessAuditServiceModule, RedisCacheModule.register(), ConsultationServiceModule],
  providers: [ConsultationTimeoutSweepService],
  exports: [ConsultationTimeoutSweepService],
})
export class ConsultationTimeoutSweepServiceModule {}
