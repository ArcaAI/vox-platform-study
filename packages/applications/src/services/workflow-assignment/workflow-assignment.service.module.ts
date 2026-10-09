import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ActionConfirmationService } from '../settings-registry/action-confirmation.service';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
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
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    // TASK-1057 — `ActionConfirmationService` (the platform reason policy) is provided LOCALLY, with
    // its stateless `TenantSettingsService` reader, rather than by importing EffectiveSettingsModule:
    // that import puts `effective-settings.module` in flight on the summary module's load path and
    // leaves `GateEditMiningServiceModule` holding an undefined import (summary.di-wiring.task972).
    // Only `mode`/`assert` are used here, so the optional platform write lane is not needed.
    TenantSettingsService,
    ActionConfirmationService,
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
