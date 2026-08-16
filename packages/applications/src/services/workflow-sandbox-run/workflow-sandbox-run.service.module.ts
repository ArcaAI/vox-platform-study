import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { HarnessGatewayServiceModule } from '../consultation/harness/harness-gateway.service.module';
import { WorkflowDefinitionServiceModule } from '../workflow-definition';
import { WorkflowRunServiceModule } from '../workflow-run';
import { IWorkflowSandboxRunService } from './IWorkflowSandboxRunService';
import { WorkflowSandboxRunService } from './workflow-sandbox-run.service';

/**
 * WorkflowSandboxRunService DI module (TASK-721 Phase C).
 *
 * - CommonServiceModule          -> `IS3Service` (claim-check blob write).
 * - CoreDatabaseModule           -> `WorkflowTestFixtureRepository`.
 * - HarnessGatewayServiceModule  -> the outbound harness dispatcher client.
 * - WorkflowDefinitionServiceModule -> `IWorkflowDefinitionService` (fresh compile of the
 *   tested version's graph, DRAFT included).
 * - WorkflowRunServiceModule     -> `IWorkflowRunService` (the read-model / ownership-anchor
 *   writes; also the `admin/workflow-runs` list's `includeSandbox` exclusion point).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, HarnessGatewayServiceModule, WorkflowDefinitionServiceModule, WorkflowRunServiceModule],
  providers: [
    WorkflowSandboxRunService,
    {
      provide: IWorkflowSandboxRunService,
      // useExisting, not useClass — useClass would construct a second
      // WorkflowSandboxRunService instance instead of aliasing the one above.
      useExisting: WorkflowSandboxRunService,
    },
  ],
  exports: [IWorkflowSandboxRunService, WorkflowSandboxRunService],
})
export class WorkflowSandboxRunServiceModule {}
