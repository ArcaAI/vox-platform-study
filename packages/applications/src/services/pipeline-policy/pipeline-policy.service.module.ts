import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConfigResolverModule } from '../config-resolver';
import { PipelinePolicyService } from './pipeline-policy.service';

/**
 * PipelinePolicyService DI module. Imports
 * CoreDatabaseModule for the PipelinePolicy + PipelinePolicyChange repositories
 * and the `CORE_DATABASE_SERVICE` (interactive transactions), and
 * ConfigResolverModule for the effective-cascade resolution. `ClsService` is
 * resolved from the globally-registered `ClsModule`.
 */
@Module({
  imports: [CoreDatabaseModule, ConfigResolverModule],
  providers: [PipelinePolicyService],
  exports: [PipelinePolicyService],
})
/** @deprecated TASK-861 — removed in R4. with `PipelinePolicy`. */
export class PipelinePolicyServiceModule {}
