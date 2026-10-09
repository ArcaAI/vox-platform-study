import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { IWorkflowAssignmentService } from './IWorkflowAssignmentService';
import { WorkflowAssignmentService } from './workflow-assignment.service';

/**
 * WorkflowAssignmentService DI module.
 *
 * - CommonServiceModule -> `CORE_DATABASE_SERVICE` (the row edit + its WORM
 *   change row commit in one `baseClient.$transaction`).
 * - CoreDatabaseModule -> `WorkflowAssignment*` + `WorkflowDefinition` +
 *   `Department` repositories.
 */
@Module({
  // TASK-1057 — `ActionConfirmationService` (the platform reason policy).
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule],
  providers: [
    WorkflowAssignmentService,
    {
      provide: IWorkflowAssignmentService,
      // useExisting, not useClass — aliasing the instance above rather than
      // constructing a second one.
      useExisting: WorkflowAssignmentService,
    },
  ],
  exports: [IWorkflowAssignmentService, WorkflowAssignmentService],
})
export class WorkflowAssignmentServiceModule {}
