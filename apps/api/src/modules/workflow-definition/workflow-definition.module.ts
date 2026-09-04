import { Module } from '@nestjs/common';
import { WorkflowDefinitionServiceModule, WorkflowExposureServiceModule } from '@arcaai/applications';
import { WorkflowDefinitionController } from './workflow-definition.controller';

@Module({
  // TASK-864: `WorkflowExposureServiceModule` supplies `IWorkflowExposureService` for the
  // inbound webhook secret rotation route.
  imports: [WorkflowDefinitionServiceModule, WorkflowExposureServiceModule],
  controllers: [WorkflowDefinitionController],
})
export class WorkflowDefinitionModule {}
