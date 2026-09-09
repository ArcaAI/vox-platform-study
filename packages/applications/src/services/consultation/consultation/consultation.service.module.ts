import { Module } from '@nestjs/common';
import { ConsultationService } from './consultation.service';
import { IConsultationService } from './IConsultationService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { ConsultationWorkflowDispatchServiceModule } from '../workflow-dispatch/consultation-workflow-dispatch.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ConsentServiceModule } from '../../consent/consent-grant.service.module';
import { AuthorizationModule } from '../../../authorization/authorization.module';

@Module({
  // HarnessAuditServiceModule resolves the @Optional
  // HarnessAuditService WORM append; EffectiveSettingsModule resolves the
  // @Optional TenantSettingsService kill-switch read.
  // ConsultationWorkflowDispatchServiceModule supplies the optional
  // IConsultationWorkflowDispatchService that `getOrCreate` calls on create.
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    EntitlementsServiceModule,
    HarnessAuditServiceModule,
    EffectiveSettingsModule,
    ConsultationWorkflowDispatchServiceModule,
    // supplies IConsentGrantService so `getOrCreate` can record the
    // consent the doctor gives by opening the consultation. No cycle:
    // ConsentServiceModule imports neither this module nor anything that leads
    // back to it.
    ConsentServiceModule,
    // TASK-933 — `PolicyEngine`, which is what lets `getOrCreate` answer "may the NAMED
    // clinician own a consultation?" from the service. The module is @Global, but it is named
    // here for the same reason `AgentServiceModule` names it: the dependency is load-bearing
    // (absent ⇒ every service-account open is a 404) and an implicit global is not a record of
    // that. No cycle: `AuthorizationModule` imports CoreDatabase, Redis and ApiKey only.
    AuthorizationModule,
  ],
  providers: [
    ConsultationService,
    {
      provide: IConsultationService,
      // useExisting, not useClass — useClass would construct a second
      // ConsultationService instance instead of aliasing the one above. No
      // cache/listener/timer state here, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: ConsultationService,
    },
  ],
  exports: [IConsultationService, ConsultationService],
})
export class ConsultationServiceModule {}
