import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { IAgentAssignmentService } from './IAgentAssignmentService';
import { AgentAssignmentService } from './agent-assignment.service';

/** AgentAssignmentService DI module (the WorkflowAssignmentServiceModule shape). */
@Module({
  // TASK-1057 — `ActionConfirmationService` (the platform reason policy).
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule],
  providers: [AgentAssignmentService, { provide: IAgentAssignmentService, useExisting: AgentAssignmentService }],
  exports: [IAgentAssignmentService, AgentAssignmentService],
})
export class AgentAssignmentServiceModule {}
