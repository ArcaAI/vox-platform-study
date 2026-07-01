import { Module } from '@nestjs/common';
import { ConsultationService } from './consultation.service';
import { IConsultationService } from './IConsultationService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    {
      provide: IConsultationService,
      useClass: ConsultationService,
    },
    ConsultationService,
  ],
  exports: [IConsultationService, ConsultationService],
})
export class ConsultationServiceModule {}
