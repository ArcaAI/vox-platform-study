import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { WorkflowAssignmentServiceModule } from '../workflow-assignment/workflow-assignment.service.module';
import { ConfigResolver } from './config-resolver.service';

/**
 * ConfigResolver DI module. Imports `CoreDatabaseModule` for the `UserProfile` repository
 * (preferred-prompt threading) and the `UserSettings` repository (the doctor's DNA preference,
 * TASK-882), plus `WorkflowAssignmentServiceModule` so the `@Optional()`
 * `IWorkflowAssignmentService` resolves in production: every tenant-level decision this
 * resolver answers (auto-summary, the DNA style and redaction gates, re-visit carry-forward)
 * is read off the assigned consultation graph, and without this import the resolver would
 * silently answer its unwired defaults.
 */
@Module({
  imports: [CoreDatabaseModule, WorkflowAssignmentServiceModule],
  providers: [ConfigResolver],
  exports: [ConfigResolver],
})
export class ConfigResolverModule {}
