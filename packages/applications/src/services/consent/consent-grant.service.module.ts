import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ConsentGrantService } from './consent-grant.service';
import { IConsentGrantService } from './IConsentGrantService';
import { ConsultationConsentService } from './consultation-consent.service';
import { IConsultationConsentService } from './IConsultationConsentService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    ConsentGrantService,
    { provide: IConsentGrantService, useExisting: ConsentGrantService },
    ConsultationConsentService,
    { provide: IConsultationConsentService, useExisting: ConsultationConsentService },
  ],
  exports: [IConsentGrantService, ConsentGrantService, IConsultationConsentService, ConsultationConsentService],
})
export class ConsentServiceModule {}
