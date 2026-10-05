import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ConsultationEncounterService } from './consultation-encounter.service';
import { IConsultationEncounterServiceToken } from './IConsultationEncounterService';

/**
 * The encounters of a consultation episode. No dependency on the consultation or lifecycle
 * services, so both may import this module without a cycle.
 */
@Module({
  // EffectiveSettingsModule resolves the @Optional TenantSettingsService (auto-close and reopen
  // policy, tenant time zone).
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule],
  providers: [ConsultationEncounterService, { provide: IConsultationEncounterServiceToken, useExisting: ConsultationEncounterService }],
  exports: [IConsultationEncounterServiceToken, ConsultationEncounterService],
})
export class ConsultationEncounterServiceModule {}
