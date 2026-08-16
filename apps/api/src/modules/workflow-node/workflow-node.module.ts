import { Module } from '@nestjs/common';
import { WorkflowDefinitionServiceModule } from '@arcaai/applications';
import { WorkflowNodeController } from './workflow-node.controller';

@Module({
  imports: [WorkflowDefinitionServiceModule],
  controllers: [WorkflowNodeController],
})
export class WorkflowNodeModule {}
