import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { WorkflowRunServiceModule } from '../../workflow-run/workflow-run.service.module';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { IConsultationWorkflowDispatchService } from './IConsultationWorkflowDispatchService';
import { ConsultationWorkflowDispatchService } from './consultation-workflow-dispatch.service';

/**
 * Consultation-open workflow dispatch DI module (TASK-789 C-1).
 *
 * - WorkflowAssignmentServiceModule -> the department -> tenant -> platform cascade this ticket
 *   gave its first production caller.
 * - WorkflowRunServiceModule        -> the ownership-anchor row, stamped `'consultation open'`.
 * - HarnessGatewayServiceModule     -> `startWorkflowRun` (the interpreter dispatcher).
 * - CommonServiceModule             -> `IS3Service` for the compiled-config claim check.
 * - CoreDatabaseModule              -> `WorkflowDefinitionRepository`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, WorkflowAssignmentServiceModule, WorkflowRunServiceModule, HarnessGatewayServiceModule],
  providers: [
    ConsultationWorkflowDispatchService,
    { provide: IConsultationWorkflowDispatchService, useExisting: ConsultationWorkflowDispatchService },
  ],
  exports: [IConsultationWorkflowDispatchService, ConsultationWorkflowDispatchService],
})
export class ConsultationWorkflowDispatchServiceModule {}
