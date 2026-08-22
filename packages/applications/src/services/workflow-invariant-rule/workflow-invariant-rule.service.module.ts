import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IWorkflowInvariantRuleService } from './IWorkflowInvariantRuleService';
import { WorkflowInvariantRuleService } from './workflow-invariant-rule.service';

/**
 * WorkflowInvariantRuleService DI module (TASK-790 W3b).
 *
 * - CommonServiceModule -> the house baseline every service module imports.
 * - CoreDatabaseModule  -> `WorkflowInvariantRuleRepository`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [WorkflowInvariantRuleService, { provide: IWorkflowInvariantRuleService, useExisting: WorkflowInvariantRuleService }],
  exports: [IWorkflowInvariantRuleService, WorkflowInvariantRuleService],
})
export class WorkflowInvariantRuleServiceModule {}
