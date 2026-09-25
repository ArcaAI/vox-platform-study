import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { WorkflowRunServiceModule } from '../../workflow-run/workflow-run.service.module';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';
import { EffectiveTriggerSchemaModule } from '../../workflow-exposure/effective-trigger-schema.module';
import { IConsultationWorkflowDispatchService } from './IConsultationWorkflowDispatchService';
import { ConsultationWorkflowDispatchService } from './consultation-workflow-dispatch.service';

/**
 * Consultation-open workflow dispatch DI module.
 *
 * - WorkflowAssignmentServiceModule -> the department -> tenant -> platform cascade this ticket
 *   gave its first production caller.
 * - WorkflowRunServiceModule -> the ownership-anchor row, stamped `'consultation open'`.
 * - HarnessGatewayServiceModule -> `startWorkflowRun` (the interpreter dispatcher).
 * - CommonServiceModule -> `IS3Service` for the compiled-config claim check.
 * - CoreDatabaseModule -> `WorkflowDefinitionRepository`.
 * - VisitTypeServiceModule -> `VisitTypeService` (TASK-891), which derives the reserved
 *   `visit-type:<key>` selector tag for the consultation-palette cascade (OD-2/OD-3).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    WorkflowAssignmentServiceModule,
    WorkflowRunServiceModule,
    HarnessGatewayServiceModule,
    VisitTypeServiceModule,
    // The tenant's CURRENT context-schema pin, so a follow-latest trigger dispatches against what
    // the tenant has pinned NOW. The SAME module the exposure plane imports — one resolver, so
    // the two dispatch paths cannot disagree. No cycle: it imports CoreDatabaseModule only.
    EffectiveTriggerSchemaModule,
  ],
  providers: [
    ConsultationWorkflowDispatchService,
    { provide: IConsultationWorkflowDispatchService, useExisting: ConsultationWorkflowDispatchService },
  ],
  exports: [IConsultationWorkflowDispatchService, ConsultationWorkflowDispatchService],
})
export class ConsultationWorkflowDispatchServiceModule {}
