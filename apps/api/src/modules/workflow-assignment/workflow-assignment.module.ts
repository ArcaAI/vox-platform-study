import { Module } from '@nestjs/common';
import { WorkflowAssignmentServiceModule } from '@arcaai/applications';
import { WorkflowAssignmentController } from './workflow-assignment.controller';

@Module({
  imports: [WorkflowAssignmentServiceModule],
  controllers: [WorkflowAssignmentController],
})
export class WorkflowAssignmentModule {}
