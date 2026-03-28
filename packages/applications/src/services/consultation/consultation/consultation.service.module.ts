import { Module } from '@nestjs/common';
import { ConsultationService } from './consultation.service';
import { IConsultationService } from './IConsultationService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
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
