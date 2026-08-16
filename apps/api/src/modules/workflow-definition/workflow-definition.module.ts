import { Module } from '@nestjs/common';
import { WorkflowDefinitionServiceModule } from '@arcaai/applications';
import { WorkflowDefinitionController } from './workflow-definition.controller';

@Module({
  imports: [WorkflowDefinitionServiceModule],
  controllers: [WorkflowDefinitionController],
})
export class WorkflowDefinitionModule {}
