import { AgentAssignmentServiceModule, AgentServiceModule, AsrLanguageCapabilityServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AgentAdminController } from './agent-admin.controller';
import { AgentAssignmentAdminController } from './agent-assignment-admin.controller';

/** `/admin/agents/**` + `/admin/agent-assignments/**` (TASK-863). */
@Module({
  // AgentServiceModule imports the assignment module for its own resolver but does not re-export
  // it, so AgentAssignmentAdminController's IAgentAssignmentService must be imported here —
  // Nest cannot resolve it transitively and the gateway refused to boot (route-manifest emit).
  // TASK-1004 — `AsrLanguageCapabilityService` for the advisory language warnings on ASR
  // assignments and publishes.
  imports: [AgentServiceModule, AgentAssignmentServiceModule, AsrLanguageCapabilityServiceModule],
  controllers: [AgentAdminController, AgentAssignmentAdminController],
})
export class AgentAdminModule {}
