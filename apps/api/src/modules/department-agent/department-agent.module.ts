import { Module } from '@nestjs/common';
import { DepartmentAgentServiceModule } from '@arcaai/applications';
import { DepartmentAgentController } from './department-agent.controller';

@Module({
  imports: [DepartmentAgentServiceModule],
  controllers: [DepartmentAgentController],
})
export class DepartmentAgentModule {}
