import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ConsultationTelemetryService } from './consultation-telemetry.service';
import { IConsultationTelemetryService } from './IConsultationTelemetryService';

/**
 * `ConsultationTelemetryService` DI module (TASK-999 Lane B).
 *
 * - `CoreDatabaseModule` supplies all seven repositories the fan-out reads.
 * - `CommonServiceModule` supplies `IAppSettingsService`, which the
 *   `partialSummary` block consults to tell `PRUNED` from `NO_ACTIVITY`.
 *
 * Deliberately depends on NO other application service: this is a read-only
 * projection over existing tables, so injecting (say) `IConsultationService`
 * would buy a cycle and nothing else.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    ConsultationTelemetryService,
    {
      provide: IConsultationTelemetryService,
      // useExisting, not useClass — useClass would construct a second instance
      // instead of aliasing the one above.
      useExisting: ConsultationTelemetryService,
    },
  ],
  exports: [IConsultationTelemetryService, ConsultationTelemetryService],
})
export class ConsultationTelemetryServiceModule {}
