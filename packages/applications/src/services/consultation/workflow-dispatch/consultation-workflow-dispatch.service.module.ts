import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { WorkflowDefinitionServiceModule } from '../../workflow-definition/workflow-definition.service.module';
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
 * - WorkflowDefinitionServiceModule -> `SttPipelineResolverService` (TASK-790 W4). That module's
 *   own comment called its consumer "a FUTURE, separate wiring pass"; this is that pass — the
 *   resolver had no production injector at all until now (TASK-789 H-5).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    WorkflowAssignmentServiceModule,
    WorkflowRunServiceModule,
    HarnessGatewayServiceModule,
    WorkflowDefinitionServiceModule,
  ],
  providers: [
    ConsultationWorkflowDispatchService,
    { provide: IConsultationWorkflowDispatchService, useExisting: ConsultationWorkflowDispatchService },
  ],
  exports: [IConsultationWorkflowDispatchService, ConsultationWorkflowDispatchService],
})
export class ConsultationWorkflowDispatchServiceModule {}
