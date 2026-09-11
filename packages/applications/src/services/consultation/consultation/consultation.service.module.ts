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
import { ConsultationContextSchemaServiceModule } from '../../consultation-context-schema/consultation-context-schema.service.module';
import { ContextUserIdentityServiceModule } from '../../user/identity';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';
import { ContextServiceModule } from '../context/context.service.module';

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
    // TASK-950 §D-6 — the two collaborators `open` needs once a caller may send a schema-typed
    // `context`. Named here (rather than relied on globally) for the same reason
    // `AuthorizationModule` is: both are load-bearing when a context payload arrives — absent,
    // such a request is a 503 — and an implicit provider is not a record of that.
    //
    // No cycle either way: `ConsultationContextSchemaServiceModule` imports only
    // `CommonServiceModule` + `CoreDatabaseModule`, and the identity module owns the user
    // surface, which knows nothing about consultations.
    ConsultationContextSchemaServiceModule,
    ContextUserIdentityServiceModule,
    // TASK-951 §D-3 — `VisitTypeService`, so a caller can STATE its visit type through the
    // schema and have it alias-matched against the one platform vocabulary. The module takes no
    // dependency at all (the tenant catalogue it used to read was retired by TASK-882), so there
    // is nothing here that could close a cycle.
    VisitTypeServiceModule,
    // TASK-951 §D-5 — `IContextService`, so the values validated at open are PERSISTED as context
    // items through the one service that already owns schema pinning, canonical content,
    // encryption, the v1 audit version and the live fan-out. One-way: `ContextServiceModule`
    // imports `CommonServiceModule`, `CoreDatabaseModule` and the context-schema module only,
    // none of which lead back here.
    ContextServiceModule,
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
