import { Module } from '@nestjs/common';
import { ConsultationService } from './consultation.service';
import { IConsultationService } from './IConsultationService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { ConsultationWorkflowDispatchServiceModule } from '../workflow-dispatch/consultation-workflow-dispatch.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';

@Module({
  // TASK-711 — HarnessAuditServiceModule resolves the @Optional
  // HarnessAuditService WORM append; EffectiveSettingsModule resolves the
  // @Optional TenantSettingsService kill-switch read.
  // TASK-789 C-1: ConsultationWorkflowDispatchServiceModule supplies the optional
  // IConsultationWorkflowDispatchService that `getOrCreate` calls on create.
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    EntitlementsServiceModule,
    HarnessAuditServiceModule,
    EffectiveSettingsModule,
    ConsultationWorkflowDispatchServiceModule,
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
