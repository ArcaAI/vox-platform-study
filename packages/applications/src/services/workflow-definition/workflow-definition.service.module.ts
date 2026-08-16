import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { IWorkflowDefinitionService } from './IWorkflowDefinitionService';
import { WorkflowDefinitionService } from './workflow-definition.service';

/**
 * WorkflowDefinitionService DI module (TASK-734).
 *
 * - CommonServiceModule       -> config + globals + `CORE_DATABASE_SERVICE` (the version-mint
 *   transaction in `create()` needs `databaseService.baseClient.$transaction`).
 * - CoreDatabaseModule        -> `WorkflowDefinitionRepository`.
 * - EntitlementsServiceModule -> `IEntitlementsService`, the `maxWorkflowDefinitions` quota
 *   precheck on `create()`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    WorkflowDefinitionService,
    {
      provide: IWorkflowDefinitionService,
      // useExisting, not useClass — useClass would construct a second
      // WorkflowDefinitionService instance instead of aliasing the one above.
      useExisting: WorkflowDefinitionService,
    },
  ],
  exports: [IWorkflowDefinitionService, WorkflowDefinitionService],
})
export class WorkflowDefinitionServiceModule {}
