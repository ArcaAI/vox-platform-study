import { UsageAnalyticsServiceModule, WorkflowRunServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { WorkflowRunController } from './workflow-run.controller';

/**
 * WorkflowRunModule — the `/admin/workflow-runs/*` tenant-scoped
 * runs/observability read plane.
 *
 * `WorkflowRunServiceModule` supplies `IWorkflowRunService`;
 * `UsageAnalyticsServiceModule` supplies `IUsageAnalyticsService`, whose
 * `getWorkflowRunCpuSeconds` decorates the run DETAIL read (TASK-959 §3.4).
 * `ClsService` is global.
 */
@Module({
  imports: [WorkflowRunServiceModule, UsageAnalyticsServiceModule],
  controllers: [WorkflowRunController],
})
export class WorkflowRunModule {}
