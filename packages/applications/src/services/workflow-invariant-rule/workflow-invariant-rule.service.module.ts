import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { IWorkflowInvariantRuleService } from './IWorkflowInvariantRuleService';
import { WorkflowInvariantRuleService } from './workflow-invariant-rule.service';

/**
 * WorkflowInvariantRuleService DI module (b).
 *
 * - CommonServiceModule -> the house baseline every service module imports.
 * - CoreDatabaseModule -> `WorkflowInvariantRuleRepository`.
 */
@Module({
  // TASK-1057 — `ActionConfirmationService` (the platform rationale policy).
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule],
  providers: [WorkflowInvariantRuleService, { provide: IWorkflowInvariantRuleService, useExisting: WorkflowInvariantRuleService }],
  exports: [IWorkflowInvariantRuleService, WorkflowInvariantRuleService],
})
export class WorkflowInvariantRuleServiceModule {}
