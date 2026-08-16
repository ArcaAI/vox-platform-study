import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { WorkflowTestFixtureService } from './workflow-test-fixture.service';
import { IWorkflowTestFixtureService } from './IWorkflowTestFixtureService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [WorkflowTestFixtureService, { provide: IWorkflowTestFixtureService, useExisting: WorkflowTestFixtureService }],
  exports: [IWorkflowTestFixtureService, WorkflowTestFixtureService],
})
export class WorkflowTestFixtureServiceModule {}
