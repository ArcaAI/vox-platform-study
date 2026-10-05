import { Module } from '@nestjs/common';
import { ConsultationHistoryServiceModule, ConsultationServiceModule, EffectiveSettingsModule } from '@arcaai/applications';
import { ConsultationAccessHelper } from '../consultation/consultation-access.helper';
import { AdminConsultationHistoryController } from './admin-consultation-history.controller';
import { ConsultationHistoryController } from './consultation-history.controller';

/** The consultation history read plane (admin and business). */
@Module({
  // `EffectiveSettingsModule` supplies `TenantSettingsService` to the shared access helper.
  imports: [ConsultationHistoryServiceModule, ConsultationServiceModule, EffectiveSettingsModule],
  providers: [ConsultationAccessHelper],
  controllers: [AdminConsultationHistoryController, ConsultationHistoryController],
})
export class ConsultationHistoryModule {}
