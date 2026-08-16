import { Module } from '@nestjs/common';
import { WorkflowTestFixtureServiceModule } from '@arcaai/applications';
import { WorkflowTestFixtureController } from './workflow-test-fixture.controller';

@Module({
  imports: [WorkflowTestFixtureServiceModule],
  controllers: [WorkflowTestFixtureController],
})
export class WorkflowTestFixtureModule {}
