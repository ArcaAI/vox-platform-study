import { Module } from '@nestjs/common';
import { AsrLanguageCapabilityServiceModule, WorkflowDefinitionServiceModule, WorkflowExposureServiceModule } from '@arcaai/applications';
import { WorkflowDefinitionController } from './workflow-definition.controller';

@Module({
  // TASK-864: `WorkflowExposureServiceModule` supplies `IWorkflowExposureService` for the
  // inbound webhook secret rotation route.
  // TASK-1004 — `AsrLanguageCapabilityService` for the advisory language warnings on publish.
  imports: [WorkflowDefinitionServiceModule, WorkflowExposureServiceModule, AsrLanguageCapabilityServiceModule],
  controllers: [WorkflowDefinitionController],
})
export class WorkflowDefinitionModule {}
