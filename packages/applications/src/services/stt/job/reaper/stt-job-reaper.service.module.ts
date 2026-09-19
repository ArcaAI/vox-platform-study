import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';

import { CommonServiceModule } from '../../../baseServices';
import { SttJobReaperService } from './stt-job-reaper.service';

/**
 * TASK-992 — registers the self-scheduling {@link SttJobReaperService}.
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()`
 * (`SchedulerRegistry`), `EventEmitterModule.forRoot()` (`@OnEvent` +
 * sys-event fan-out) and `ClsModule.forRoot()` (per-row tenant binding), the
 * same three {@link ConsultationTimeoutSweepServiceModule} depends on.
 * `CommonServiceModule` provides `IAppSettingsService`; `CoreDatabaseModule`
 * provides `TranscriptionJobRepository`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [SttJobReaperService],
  exports: [SttJobReaperService],
})
export class SttJobReaperServiceModule {}
