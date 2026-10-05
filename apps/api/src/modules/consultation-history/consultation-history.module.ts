import { Module } from '@nestjs/common';
import { ConsultationHistoryServiceModule, ConsultationServiceModule } from '@arcaai/applications';
import { AdminConsultationHistoryController } from './admin-consultation-history.controller';
import { ConsultationHistoryController } from './consultation-history.controller';

/** The consultation history read plane (admin and business). */
@Module({
  imports: [ConsultationHistoryServiceModule, ConsultationServiceModule],
  controllers: [AdminConsultationHistoryController, ConsultationHistoryController],
})
export class ConsultationHistoryModule {}
