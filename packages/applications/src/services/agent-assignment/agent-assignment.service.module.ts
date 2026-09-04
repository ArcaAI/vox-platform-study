import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IAgentAssignmentService } from './IAgentAssignmentService';
import { AgentAssignmentService } from './agent-assignment.service';

/** AgentAssignmentService DI module (the WorkflowAssignmentServiceModule shape). */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [AgentAssignmentService, { provide: IAgentAssignmentService, useExisting: AgentAssignmentService }],
  exports: [IAgentAssignmentService, AgentAssignmentService],
})
export class AgentAssignmentServiceModule {}
