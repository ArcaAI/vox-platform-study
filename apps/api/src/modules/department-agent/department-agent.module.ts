import { Module } from '@nestjs/common';
import { DepartmentAgentServiceModule } from '@arcaai/applications';
import { DepartmentAgentController } from './department-agent.controller';
import { DepartmentAgentResyncController } from './department-agent-resync.controller';

@Module({
  imports: [DepartmentAgentServiceModule],
  controllers: [DepartmentAgentController, DepartmentAgentResyncController],
})
export class DepartmentAgentModule {}
