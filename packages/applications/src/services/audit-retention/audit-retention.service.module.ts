import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AuditRetentionService } from './audit-retention.service';

/**
 * Registers the self-scheduling {@link AuditRetentionService}.
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()` (SchedulerRegistry)
 * and `EventEmitterModule.forRoot()` (@OnEvent). `CommonServiceModule` provides
 * `IAppSettingsService`; `CoreDatabaseModule` provides the `CORE_DATABASE_SERVICE`
 * token used for the unscoped retention delete.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [AuditRetentionService],
  exports: [AuditRetentionService],
})
export class AuditRetentionServiceModule {}
