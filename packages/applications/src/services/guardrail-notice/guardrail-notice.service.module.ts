import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { HarnessAuditServiceModule } from '../harness-audit/harness-audit.service.module';
import { HarnessGatewayServiceModule } from '../consultation/harness/harness-gateway.service.module';
import { ConsultationLifecycleGateModule } from '../consultation/lifecycle/lifecycle.module';
import { ConsultationWorkflowDispatchServiceModule } from '../consultation/workflow-dispatch/consultation-workflow-dispatch.service.module';
import { GuardrailNoticeService } from './guardrail-notice.service';
import { IGuardrailNoticeService } from './IGuardrailNoticeService';

/**
 * TASK-1050 W2e — the consultation's guardrail notices: list, acknowledge, resume a hold.
 *
 * - `ConsultationLifecycleGateModule` → the lifecycle event publisher (the release event);
 * - `HarnessAuditServiceModule` → the `SAFETY_OVERRIDE` WORM row of an `acknowledged` resume;
 * - `HarnessGatewayServiceModule` → the signal that releases a run paused at the blocked node;
 * - `ConsultationWorkflowDispatchServiceModule` → the supersede fallback when no run is paused.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConsultationLifecycleGateModule,
    HarnessAuditServiceModule,
    HarnessGatewayServiceModule,
    ConsultationWorkflowDispatchServiceModule,
  ],
  providers: [GuardrailNoticeService, { provide: IGuardrailNoticeService, useExisting: GuardrailNoticeService }],
  exports: [IGuardrailNoticeService, GuardrailNoticeService],
})
export class GuardrailNoticeServiceModule {}
