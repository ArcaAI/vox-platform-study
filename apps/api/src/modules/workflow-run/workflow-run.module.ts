import { WorkflowRunServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { WorkflowRunController } from './workflow-run.controller';

/**
 * WorkflowRunModule — the `/admin/workflow-runs/*` tenant-scoped
 * runs/observability read plane.
 *
 * `WorkflowRunServiceModule` supplies `IWorkflowRunService`. `ClsService` is
 * global.
 */
@Module({
  imports: [WorkflowRunServiceModule],
  controllers: [WorkflowRunController],
})
export class WorkflowRunModule {}
