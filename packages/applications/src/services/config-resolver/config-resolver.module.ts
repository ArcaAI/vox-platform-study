import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { WorkflowAssignmentServiceModule } from '../workflow-assignment/workflow-assignment.service.module';
import { ConfigResolver } from './config-resolver.service';

/**
 * ConfigResolver DI module. Imports
 * CoreDatabaseModule for the PipelinePolicy repository (cascade rows + SYSTEM
 * default) and the UserProfile repository (preferred-prompt threading), plus
 * `WorkflowAssignmentServiceModule` (lane A item 2) so the `@Optional()`
 * `IWorkflowAssignmentService` resolves in production: DNA-redaction's TENANT gate
 * is now the presence of an ACTIVE `agent.dna_redaction` node in the tenant's
 * governing consultation definition, and without this import the resolver would
 * silently keep answering from the legacy `dnaRedactionEnabled` cascade instead.
 */
@Module({
  imports: [CoreDatabaseModule, WorkflowAssignmentServiceModule],
  providers: [ConfigResolver],
  exports: [ConfigResolver],
})
export class ConfigResolverModule {}
