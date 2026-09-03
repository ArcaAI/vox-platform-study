import { AgentServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AgentAdminController } from './agent-admin.controller';
import { AgentAssignmentAdminController } from './agent-assignment-admin.controller';

/** `/admin/agents/**` + `/admin/agent-assignments/**` (TASK-863). */
@Module({
  imports: [AgentServiceModule],
  controllers: [AgentAdminController, AgentAssignmentAdminController],
})
export class AgentAdminModule {}
