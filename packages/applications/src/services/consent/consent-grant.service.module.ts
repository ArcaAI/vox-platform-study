import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { HarnessAuditServiceModule } from '../harness-audit';
import { ConsentGrantService } from './consent-grant.service';
import { IConsentGrantService } from './IConsentGrantService';
import { ConsultationConsentService } from './consultation-consent.service';
import { IConsultationConsentService } from './IConsultationConsentService';

@Module({
  // HarnessAuditServiceModule supplies the WORM audit trail
  // (`CONSENT_GIVEN`/`CONSENT_WITHDRAWN` — TASK-712 Phase 4 follow-up).
  imports: [CommonServiceModule, CoreDatabaseModule, HarnessAuditServiceModule],
  providers: [
    ConsentGrantService,
    { provide: IConsentGrantService, useExisting: ConsentGrantService },
    ConsultationConsentService,
    { provide: IConsultationConsentService, useExisting: ConsultationConsentService },
  ],
  exports: [IConsentGrantService, ConsentGrantService, IConsultationConsentService, ConsultationConsentService],
})
export class ConsentServiceModule {}
